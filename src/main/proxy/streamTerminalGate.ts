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

/** A provider may omit usage, but must not advertise untyped or negative
 * token counts as measured. Do not infer an absent count from text length. */
function hasMeasuredUsage(value: unknown): boolean {
  if (!isRecord(value)) return false
  return ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key =>
    Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
}

/** A successful HTTP 200 and a synthesized default choice are not enough. */
export function hasCompletedNonStreamAnswer(value: unknown): boolean {
  if (!isRecord(value) || value.error !== undefined || value.type === 'error' ||
      !Array.isArray(value.choices) || value.choices.length !== 1) return false
  if (value.usage !== undefined && value.usage !== null && !hasMeasuredUsage(value.usage)) {
    return false
  }
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
  // Tool result messages reference an individual tool_call_id. Two separate
  // calls sharing one ID cannot be addressed unambiguously by a client.
  if (Array.isArray(calls) && new Set(calls.map(call => call.id)).size !== calls.length) return false
  if (choice.finish_reason === 'tool_calls') return Array.isArray(calls) && calls.length > 0
  // Tool-call-only replies cannot be represented by a text finish_reason.
  if (calls !== undefined) return false
  return typeof content === 'string' && !!content.trim()
}

/** The public stop option is not understood by dedicated consumer-web
 * adapters. Normalize it once; route validation rejects empty members. */
export function getStopSequences(stop: string | string[] | null | undefined): string[] {
  return typeof stop === 'string' ? [stop] : Array.isArray(stop) ? stop : []
}

function findFirstStop(text: string, stops: readonly string[]): number {
  let earliest = -1
  for (const value of stops) {
    const index = text.indexOf(value)
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index
  }
  return earliest
}

/** Truncate only a verified completed assistant text answer. Preserve upstream
 * usage provenance and every other response field; no second provider effect. */
export function applyStopSequencesNonStream<T>(value: T, stops: readonly string[]): T {
  if (!stops.length || !isRecord(value) || !Array.isArray(value.choices) ||
      value.choices.length !== 1 || !isRecord(value.choices[0])) return value
  const choice = value.choices[0] as StreamRecord
  if (!isRecord(choice.message) || typeof choice.message.content !== 'string') return value
  const index = findFirstStop(choice.message.content, stops)
  if (index === -1) return value
  return {
    ...value,
    choices: [{
      ...choice,
      finish_reason: 'stop',
      message: { ...choice.message, content: choice.message.content.slice(0, index) },
    }],
  } as T
}

/** Incremental stop normalization BEFORE the strict terminal gate. Keep only
 * maxStopLength-1 characters uncommitted so a match spanning provider SSE
 * frames (including a split surrogate pair) cannot leak a suffix. Consume the
 * original transport through verified EOF: finding a stop is NOT permission
 * to invent [DONE], settle an account early or cancel a remote operation. */
