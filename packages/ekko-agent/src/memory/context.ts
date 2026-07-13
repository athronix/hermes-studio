import type { MemoryContext, MemoryNode } from './types'

export function buildMemoryContextPrompt(context: MemoryContext): string {
  if (!context.diagnostics.enabled || context.usedMemoryIds.length === 0 && !context.latestSummary) return ''
  const sections: string[] = []
  if (context.latestSummary) {
    sections.push(`Latest session summary:\n${context.latestSummary.summary}`)
  }
  appendNodes(sections, 'Relevant memories', context.relevantNodes)
  if (!sections.length) return ''
  return [
    '## Retrieved Memory',
    'Use these memories only when relevant. Newer memories override older conflicting information.',
    ...sections,
  ].join('\n\n')
}

function appendNodes(sections: string[], title: string, nodes: MemoryNode[]): void {
  if (!nodes.length) return
  sections.push(`${title}:\n${nodes.map(node => `- [${node.id}] ${node.content}`).join('\n')}`)
}
