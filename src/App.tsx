import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import MainLayout from './layouts/MainLayout'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import HistoryPage from './pages/HistoryPage'
import { AudioRecorder } from './components/AudioRecorder'
import { HUD } from './components/HUD'
import { SessionHUD } from './components/SessionHUD'
import { resolveWindowKind, type WindowKind } from './shared/window-kind'

function readWindowKind(): WindowKind {
  let label: string | null = null
  try {
    label = getCurrentWindow().label
  } catch {
    // Not running inside Tauri (browser preview): hash decides.
  }
  return resolveWindowKind(label, window.location.hash.slice(1))
}

function App() {
  const [windowKind] = useState<WindowKind>(() => readWindowKind())
  const [currentRoute, setCurrentRoute] = useState(() => {
    const hash = window.location.hash.slice(1) || ''
    return hash && hash !== '/' ? hash : '/home'
  })

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1) || ''
      setCurrentRoute(hash && hash !== '/' ? hash : '/home')
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  if (windowKind === 'background') {
    return <AudioRecorder />
  }

  // Standby capsule: draggable / dockable idle + latched launcher (overlay window).
  if (windowKind === 'overlay') {
    return <HUD />
  }

  // Session capsule: fixed bottom-center recording / processing / result
  // visuals (session window, shown & positioned by Rust per session start).
  if (windowKind === 'session') {
    return <SessionHUD />
  }

  const getPage = () => {
    switch (currentRoute) {
      case '/settings':
        return <SettingsPage />
      case '/history':
        return <HistoryPage />
      default:
        return <HomePage />
    }
  }

  // Main window: default route is the main interface (home); settings /
  // history are reached via hash (tray menu, hotkey, sidebar).
  const route =
    currentRoute === '/settings' ? '/settings' : currentRoute === '/history' ? '/history' : '/home'
  return <MainLayout currentRoute={route}>{getPage()}</MainLayout>
}

export default App
