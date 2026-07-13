import type { MemoryNode } from './types'

const KEY_ALIASES: Record<string, string> = {
  avoid_food: 'avoid_ingredient',
  disliked_ingredient: 'avoid_ingredient',
  excluded_ingredient: 'avoid_ingredient',
  preferred_food: 'preferred_ingredient',
  taste_profile: 'flavor_profile',
}

export interface NormalizeMemoryNodeInput {
  draft: Partial<MemoryNode>
  now?: string
}

export type NormalizeMemoryNodeResult =
  | { accepted: true; node: Omit<MemoryNode, 'id'> }
  | { accepted: false; reason: string }

export function normalizeMemoryKey(key: string | undefined): string | undefined {
  const normalized = key?.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) return undefined
  return KEY_ALIASES[normalized] || normalized
}

export function memoryConflictKey(node: Pick<MemoryNode, 'key' | 'valueJson'>): string | undefined {
  if (!node.key) return undefined
  if (node.key === 'avoid_ingredient' || node.key === 'preferred_ingredient') {
    const subject = typeof node.valueJson === 'string'
      ? node.valueJson
      : node.valueJson && typeof node.valueJson === 'object' && !Array.isArray(node.valueJson)
        ? (node.valueJson as Record<string, unknown>).ingredient
        : undefined
    if (subject != null && String(subject).trim()) {
      return `${node.key}\u0000${String(subject).trim().toLowerCase()}`
    }
  }
  return node.key
}

export function normalizeMemoryNode(input: NormalizeMemoryNodeInput): NormalizeMemoryNodeResult {
  const { draft } = input
  const now = input.now || new Date().toISOString()
  const key = normalizeMemoryKey(draft.key)

  const title = String(draft.title || '').trim()
  const content = String(draft.content || '').trim()
  if (!title || !content) return { accepted: false, reason: 'Memory title and content are required.' }

  const expiresAt = optionalIsoDate(draft.expiresAt)
  if (draft.expiresAt && !expiresAt) return { accepted: false, reason: 'expiresAt must be an ISO date.' }
  return {
    accepted: true,
    node: {
      parentId: draft.parentId,
      supersedesId: draft.supersedesId,
      key,
      valueJson: normalizeValue(key, draft.valueJson),
      title,
      content,
      status: draft.status || 'active',
      confidence: clampScore(draft.confidence, 0.7),
      importance: clampScore(draft.importance, 0.6),
      sourceMessageIds: uniqueStrings(draft.sourceMessageIds || []),
      createdAt: draft.createdAt || now,
      updatedAt: now,
      expiresAt,
    },
  }
}

function normalizeValue(key: string | undefined, value: unknown): unknown {
  if (key === 'flavor_profile' && typeof value === 'string') {
    const output: Record<string, string> = {}
    if (/少油|低油|low oil/i.test(value)) output.oil = 'low'
    if (/少辣|微辣|low spic/i.test(value)) output.spicy = 'low'
    return Object.keys(output).length ? output : value.trim()
  }
  if (typeof value === 'string') return value.trim()
  return value
}

function optionalIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
}

function clampScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, Number(value)))
}
