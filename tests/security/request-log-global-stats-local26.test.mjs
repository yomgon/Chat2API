import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Actual TSX consumers, synthetic hooks/IPC only. No Electron, user profile,
// renderer store, provider client, sockets, browser or real timers are loaded.
const root = new URL('../../', import.meta.url)
const uiDir = 'src/renderer/src/components/logs/'
const translations = JSON.parse(readFileSync(new URL('src/renderer/src/i18n/locales/en-US.json', root), 'utf8'))
const compilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
}
const compiled = Object.fromEntries(['RequestLogList', 'RequestLogStats'].map(name => {
  const fileName = uiDir + name + '.tsx'
  const source = readFileSync(new URL(fileName, root), 'utf8')
  const result = ts.transpileModule(source, { fileName, compilerOptions, reportDiagnostics: true })
  assert.deepEqual(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [])
  return [name, result.outputText]
}))
const SECRET = 'SYNTHETIC_PRIVATE_IPC_ERROR_LOCAL26'
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const t = (key, fallback) => {
  const value = key.split('.').reduce((node, part) => node?.[part], translations)
  return typeof value === 'string' ? value
    : typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
}
const today = (totalRequests = 6, successRequests = 1, failedRequests = 5) => Object.freeze({
  date: '2026-11-10', totalRequests, successRequests, failedRequests,
  totalLatency: 0, modelUsage: {}, providerUsage: {},
})
const row = (id, status = 'success') => ({
  id, timestamp: 1, status, statusCode: status === 'success' ? 200 : 502,
  method: 'POST', url: '/v1/chat/completions', model: 'Synthetic-' + id,
  providerId: 'synthetic', responseStatus: 200, latency: 1, isStream: false,
})
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function harness(options = {}) {
  const state = {
    today: today(), rows: [], config: { requestLogConfig: { enabled: false } },
    retained: { total: 0, success: 0, error: 0, todayTotal: 0, todaySuccess: 0, todayError: 0 },
    ...options,
  }
  const calls = [], diagnostics = [], forbidden = [], slots = [], effects = [], intervals = new Map()
  let cursor = 0, dirty = true, tree, intervalId = 0
  const deny = name => { forbidden.push(name); throw new Error('Forbidden synthetic boundary: ' + name) }
  const invoke = (name, implementation) => async (...args) => {
    calls.push({ name, args })
    return implementation(...args)
  }
  const read = value => {
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value() : value
  }
  const api = {
    requestLogs: {
      get: invoke('requestLogs.get', filter => {
        const rows = read(state.rows)
        return filter.status ? rows.filter(item => item.status === filter.status) : rows
      }),
      getStats: invoke('requestLogs.getStats', () => read(state.retained)),
      clear: invoke('requestLogs.clear', () => { state.rows = [] }),
    },
    statistics: options.noStatistics ? undefined : {
      getToday: options.noGetToday ? undefined : invoke('statistics.getToday', () => read(state.today)),
    },
    config: options.noConfig ? undefined : {
      get: invoke('config.get', () => read(state.config)),
      update: () => deny('config.update'),
    },
  }
  const window = {
    electronAPI: new Proxy(api, { get(target, name) {
      if (!(name in target)) return deny('electronAPI.' + String(name))
      return target[name]
    } }),
    addEventListener() {}, removeEventListener() {},
  }
  function memo(factory, deps) {
    const index = cursor++
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps }
    return slots[index].value
  }
  const react = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true }
      }]
    },
    useRef: initial => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) {
        slots[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => {
          slots[index].cleanup?.()
          slots[index].cleanup = callback()
        })
      }
    },
  }
  const inert = {
    '@/components/ui/badge': { Badge: 'Badge' },
    '@/components/ui/button': { Button: 'Button' },
    '@/components/ui/card': { Card: 'Card', CardContent: 'CardContent' },
    '@/components/ui/select': Object.fromEntries(
      ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map(name => [name, name])),
    '@/components/ui/dialog': {
      ...Object.fromEntries(['DialogContent', 'DialogDescription', 'DialogFooter',
        'DialogHeader', 'DialogTitle'].map(name => [name, name])),
      Dialog: ({ open, children }) => open ? jsx('Dialog', { children }) : null,
    },
    './RequestLogDetail': { RequestLogDetail: 'RequestLogDetail' },
    'lucide-react': Object.fromEntries(
      ['Trash2', 'TrendingUp', 'CheckCircle', 'XCircle', 'Activity'].map(name => [name, name])),
    '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
    'react-window': { List: props => jsx('VirtualList', {
      ...props, children: props.rowProps.logs.map((_, index) =>
        props.rowComponent({ ...props.rowProps, index, style: {} })),
    }) },
  }
  const modules = new Map()
  const context = vm.createContext({
    window,
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(name => [name,
      (...args) => diagnostics.push(args)])),
    setInterval(callback, delay) {
      assert.equal(delay, 3000)
      const id = ++intervalId
      intervals.set(id, callback)
      return id
    },
    clearInterval: id => intervals.delete(id),
  }, { codeGeneration: { strings: false, wasm: false } })
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const module = { exports: {} }
    const require = id => {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (id === 'react-i18next') return { useTranslation: () => ({ t }) }
      if (id === './RequestLogStats') return load('RequestLogStats')
      if (Object.hasOwn(inert, id)) return inert[id]
      return deny('import ' + id)
    }
    const factory = new vm.Script('(function(require,module,exports){' + compiled[name] + '\n})',
      { filename: uiDir + name + '.tsx' }).runInContext(context, { timeout: 1000 })
    factory(require, module, module.exports)
    modules.set(name, module.exports)
    return module.exports
  }
  const { RequestLogList } = load('RequestLogList')
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  function render() {
    cursor = 0
    dirty = false
    tree = expand(RequestLogList())
    while (effects.length) effects.shift()()
  }
  async function flush() {
    for (let i = 0; i < 30; i++) {
      if (dirty) render()
      await Promise.resolve()
    }
    if (dirty) render()
    assert.deepEqual(forbidden, [], 'Only allowlisted synthetic IPC/imports may be accessed')
  }
  const nodes = () => {
    const result = []
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== 'object') return
      result.push(node)
      visit(node.props.children)
    }
    visit(tree)
    return result
  }
  const textOf = node => Array.isArray(node) ? node.map(textOf).join(' ')
    : node == null || typeof node === 'boolean' ? ''
      : typeof node === 'object' ? textOf(node.props?.children) : String(node)
  const cardValues = () => nodes().filter(node => node.type === 'Card').map(card => {
    const content = card.props.children
    return textOf(content.props.children.find(node => node?.type === 'p'))
  })
  return {
    state, calls, diagnostics, flush, cardValues,
    text: () => textOf(tree),
    rows: () => nodes().find(node => node.type === 'VirtualList')?.props.rowProps.logs ?? [],
    count: name => calls.filter(call => call.name === name).length,
    async refresh() {
      await nodes().find(node => node.type === 'Button' && textOf(node) === t('dashboard.refresh')).props.onClick()
      await flush()
    },
    async filter(value) {
      nodes().find(node => node.type === 'Select').props.onValueChange(value)
      await flush()
    },
    async clear() {
      nodes().find(node => node.type === 'Button' && textOf(node) === t('logs.clearLogs')).props.onClick()
      await flush()
      const buttons = nodes().filter(node => node.type === 'Button' && textOf(node) === t('logs.clearLogs'))
      await buttons.at(-1).props.onClick()
      await flush()
    },
    async tick() { for (const callback of [...intervals.values()]) callback(); await flush() },
    unmount() { for (const slot of slots) slot?.cleanup?.(); assert.equal(intervals.size, 0) },
  }
}
const assertCards = (h, expected) => assert.deepEqual(h.cardValues(), expected)
const assertUnavailable = h => assertCards(h, Array(4).fill('Unavailable'))

