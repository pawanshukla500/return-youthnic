import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ThemeProvider, initThemeBeforePaint } from './state/ThemeProvider'
import { SessionProvider } from './state/SessionContext'
import './styles/index.css'

// Apply the persisted theme before first paint to avoid a flash.
initThemeBeforePaint()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
)
