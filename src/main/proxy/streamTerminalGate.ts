/**
 * OpenAI-compatible SSE completion gate.
 *
 * A stream existing, returning HTTP 200 or ending its transport is not proof
 * that a provider completed a model answer. Each provider can emit a partial
 * answer and fail later. Keep the final finish_reason and [DONE] private until
 * an actual upstream EOF confirms the whole stream was well formed.
 *
 * No network effects, retry, model dispatch or credential access exist here.
 */
import { Readable, Transform } from 'stream'

const MAX_SSE_EVENT_CHARS = 1_048_576
const TERMINAL_ERROR = 'data: {"error":{"message":"Upstream stream did not complete","type":"api_error","code":"provider_stream_incomplete"}}\n\n'
const TERMINAL_DONE = 'data: [DONE]\n\n'
const VALID_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls'])

type StreamRecord = Record<string, unknown>

function isRecord(value: unknown): value is StreamRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A successful HTTP 200 and a synthesized default choice are not enough. */
export function hasCompletedNonStreamAnswer(value: unknown): boolean {
  if (!isRecord(value) || value.error !== undefined || value.type === 'error' ||
      !Array.isArray(value.choices) || value.choices.length !== 1) return false
  const choice = value.choices[0]
  if (!isRecord(choice) || !VALID_FINISH_REASONS.has(choice.finish_reason as string) ||
      !isRecord(choice.message) || choice.message.role !== 'assistant' ||
      choice.message.error !== undefined || choice.error !== undefined) return false
  const content = choice.message.content
  const calls = choice.message.tool_calls
  if (calls !== undefined && (!Array.isArray(calls) || calls.length === 0 ||
      !calls.every((call: unknown) =>
        isRecord(call) && typeof call.id === 'string' && !!call.id.trim() &&
        (call.type === undefined || call.type === 'function') &&
        isRecord(call.function) && typeof call.function.name === 'string' &&
        !!call.function.name.trim() && typeof call.function.arguments === 'string' &&
        !!call.function.arguments.trim()))) return false
  if (choice.finish_reason === 'tool_calls') return Array.isArray(calls) && calls.length > 0
  // Tool-call-only replies cannot be represented by a text finish_reason.
  if (calls !== undefined) return false
  return typeof content === 'string' && !!content.trim()
}

/**
 * @param upstream The already OpenAI-SSE-formatted stream from an adapter.
 * @param onTerminal Called exactly once: true for a verified completed answer,
 * false for an upstream error, malformed input, aborted transport or EOF
 * without verified termination. A failure says nothing about remote side
 * effects and MUST NOT trigger replay.
 */
