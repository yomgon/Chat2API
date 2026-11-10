import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeepSeekWebModelCatalog } from '../../src/main/providers/deepseekWebModelCatalog.ts'

// Observed anonymous web-setting structure, never a real user/token.
const sample = {
  code: 0,
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      settings: {
        model_configs: {
          id: 1356454870,
          value: [
            { model_type: 'default', name: '快速模式', enabled: true, switchable: true, is_default: true },
            { model_type: 'expert', name: '专家模式', enabled: false, switchable: false },
            { model_type: 'vision', name: '识图模式', enabled: false, switchable: false },
          ],
        },
      },
    },
  },
}

const clone = value => structuredClone(value)
function expectBad(value) {
  assert.throws(() => parseDeepSeekWebModelCatalog(value), e =>
    e instanceof Error && e.message === 'DeepSeek web model settings are invalid or unsupported.'
    && e.cause === undefined && !JSON.stringify(e).includes('user-token'),
  )
}

test('Actual public web-settings envelope exposes enabled DeepSeek chat modes only', () => {
  const before = clone(sample)
  const catalog = parseDeepSeekWebModelCatalog(sample)
  assert.deepEqual(catalog, { supportedModels: ['快速模式'], modelMappings: { '快速模式': 'default' } })
  assert.deepEqual(sample, before)
})

test('Expert becomes a valid wire mode only when enabled and switchable', () => {
  const x = clone(sample)
  x.data.biz_data.settings.model_configs.value[1].enabled = true
  x.data.biz_data.settings.model_configs.value[1].switchable = true
  const catalog = parseDeepSeekWebModelCatalog(x)
  assert.deepEqual(catalog.supportedModels, ['快速模式', '专家模式'])
  assert.equal(catalog.modelMappings['专家模式'], 'expert')
})

test('Non-chat vision, unrelated API model and unsupported flags never become proxy routes', () => {
  const x = clone(sample)
  x.data.biz_data.settings.model_configs.value[2].enabled = true
  x.data.biz_data.settings.model_configs.value[2].switchable = true
  x.data.biz_data.settings.model_configs.value.push({model_type:'deepseek-v4.1-flash',name:'API marketing model',enabled:true,switchable:true})
  assert.deepEqual(parseDeepSeekWebModelCatalog(x).supportedModels, ['快速模式'])
})

test('HTTP200 business failure and missing settings fail without guessing model ids', () => {
  for (const payload of [
    { code: 0, data: { biz_code: 2, biz_msg: 'INVALID_PARAM', biz_data: null } },
    { code: 0, data: { biz_code: 1, biz_msg: 'SETTINGS_NOT_FOUND', biz_data: null } },
    { code: 200, data: clone(sample.data) },
    {}, null, [], 'bad',
  ]) expectBad(payload)
})

test('No enabled/selectable chat mode and malformed fields never clear the saved catalog', () => {
  for (const mutation of [
    x => { x.data.biz_data.settings.model_configs.value[0].enabled = false },
    x => { x.data.biz_data.settings.model_configs.value[0].name = 'constructor' },
    x => { x.data.biz_data.settings.model_configs.value[0].name = 'secret\nInjected' },
    x => { x.data.biz_data.settings.model_configs.value[0].enabled = 'yes' },
    x => { x.data.biz_data.settings.model_configs.value[0].model_type = {} },
    x => { x.data.biz_data.settings.model_configs.value[0].switchable = null },
  ]) { const x=clone(sample); mutation(x);expectBad(x) }
})

test('Prototype-sensitive entries, sparse arrays, duplicate modes and oversized listings fail closed', () => {
  const polluted = clone(sample)
  Object.defineProperty(polluted.data.biz_data.settings.model_configs.value[0], '__proto__', {value:{malicious:true},enumerable:true})
  expectBad(polluted)
  const sparse = clone(sample)
  delete sparse.data.biz_data.settings.model_configs.value[1]
  expectBad(sparse)
  const dupe = clone(sample)
  dupe.data.biz_data.settings.model_configs.value.push({model_type:'default',name:'Quick',enabled:true,switchable:true})
  expectBad(dupe)
  const huge = clone(sample)
  huge.data.biz_data.settings.model_configs.value = Array.from({length:101},(_,i)=>({model_type:'unused'+i,name:'Unused'+i,enabled:false,switchable:false}))
  expectBad(huge)
})
