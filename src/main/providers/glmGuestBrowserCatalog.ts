import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'crypto'
import type { ProviderModelCatalog } from './modelCatalog'
import { parseGLMGuestWebModelCatalog } from './glmGuestWebModelCatalog'

const GUEST_PAGE = 'https://chatglm.cn/main/alltoolsdetail?lang=zh'
const ALLOWED_ORIGIN = 'https://chatglm.cn'
const LOAD_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 15_000
const MAX_RESULT_LENGTH = 64 * 1024

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GLM guest website catalog timed out')), milliseconds)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function sameOrigin(target: string): boolean {
  try {
    const url = new URL(target)
    return url.origin === ALLOWED_ORIGIN && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * Read first-party public guest website selector without accessing the
 * user's saved GLM account, refresh token, Chrome cookies, or Electron
 * sessionData.  Visiting the website can initialize an ephemeral guest
 * session *inside the isolated memory partition*; caller/UI must obtain
 * explicit permission for that behavior before invoking this function.
 *
 * The first-party website performs its own signed GET /available_models;
 * the app reads ONLY the public picker model descriptors, never credentials
 * or arbitrary page state. Failure leaves the previous models untouched.
 */
export async function fetchGLMGuestBrowserCatalog(): Promise<ProviderModelCatalog> {
  // No "persist:" prefix: unique, in-memory Electron partition, not shared
  // with user login windows, local credentials or the default browser.
  const partition = `glm-public-catalog-${randomUUID()}`
  const isolatedSession = session.fromPartition(partition)
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    // The first-party site defers its Vue model picker in fully hidden
    // windows. The user has already consented to opening this temporary
    // first-party guest browser; show it without borrowing any existing
    // browser session or profile.
    show: true,
    width: 800,
    height: 600,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      javascript: true,
      backgroundThrottling: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!sameOrigin(target)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, target) => {
    if (!sameOrigin(target)) event.preventDefault()
  })

  let failureStage = 'page-load'
  try {
    await timeout(window.loadURL(GUEST_PAGE), LOAD_TIMEOUT_MS)
    failureStage = 'same-origin'
    if (!sameOrigin(window.webContents.getURL())) throw new Error('GLM public guest website origin changed')

    // Wait only for the first-party Vuex action to mount. Avoid repeatedly
    // sending GETs on an authentication failure, timeout or site change.
    const readyExpression = `(() => {
      const store = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store
      return !!(store && typeof store.dispatch === 'function' &&
        store._actions && store._actions['Home/GetAvailableModels'])
    })()`
    let ready = false
    failureStage = 'first-party-action'
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        // The first-party SPA may navigate its main frame after loadURL
        // resolves. executeJavaScript can reject while that frame is being
        // replaced; this is not a catalog/authentication failure yet.
        ready = await timeout(window.webContents.executeJavaScript(readyExpression), 1_000) === true
      } catch {
        ready = false
      }
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ready || !sameOrigin(window.webContents.getURL())) {
      // Only inspect authored boolean state of the official page: no DOM
      // text, account info, tokens, cookies, request headers or storage.
      const state = await timeout(window.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('#app')
        if (!root) return 'no-app-root'
        if (!root.__vue_app__) return 'no-vue-mount'
        const store = root.__vue_app__.config?.globalProperties?.$store
        if (!store) return 'no-store'
        return 'no-action'
      })()`), 1_000).catch(() => 'evaluate-failed')
      if (typeof state === 'string' &&
          ['no-app-root', 'no-vue-mount', 'no-store', 'no-action', 'evaluate-failed'].includes(state)) {
        failureStage = state
      }
      throw new Error('GLM first-party guest website catalog action unavailable')
    }

    // Call only this fixed read-only action from the official first-party
    // site's own web client ONCE. It signs its own catalog GET. We do not
    // read its token, localStorage, cookies, profile or user information.
    const expression = `(async () => {
      const root = document.querySelector('#app')
      const app = root && root.__vue_app__
      const store = app && app.config && app.config.globalProperties &&
        app.config.globalProperties.$store
      if (!store || typeof store.dispatch !== 'function' ||
          !store._actions || !store._actions['Home/GetAvailableModels']) {
        return null
      }
      const result = await store.dispatch('Home/GetAvailableModels')
      if (!result || typeof result !== 'object' || !result.default ||
          !Array.isArray(result.models) || result.models.length < 1 ||
          result.models.length > 100) return null
      return JSON.stringify({
        status: 0,
        result: {
          default: {},
          models: result.models.map(model => ({
            display_name: model.display_name,
            selected_model: model.selected_model,
            chat_switch: model.chat_switch,
          })),
        },
      })
    })()`

    failureStage = 'first-party-response'
    const result: unknown = await timeout(window.webContents.executeJavaScript(expression), ACTION_TIMEOUT_MS)
    if (typeof result !== 'string' || result.length > MAX_RESULT_LENGTH) {
      throw new Error('GLM public guest model selector unavailable')
    }
    failureStage = 'model-schema'
    return parseGLMGuestWebModelCatalog(JSON.parse(result))
  } catch {
    // A first-party page, Axios error or Electron exception may echo request
    // headers. Never return/log its raw error or cause. The phase is authored
    // only by this module and contains no web response or credentials.
    throw new Error(`GLM_GUEST_CATALOG_${failureStage}`)
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
