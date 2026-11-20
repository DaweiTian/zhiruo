import { describe, expect, it } from 'vitest'
import { LLM_PROVIDERS, LLM_REFINE, STORED_SECRET_PLACEHOLDER } from '@/shared/constants'
import {
  defaultLLMRefineConfig,
  normalizeLLMRefineConfig,
  resolveLLMConnection,
} from '@/shared/llm-config'
import type { AppConfig } from '@/shared/types'
import {
  applyPersistedSecretState,
  getRefineConnectionFingerprint,
  invalidateRefineConnection,
  isRefineConfigComplete,
  isRefineConnectionCacheFresh,
  markRefineConnectionValidated,
  normalizeInjectConfig,
  normalizePickerConfig,
  normalizeRendererConfig,
  readRefineFeatureFlags,
  reconcileRefineFeaturesAfterConnectionChange,
  resolveMicrophoneDeviceMigration,
  type RefineConnectionValidationCache,
} from './settings-config'

function createConfig(llmKey: string): AppConfig {
  return {
    app: { language: 'system', autoLaunch: false },
    asr: {
      lowVolumeMode: true,
      microphoneDeviceId: '',
      microphoneDeviceLabel: '',
    },
    llmRefine: {
      ...defaultLLMRefineConfig,
      // 显式 provider，与下面填的 deepseek key 配套——测试不依赖默认 provider
      provider: 'deepseek',
      deepseek: {
        ...defaultLLMRefineConfig.deepseek,
        apiKey: llmKey,
      },
    },
    hotkey: { pttKey: 'F2', toggleSettings: 'CommandOrControl+,', translateKey: 'F4' },
    translation: { enabled: false, targetLanguage: 'en' },
  }
}

function createOpenRouterConfig(options?: {
  apiKey?: string
  enabled?: boolean
  translateOutput?: boolean
  translationEnabled?: boolean
}): AppConfig {
  const config = createConfig('')
  config.llmRefine = normalizeLLMRefineConfig({
    ...config.llmRefine,
    enabled: options?.enabled ?? false,
    translateOutput: options?.translateOutput ?? false,
    provider: 'openrouter',
    openrouter: {
      ...defaultLLMRefineConfig.openrouter,
      apiKey: options?.apiKey ?? 'openrouter-key',
    },
  })
  config.translation.enabled = options?.translationEnabled ?? false
  return config
}

describe('microphone device migration', () => {
  const currentDevices = [
    { deviceId: 'current-realtek-id', label: '麦克风 (Realtek High Definition Audio)' },
    { deviceId: 'usb-id', label: 'USB Microphone' },
  ]

  it('rebinds a missing device ID when exactly one current label matches', () => {
    expect(
      resolveMicrophoneDeviceMigration(
        'stale-realtek-id',
        '麦克风 (Realtek High Definition Audio)',
        currentDevices,
      ),
    ).toEqual(currentDevices[0])
  })

  it('normalizes harmless label casing and whitespace changes', () => {
    expect(
      resolveMicrophoneDeviceMigration('stale-usb-id', '  usb   MICROPHONE ', currentDevices),
    ).toEqual(currentDevices[1])
  })

  it('does nothing while the selected device ID is still available', () => {
    expect(
      resolveMicrophoneDeviceMigration(
        'current-realtek-id',
        '麦克风 (Realtek High Definition Audio)',
        currentDevices,
      ),
    ).toBeNull()
  })

  it('does not guess when multiple devices expose the same label', () => {
    expect(
      resolveMicrophoneDeviceMigration('stale-id', 'USB Microphone', [
        { deviceId: 'usb-1', label: 'USB Microphone' },
        { deviceId: 'usb-2', label: 'USB Microphone' },
      ]),
    ).toBeNull()
  })

  it('does not migrate without a persisted ID and exposed label', () => {
    expect(resolveMicrophoneDeviceMigration('', 'USB Microphone', currentDevices)).toBeNull()
    expect(resolveMicrophoneDeviceMigration('stale-id', '', currentDevices)).toBeNull()
  })
})