test('logging OFF: real UI shows global 6/1/5 and 17%, with no fabricated rows or config writes', async () => {
  const h = harness()
  await h.flush()
  assertCards(h, ['6', '1', '5', '17%'])
  assert.equal(h.rows().length, 0)
  assert.match(h.text(), /No request logs/)
  assert.match(h.text(), /Persist Request Logs.*Disabled/)
  assert.ok(h.count('statistics.getToday') > 0)
  assert.equal(h.count('requestLogs.getStats'), 0)
  assert.equal(h.state.config.requestLogConfig.enabled, false)
  h.unmount()
})

test('retained rows, status filter and row cap do not determine global cards', async () => {
  const h = harness({ today: today(120, 90, 30), rows: [row('ok'), row('bad', 'error')],
    config: { requestLogConfig: { enabled: true } } })
  await h.flush()
  assertCards(h, ['120', '90', '30', '75%'])
  assert.equal(h.rows().length, 2)
  assert.doesNotMatch(h.text(), /Persist Request Logs.*Disabled/)
  await h.filter('error')
  assertCards(h, ['120', '90', '30', '75%'])
  assert.deepEqual(h.rows().map(item => item.id), ['bad'])
  assert.equal(h.calls.filter(call => call.name === 'requestLogs.get').at(-1).args[0].status, 'error')
  assert.ok(h.calls.filter(call => call.name === 'requestLogs.get').every(call => call.args[0].limit === 200))
  assert.equal(h.count('requestLogs.getStats'), 0)
})