export function createStopSequenceSseStream(
  upstream: Readable,
  stops: readonly string[],
): { stream: Transform; hasVerifiedEmptyAnswer: () => boolean } {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const keepTail = Math.max(0, ...stops.map(value => value.length - 1))
  let pendingFrame = ''
  let withheldText = ''
  let matched = false
  let publishedNonWhitespace = false
  const serialized = (body: unknown) => 'data: ' + JSON.stringify(body) + '\n\n'

  const stream = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      try {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        if (!Buffer.isBuffer(bytes)) throw new Error('Invalid stop input')
        pendingFrame += decoder.decode(bytes, { stream: true })
        while (true) {
          const separator = /\r?\n\r?\n/.exec(pendingFrame)
          if (!separator) break
          const frame = pendingFrame.slice(0, separator.index)
          pendingFrame = pendingFrame.slice(separator.index + separator[0].length)
          if (frame.length > MAX_SSE_EVENT_CHARS) throw new Error('Oversized stop frame')
          if (!frame) continue
          const lines = frame.split(/\r?\n/)
          // The stop normalizer is not a protocol sanitizer. Never erase an
          // unknown SSE field or a non-message event by reserializing only its
          // data field: that would turn an invalid provider stream into a
          // false successful completion at the downstream strict gate.
          const invalidMetadata = lines.some(line => {
            if (!line || line.startsWith(':')) return false
            const colon = line.indexOf(':')
            const name = colon === -1 ? line : line.slice(0, colon)
            const rawValue = colon === -1 ? '' : line.slice(colon + 1)
            const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
            return (name !== 'data' && name !== 'event' &&
              name !== 'id' && name !== 'retry') ||
              (name === 'event' && value !== 'message')
          })
          if (invalidMetadata) {
            this.push(frame + '\n\n')
            continue
          }
          const dataLines = lines.filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
          const data = dataLines.join('\n')
          if (dataLines.length === 0 || data === '[DONE]') {
            this.push(frame + '\n\n')
            continue
          }
          let body: unknown
          try { body = JSON.parse(data) } catch {
            // Preserve malformed/error frames for the strict gate to reject;
            // never silently repair an upstream terminal.
            this.push(frame + '\n\n')
            continue
          }
          if (!isRecord(body) || !Array.isArray(body.choices) ||
              body.choices.length !== 1 || !isRecord(body.choices[0])) {
            this.push(frame + '\n\n')
            continue
          }
          const choice = body.choices[0] as StreamRecord
          const sourceDelta = isRecord(choice.delta) ? choice.delta :
            isRecord(choice.message) ? choice.message : null
          const hasFinish = choice.finish_reason !== undefined && choice.finish_reason !== null
          if ((hasFinish && !VALID_FINISH_REASONS.has(choice.finish_reason as string)) ||
              (sourceDelta && sourceDelta.role !== undefined &&
                sourceDelta.role !== 'assistant')) {
            // Preserve original terminal/role faults for the existing gate.
            this.push(frame + '\n\n')
            continue
          }
          if (hasFinish && matched && choice.finish_reason === 'tool_calls') {
            throw new Error('Stop cannot confirm a subsequent tool completion')
          }
          let delta = sourceDelta
          let safeContent: string | undefined
          if (delta && typeof delta.content === 'string') {
            if (!matched) {
              withheldText += delta.content
              const index = findFirstStop(withheldText, stops)
              if (index >= 0) {
                safeContent = withheldText.slice(0, index)
                withheldText = ''
                matched = true
              } else {
                const safeLength = Math.max(0, withheldText.length - keepTail)
                safeContent = withheldText.slice(0, safeLength)
                withheldText = withheldText.slice(safeLength)
              }
            } else {
              safeContent = ''
            }
            const { content: _untrusted, ...other } = delta
            delta = safeContent ? { ...other, content: safeContent } : other
            if (safeContent?.trim()) publishedNonWhitespace = true
          }
          const updatedChoice = {
            ...choice,
            ...(sourceDelta ? choice.delta !== undefined
              ? { delta } : { message: delta } : {}),
          }
          const output = { ...body, choices: [updatedChoice] }
          if (!hasFinish) {
            // Even a role-only or empty-content frame must remain visible to
            // the strict gate, which owns validation of the source protocol.
            this.push(serialized(output))
            continue
          }
          if (sourceDelta && typeof sourceDelta.content === 'string' && safeContent) {
            this.push(serialized({ ...output, choices: [{
              ...updatedChoice, finish_reason: null,
            }] }))
          }
          if (!matched && withheldText) {
            if (withheldText.trim()) publishedNonWhitespace = true
            this.push(serialized({ ...body, choices: [{
              ...choice, finish_reason: null,
              delta: { role: 'assistant', content: withheldText },
            }] }))
            withheldText = ''
          }
          const noText = sourceDelta && typeof sourceDelta.content === 'string'
            ? { ...delta, content: undefined } : delta
          this.push(serialized({ ...body, choices: [{
            ...choice,
            ...(sourceDelta ? choice.delta !== undefined
              ? { delta: noText } : { message: noText } : {}),
            finish_reason: matched && choice.finish_reason !== 'tool_calls'
              ? 'stop' : choice.finish_reason,
          }] }))
        }
        if (pendingFrame.length > MAX_SSE_EVENT_CHARS) throw new Error('Oversized stop input')
        callback()
      } catch {
        callback(new Error('Provider stop sequence stream invalid'))
      }
    },
    flush(callback) {
      try {
        const remaining = decoder.decode()
        if (remaining || (pendingFrame && !/^(?:\r?\n)*$/.test(pendingFrame))) {
          throw new Error('Unterminated stop frame')
        }
        callback()
      } catch {
        callback(new Error('Provider stop stream incomplete'))
      }
    },
  })
  upstream.once('error', () =>
    stream.destroy(new Error('Provider stop upstream failed')))
  upstream.once('close', () => {
    if (!upstream.readableEnded) {
      stream.destroy(new Error('Provider stop upstream closed prematurely'))
    }
  })
  stream.once('close', () => {
    if (!upstream.readableEnded && !upstream.destroyed) upstream.destroy()
  })
  upstream.pipe(stream)
  return {
    stream,
    hasVerifiedEmptyAnswer: () => matched && !publishedNonWhitespace,
  }
}