describe('settings persisted secret state', () => {
  it('replaces a successfully saved plaintext LLM key with the renderer placeholder', () => {
    const current = createConfig('new-llm-key')
    const persisted = createConfig(STORED_SECRET_PLACEHOLDER)
    const result = applyPersistedSecretState(current, { llmRefine: current.llmRefine }, persisted)

    expect(result.llmRefine.deepseek.apiKey).toBe(STORED_SECRET_PLACEHOLDER)
  })

  it('preserves secrets and settings edited again while the save was in flight', () => {
    const saved = createConfig('first-llm-key')
    const current = createConfig('second-llm-key')
    current.asr.lowVolumeMode = false
    current.translation.enabled = true
    const persisted = createConfig(STORED_SECRET_PLACEHOLDER)

    const result = applyPersistedSecretState(
      current,
      { asr: saved.asr, llmRefine: saved.llmRefine },
      persisted,
    )

    expect(result.llmRefine.deepseek.apiKey).toBe('second-llm-key')
    expect(result.asr.lowVolumeMode).toBe(false)
    expect(result.translation.enabled).toBe(true)
  })

  it('masks a persisted OpenAI key without changing the selected provider', () => {
    const current = createConfig('')
    current.llmRefine.provider = 'openai'
    current.llmRefine.openai.apiKey = 'openai-key'
    const persisted = createConfig('')
    persisted.llmRefine.provider = 'openai'
    persisted.llmRefine.openai.apiKey = STORED_SECRET_PLACEHOLDER

    const result = applyPersistedSecretState(current, { llmRefine: current.llmRefine }, persisted)

    expect(result.llmRefine.provider).toBe('openai')
    expect(result.llmRefine.openai.apiKey).toBe(STORED_SECRET_PLACEHOLDER)
  })

  it('masks a saved cloud ASR key when the renderer value still matches what was sent', () => {
    const current = createConfig('')
    current.asr.cloudApiKey = 'asr-key'
    const persisted = createConfig('')
    persisted.asr.cloudApiKey = STORED_SECRET_PLACEHOLDER

    const result = applyPersistedSecretState(current, { asr: current.asr }, persisted)

    expect(result.asr.cloudApiKey).toBe(STORED_SECRET_PLACEHOLDER)
  })

  it('keeps a cloud ASR key edited again while the save was in flight', () => {
    const saved = createConfig('')
    saved.asr.cloudApiKey = 'first-asr-key'
    const current = createConfig('')
    current.asr.cloudApiKey = 'second-asr-key'
    const persisted = createConfig('')
    persisted.asr.cloudApiKey = STORED_SECRET_PLACEHOLDER

    const result = applyPersistedSecretState(current, { asr: saved.asr }, persisted)

    expect(result.asr.cloudApiKey).toBe('second-asr-key')
  })
})

describe('MiMo connection resolution and normalization', () => {
  it('resolves the active connection from the mimo provider fields', () => {
    const config = normalizeLLMRefineConfig({
      ...defaultLLMRefineConfig,
      provider: 'mimo',
      mimo: {
        apiKey: 'mimo-key',
        model: 'mimo-v2.5',
        endpoint: 'https://api.xiaomimimo.com/v1',
      },
    })

    expect(resolveLLMConnection(config)).toEqual({
      provider: 'mimo',
      endpoint: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5',
      apiKey: 'mimo-key',
    })
  })

  it('preserves mimo fields across normalization instead of resetting to defaults', () => {
    const normalized = normalizeLLMRefineConfig({
      ...defaultLLMRefineConfig,
      provider: 'mimo',
      mimo: {
        apiKey: 'mimo-key',
        model: 'mimo-v2.5-asr',
        endpoint: 'https://custom.example.com/v1',
      },
    })

    expect(normalized.mimo).toEqual({
      apiKey: 'mimo-key',
      model: 'mimo-v2.5-asr',
      endpoint: 'https://custom.example.com/v1',
    })
    // A stable round-trip is what keeps isLlmRefineDirty from reporting phantom changes.
    expect(normalizeLLMRefineConfig(normalized).mimo).toEqual(normalized.mimo)
  })
})

describe('refinement configuration completeness', () => {
  it('accepts a configured provider connection, including a stored-key placeholder', () => {
    const config = createConfig(STORED_SECRET_PLACEHOLDER)

    expect(isRefineConfigComplete(config.llmRefine)).toBe(true)
  })

  it('rejects a provider connection without an API key', () => {
    const config = createConfig('')

    expect(isRefineConfigComplete(config.llmRefine)).toBe(false)
  })
})

