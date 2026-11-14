import { useEffect, useRef } from 'react'
import { LOW_VOLUME_GAIN_DB, RECORDING } from '@/shared/constants'
import type { AppConfig, ASRMode, RecordingStartPayload } from '@/shared/types'

type StopMeta = {
  chunkIndex: number
  isFinal: boolean
  rotateAfterStop: boolean
}

/**
 * 显式关闭浏览器侧的回声消除 / 降噪 / 自动增益（AGC）：三者都带自适应
 * 「爬坡」，冷启动的头几秒增益偏低——正是「开头几句录不到」的来源之一。
 * 响度交给 `lowVolumeMode` 的固定增益节点，首帧即最终增益、全程恒定。
 */
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

/**
 * Create the session's AudioContext at 16 kHz so the AudioWorklet reports (and
 * Rust encodes) 16 kHz PCM: the upload is ~3x smaller than the 48 kHz hardware
 * default and speech ASR needs nothing more. Falls back to the device default
 * rate on platforms that reject a custom sampleRate.
 */
function createRecordingAudioContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 16_000 })
  } catch {
    return new AudioContext()
  }
}

export function AudioRecorder() {
  // ---- 音频管线（micKeepAlive 开启时跨会话保温，消除冷启动头几秒丢字）----
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const pipelineDeviceIdRef = useRef<string | null>(null)
  const pipelineOpRef = useRef<Promise<unknown>>(Promise.resolve())

  // ---- 会话状态（每次会话重置）----
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const animationFrameRef = useRef<number | null>(null)
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopMetaRef = useRef<StopMeta | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const currentChunkIndexRef = useRef(0)
  const currentMimeTypeRef = useRef('audio/webm')
  const isRecordingRef = useRef(false)
  const isSessionEndingRef = useRef(false)
  const currentAsrModeRef = useRef<ASRMode>('classic')
  const streamingSequenceRef = useRef(0)
  const streamingFlushResolveRef = useRef<(() => void) | null>(null)
  const streamingStopPromiseRef = useRef<Promise<void> | null>(null)
  const micKeepAliveRef = useRef(true)

  const summarizeMediaError = (error: unknown) => {
    if (error instanceof DOMException) {
      return `${error.name}: ${error.message}`
    }
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  }

  const getAudioStream = async (deviceId?: string) => {
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : ''
    const audio: MediaTrackConstraints = { ...RAW_AUDIO_CONSTRAINTS }
    if (!normalizedDeviceId) {
      return await navigator.mediaDevices.getUserMedia({ audio })
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: normalizedDeviceId } },
      })
    } catch (error) {
      console.warn(
        `[Renderer] Selected microphone unavailable, falling back to system default: ${summarizeMediaError(error)}`,
      )
      return await navigator.mediaDevices.getUserMedia({ audio })
    }
  }

  const hasLiveAudioTrack = () => {
    return streamRef.current?.getAudioTracks().some((track) => track.readyState === 'live') ?? false
  }

  const clearChunkTimer = () => {
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current)
      chunkTimerRef.current = null
    }
  }

  const clearSessionMaxTimer = () => {
    if (sessionMaxTimerRef.current) {
      clearTimeout(sessionMaxTimerRef.current)
      sessionMaxTimerRef.current = null
    }
  }

  const applyLowVolumeGain = (lowVolumeMode: boolean) => {
    const gain = gainNodeRef.current
    if (!gain) return
    gain.gain.value = lowVolumeMode ? 10 ** (LOW_VOLUME_GAIN_DB / 20) : 1
  }

  /** 释放整条音频管线（麦克风流 / AudioContext / Worklet）。 */
  const releasePipeline = () => {
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    gainNodeRef.current = null

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
      streamRef.current = null
    }

    analyserRef.current = null
    pipelineDeviceIdRef.current = null
  }

  /** 仅重置会话级状态；保温开启时保留温热管线供下一次会话复用。 */
  const resetSessionState = () => {
    clearChunkTimer()
    clearSessionMaxTimer()

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    mediaRecorderRef.current = null
    chunksRef.current = []
    stopMetaRef.current = null
    currentSessionIdRef.current = null
    currentChunkIndexRef.current = 0
    currentMimeTypeRef.current = 'audio/webm'
    isRecordingRef.current = false
    isSessionEndingRef.current = false
    currentAsrModeRef.current = 'classic'
    streamingSequenceRef.current = 0
    streamingFlushResolveRef.current = null
    streamingStopPromiseRef.current = null
  }

  const releaseResources = () => {
    resetSessionState()
    releasePipeline()
  }

  /** 会话收尾：保温开启且流仍存活时保留管线，否则完整释放。 */
  const endSession = () => {
    const keepWarm = micKeepAliveRef.current && hasLiveAudioTrack()
    resetSessionState()
    if (!keepWarm) {
      releasePipeline()
    }
  }

  const sendAudioLevel = () => {
    if (!isRecordingRef.current) return
    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(dataArray)
    const sum = dataArray.reduce((a, b) => a + b, 0)
    const average = sum / dataArray.length
    const normalized = Math.min(average / 128, 1)
    window.electronAPI.sendAudioLevel(normalized)
    animationFrameRef.current = requestAnimationFrame(sendAudioLevel)
  }

  // Empty chunks are still sent: main tracks chunks by index and waits for the
  // final marker, so dropping one would leave the session (and HUD) stuck.
  const sendEmptyChunkMarker = (sessionId: string, chunkIndex: number, isFinal: boolean) => {
    window.electronAPI.sendAudioChunk({
      sessionId,
      chunkIndex,
      isFinal,
      mimeType: currentMimeTypeRef.current,
      buffer: new ArrayBuffer(0),
    })
  }

  const handleRecorderStop = async () => {
    const sessionId = currentSessionIdRef.current
    const mimeType = currentMimeTypeRef.current
    const audioStreamEnded = Boolean(streamRef.current && !hasLiveAudioTrack())
    const stopMeta = stopMetaRef.current ?? {
      chunkIndex: currentChunkIndexRef.current,
      isFinal: isSessionEndingRef.current || audioStreamEnded,
      rotateAfterStop: !isSessionEndingRef.current && !audioStreamEnded,
    }
    stopMetaRef.current = null

    if (audioStreamEnded) {
      stopMeta.isFinal = true
      stopMeta.rotateAfterStop = false
      isSessionEndingRef.current = true
      if (sessionId) {
        await window.electronAPI.stopSession()
      }
    }

    const blob = new Blob(chunksRef.current, { type: mimeType })
    chunksRef.current = []

    if (sessionId) {
      if (blob.size === 0) {
        console.warn('[Renderer] Sending empty audio chunk marker')
      }
      const buffer = await blob.arrayBuffer()
      window.electronAPI.sendAudioChunk({
        sessionId,
        chunkIndex: stopMeta.chunkIndex,
        isFinal: stopMeta.isFinal,
        mimeType,
        buffer,
      })
    } else {
      console.warn('[Renderer] Skipping audio chunk without active session')
    }

    if (stopMeta.isFinal || isSessionEndingRef.current) {
      endSession()
      console.log('[Renderer] Final chunk sent, session ended')
      return
    }

    currentChunkIndexRef.current = stopMeta.chunkIndex + 1
    startChunkRecorder()
  }

  const requestRecorderStop = (nextStopMeta: StopMeta) => {
    if (nextStopMeta.isFinal) {
      isSessionEndingRef.current = true
    }

    const existingStopMeta = stopMetaRef.current
    if (existingStopMeta) {
      if (nextStopMeta.isFinal) {
        existingStopMeta.isFinal = true
        existingStopMeta.rotateAfterStop = false
      }
      return
    }

    const recorder = mediaRecorderRef.current
    if (!recorder) {
      if (nextStopMeta.isFinal) {
        const sessionId = currentSessionIdRef.current
        if (sessionId) {
          sendEmptyChunkMarker(sessionId, nextStopMeta.chunkIndex, true)
        }
        endSession()
      }
      return
    }

    clearChunkTimer()
    stopMetaRef.current = {
      chunkIndex: nextStopMeta.chunkIndex,
      isFinal: nextStopMeta.isFinal,
      rotateAfterStop: nextStopMeta.rotateAfterStop && !nextStopMeta.isFinal,
    }

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }
  }

  const scheduleChunkRotation = () => {
    clearChunkTimer()
    chunkTimerRef.current = setTimeout(() => {
      if (!isSessionEndingRef.current) {
        requestRecorderStop({
          chunkIndex: currentChunkIndexRef.current,
          isFinal: false,
          rotateAfterStop: true,
        })
      }
    }, RECORDING.CHUNK_DURATION_SECONDS * 1000)
  }

  const startChunkRecorder = () => {
    const stream = streamRef.current
    if (!stream) return
    if (!hasLiveAudioTrack()) {
      const sessionId = currentSessionIdRef.current
      const chunkIndex = currentChunkIndexRef.current
      void (async () => {
        await window.electronAPI.stopSession().catch(() => {})
        if (sessionId) {
          sendEmptyChunkMarker(sessionId, chunkIndex, true)
        }
        releaseResources()
      })().catch(() => {})
      return
    }

    const mediaRecorder = new MediaRecorder(stream, { mimeType: currentMimeTypeRef.current })
    mediaRecorderRef.current = mediaRecorder
    chunksRef.current = []

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data)
      }
    }

    mediaRecorder.onstop = () => {
      void handleRecorderStop().catch(() => {})
    }

    mediaRecorder.onerror = (event) => {
      console.error('[Renderer] MediaRecorder error:', event)
      window.electronAPI.sendError(`MediaRecorder error: ${event}`)
      releaseResources()
    }

    mediaRecorder.start()
    scheduleChunkRotation()
    console.log(`[Renderer] Recording chunk ${currentChunkIndexRef.current} started`)
  }

  const finishStreamingCapture = async () => {
    if (streamingStopPromiseRef.current) return streamingStopPromiseRef.current

    const finish = async () => {
      clearSessionMaxTimer()
      const sessionId = currentSessionIdRef.current
      const worklet = workletNodeRef.current

      if (worklet) {
        await new Promise<void>((resolve) => {
          let completed = false
          const complete = () => {
            if (completed) return
            completed = true
            streamingFlushResolveRef.current = null
            resolve()
          }
          streamingFlushResolveRef.current = complete
          worklet.port.postMessage({ type: 'flush' })
          setTimeout(complete, 1000)
        })
      }

      isSessionEndingRef.current = true
      if (sessionId) {
        window.electronAPI.sendStreamingAudioEnd({
          sessionId,
          sequence: streamingSequenceRef.current,
        })
      }
      endSession()
      console.log('[Renderer] Streaming audio final marker sent, session ended')
    }

    streamingStopPromiseRef.current = finish()
    return streamingStopPromiseRef.current
  }

  /**
   * 确保音频管线就绪。保温开启时跨会话复用同一条流 / AudioContext / Worklet
   * （下次按键立即达到最佳收音）；设备切换或流失效时重建。串行化以避免
   * 预热与会话启动并发建线。
   */
  const ensurePipeline = (deviceId: string | undefined, lowVolumeMode: boolean): Promise<void> => {
    const run = pipelineOpRef.current.then(() => ensurePipelineInner(deviceId, lowVolumeMode))
    pipelineOpRef.current = run.catch(() => {})
    return run
  }

  const ensurePipelineInner = async (deviceId: string | undefined, lowVolumeMode: boolean) => {
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : ''

    if (
      streamRef.current &&
      pipelineDeviceIdRef.current === normalizedDeviceId &&
      hasLiveAudioTrack() &&
      audioContextRef.current &&
      workletNodeRef.current
    ) {
      applyLowVolumeGain(lowVolumeMode)
      await audioContextRef.current.resume().catch(() => {})
      return
    }

    releasePipeline()
    const stream = await getAudioStream(normalizedDeviceId || undefined)

    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (isRecordingRef.current && !isSessionEndingRef.current) {
          console.warn('[Renderer] Microphone stream ended during recording')
          void window.electronAPI.stopSession().catch(() => {})
        }
        releasePipeline()
      }
    })

    // 16 kHz keeps the PCM/WAV upload ~3x smaller than the 48 kHz hardware
    // default (speech ASR needs nothing more); the worklet reports the actual
    // context rate and Rust encodes the WAV with it.
    const audioContext = createRecordingAudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.3
    source.connect(analyser)

    const gain = audioContext.createGain()
    gain.gain.value = lowVolumeMode ? 10 ** (LOW_VOLUME_GAIN_DB / 20) : 1
    source.connect(gain)

    const workletUrl = new URL('./voice-key-pcm-worklet.js', window.location.href).toString()
    await audioContext.audioWorklet.addModule(workletUrl)
    const worklet = new AudioWorkletNode(audioContext, 'voice-key-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })

    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      const message = data as Record<string, unknown>

      if (message.type === 'flushed') {
        streamingFlushResolveRef.current?.()
        return
      }

      if (
        message.type !== 'audio' ||
        !(message.buffer instanceof ArrayBuffer) ||
        typeof message.sampleRate !== 'number'
      ) {
        return
      }

      const sessionId = currentSessionIdRef.current
      if (!sessionId || isSessionEndingRef.current) return
      if (currentAsrModeRef.current !== 'streaming') return
      window.electronAPI.sendStreamingAudioFrame({
        sessionId,
        sequence: streamingSequenceRef.current++,
        sampleRate: message.sampleRate,
        buffer: message.buffer,
      })
    }

    gain.connect(worklet)

    // An AudioWorklet needs a live output graph to be processed. Route it to a
    // muted gain node so microphone audio is never played back to the user.
    const mute = audioContext.createGain()
    mute.gain.value = 0
    worklet.connect(mute)
    mute.connect(audioContext.destination)
    await audioContext.resume()

    streamRef.current = stream
    audioContextRef.current = audioContext
    analyserRef.current = analyser
    gainNodeRef.current = gain
    workletNodeRef.current = worklet
    pipelineDeviceIdRef.current = normalizedDeviceId
  }

  /** 应用保温配置：开启即预热管线，关闭则释放（录音中推迟到会话结束）。 */
  const applyKeepAliveConfig = (config: AppConfig) => {
    const keepAlive = config.asr?.micKeepAlive ?? true
    micKeepAliveRef.current = keepAlive
    const deviceId = config.asr?.microphoneDeviceId
    const lowVolumeMode = config.asr?.lowVolumeMode ?? true

    if (isRecordingRef.current) return

    if (!keepAlive) {
      // 排在在建管线之后释放，避免预热完成又把麦克风留在开启态。
      void pipelineOpRef.current.catch(() => {}).then(() => releasePipeline())
      return
    }

    void ensurePipeline(deviceId, lowVolumeMode).catch((error) => {
      console.warn('[Renderer] Mic pre-warm failed:', summarizeMediaError(error))
    })
  }

  const startRecordingSession = async (payload: RecordingStartPayload) => {
    if (isRecordingRef.current) {
      console.warn('[Renderer] Already recording, ignoring start request')
      return
    }

    try {
      resetSessionState()

      currentSessionIdRef.current = payload.sessionId
      currentAsrModeRef.current = payload.asrMode
      currentChunkIndexRef.current = 0
      isRecordingRef.current = true
      isSessionEndingRef.current = false
      micKeepAliveRef.current = payload.micKeepAlive ?? true

      await ensurePipeline(payload.microphoneDeviceId, payload.lowVolumeMode ?? true)

      // SESSION_STOP may have arrived while the pipeline was being prepared
      // (the final marker was already sent by requestRecorderStop); drop the
      // session instead of recording into a dead one. With keep-alive on the
      // freshly built pipeline is exactly what the next session wants, so it
      // stays warm instead of being torn down.
      if (currentSessionIdRef.current !== payload.sessionId || isSessionEndingRef.current) {
        console.warn('[Renderer] Session ended while acquiring microphone, discarding')
        if (!micKeepAliveRef.current) {
          releasePipeline()
        }
        return
      }

      sendAudioLevel()

      let mimeType = 'audio/wav'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm'
      }
      currentMimeTypeRef.current = mimeType

      if (payload.asrMode !== 'streaming') {
        startChunkRecorder()
      }

      sessionMaxTimerRef.current = setTimeout(() => {
        if (!isSessionEndingRef.current && currentSessionIdRef.current === payload.sessionId) {
          void window.electronAPI.stopSession().catch(() => {})
        }
      }, RECORDING.SESSION_MAX_DURATION_SECONDS * 1000)
    } catch (error) {
      console.error('[Renderer] Failed to start recording:', error)
      // Only report/cleanup if this session is still current; a stale failure
      // must not tear down a newer session's resources.
      if (currentSessionIdRef.current === payload.sessionId) {
        window.electronAPI.sendError(`Failed to access microphone: ${error}`)
        releaseResources()
      }
    }
  }

  const stopRecordingSession = () => {
    console.log('[Renderer] onStopRecording triggered')
    if (currentAsrModeRef.current === 'streaming') {
      void finishStreamingCapture().catch(() => {})
      return
    }
    requestRecorderStop({
      chunkIndex: currentChunkIndexRef.current,
      isFinal: true,
      rotateAfterStop: false,
    })
  }

  const startRecordingSessionRef = useRef(startRecordingSession)
  const stopRecordingSessionRef = useRef(stopRecordingSession)
  const releaseResourcesRef = useRef(releaseResources)
  const applyKeepAliveConfigRef = useRef(applyKeepAliveConfig)

  useEffect(() => {
    startRecordingSessionRef.current = startRecordingSession
    stopRecordingSessionRef.current = stopRecordingSession
    releaseResourcesRef.current = releaseResources
    applyKeepAliveConfigRef.current = applyKeepAliveConfig
  })

  useEffect(() => {
    const removeStartRecordingListener = window.electronAPI.onStartRecording((payload) => {
      void startRecordingSessionRef.current(payload)
    })

    const removeStopRecordingListener = window.electronAPI.onStopRecording(() => {
      stopRecordingSessionRef.current()
    })

    const removeConfigUpdatedListener = window.electronAPI.onConfigUpdated((config) => {
      applyKeepAliveConfigRef.current(config)
    })

    // 预热：保温开启时启动即把麦克风管线打开并保持，下一次按键零延迟。
    void window.electronAPI
      .getConfig()
      .then((config) => applyKeepAliveConfigRef.current(config))
      .catch(() => {})

    return () => {
      removeStartRecordingListener?.()
      removeStopRecordingListener?.()
      removeConfigUpdatedListener?.()
      releaseResourcesRef.current()
      console.log('[Renderer] Component unmounted, resources released')
    }
  }, [])

  return null
}
