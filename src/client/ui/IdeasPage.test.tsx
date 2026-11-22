import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createElement, type ReactElement } from 'react'
import { initialIdeasState, type Idea, type IdeasClientState, type IdeasControllerFace } from '../../shared/ideas.ts'
import { initialState, type BoardControllerFace, type ClientState } from '../../shared/model.ts'
import { discussionText, IdeasPage } from './IdeasPage.tsx'

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactElement) => string }
const example: Idea = { id: '11111111-1111-4111-8111-111111111111', title: '<测试点子>', content: '第一行\n第二行', kind: 'plugin', tags: ['AI'], folderIds: [], sessionIds: [], version: 1, createdAt: 100, updatedAt: 100, trashedAt: null }
function render(ideas: IdeasClientState) {
  const controller: IdeasControllerFace = { subscribe: () => () => {}, getSnapshot: () => ideas, refresh: async () => {}, command: async () => true, clearError: () => {} }
  const state: ClientState = { board: initialState(), sessions: [], loading: false, saving: false, connected: true, runtimeReady: true }
  const board: BoardControllerFace = { subscribe: () => () => {}, getSnapshot: () => state, refresh: async () => {}, command: async () => true, openSession: async () => true, renameSession: async () => true, clearError: () => {} }
  return renderToStaticMarkup(createElement(IdeasPage, { controller, board }))
}

test('点子列表显示类型、标签和安全转义的正文，不显示已回收记录', () => {
  const html = render({ data: { ...initialIdeasState(), ideas: [example, { ...example, id: '22222222-2222-4222-8222-222222222222', title: '已回收记录', trashedAt: 200 }] }, loaded: true, loading: false, saving: false })
  assert.match(html, /&lt;测试点子&gt;/); assert.doesNotMatch(html, /<测试点子>/)
  assert.match(html, /插件点子/); assert.match(html, /#.*AI/); assert.match(html, /回收站/)
  assert.doesNotMatch(html, /已回收记录/)
  assert.match(html, /aria-label="搜索点子"/); assert.match(html, /aria-label="按点子类型筛选"/)
})

test('首次加载失败不伪报空库，且禁止新建操作', () => {
  const html = render({ data: initialIdeasState(), loaded: false, loading: false, saving: false, error: '服务不可用' })
  assert.match(html, /点子库尚未读取/); assert.doesNotMatch(html, /暂无匹配的点子/)
  assert.match(html, /disabled=""[^>]*>记个点子<\/button>/)
})

test('讨论材料只包含点子文本，不嵌入会话内容或自动发送指令', () => {
  const text = discussionText(example)
  assert.equal(text, '# 点子：<测试点子>\n类型：插件点子\n标签：AI\n\n第一行\n第二行')
  assert.doesNotMatch(text, /session|发送|执行/)
})