describe('reconcileRefineFeaturesAfterConnectionChange', () => {
  it('keeps feature flags when switching between complete providers', () => {
    const prev = createOpenRouterConfig({
      enabled: true,
      translateOutput: true,
      translationEnabled: true,
    })
    const nextRefine = normalizeLLMRefineConfig({
      ...prev.llmRefine,
      provider: 'deepseek',
      deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: 'deepseek-key' },
    })

    const result = reconcileRefineFeaturesAfterConnectionChange(prev, nextRefine, null)

    expect(result.config.llmRefine.provider).toBe('deepseek')
    expect(readRefineFeatureFlags(result.config)).toEqual({
      enabled: true,
      translateOutput: true,
      translationEnabled: true,
    })
    expect(result.snapshot).toBeNull()
    expect(result.shouldReverifyConnection).toBe(true)
  })

  it('disables features and snapshots intent when the target provider is incomplete', () => {
    const prev = createOpenRouterConfig({
      enabled: true,
      translateOutput: true,
      translationEnabled: true,
    })
    const nextRefine = normalizeLLMRefineConfig({
      ...prev.llmRefine,
      provider: 'deepseek',
      deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: '' },
    })

    const result = reconcileRefineFeaturesAfterConnectionChange(prev, nextRefine, null)

    expect(result.config.llmRefine.provider).toBe('deepseek')
    expect(readRefineFeatureFlags(result.config)).toEqual({
      enabled: false,
      translateOutput: false,
      translationEnabled: false,
    })
    expect(result.snapshot).toEqual({
      enabled: true,
      translateOutput: true,
      translationEnabled: true,
    })
    expect(result.shouldReverifyConnection).toBe(false)
  })

  it('restores snapshotted flags when returning to a complete provider', () => {
    const incomplete = createOpenRouterConfig({ enabled: false })
    incomplete.llmRefine = normalizeLLMRefineConfig({
      ...incomplete.llmRefine,
      provider: 'deepseek',
      enabled: false,
      translateOutput: false,
      deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: '' },
    })
    incomplete.translation.enabled = false

    const snapshot = {
      enabled: true,
      translateOutput: true,
      translationEnabled: true,
    }
    const nextRefine = normalizeLLMRefineConfig({
      ...incomplete.llmRefine,
      provider: 'openrouter',
      openrouter: {
        ...defaultLLMRefineConfig.openrouter,
        apiKey: 'openrouter-key',
      },
    })

    const result = reconcileRefineFeaturesAfterConnectionChange(incomplete, nextRefine, snapshot)

    expect(result.config.llmRefine.provider).toBe('openrouter')
    expect(readRefineFeatureFlags(result.config)).toEqual(snapshot)
    expect(result.snapshot).toBeNull()
    expect(result.shouldReverifyConnection).toBe(true)
  })

  it('does not invent an on state when no snapshot and features were already off', () => {
    const prev = createOpenRouterConfig({ enabled: false })
    const nextRefine = normalizeLLMRefineConfig({
      ...prev.llmRefine,
      provider: 'deepseek',
      deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: 'deepseek-key' },
    })

    const result = reconcileRefineFeaturesAfterConnectionChange(prev, nextRefine, null)

    expect(readRefineFeatureFlags(result.config)).toEqual({
      enabled: false,
      translateOutput: false,
      translationEnabled: false,
    })
    expect(result.snapshot).toBeNull()
    expect(result.shouldReverifyConnection).toBe(false)
  })

  it('preserves an existing snapshot when switching across incomplete providers', () => {
    const prev = createOpenRouterConfig({ enabled: false })
    prev.llmRefine = normalizeLLMRefineConfig({
      ...prev.llmRefine,
      provider: 'deepseek',
      deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: '' },
    })
    const existingSnapshot = {
      enabled: true,
      translateOutput: false,
      translationEnabled: true,
    }
    const nextRefine = normalizeLLMRefineConfig({
      ...prev.llmRefine,
      provider: 'openai',
      openai: { ...defaultLLMRefineConfig.openai, apiKey: '' },
    })

    const result = reconcileRefineFeaturesAfterConnectionChange(prev, nextRefine, existingSnapshot)

    expect(result.config.llmRefine.provider).toBe('openai')
    expect(readRefineFeatureFlags(result.config)).toEqual({
      enabled: false,
      translateOutput: false,
      translationEnabled: false,
    })
    expect(result.snapshot).toEqual(existingSnapshot)
  })

  it('covers the reported round-trip: openrouter on 鈫?incomplete deepseek 鈫?openrouter on', () => {
    const openrouterOn = createOpenRouterConfig({
      enabled: true,
      translateOutput: false,
      translationEnabled: false,
    })

    const toDeepSeek = reconcileRefineFeaturesAfterConnectionChange(
      openrouterOn,
      normalizeLLMRefineConfig({
        ...openrouterOn.llmRefine,
        provider: 'deepseek',
        deepseek: { ...defaultLLMRefineConfig.deepseek, apiKey: '' },
      }),
      null,
    )

    expect(toDeepSeek.config.llmRefine.enabled).toBe(false)
    expect(toDeepSeek.snapshot?.enabled).toBe(true)

    const backToOpenRouter = reconcileRefineFeaturesAfterConnectionChange(
      toDeepSeek.config,
      normalizeLLMRefineConfig({
        ...toDeepSeek.config.llmRefine,
        provider: 'openrouter',
        openrouter: {
          ...defaultLLMRefineConfig.openrouter,
          apiKey: 'openrouter-key',
        },
      }),
      toDeepSeek.snapshot,
    )

    expect(backToOpenRouter.config.llmRefine.provider).toBe('openrouter')
    expect(backToOpenRouter.config.llmRefine.enabled).toBe(true)
    expect(backToOpenRouter.snapshot).toBeNull()
    expect(backToOpenRouter.shouldReverifyConnection).toBe(true)
  })
})

