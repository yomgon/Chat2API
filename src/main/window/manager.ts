import { BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { storeManager } from '../store/store'
import { isSafeExternalLink, isTrustedRendererNavigation } from './navigationGuard'

let mainWindow: BrowserWindow | null = null

export interface WindowOptions {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  show?: boolean
}

export function createWindow(options: WindowOptions = {}): BrowserWindow {
  const {
    width = 1200,
    height = 800,
    minWidth = 800,
    minHeight = 600,
    title = 'Chat2API Private Local',
    show = false,
  } = options

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    title,
    show,
    autoHideMenuBar: true,
    frame: true,
    backgroundColor: '#1a1a1a',
    icon: join(__dirname, '../../resources/icon.png'),
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalLink(url)) {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDev = process.env.NODE_ENV === 'development'
    const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
    const expectedPage = isDev
      ? devUrl
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
    if (!isTrustedRendererNavigation(url, expectedPage)) {
      event.preventDefault()
      if (isSafeExternalLink(url)) {
        void shell.openExternal(url).catch(() => {})
      }
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('close', (event) => {
    if (!(app as typeof app & { isQuitting?: boolean }).isQuitting) {
      try {
        const config = storeManager.getConfig()
        if (config.minimizeToTray) {
          event.preventDefault()
          mainWindow?.hide()
        }
      } catch {
        console.error('[Window] Failed to get config during close')
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  }
}

export function hideWindow(): void {
  mainWindow?.hide()
}

export function minimizeWindow(): void {
  mainWindow?.minimize()
}

export function maximizeWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
}

export function closeWindow(): void {
  mainWindow?.close()
}

export function isWindowVisible(): boolean {
  return mainWindow?.isVisible() ?? false
}

export function isWindowMaximized(): boolean {
  return mainWindow?.isMaximized() ?? false
}

export function isWindowMinimized(): boolean {
  return mainWindow?.isMinimized() ?? false
}

export function loadUrl(url: string): Promise<void> {
  return mainWindow?.loadURL(url) ?? Promise.resolve()
}

export function loadFile(filePath: string): Promise<void> {
  return mainWindow?.loadFile(filePath) ?? Promise.resolve()
}

export function reloadWindow(): void {
  mainWindow?.reload()
}

export function openDevTools(): void {
  mainWindow?.webContents.openDevTools()
}

export function closeDevTools(): void {
  mainWindow?.webContents.closeDevTools()
}

export function toggleDevTools(): void {
  mainWindow?.webContents.toggleDevTools()
}
