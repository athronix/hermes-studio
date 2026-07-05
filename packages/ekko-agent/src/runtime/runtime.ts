import { randomUUID } from 'node:crypto'
import {
  createSystemMessage,
  createToolResultMessage,
  collectModelEvents,
  modelResponseToAgentMessage,
  normalizeAgentMessages,
} from '../model/messages'
import type { AgentOutputMessage } from '../model/messages'
import type { AgentMessage, AgentToolCall, ModelRequest, ModelResponse } from '../model/types'
import type { AgentSkill } from '../skills/types'
import { AgentToolRegistry, createDefaultToolRegistry } from '../tools/registry'
import type { AgentToolContext, AgentToolResult } from '../tools/types'
import type { AgentRuntimeEvent } from './events'
import { buildSystemPrompt } from './system-prompt'
import type { AgentRuntimeOptions, AgentRuntimeRunInput, AgentRuntimeRunResult, AgentRuntimeStep } from './types'

export const DEFAULT_AGENT_MAX_STEPS = 90
export const DEFAULT_AGENT_MODEL_MAX_RETRIES = 3
export const DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES = 6
export const DEFAULT_AGENT_TOOL_DELAY_MS = 1000

interface ModelResponseResult {
  response: ModelResponse
  emittedReasoning: boolean
}

export class AgentRuntime {
  private readonly modelClient: AgentRuntimeOptions['modelClient']
  private readonly tools: AgentToolRegistry
  private readonly skills: AgentSkill[]
  private readonly systemPrompt?: string
  private readonly runtimeInstructions: string[]
  private readonly maxSteps: number
  private readonly toolContext?: AgentToolContext
  private readonly modelDefaults?: AgentRuntimeOptions['modelDefaults']
  private readonly maxModelRetries: number
  private readonly maxConsecutiveToolFailures: number
  private readonly toolDelayMs: number

  constructor(options: AgentRuntimeOptions) {
    this.modelClient = options.modelClient
    this.tools = options.tools ?? createDefaultToolRegistry()
    this.skills = options.skills ?? []
    this.systemPrompt = options.systemPrompt
    this.runtimeInstructions = options.runtimeInstructions ?? []
    this.maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
    this.toolContext = options.toolContext
    this.modelDefaults = options.modelDefaults
    this.maxModelRetries = options.maxModelRetries ?? DEFAULT_AGENT_MODEL_MAX_RETRIES
    this.maxConsecutiveToolFailures = options.maxConsecutiveToolFailures ?? DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES
    this.toolDelayMs = options.toolDelayMs ?? DEFAULT_AGENT_TOOL_DELAY_MS
    this.registerSkillTools(this.skills)
  }

  registerSkill(skill: AgentSkill): void {
    this.skills.push(skill)
    this.registerSkillTools([skill])
  }

  registerSkills(skills: AgentSkill[]): void {
    for (const skill of skills) {
      this.registerSkill(skill)
    }
  }