describe('refine connection fingerprint', () => {
  it('stays stable across normalize round-trips and placeholder keys', () => {
    const config = createOpenRouterConfig({ apiKey: 'openrouter-key' })
    const fingerprint = getRefineConnectionFingerprint(config.llmRefine)

    expect(getRefineConnectionFingerprint(normalizeLLMRefineConfig(config.llmRefine))).toBe(
      fingerprint,
    )

    const masked = createOpenRouterConfig({ apiKey: STORED_SECRET_PLACEHOLDER })
    expect(getRefineConnectionFingerprint(masked.llmRefine)).toBe(
      getRefineConnectionFingerprint(normalizeLLMRefineConfig(masked.llmRefine)),
    )
  })

  it('changes when the api key, model, or provider changes', () => {
    const base = getRefineConnectionFingerprint(createOpenRouterConfig().llmRefine)

    const otherKey = createOpenRouterConfig({ apiKey: 'another-key' })
    expect(getRefineConnectionFingerprint(otherKey.llmRefine)).not.toBe(base)

    const otherProvider = createConfig('deepseek-key')
    expect(getRefineConnectionFingerprint(otherProvider.llmRefine)).not.toBe(base)

    const otherModel = createOpenRouterConfig()
    const alternateModel = LLM_PROVIDERS.OPENROUTER_MODELS.find(
      (option) => option.id !== otherModel.llmRefine.openrouter.model,
    )
    expect(alternateModel).toBeDefined()
    if (!alternateModel) throw new Error('expected an alternate OpenRouter model')
    otherModel.llmRefine = normalizeLLMRefineConfig({
      ...otherModel.llmRefine,
      openrouter: { ...otherModel.llmRefine.openrouter, model: alternateModel.id },
    })
    expect(getRefineConnectionFingerprint(otherModel.llmRefine)).not.toBe(base)
  })
})

