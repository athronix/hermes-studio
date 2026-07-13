// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  store: null as any,
  requests: [] as Array<{
    text: string
    resolve: (value: { audio: Blob; engine: string; provider: string }) => void
  }>,
  activeRequests: 0,
  maxActiveRequests: 0,
  audioInstances: [] as MockAudio[],
  recognitionStopResult: '',
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/hermes/chat', async () => {
  const { reactive } = await import('vue')
  testState.store = reactive({
    activeSessionId: 'voice-session',
    activeSession: { id: 'voice-session', title: 'Voice', agent: 'codex', messages: [] },
    messages: [] as any[],
    isStreaming: true,
    isSessionLive: () => false,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
  })
  return { useChatStore: () => testState.store }
})

vi.mock('@/composables/useBrowserSpeechRecognition', async () => {
  const { ref } = await import('vue')
  return {
    useBrowserSpeechRecognition: () => ({
      transcript: ref(''),
      partialTranscript: ref(''),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async () => testState.recognitionStopResult),
      cancel: vi.fn(),
      clearError: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useSttSettings', async () => {
  const { ref } = await import('vue')
  return {
    useSttSettings: () => ({
      openaiLanguage: ref('zh-CN'),
      customLanguage: ref(''),
    }),
  }
})

vi.mock('@/composables/useVoiceSettings', async () => {
  const { ref } = await import('vue')
  return {
    useVoiceSettings: () => ({
      provider: ref('edge'),
      webspeechVoice: ref(''),
      openaiApiKey: ref(''),
      openaiBaseUrl: ref(''),
      openaiModel: ref('tts-1'),
      openaiVoice: ref('alloy'),
      customUrl: ref(''),
      customApiKey: ref(''),
      edgeUrl: ref(''),
      edgeVoice: ref('zh-CN-XiaoxiaoNeural'),
      edgeRate: ref(1),
      edgePitchHz: ref(0),
      mimoApiKey: ref(''),
      mimoAuthMode: ref('bearer'),
      mimoBaseUrl: ref(''),
      mimoModel: ref('mimo-v2.5-tts'),
      mimoVoice: ref(''),
      mimoVoiceDesignDesc: ref(''),
      mimoVoiceCloneDataUri: ref(''),
      mimoVoiceCloneFormat: ref('wav'),
      mimoStylePrompt: ref(''),
      doubaoBaseUrl: ref(''),
      doubaoModel: ref(''),
      doubaoVoice: ref(''),
      doubaoStylePrompt: ref(''),
    }),
  }
})

vi.mock('@/composables/useSpeech', async () => {
  const { ref } = await import('vue')
  return {
    useGlobalSpeech: () => ({
      isPlaying: ref(false),
      isCustomPlaying: ref(false),
      isSupported: ref(false),
      stop: vi.fn(),
      extractReadableText: (text: string) => text,
      speakViaBrowser: vi.fn(),
    }),
  }
})

vi.mock('@/api/hermes/tts', () => ({
  synthesizeSpeech: vi.fn(({ text }: { text: string }) => {
    testState.activeRequests += 1
    testState.maxActiveRequests = Math.max(testState.maxActiveRequests, testState.activeRequests)
    return new Promise((resolve) => {
      testState.requests.push({
        text,
        resolve: (value) => {
          testState.activeRequests -= 1
          resolve(value)
        },
      })
    })
  }),
}))

class MockAudio {
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()

  constructor(src = '') {
    this.src = src
    testState.audioInstances.push(this)
  }
}

import RealtimeVoiceStage from '@/components/hermes/chat/RealtimeVoiceStage.vue'

async function settle() {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function resolveRequest(index: number) {
  testState.requests[index].resolve({
    audio: new Blob([testState.requests[index].text], { type: 'audio/mpeg' }),
    engine: 'edge',
    provider: 'edge',
  })
}

describe('RealtimeVoiceStage prepared playback queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testState.requests = []
    testState.activeRequests = 0
    testState.maxActiveRequests = 0
    testState.audioInstances = []
    testState.recognitionStopResult = ''
    vi.stubGlobal('Audio', MockAudio)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => `blob:voice-${blob.size}-${Math.random()}`),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prepares at most five segments concurrently but always plays and captions FIFO', async () => {
    const wrapper = mount(RealtimeVoiceStage)
    expect(wrapper.find('.voice-stage__controls').exists()).toBe(false)
    expect(wrapper.find('.voice-stage__back').exists()).toBe(true)
    expect(wrapper.get('.voice-stage__identity span').text()).toBe('Codex')
    testState.store.messages.push({
      id: 'assistant-stream',
      role: 'assistant',
      content: '第一句。第二句。第三句。第四句。第五句。第六句。',
      timestamp: Date.now(),
      isStreaming: true,
    })
    await settle()

    expect(testState.requests.map(request => request.text)).toEqual([
      '第一句。',
      '第二句。',
      '第三句。',
      '第四句。',
      '第五句。',
    ])
    expect(testState.maxActiveRequests).toBe(5)

    resolveRequest(4)
    await settle()
    expect(testState.requests[5].text).toBe('第六句。')
    expect(testState.maxActiveRequests).toBe(5)
    expect(testState.audioInstances).toHaveLength(0)

    resolveRequest(1)
    resolveRequest(0)
    await settle()

    expect(testState.audioInstances).toHaveLength(1)
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('第一句。')

    testState.audioInstances[0].onended?.()
    await settle()

    expect(testState.audioInstances).toHaveLength(2)
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('第二句。')

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    expect(testState.store.stopStreaming).toHaveBeenCalledTimes(1)
    expect(testState.audioInstances[1].pause).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('voice-stage--idle')
    wrapper.unmount()
  })

  it('stops the active model turn when the animation is clicked while thinking', async () => {
    const wrapper = mount(RealtimeVoiceStage)
    testState.recognitionStopResult = '执行一个任务'

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.sendMessage).toHaveBeenCalledWith('执行一个任务')
    expect(wrapper.classes()).toContain('voice-stage--thinking')

    for (let index = 1; index <= 5; index += 1) {
      testState.store.messages.push({
        id: `tool-${index}`,
        role: 'tool',
        content: '',
        toolName: `tool-${index}`,
        toolStatus: index === 5 ? 'running' : 'done',
        timestamp: Date.now() + index,
      })
    }
    await settle()
    expect(wrapper.findAll('.voice-stage__tool strong').map(node => node.text())).toEqual([
      'tool-5',
      'tool-4',
      'tool-3',
      'tool-2',
    ])

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.stopStreaming).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('voice-stage--idle')
    wrapper.unmount()
  })
})
