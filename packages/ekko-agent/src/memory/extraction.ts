import type { MemoryExtraction, MemoryExtractionInput, MemoryExtractor, MemoryNode } from './types'

export class RuleBasedMemoryExtractor implements MemoryExtractor {
  async extract(input: MemoryExtractionInput): Promise<MemoryExtraction> {
    const userMessages = input.messages.filter(message => message.role === 'user' && message.content.trim())
    const nodes: MemoryExtraction['nodes'] = []
    for (const message of userMessages) {
      nodes.push(...extractUserMemories(message.content, message.id))
    }
    const latestUser = userMessages.at(-1)?.content.trim()
    const latestAssistant = input.messages.filter(message => message.role === 'assistant' && message.content.trim()).at(-1)?.content.trim()
    const summaryParts = [
      input.previousSummary?.summary,
      latestUser ? `User: ${truncate(latestUser, 240)}` : '',
      latestAssistant ? `Assistant: ${truncate(latestAssistant, 240)}` : '',
    ].filter(Boolean)
    return {
      summaryPatch: summaryParts.join('\n'),
      currentGoal: latestUser,
      nodes,
    }
  }
}

function extractUserMemories(content: string, sourceMessageId: string): MemoryExtraction['nodes'] {
  const output: MemoryExtraction['nodes'] = []
  const explicit = /记住|以后(?:都|请)?|长期|remember|from now on|always/i.test(content)
  const avoidMatch = content.match(/(?:不吃|不要|避免|别(?:再)?推荐)\s*([\p{Script=Han}A-Za-z0-9_-]{1,12})/u)
  if (avoidMatch) {
    output.push({
      operation: 'create',
      explicitUserIntent: explicit || /不吃|不要|避免/.test(content),
      reason: 'User expressed an ingredient avoidance preference.',
      node: cookingPreference({
        key: 'avoid_ingredient',
        valueJson: avoidMatch[1],
        title: `Avoid ${avoidMatch[1]}`,
        content: `When recommending food or recipes, avoid ${avoidMatch[1]}.`,
        tags: ['饮食偏好', '忌口'],
        entities: [avoidMatch[1]],
        sourceMessageIds: [sourceMessageId],
      }),
    })
  }
  if (/少油|少辣|低油|微辣/.test(content)) {
    const values: Record<string, string> = {}
    if (/少油|低油/.test(content)) values.oil = 'low'
    if (/少辣|微辣/.test(content)) values.spicy = 'low'
    output.push({
      operation: 'create',
      explicitUserIntent: explicit || /喜欢|偏好|要/.test(content),
      reason: 'User expressed a cooking flavor preference.',
      node: cookingPreference({
        key: 'flavor_profile',
        valueJson: values,
        title: 'Preferred flavor profile',
        content: `Prefer ${values.oil === 'low' ? 'low-oil' : ''}${values.oil && values.spicy ? ' and ' : ''}${values.spicy === 'low' ? 'low-spice' : ''} food recommendations.`,
        tags: ['饮食偏好', '口味'],
        entities: Object.keys(values),
        sourceMessageIds: [sourceMessageId],
      }),
    })
  }
  const correction = content.match(/([\p{Script=Han}A-Za-z0-9_-]{1,12})现在可以(?:接受)?(?:一点|少量)?/u)
  if (correction) {
    output.push({
      operation: 'supersede',
      explicitUserIntent: true,
      reason: 'User explicitly corrected a previous ingredient preference.',
      node: cookingPreference({
        type: 'correction',
        key: 'avoid_ingredient',
        valueJson: { ingredient: correction[1], tolerance: 'limited' },
        title: `Limited tolerance for ${correction[1]}`,
        content: `${correction[1]} is acceptable in small amounts, but should not be used heavily.`,
        tags: ['饮食偏好', '纠正'],
        entities: [correction[1]],
        sourceMessageIds: [sourceMessageId],
      }),
    })
  }
  if (explicit && output.length === 0) {
    const remembered = content.replace(/^(?:请)?(?:记住|remember(?: that)?)[，,:：\s]*/i, '').trim()
    if (remembered) {
      output.push({
        operation: 'create',
        explicitUserIntent: true,
        reason: 'User explicitly requested long-term retention.',
        node: {
          scope: 'user',
          domain: 'general',
          categoryPath: ['general'],
          type: 'fact',
          title: truncate(remembered, 80),
          content: remembered,
          confidence: 0.98,
          importance: 0.85,
          sourceMessageIds: [sourceMessageId],
        },
      })
    }
  }
  return output
}

function cookingPreference(overrides: Partial<MemoryNode>): Partial<MemoryNode> {
  return {
    scope: 'user',
    domain: '生活技能',
    categoryPath: ['生活技能', '做饭', '饮食偏好'],
    type: 'preference',
    confidence: 0.98,
    importance: 0.9,
    ...overrides,
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
