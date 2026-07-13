const EXISTENCE_OPERATORS = new Set(['exists', 'not_exists'])

export function serializeWorkflowConditionValue(value: unknown): string {
  if (value === undefined) return ''
  const serialized = JSON.stringify(value)
  return serialized === undefined ? '' : serialized
}

export function parseWorkflowConditionValue(raw: string, operator: string): unknown {
  if (EXISTENCE_OPERATORS.has(operator)) return undefined
  const value = raw.trim()
  if (!value) throw new Error('workflow condition value must be valid JSON')
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('workflow condition value must be valid JSON')
  }
}

export function workflowConditionNeedsValue(operator: string): boolean {
  return !EXISTENCE_OPERATORS.has(operator)
}
