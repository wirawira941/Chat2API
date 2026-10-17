/**
 * Server renderer entry.
 *
 * Same as src/renderer/src/main.tsx, plus one extra import at the top: the
 * *unmodified* Electron preload script. Because the renderer build aliases the
 * `electron` module to ./electron-shim.ts, running the preload here populates
 * `window.electronAPI` with the real 105-method surface, backed by HTTP + SSE
 * instead of ipcRenderer. No API has to be re-declared.
 */

import '../../src/preload/index'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from '@/App'
import ErrorBoundary from '@/components/ErrorBoundary'
import { ThemeProvider } from '@/components/ThemeProvider'
import '@/i18n'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