describe('refine connection validation cache', () => {
  const fingerprint = 'openrouter\nhttps://openrouter.ai/api/v1\nmodel\nkey'

  function createCache(): RefineConnectionValidationCache {
    return new Map()
  }

  it('misses when the connection was never validated', () => {
    expect(isRefineConnectionCacheFresh(createCache(), fingerprint, Date.now())).toBe(false)
  })

  it('hits while the validation is within the TTL', () => {
    const cache = createCache()
    const now = 1_000_000
    markRefineConnectionValidated(cache, fingerprint, now)

    expect(
      isRefineConnectionCacheFresh(cache, fingerprint, now + LLM_REFINE.CONNECTION_CACHE_TTL_MS),
    ).toBe(true)
  })

  it('misses and evicts the entry once the TTL has passed', () => {
    const cache = createCache()
    const now = 1_000_000
    markRefineConnectionValidated(cache, fingerprint, now)

    const staleNow = now + LLM_REFINE.CONNECTION_CACHE_TTL_MS + 1
    expect(isRefineConnectionCacheFresh(cache, fingerprint, staleNow)).toBe(false)
    expect(cache.has(fingerprint)).toBe(false)
  })

  it('forgets a connection explicitly after a failed test', () => {
    const cache = createCache()
    const now = 1_000_000
    markRefineConnectionValidated(cache, fingerprint, now)
    invalidateRefineConnection(cache, fingerprint)

    expect(isRefineConnectionCacheFresh(cache, fingerprint, now)).toBe(false)
  })
})

describe('picker config normalization', () => {
  it('keeps hub as a valid side-button action and drops the legacy hubButton key', () => {
    expect(normalizePickerConfig({ x2Action: 'hub' }).x2Action).toBe('hub')
    expect(normalizePickerConfig({ x1Action: 'hub' }).x1Action).toBe('hub')
    expect(normalizePickerConfig({ x1Action: 'history' as never }).x1Action).toBe('snippets')
    // 0.10.x 的 hubButton 已由 Rust 迁移进落点，归一后不再保留。
    const legacy = normalizePickerConfig({ hubButton: 'x2' } as never) as unknown as Record<
      string,
      unknown
    >
    expect(legacy.hubButton).toBeUndefined()
  })

  it('keeps the hub action distinct from the panel master switch', () => {
    const config = normalizePickerConfig({ enabled: false, x2Action: 'hub' })
    expect(config.enabled).toBe(false)
    expect(config.x2Action).toBe('hub')
  })

  it('raises the per-entry snippet cap to 256 characters', () => {
    const long = 'x'.repeat(256)
    expect(normalizePickerConfig({ userSnippets: [long] }).userSnippets).toEqual([long])
    expect(normalizePickerConfig({ userSnippets: ['x'.repeat(257)] }).userSnippets).toEqual([])
  })

  it('clamps the panel width into 240–720 and falls back to 320', () => {
    expect(normalizePickerConfig({ panelWidth: 480 }).panelWidth).toBe(480)
    expect(normalizePickerConfig({ panelWidth: 100 }).panelWidth).toBe(240)
    expect(normalizePickerConfig({ panelWidth: 5000 }).panelWidth).toBe(720)
    expect(normalizePickerConfig({ panelWidth: Number.NaN }).panelWidth).toBe(320)
    expect(normalizePickerConfig().panelWidth).toBe(320)
  })
})

describe('inject config normalization', () => {
  it('keeps valid inject modes and falls back to auto', () => {
    expect(normalizeInjectConfig({ mode: 'paste' }).mode).toBe('paste')
    expect(normalizeInjectConfig({ mode: 'type' }).mode).toBe('type')
    expect(normalizeInjectConfig({ mode: 'clipboard' }).mode).toBe('clipboard')
    expect(normalizeInjectConfig({ mode: 'auto' }).mode).toBe('auto')
    expect(normalizeInjectConfig({ mode: 'keybd' as never }).mode).toBe('auto')
    expect(normalizeInjectConfig({}).mode).toBe('auto')
    expect(normalizeInjectConfig().mode).toBe('auto')
  })
})

describe('hotwords normalization on load', () => {
  it('cleans hotwords like the glossary (trim, dedupe, 100 × 64)', () => {
    const config = createConfig('key')
    const normalized = normalizeRendererConfig({
      ...config,
      asr: {
        ...config.asr,
        hotwords: [' 芷若 ', '芷若', '', 'x'.repeat(65), 'Zhiruo'],
      },
    })
    expect(normalized.asr.hotwords).toEqual(['芷若', 'Zhiruo'])
  })

  it('defaults to an empty hotword list', () => {
    const normalized = normalizeRendererConfig(createConfig('key'))
    expect(normalized.asr.hotwords).toEqual([])
  })
})
