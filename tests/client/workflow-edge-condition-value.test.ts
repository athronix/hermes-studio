import { describe, expect, it } from 'vitest'
import { parseWorkflowConditionValue, serializeWorkflowConditionValue } from '../../packages/client/src/utils/workflow-edge-condition'

describe('workflow edge condition values', () => {
  it('round-trips typed JSON operands without coercing them to strings', () => {
    expect(serializeWorkflowConditionValue(42)).toBe('42')
    expect(serializeWorkflowConditionValue(['ready', 2])).toBe('["ready",2]')
    expect(parseWorkflowConditionValue('42', 'greater_than')).toBe(42)
    expect(parseWorkflowConditionValue('["ready",2]', 'in')).toEqual(['ready', 2])
    expect(parseWorkflowConditionValue('true', 'equals')).toBe(true)
    expect(parseWorkflowConditionValue('"ready"', 'equals')).toBe('ready')
  })

  it('omits operands for existence operators', () => {
    expect(parseWorkflowConditionValue('ignored', 'exists')).toBeUndefined()
    expect(parseWorkflowConditionValue('ignored', 'not_exists')).toBeUndefined()
  })

  it('rejects malformed JSON operands instead of saving string fallbacks', () => {
    expect(() => parseWorkflowConditionValue('ready', 'equals')).toThrow('valid JSON')
    expect(() => parseWorkflowConditionValue('{', 'in')).toThrow('valid JSON')
  })
})