test('clearing retained rows preserves global accounting and logging OFF', async () => {
  const h = harness({ rows: [row('retained')] })
  await h.flush()
  await h.clear()
  assert.equal(h.count('requestLogs.clear'), 1)
  assert.equal(h.rows().length, 0)
  assertCards(h, ['6', '1', '5', '17%'])
  assert.equal(h.state.config.requestLogConfig.enabled, false)
})

for (const [name, options] of [
  ['missing statistics API', { noStatistics: true }],
  ['missing getToday method', { noGetToday: true }],
  ['rejected getToday', { today: new Error(SECRET) }],
  ['absent reply', { today: undefined }],
  ['null reply', { today: null }],
  ['missing counters', { today: {} }],
  ['string counter', { today: today('6', 1, 5) }],
  ['negative counter', { today: today(-1, 1, 5) }],
  ['fractional counter', { today: today(6.5, 1, 5) }],
  ['nonfinite counter', { today: today(Infinity, 1, 5) }],
]) {
  test(name + ': visible Unavailable, retained rows still work, no secret reflection', async () => {
    const h = harness({ rows: [row('retained')], ...options })
    await h.flush()
    assertUnavailable(h)
    assert.equal(h.rows().length, 1)
    assert.doesNotMatch(h.text() + JSON.stringify(h.diagnostics), new RegExp(SECRET))
    assert.equal(h.count('requestLogs.getStats'), 0)
  })
}

test('a valid global zero remains a real zero, with a finite zero success rate', async () => {
  const h = harness({ today: today(0, 0, 0) })
  await h.flush()
  assertCards(h, ['0', '0', '0', '0%'])
})

test('pending initial accounting displays Loading rather than a fabricated zero', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const h = harness({ today: () => pending })
  await h.flush()
  assertCards(h, Array(4).fill('Loading...'))
  resolve(today())
  await h.flush()
  assertCards(h, ['6', '1', '5', '17%'])
})

test('periodic refresh replaces stale counts with Unavailable on failure and can recover locally', async () => {
  const h = harness()
  await h.flush()
  assertCards(h, ['6', '1', '5', '17%'])
  h.state.today = new Error(SECRET)
  await h.tick()
  assertUnavailable(h)
  h.state.today = today(7, 2, 5)
  await h.refresh()
  assertCards(h, ['7', '2', '5', '29%'])
  assert.doesNotMatch(JSON.stringify(h.diagnostics), new RegExp(SECRET))
})

for (const [name, options] of [
  ['missing config API', { noConfig: true }],
  ['rejected config', { config: new Error(SECRET) }],
  ['absent config', { config: undefined }],
  ['missing logging flag', { config: {} }],
  ['nonboolean logging flag', { config: { requestLogConfig: { enabled: 'false' } } }],
]) {
  test(name + ': keep ordinary empty state without asserting logging OFF', async () => {
    const h = harness(options)
    await h.flush()
    assertCards(h, ['6', '1', '5', '17%'])
    assert.match(h.text(), /No request logs/)
    assert.doesNotMatch(h.text(), /Persist Request Logs.*Disabled/)
    assert.doesNotMatch(h.text() + JSON.stringify(h.diagnostics), new RegExp(SECRET))
  })
}

test('unknown config after refresh removes a formerly confirmed OFF explanation', async () => {
  const h = harness()
  await h.flush()
  assert.match(h.text(), /Persist Request Logs.*Disabled/)
  h.state.config = new Error(SECRET)
  await h.refresh()
  assert.doesNotMatch(h.text(), /Persist Request Logs.*Disabled/)
})

test('UI reads only scalar accounting and logging flag, never unrelated config/statistics metadata', async () => {
  const counts = { totalRequests: 6, successRequests: 1, failedRequests: 5 }
  const config = { requestLogConfig: { enabled: false } }
  for (const [object, keys] of [[counts, ['modelUsage', 'providerUsage']], [config, ['apiKeys', 'managementApiSecret']]]) {
    for (const key of keys) Object.defineProperty(object, key, { enumerable: true, get() {
      assert.fail('Unrelated private field was read: ' + key)
    } })
    Object.freeze(object)
  }
  const h = harness({ today: counts, config })
  await h.flush()
  assertCards(h, ['6', '1', '5', '17%'])
  assert.match(h.text(), /Persist Request Logs.*Disabled/)
  for (const args of h.diagnostics) {
    assert.equal(args.length, 1)
    assert.equal(typeof args[0], 'string')
    assert.doesNotMatch(args[0], new RegExp(SECRET))
  }
})
