import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { initialState, type ClientState, type SessionView } from '../../shared/model.js'
import { getRemovedRows, matchesRemovedRow } from './removed-helpers.js'
import { RemovedList } from './RemovedList.js'

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactElement) => string }
const session = (id: string, values: Partial<SessionView> = {}): SessionView => ({ id, title: `会话 ${id}`, workspaceId: 'work', workspaceTitle: '产品', updatedAt: 1, status: 'idle', archived: false, missing: false, subagent: false, openable: true, ...values })
function state(): ClientState {
  const board = initialState()
  board.excludedSessionIds = ['legacy', 'new', 'missing', 'archived']
  board.removedEntries = [{ entry: { sessionId: 'new', columnId: 'later', note: '保留接口验证备注', source: 'manual', addedAt: 1, updatedAt: 2, version: 3 }, removedAt: 10 }]
  return { board, sessions: [session('legacy'), session('new'), session('archived', { archived: true })], connected: true, runtimeReady: true, loading: false, saving: false }
}
const markup = (value: ClientState) => renderToStaticMarkup(createElement(RemovedList, { state: value, busy: false, openingId: null, onRestore: async () => true, onOpen: async () => {}, onRefresh: async () => {} }))

test('新旧取消关注记录均可见，新快照优先，备注、原分类和 ID 可追溯', () => {
  const value = state()
  const rows = getRemovedRows(value)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].sessionId, 'new')
  assert.equal(rows[0].entry?.columnId, 'later')
  assert.equal(rows.find(row => row.sessionId === 'legacy')?.entry, undefined)
  for (const query of ['接口 备注', 'new', '会话 产品']) assert.ok(matchesRemovedRow(rows[0], query, 'work'))
  assert.equal(matchesRemovedRow(rows[0], '', 'other'), false)
  const html = markup(value)
  assert.match(html, /旧版本未保存取消时间、备注及原分类/)
  assert.match(html, /原分类：暂时搁置/)
  assert.match(html, /保留接口验证备注/)
  assert.match(html, /会话 ID：missing/)
  assert.equal((html.match(/data-removed-session=/g) ?? []).length, 4)
})

test('缺失、归档、目录同步和断线时禁用恢复且保留记录', () => {
  const value = state()
  const rows = getRemovedRows(value)
  assert.match(rows.find(row => row.sessionId === 'missing')!.reason, /找不到/)
  assert.match(rows.find(row => row.sessionId === 'archived')!.reason, /已归档/)
  assert.equal(rows[0].reason, '')
  for (const patch of [{ connected: false }, { runtimeReady: false }]) {
    const changed = { ...value, ...patch }
    assert.ok(getRemovedRows(changed).every(row => row.reason))
    const html = markup(changed)
    assert.equal((html.match(/disabled=""[^>]*>恢复关注/g) ?? []).length, 4)
  }
  assert.equal(value.board.excludedSessionIds.length, 4)
})

test('无记录显示空态，大量历史排除分页渲染且不隐藏计数', () => {
  const value = state()
  value.board = initialState()
  assert.match(markup(value), /暂无已取消关注的会话/)
  value.board.excludedSessionIds = Array.from({ length: 101 }, (_, index) => `old-${index}`)
  const html = markup(value)
  assert.equal((html.match(/data-removed-session=/g) ?? []).length, 80)
  assert.match(html, /显示 101 \/ 101 条/)
  assert.match(html, /再显示 21 条/)
})