export function createOpenAIStreamTerminalGate(
  upstream: Readable,
  onTerminal: (completed: boolean) => void,
): Transform {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pendingText = ''
  let settled = false
  let sawAnswer = false
  // OpenAI may split a function name/arguments across multiple tool-call
  // deltas. Validate the *complete* call, never a lone arguments fragment.
  const toolCalls = new Map<number, { id: string, name: string, hasArguments: boolean }>()
  let sawFinish = false
  let sawDone = false
  let pendingFinish = ''
  let pendingUsage = ''

  const settle = (completed: boolean) => {
    if (settled) return
    settled = true
    try {
      onTerminal(completed)
    } catch {
      // Never reveal an exception from account/stat persistence in SSE output.
    }
  }

  const gate = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      if (settled) {
        callback()
        return
      }
      try {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        if (!Buffer.isBuffer(bytes)) {
          fail()
          callback()
          return
        }
        pendingText += decoder.decode(bytes, { stream: true })

        // Check each dispatched event separately, not a coalesced transport
        // chunk containing many individually small legal SSE frames.
        while (!settled) {
          const separator = /\r?\n\r?\n/.exec(pendingText)
          if (!separator) break
          const frame = pendingText.slice(0, separator.index)
          pendingText = pendingText.slice(separator.index + separator[0].length)
          if (frame.length > MAX_SSE_EVENT_CHARS) {
            fail()
            break
          }
          acceptFrame(frame)
        }
        if (!settled && pendingText.length > MAX_SSE_EVENT_CHARS) fail()
      } catch {
        fail()
      }
      callback()
    },
    flush(callback) {
      if (!settled) {
        try {
          const remaining = decoder.decode()
          // The transport may not end in a partial UTF-8 code point, an
          // unfinished SSE event or an unconfirmed final model message.
          if (remaining || pendingText || !sawFinish || !sawDone ||
              (!sawAnswer && toolCalls.size === 0)) {
            fail()
          } else {
            if (pendingFinish) this.push(pendingFinish)
            if (pendingUsage) this.push(pendingUsage)
            this.push(TERMINAL_DONE)
            settle(true)
          }
        } catch {
          fail()
        }
      }
      callback()
    },
  })

  const fail = () => {
    if (settled) return
    gate.push(TERMINAL_ERROR)
    settle(false)
    // A malformed frame must not leave a live upstream holding the downstream
    // HTTP connection open indefinitely. This cancels only the local stream;
    // it never retries or concludes that the remote operation did not happen.
    upstream.unpipe(gate)
    if (!gate.writableEnded) gate.end()
    if (!upstream.destroyed) upstream.destroy()
  }

  const acceptFrame = (frame: string) => {
    if (settled || frame.length === 0) return
    let eventName = ''
    const dataLines: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') dataLines.push(value)
      else if (field === 'event') eventName = value
      else if (field !== 'id' && field !== 'retry') {
        fail()
        return
      }
    }
    if (eventName && eventName !== 'message') {
      fail()
      return
    }
    if (dataLines.length === 0) return

    const data = dataLines.join('\n')
    if (data === '[DONE]') {
      if (sawDone || !sawFinish) fail()
      else sawDone = true
      return
    }
    let body: unknown
    try {
      body = JSON.parse(data)
    } catch {
      fail()
      return
    }
    if (!isRecord(body) || body.error !== undefined || body.type === 'error' ||
        !Array.isArray(body.choices)) {
      fail()
      return
    }
    if (body.choices.length === 0) {
      // A valid OpenAI usage-only record may follow the final finish chunk,
      // but cannot stand in for an answer or appear after [DONE].
      if (!sawFinish || sawDone || pendingUsage || !isRecord(body.usage)) {
        fail()
        return
      }
      // The final finish chunk is intentionally withheld until genuine EOF;
      // withhold the corresponding usage-only frame too. Otherwise consumers
      // observe usage before finish or count it despite a late failed stream.
      pendingUsage = 'data: ' + JSON.stringify(body) + '\n\n'
      return
    }
    if (sawDone || sawFinish) {
      // Model content after finish, including a late error, invalidates it.
      fail()
      return
    }
    if (body.choices.length !== 1 || !isRecord(body.choices[0])) {
      fail()
      return
    }
    const choice = body.choices[0] as StreamRecord
    if (choice.error !== undefined ||
        (body.object !== undefined && body.object !== 'chat.completion.chunk') ||
        (choice.index !== undefined && choice.index !== 0)) {
      fail()
      return
    }
    const delta = choice.delta ?? choice.message
    if (delta !== undefined && !isRecord(delta)) {
      fail()
      return
    }
    if (isRecord(delta)) {
      if ((delta.role !== undefined && delta.role !== 'assistant') ||
          delta.error !== undefined) {
        fail()
        return
      }
      const content = delta.content
      if (content !== undefined && content !== null && typeof content !== 'string') {
        fail()
        return
      }
      if (typeof content === 'string' && content.trim()) sawAnswer = true
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) {
          fail()
          return
        }
        for (const call of delta.tool_calls) {
          if (!isRecord(call) || !Number.isInteger(call.index) ||
              (call.index as number) < 0 ||
              (call.type !== undefined && call.type !== 'function') ||
              (call.id !== undefined && (typeof call.id !== 'string' || !call.id)) ||
              (call.function !== undefined && !isRecord(call.function))) {
            fail()
            return
          }
          const index = call.index as number
          const state = toolCalls.get(index) ?? { id: '', name: '', hasArguments: false }
          const action = call.function
          if (typeof call.id === 'string') {
            if (state.id && state.id !== call.id) {
              fail()
              return
            }
            state.id = call.id
          }
          if (isRecord(action)) {
            if ((action.name !== undefined && typeof action.name !== 'string') ||
                (action.arguments !== undefined && typeof action.arguments !== 'string')) {
              fail()
              return
            }
            if (typeof action.name === 'string') state.name += action.name
            if (typeof action.arguments === 'string' && action.arguments.trim()) {
              state.hasArguments = true
            }
          }
          if (state.name.length > 256 || state.id.length > 256 ||
              (toolCalls.size >= 128 && !toolCalls.has(index))) {
            fail()
            return
          }
          toolCalls.set(index, state)
        }
      }
    }

    const reason = choice.finish_reason
    const serialized = 'data: ' + JSON.stringify(body) + '\n\n'
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string' || !VALID_FINISH_REASONS.has(reason)) {
        fail()
        return
      }
      const validTools = toolCalls.size > 0 &&
        [...toolCalls.values()].every(call => !!call.id.trim() &&
          !!call.name.trim() && call.hasArguments)
      if (reason === 'tool_calls' ? !validTools : toolCalls.size > 0 || !sawAnswer) {
        fail()
        return
      }
      sawFinish = true
      pendingFinish = serialized
      return
    }
    gate.push(serialized)
  }

  const abort = () => {
    if (settled) return
    fail()
    upstream.unpipe(gate)
    gate.end()
  }
  upstream.once('error', abort)
  upstream.once('close', () => {
    if (!upstream.readableEnded) abort()
  })
  gate.once('close', () => {
    if (settled) return
    settle(false)
    upstream.unpipe(gate)
    if (!upstream.destroyed) upstream.destroy()
  })
  upstream.pipe(gate)
  return gate
}
