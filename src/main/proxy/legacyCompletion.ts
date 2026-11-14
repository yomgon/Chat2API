/**
 * The legacy /v1/completions wire format is text_completion, not chat.completion.
 * Only reframe verified text answers; never fabricate usage or model completion.
 */
import { Readable, Transform } from 'stream'
import type { ChatCompletionResponse } from './types'

const MAX_FRAME = 1_048_576

export function toLegacyCompletion(
  response: ChatCompletionResponse,
  id: string,
  model: string,
) {
  const choice = response.choices[0]
  const completed = {
    id,
    object: 'text_completion' as const,
    created: typeof response.created === 'number' ? response.created : Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, text: choice.message!.content, logprobs: null, finish_reason: choice.finish_reason }],
  }
  // An absent usage field stays absent, instead of being presented as measured
  // or invented token counts. Preserve only the original forwarder provenance.
  return response.usage === undefined ? completed : { ...completed, usage: response.usage }
}

/**
 * Input is the verified chat-SSE terminal gate, which alone may publish DONE.
 * A transport cancellation of this downstream Transform destroys the upstream
 * gate as well, so the owning API route records an unconfirmed operation.
 */
export function createLegacyCompletionStream(
  chatStream: Readable,
  id: string,
  model: string,
): Transform {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let sawDone = false

  const transform = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      try {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        pending += decoder.decode(bytes, { stream: true })
        while (true) {
          const separator = /\r?\n\r?\n/.exec(pending)
          if (!separator) break
          const frame = pending.slice(0, separator.index)
          pending = pending.slice(separator.index + separator[0].length)
          if (frame.length > MAX_FRAME || sawDone) throw new Error('Invalid legacy stream frame')
          if (!frame) continue
          const dataLines = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          if (dataLines.length === 0) throw new Error('Invalid legacy stream event')
          const data = dataLines.map(line => line.slice(5).replace(/^ /, '')).join('\n')
          if (data === '[DONE]') {
            sawDone = true
            this.push('data: [DONE]\n\n')
            continue
          }
          const event = JSON.parse(data) as Record<string, unknown>
          if (event.error) {
            // Fixed error events are emitted by the terminal gate, never a
            // raw provider exception/credential/response body.
            this.push('data: ' + JSON.stringify(event) + '\n\n')
            continue
          }
          if (!Array.isArray(event.choices)) throw new Error('Invalid legacy choices')
          if (event.choices.length === 0) {
            if (!event.usage) throw new Error('Invalid legacy usage')
            this.push('data: ' + JSON.stringify({ id, object: 'text_completion',
              created: event.created ?? Math.floor(Date.now() / 1000), model,
              choices: [], usage: event.usage }) + '\n\n')
            continue
          }
          if (event.choices.length !== 1) throw new Error('Invalid legacy choice count')
          const choice = event.choices[0] as Record<string, unknown>
          // The verified chat terminal gate accepts either an incremental
          // `delta` or an assistant `message` frame. Legacy consumers still
          // need plain text, not the original chat-specific envelope.
          const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
          if (delta?.tool_calls !== undefined) {
            throw new Error('Unsupported legacy tool response')
          }
          this.push('data: ' + JSON.stringify({ id, object: 'text_completion',
            created: event.created ?? Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, text: delta?.content ?? '', logprobs: null,
              finish_reason: choice.finish_reason ?? null }] }) + '\n\n')
        }
        if (pending.length > MAX_FRAME) throw new Error('Oversized legacy frame')
        callback()
      } catch {
        callback(new Error('Legacy completion stream conversion failed'))
      }
    },
    flush(callback) {
      try {
        const remainder = decoder.decode()
        if (remainder || (pending && !/^(?:\r?\n)*$/.test(pending))) {
          throw new Error('Incomplete legacy stream frame')
        }
        callback()
      } catch {
        callback(new Error('Legacy completion stream conversion failed'))
      }
    },
  })

  chatStream.once('error', () => transform.destroy(new Error('Legacy completion upstream closed')))
  transform.once('close', () => {
    if (!transform.readableEnded && !chatStream.destroyed) chatStream.destroy()
  })
  chatStream.pipe(transform)
  return transform
}
