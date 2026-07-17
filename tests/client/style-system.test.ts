import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('client style system', () => {
  it('keeps shared page headers on one layout baseline', () => {
    const globalStyles = readClientFile('styles/global.scss')

    expect(globalStyles).toContain('min-height: 64px;')
    expect(globalStyles).toContain('padding: 14px 20px;')
    expect(globalStyles).toContain('.page-header > .header-actions')
  })

  it('aligns SCSS surfaces and radii with the Naive UI theme', () => {
    const variables = readClientFile('styles/variables.scss')
    const theme = readClientFile('styles/theme.ts')

    expect(variables).toContain('--bg-card: #2a2a2a;')
    expect(theme).toContain("cardColor: '#2a2a2a'")
    expect(variables).toContain('$radius-sm: 6px;')
    expect(variables).toContain('$radius-md: 8px;')
    expect(variables).toContain('$radius-lg: 8px;')
    expect(theme).toContain("borderRadius: '8px'")
    expect(theme).toContain("borderRadiusSmall: '6px'")
  })

  it('keeps chat surfaces aligned while preserving composer elevation in dark mode', () => {
    const chatInput = readClientFile('components/hermes/chat/ChatInput.vue')
    const groupChatInput = readClientFile('components/hermes/group-chat/GroupChatInput.vue')
    const virtualMessageList = readClientFile('components/hermes/chat/VirtualMessageList.vue')

    expect(chatInput).toContain('background-color: $bg-main-surface;')
    expect(groupChatInput).toContain('background-color: $bg-main-surface;')
    expect(virtualMessageList).toContain('background-color: $bg-main-surface;')
    expect(chatInput.match(/background-color: #333333;/g)).toHaveLength(1)
    expect(groupChatInput.match(/background-color: #333333;/g)).toHaveLength(1)
  })

  it('replays the history detail fade when the selected session changes', () => {
    const historyView = readClientFile('views/hermes/HistoryView.vue')
    const historyMessageList = readClientFile('components/hermes/chat/HistoryMessageList.vue')

    expect(historyView).toContain(`:key="historySession?.id || 'history-empty'"`)
    expect(historyMessageList).toContain('animation: history-message-surface-fade-in 1.5s ease both;')
  })

  it('keeps the three-way conversation switch active state visible in dark mode', () => {
    const pageSidebarNav = readClientFile('components/layout/PageSidebarNav.vue')

    expect(pageSidebarNav).toContain(
      ':global(.dark .conversation-switch--three .conversation-switch-tab.active)',
    )
    expect(pageSidebarNav).toContain('background: $bg-card-hover;')
    expect(pageSidebarNav).toContain('inset 0 0 0 1px $border-color')
  })

  it('keeps the coding agents page aligned with the app main surface', () => {
    const codingAgentsView = readClientFile('views/hermes/CodingAgentsView.vue')

    expect(codingAgentsView).toMatch(
      /\.coding-agents-content\s*\{[^}]*background: \$bg-main-surface;/s,
    )
  })
})
