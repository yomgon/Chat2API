import type { RequestLogEntry } from '../store/types.ts'
import type { RequestLogConfig } from './types.ts'

export function sanitizeRequestLogEntry(
  entry: Omit<RequestLogEntry, 'id'>,
  config: RequestLogConfig,
): Omit<RequestLogEntry, 'id'> {
  const sanitized: Omit<RequestLogEntry, 'id'> = {
    ...entry,
    userInput: config.includeBodies
      ? sanitizeRequestLogBody(entry.userInput, config)
      : undefined,
    errorStack: undefined,
  }

  if (!config.includeBodies) {
    sanitized.requestBody = undefined
    sanitized.responseBody = undefined
    sanitized.responsePreview = undefined
    sanitized.errorMessage = sanitizeRequestLogError(entry.errorMessage, config)
    return sanitized
  }

  sanitized.requestBody = sanitizeRequestLogBody(entry.requestBody, config)
  sanitized.responseBody = sanitizeRequestLogBody(entry.responseBody, config)
  sanitized.responsePreview = sanitizeRequestLogBody(entry.responsePreview, config)
  sanitized.errorMessage = sanitizeRequestLogError(entry.errorMessage, config)

  return sanitized
}

export function sanitizeRequestLogUpdates(
  updates: Partial<RequestLogEntry>,
  config: RequestLogConfig,
): Partial<RequestLogEntry> {
  const sanitized: Partial<RequestLogEntry> = {
    ...updates,
    userInput: config.includeBodies
      ? sanitizeRequestLogBody(updates.userInput, config)
      : undefined,
    errorStack: undefined,
  }

  if (!config.includeBodies) {
    sanitized.requestBody = undefined
    sanitized.responseBody = undefined
    sanitized.responsePreview = undefined
    sanitized.errorMessage = sanitizeRequestLogError(updates.errorMessage, config)
    return sanitized
  }

  sanitized.requestBody = sanitizeRequestLogBody(updates.requestBody, config)
  sanitized.responseBody = sanitizeRequestLogBody(updates.responseBody, config)
  sanitized.responsePreview = sanitizeRequestLogBody(updates.responsePreview, config)
  sanitized.errorMessage = sanitizeRequestLogError(updates.errorMessage, config)

  return sanitized
}

export function trimRequestLogsToMaxEntries(
  entries: RequestLogEntry[],
  config: RequestLogConfig,
): RequestLogEntry[] {
  const maxEntries = Math.max(0, config.maxEntries)
  if (maxEntries === 0) {
    return []
  }

  if (entries.length <= maxEntries) {
    return entries
  }

  return entries.slice(entries.length - maxEntries)
}

function sanitizeRequestLogBody(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, config.maxBodyChars)
}

function sanitizeRequestLogError(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value
  return truncateText(redactSensitiveText(value), Math.min(config.maxBodyChars, 1000))
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value
  if (maxChars <= 0) return undefined
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`
}

function redactSensitiveText(value: string): string {
  return value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]').replace(
    /(\"?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|token)\"?\s*[:=]\s*)\"?[^\",}\]\s]+\"?/gi,
    '$1"[REDACTED]"',
  )
}
