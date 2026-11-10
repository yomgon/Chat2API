import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  createKimiChatPayload,
  encodeKimiGrpcFrame,
  resolveKimiScenario,
} from '../../src/main/proxy/adapters/providerModelOptions.ts'

// Public GetAvailableModels entries supplied by prime on 2026-11-08.
// These fixtures verify local serialization only, not live ChatService acceptance.
const CHAT_MODEL = Object.freeze({
  id: 'k2d6-chat', key: 'k2d6', displayName: 'Instant', scenario: 'SCENARIO_CHAT',
})
const AGENT_IDS = ['k3-agent', 'k28-agent-preview']
const ERROR_MESSAGE = 'Kimi agent models are not supported by the chat adapter.'

function assertAgentRejected(operation, forbidden = []) {
  assert.throws(operation, error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, ERROR_MESSAGE)
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['message', 'stack'])
    const rendered = inspect(error, { showHidden: true })
    for (const value of forbidden) assert.equal(rendered.includes(value), false)
    return true
  })
}

test('the exact public Kimi chat ID uses its server-declared scenario', () => {
  assert.equal(resolveKimiScenario(CHAT_MODEL.id), CHAT_MODEL.scenario)
})

test('Kimi web chat payload and frame preserve both scenarios, content, and feature flags', () => {
  for (const enableWebSearch of [false, true]) {
    for (const enableThinking of [false, true]) {
      const input = Object.freeze({
        model: CHAT_MODEL.id,
        content: 'Synthetic chat content: 안녕하세요 🌙',
        enableWebSearch,
        enableThinking,
      })
      const expected = {
        scenario: CHAT_MODEL.scenario,
        chat_id: '',
        tools: enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
        message: {
          parent_id: '',
          role: 'user',
          blocks: [{ message_id: '', text: { content: input.content } }],
          scenario: CHAT_MODEL.scenario,
        },
        options: { thinking: enableThinking },
      }
      const payload = createKimiChatPayload(input)
      assert.deepEqual(payload, expected)
      const frame = encodeKimiGrpcFrame(payload)
      assert.equal(frame.readUInt8(0), 0)
      assert.equal(frame.readUInt32BE(1), Buffer.byteLength(JSON.stringify(expected), 'utf8'))
      assert.equal(frame.length, 5 + frame.readUInt32BE(1))
      assert.deepEqual(JSON.parse(frame.subarray(5).toString('utf8')), expected)
    }
  }
})

test('legacy Kimi names and feature aliases retain their prior scenarios', () => {
  for (const [model, scenario] of [
    ['Kimi-K2.6', 'SCENARIO_K2D6'],
    ['kimi-k2.6', 'SCENARIO_K2D6'],
    ['KiMi-K2.6-Think-Search', 'SCENARIO_K2D6'],
    ['Kimi-K2.5', 'SCENARIO_K2D5'],
    ['kimi-k2.5-search', 'SCENARIO_K2D5'],
    ['kimi', 'SCENARIO_K2D5'],
    ['moonshot-v1-8k', 'SCENARIO_K2D5'],
  ]) {
    assert.equal(resolveKimiScenario(model), scenario)
    const payload = createKimiChatPayload({
      model, content: 'Synthetic legacy chat', enableWebSearch: false, enableThinking: false,
    })
    assert.equal(payload.scenario, scenario)
    assert.equal(payload.message.scenario, scenario)
  }
})

test('catalog keys, labels, and near matches do not acquire the exact web ID mapping', () => {
  for (const model of [
    CHAT_MODEL.key, CHAT_MODEL.displayName, 'K2D6-CHAT',
    'k2d6-chat-preview', 'prefix-k2d6-chat', 'k2d6-chat-think-search',
    ' k2d6-chat', 'k2d6-chat ',
  ]) {
    assert.equal(resolveKimiScenario(model), 'SCENARIO_K2D5')
  }
})

test('explicit Kimi agent IDs fail before legacy scenario fallback and payload creation', () => {
  for (const model of AGENT_IDS) {
    assertAgentRejected(() => resolveKimiScenario(model), [model])
    for (const enableWebSearch of [false, true]) {
      for (const enableThinking of [false, true]) {
        const marker = 'synthetic-private-content-DO-NOT-LOG'
        assertAgentRejected(() => createKimiChatPayload({
          model, content: marker, enableWebSearch, enableThinking,
        }), [model, marker])
      }
    }
  }
})

test('agent rejection does not read content or feature options', () => {
  for (const model of AGENT_IDS) {
    let reads = 0
    const input = { model }
    for (const key of ['content', 'enableWebSearch', 'enableThinking']) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() { reads++; throw new Error('synthetic-private-getter') },
      })
    }
    assertAgentRejected(() => createKimiChatPayload(input), [model, 'synthetic-private-getter'])
    assert.equal(reads, 0)
  }
})

test('agent denial covers casing and padding without logging request data', context => {
  const output = []
  const intercepted = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map(method =>
    context.mock.method(console, method, (...args) => { output.push(args) }))
  try {
    for (const id of AGENT_IDS) {
      for (const model of [id.toUpperCase(), ` ${id} `, `\t${id.toUpperCase()}\n`]) {
        assertAgentRejected(() => resolveKimiScenario(model), [id, model])
        assertAgentRejected(() => createKimiChatPayload({
          model, content: 'synthetic-private-input', enableWebSearch: true, enableThinking: true,
        }), [id, model, 'synthetic-private-input'])
      }
    }
  } finally {
    for (const interceptedMethod of intercepted) interceptedMethod.mock.restore()
  }
  assert.deepEqual(output, [])
  assert.equal(resolveKimiScenario(CHAT_MODEL.id), CHAT_MODEL.scenario)
})
