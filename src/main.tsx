import React from 'react'
import ReactDOM from 'react-dom/client'
import { SessionNotifications } from '@/components/SessionNotifications'
import { Toaster } from '@/components/ui/sonner'
import { initRendererLogger } from '@/lib/logger'
import { initThemeStore } from '@/lib/useTheme'
import { installTauriApi, tauriApi } from '@/lib/tauri-api'
import App from './App.tsx'
import i18n, { initI18n } from './i18n'
import './index.css'

installTauriApi()
initRendererLogger()
// 所有窗口（main/overlay/session/hub/background）共用本入口，统一应用主题与强调色
initThemeStore()

const root = ReactDOM.createRoot(document.getElementById('root')!)

initI18n()
  .catch((error) => {
    console.error('[i18n] Failed to initialize, falling back to defaults.', error)
  })
  .finally(() => {
    root.render(
      <React.StrictMode>
        <App />
        <SessionNotifications />
        <Toaster />
      </React.StrictMode>,
    )

    tauriApi.onAppLanguageChanged((snapshot) => {
      void i18n.changeLanguage(snapshot.resolved).catch(() => {})
      document.documentElement.lang = snapshot.resolved
    })
  })