/**
 * @param upstream The already OpenAI-SSE-formatted stream from an adapter.
 * @param onTerminal Called exactly once: true for a verified completed answer,
 * false for an upstream error, malformed input, aborted transport or EOF
 * without verified termination. A failure says nothing about remote side
 * effects and MUST NOT trigger replay. A callback exception during confirmed
 * EOF means the local success could not be durably settled; no final [DONE]
 * may reach the caller in that case.
 */
export function createOpenAIStreamTerminalGate(
  upstream: Readable,
  onTerminal: (completed: boolean) => void,
  options?: {
    allowToolCalls?: boolean
    /** When an HTTP client declares tools, never promote an undeclared/other
     * forced name into a completed call. The original provider stream is not
     * trusted to have honored the public request contract. */
    acceptedToolNames?: readonly string[]
    requireToolCalls?: boolean
    /** A caller disabling parallel tool calls permits at most one final call. */
    maxToolCalls?: number
    /** True only after the stop normalizer observed and removed a real
     * sequence at the beginning of an originally nonempty assistant answer. */
    allowVerifiedEmptyStopAnswer?: () => boolean
    /** For a requested native tool-use format, convert fully assembled calls
     * before terminal acceptance and never publish unverified partial input. */
    formatNativeToolChunk?: (chunk: unknown) => unknown
  },
): Transform {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pendingText = ''
  let settled = false
  let sawAnswer = false
  // OpenAI may split a function name/arguments across multiple tool-call
  // deltas. Validate the *complete* call, never a lone arguments fragment.
  const toolCalls = new Map<number, {
    id: string; name: string; hasArguments: boolean; args: string
  }>()
  let sawFinish = false
  let sawDone = false
  let pendingFinish = ''
  let pendingUsage = ''
  let pendingNativeTools = ''
  // Tool deltas with a declared/forced selection remain private until their
  // assembled names and clean terminal have been checked and the exact account
  // settlement has committed. Do not publish a partial invalid tool request.
  const pendingConstrainedToolFrames: string[] = []
  let bufferedToolChars = 0

  const settle = (completed: boolean): boolean => {
    if (settled) return false
    settled = true
    try {
      onTerminal(completed)
      return true
    } catch {
      // Never reveal an exception from account/stat persistence in SSE output.
      return false
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
          // A final fully terminated *empty* SSE line is harmless. The
          // two-newline dispatcher may retain one LF/CRLF after [DONE],
          // including when a provider sends extra blank lines. Do not trim:
          // spaces, a dangling CR, a partial field and malformed UTF-8 must
          // still revoke completion instead of being silently discarded.
          const incompleteTail = pendingText !== '' && !/^(?:\r?\n)*$/.test(pendingText)
          if (remaining || incompleteTail || !sawFinish || !sawDone ||
              (!sawAnswer && toolCalls.size === 0 &&
                options?.allowVerifiedEmptyStopAnswer?.() !== true)) {
            fail()
          } else {
            // Success accounting is the final local acceptance condition.
            // Publish finish, usage and DONE only after its synchronous
            // callback has returned successfully; never send a false DONE
            // when local account persistence rejects the completed answer.
            if (!settle(true)) {
              this.push(TERMINAL_ERROR)
            } else {
              for (const frame of pendingConstrainedToolFrames) this.push(frame)
              if (pendingNativeTools) this.push(pendingNativeTools)
              if (pendingFinish) this.push(pendingFinish)
              if (pendingUsage) this.push(pendingUsage)
              this.push(TERMINAL_DONE)
            }
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
        !Array.isArray(body.choices) ||
        (body.usage !== undefined && body.usage !== null && !hasMeasuredUsage(body.usage))) {
      fail()
      return
    }
    if (body.choices.length === 0) {
      // A valid OpenAI usage-only record may follow the final finish chunk,
      // but cannot stand in for an answer or appear after [DONE].
      if (!sawFinish || sawDone || pendingUsage || !hasMeasuredUsage(body.usage)) {
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
        // Legacy text completions have no representation for native tool
        // calls. Reject them before the gate can settle an account success.
        if (options?.allowToolCalls === false) {
          fail()
          return
        }
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
          const state = toolCalls.get(index) ??
            { id: '', name: '', hasArguments: false, args: '' }
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
            if (typeof action.arguments === 'string' && options?.formatNativeToolChunk) {
              state.args += action.arguments
              if (state.args.length > MAX_SSE_EVENT_CHARS) {
                fail()
                return
              }
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
      const completedTools = [...toolCalls.values()]
      const validTools = completedTools.length > 0 &&
        completedTools.every(call => !!call.id.trim() &&
          !!call.name.trim() && call.hasArguments) &&
        new Set(completedTools.map(call => call.id)).size === completedTools.length
      if (reason === 'tool_calls' ? !validTools :
          toolCalls.size > 0 || (!sawAnswer && !(reason === 'stop' &&
            options?.allowVerifiedEmptyStopAnswer?.() === true))) {
        fail()
        return
      }
      if ((options?.requireToolCalls && reason !== 'tool_calls') ||
          (options?.maxToolCalls !== undefined &&
            toolCalls.size > options.maxToolCalls) ||
          (reason === 'tool_calls' && options?.acceptedToolNames &&
            [...toolCalls.values()].some(call =>
              !options.acceptedToolNames?.includes(call.name)))) {
        // A structurally complete answer must still honor the client's forced
        // or declared function selection before any charge or final DONE.
        fail()
        return
      }
      if (reason === 'tool_calls' && options?.formatNativeToolChunk) {
        // Native tool-use is defined over complete JSON objects. Do not
        // publish partial OpenAI arguments or settle a malformed native reply.
        const fullCalls: StreamRecord[] = []
        for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          try {
            const input: unknown = JSON.parse(call.args)
            if (!isRecord(input)) {
              fail()
              return
            }
          } catch {
            fail()
            return
          }
          fullCalls.push({
            index, id: call.id, type: 'function',
            function: { name: call.name, arguments: call.args },
          })
        }
        try {
          const prepared = options.formatNativeToolChunk({
            ...body,
            choices: [{
              ...choice,
              delta: { role: 'assistant', tool_calls: fullCalls },
              finish_reason: null,
            }],
          })
          if (!isRecord(prepared) || !Array.isArray(prepared.choices) ||
              prepared.choices.length !== 1 || !isRecord(prepared.choices[0]) ||
              !isRecord(prepared.choices[0].delta) ||
              !Array.isArray(prepared.choices[0].delta.content) ||
              prepared.choices[0].delta.content.length !== fullCalls.length ||
              !prepared.choices[0].delta.content.every((item: unknown) =>
                isRecord(item) && item.type === 'tool_use' &&
                typeof item.id === 'string' && typeof item.name === 'string' &&
                isRecord(item.input))) {
            fail()
            return
          }
          pendingNativeTools = 'data: ' + JSON.stringify(prepared) + '\n\n'
        } catch {
          fail()
          return
        }
      }
      sawFinish = true
      pendingFinish = serialized
      return
    }
    if (options?.formatNativeToolChunk && isRecord(delta) &&
        delta.tool_calls !== undefined) {
      // Never pass raw OpenAI tool fragments to a native tool-use consumer.
      // Preserve any independent text content if a provider combines both.
      if (typeof delta.content === 'string' && delta.content.length) {
        const { tool_calls: _toolCalls, ...textDelta } = delta
        gate.push('data: ' + JSON.stringify({
          ...body, choices: [{ ...choice, delta: textDelta }],
        }) + '\n\n')
      }
      return
    }
    if (options?.acceptedToolNames && isRecord(delta) &&
        delta.tool_calls !== undefined) {
      bufferedToolChars += serialized.length
      if (bufferedToolChars > MAX_SSE_EVENT_CHARS) {
        fail()
        return
      }
      pendingConstrainedToolFrames.push(serialized)
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
