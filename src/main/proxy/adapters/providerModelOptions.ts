export interface DeepSeekChatOptionInput {
  model: string
  originalModel?: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const aliasLower = (request.originalModel ?? request.model).toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = aliasLower.includes('search')
  const isThinkingAlias = aliasLower.includes('think')
    || aliasLower.includes('r1')
    || aliasLower.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_K2D6' | 'SCENARIO_CHAT'

export function resolveKimiScenario(model: string): KimiScenario {
  const modelLower = model.toLowerCase()
  const modelId = modelLower.trim()
  if (modelId === 'k3-agent' || modelId === 'k28-agent-preview') {
    throw new Error('Kimi agent models are not supported by the chat adapter.')
  }

  // Public model settings bind this exact ID to SCENARIO_CHAT.
  // Catalog discovery alone does not verify live ChatService compatibility.
  if (model === 'k2d6-chat') return 'SCENARIO_CHAT'

  return modelLower.includes('k2.6') ? 'SCENARIO_K2D6' : 'SCENARIO_K2D5'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
}) {
  const scenario = resolveKimiScenario(options.model)

  return {
    scenario,
    chat_id: '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