  async refreshTools(): Promise<void> {
    await this.tools.refreshTools()
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    await this.refreshTools()

    const runId = randomUUID()
    const events: AgentRuntimeEvent[] = []
    const steps: AgentRuntimeStep[] = []
    const maxSteps = input.maxSteps ?? this.maxSteps
    const maxModelRetries = input.maxModelRetries ?? this.maxModelRetries
    const maxConsecutiveToolFailures = input.maxConsecutiveToolFailures ?? this.maxConsecutiveToolFailures
    const toolDelayMs = input.toolDelayMs ?? this.toolDelayMs
    const emit = (event: AgentRuntimeEvent) => {
      events.push(event)
      input.onEvent?.(event)
    }

    emit({ type: 'run.started', runId, maxSteps })

    const runSkills = [...this.skills, ...(input.skills ?? [])]
    this.registerSkillTools(input.skills ?? [])
    const messages = this.prepareMessages(input, runSkills)
    let output: AgentOutputMessage = {
      role: 'assistant',
      content: '',
    }
    let consecutiveToolFailures = 0

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        throwIfAborted(input.signal)
        emit({ type: 'model.started', runId, step })
        const modelResult = await this.createModelResponseWithRetries(
          this.modelRequest(input, messages),
          runId,
          step,
          maxModelRetries,
          emit,
        )
        const response = modelResult.response
        const assistantMessage = modelResponseToAgentMessage(response)
        output = assistantMessage
        messages.push(assistantMessage)
        steps.push({ type: 'model', step, message: assistantMessage })
        if (assistantMessage.reasoning && !modelResult.emittedReasoning) {
          emit({ type: 'model.reasoning', runId, step, text: assistantMessage.reasoning })
        }
        emit({ type: 'model.message', runId, step, message: assistantMessage })

        const toolCalls = assistantMessage.toolCalls ?? []
        if (toolCalls.length === 0) {
          emit({ type: 'run.completed', runId, output, steps: step })
          return { runId, messages, output, steps, events }
        }

        for (const toolCall of toolCalls) {
          throwIfAborted(input.signal)
          const result = await this.executeTool(
            runId,
            step,
            toolCall,
            this.runToolContext(input),
            emit,
            input.signal,
          )
          throwIfAborted(input.signal)
          messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name))
          steps.push({ type: 'tool', step, toolCallId: toolCall.id, toolName: toolCall.name, result })
          consecutiveToolFailures = result.ok ? 0 : consecutiveToolFailures + 1
          if (maxConsecutiveToolFailures > 0 && consecutiveToolFailures >= maxConsecutiveToolFailures) {
            emit({ type: 'run.tool_failure_limit', runId, failures: consecutiveToolFailures })
            output = {
              role: 'assistant',
              content: `Stopped after ${consecutiveToolFailures} consecutive tool failures.`,
              finishReason: 'tool_failure_limit',
            }
            emit({ type: 'run.completed', runId, output, steps: step })
            return { runId, messages, output, steps, events }
          }
          await delay(toolDelayMs, input.signal)
        }
      }

      emit({ type: 'run.max_steps', runId, maxSteps })
      output = {
        role: 'assistant',
        content: `Stopped after reaching maxSteps (${maxSteps}).`,
        finishReason: 'max_steps',
      }
      emit({ type: 'run.completed', runId, output, steps: maxSteps })
      return { runId, messages, output, steps, events }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'run.failed', runId, error: message, steps: steps.length })
      throw error
    }
  }

  private async createModelResponseWithRetries(
    request: ModelRequest,
    runId: string,
    step: number,
    maxRetries: number,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<ModelResponseResult> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        throwIfAborted(request.signal)
        if (request.stream && this.modelClient.capabilities.streaming) {
          return await this.streamModelResponse(request, runId, step, emit)
        }
        return {
          response: await this.modelClient.create(request),
          emittedReasoning: false,
        }
      } catch (error) {
        throwIfAborted(request.signal)
        if (attempt > maxRetries) throw error
        emit({
          type: 'model.retry',
          runId,
          step,
          retry: attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw new Error('Model request retry loop exited unexpectedly.')
  }

  private async streamModelResponse(
    request: ModelRequest,
    runId: string,
    step: number,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<ModelResponseResult> {
    let emittedReasoning = false
    const events = this.modelClient.stream({ ...request, stream: true })
    const output = await collectModelEvents((async function *streamAndEmit() {
      for await (const event of events) {
        if (event.type === 'text-delta') {
          emit({ type: 'model.delta', runId, step, text: event.text })
        } else if (event.type === 'reasoning-delta') {
          emittedReasoning = true
          emit({ type: 'model.reasoning', runId, step, text: event.text })
        } else if (event.type === 'tool-call') {
          emit({ type: 'model.tool_call', runId, step, toolCall: event.toolCall })
        } else if (event.type === 'usage') {
          emit({ type: 'model.usage', runId, step, usage: event.usage })
        } else if (event.type === 'error') {
          throw new Error(event.error)
        }
        yield event
      }
    })())
    if (isEmptyModelResponse(output.message)) {
      return {
        response: await this.modelClient.create({ ...request, stream: false }),
        emittedReasoning: false,
      }
    }
    return {
      response: output.message,
      emittedReasoning,
    }
  }

  private prepareMessages(input: AgentRuntimeRunInput, skills: AgentSkill[]): AgentMessage[] {
    const normalized = normalizeAgentMessages(input.messages)
    const userSystemMessages = normalized.filter(message => message.role === 'system').map(message => message.content)
    const nonSystemMessages = normalized.filter(message => message.role !== 'system')
    const systemPrompt = buildSystemPrompt({
      basePrompt: input.systemPrompt ?? this.systemPrompt,
      runtimeInstructions: this.runtimeInstructions,
      userSystemMessages,
      skills,
      context: input.toolContext ?? this.toolContext,
    })

    return [
      createSystemMessage(systemPrompt),
      ...nonSystemMessages,
    ]
  }

  private modelRequest(input: AgentRuntimeRunInput, messages: AgentMessage[]): ModelRequest {
    return {
      ...this.modelDefaults,
      model: input.model ?? this.modelDefaults?.model,
      temperature: input.temperature ?? this.modelDefaults?.temperature,
      maxTokens: input.maxTokens ?? this.modelDefaults?.maxTokens,
      metadata: input.metadata ?? this.modelDefaults?.metadata,
      messages,
      signal: input.signal,
      tools: this.tools.definitions(),
      stream: this.modelClient.capabilities.streaming,
    }
  }

  private runToolContext(input: AgentRuntimeRunInput): AgentToolContext | undefined {
    const context = input.toolContext ?? this.toolContext
    if (!input.signal) return context
    return {
      ...context,
      signal: input.signal,
    }
  }

  private async executeTool(
    runId: string,
    step: number,
    toolCall: AgentToolCall,
    context: AgentToolContext | undefined,
    emit: (event: AgentRuntimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now()
    emit({
      type: 'tool.started',
      runId,
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    })

    try {
      throwIfAborted(signal)
      const result = await this.tools.execute(toolCall.name, toolCall.arguments, context)
      throwIfAborted(signal)
      emit({
        type: result.ok ? 'tool.completed' : 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: AgentToolResult = {
        ok: false,
        content: message,
        error: message,
      }
      emit({
        type: 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  }

  private registerSkillTools(skills: AgentSkill[]): void {
    for (const skill of skills) {
      if (skill.tools?.length) {
        this.tools.registerMany(skill.tools)
      }
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('Run aborted.')
  error.name = 'AbortError'
  return error
}

function isEmptyModelResponse(response: ModelResponse): boolean {
  return (
    !response.content?.trim() &&
    !response.reasoning?.trim() &&
    !(response.toolCalls?.length)
  )
}
