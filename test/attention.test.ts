import test from 'node:test'
import assert from 'node:assert/strict'
import { getBoardRows, groupWorkspaces, matchesRow, moveAnchor } from '../src/client/ui/board-helpers.ts'
import { initialState, type ClientState, type ColumnId, type RuntimeStatus, type SessionView } from '../src/shared/model.ts'

function fixture(items: Array<[string, ColumnId, RuntimeStatus]>): ClientState {
  return { board: { ...initialState(), entries: items.map(([id, columnId]) => ({ sessionId: id, columnId, note: '保留备注', source: 'manual', version: 1, addedAt: 1, updatedAt: 1 })) }, sessions: items.map(([id, _columnId, status]): SessionView => ({ id, status, title: id, workspaceId: 'w', workspaceTitle: '工作区', updatedAt: 1, archived: false, missing: false, subagent: false, openable: true })), connected: true, runtimeReady: true, loading: false, saving: false }
}

test('等待回应与完成未读自动归集且不重复，手动待处理和搁置均保留', () => {
  const state = fixture([['unread', 'focus', 'unread'], ['question', 'focus', 'waiting'], ['manual', 'waiting', 'idle'], ['later', 'later', 'unread'], ['running', 'focus', 'running']])
  const before = structuredClone(state.board)
  const rows = getBoardRows(state)
  assert.deepEqual(rows.filter(r => r.displayColumnId === 'waiting').map(r => r.entry.sessionId), ['manual', 'unread', 'question'])
  assert.deepEqual(rows.filter(r => r.displayColumnId === 'focus').map(r => r.entry.sessionId), ['running'])
  assert.equal(rows.find(r => r.entry.sessionId === 'later')!.displayColumnId, 'later')
  assert.equal(new Set(rows.map(r => r.entry.sessionId)).size, rows.length)
  assert.deepEqual(state.board, before)
})

test('读过或回应后自动回到原分类原位置，手动待处理不跟随返回', () => {
  const state = fixture([['before', 'focus', 'idle'], ['a', 'focus', 'unread'], ['after', 'focus', 'idle'], ['manual', 'waiting', 'unread']])
  const original = structuredClone(state.board)
  assert.equal(getBoardRows(state).find(r => r.entry.sessionId === 'a')!.displayColumnId, 'waiting')
  for (const status of ['idle', 'running', 'unknown'] as const) {
    state.sessions[1].status = status; state.sessions[3].status = status
    const rows = getBoardRows(state)
    assert.deepEqual(rows.filter(r => r.displayColumnId === 'focus').map(r => r.entry.sessionId), ['before', 'a', 'after'])
    assert.equal(rows.find(r => r.entry.sessionId === 'manual')!.displayColumnId, 'waiting')
  }
  assert.deepEqual(state.board, original)
})

test('未关注会话不进入待处理，断线、同步中和不可用记录不依据过期状态归集', () => {
  const state = fixture([['a', 'focus', 'unread']])
  state.sessions.push({ ...state.sessions[0], id: 'unwatched' })
  assert.equal(getBoardRows(state).length, 1)
  for (const flags of [{ connected: false }, { runtimeReady: false }]) assert.equal(getBoardRows({ ...state, ...flags })[0].displayColumnId, 'focus')
  for (const flags of [{ archived: true }, { missing: true }, { subagent: true }, { openable: false }]) assert.equal(getBoardRows({ ...state, sessions: [{ ...state.sessions[0], ...flags }] })[0].displayColumnId, 'focus')
})

test('筛选、分组和计数使用展示位置，原分类与备注仍可用', () => {
  const rows = getBoardRows(fixture([['a', 'focus', 'unread'], ['b', 'focus', 'waiting'], ['c', 'later', 'unread']]))
  const waiting = rows.filter(r => r.displayColumnId === 'waiting')
  assert.equal(groupWorkspaces(waiting)[0].rows.length, 2)
  assert.equal(waiting.filter(r => matchesRow(r, '保留备注', 'w', 'unread')).length, 1)
  assert.ok(waiting.every(r => r.entry.columnId === 'focus'))
})

test('跨列排序锚点跳过自动项与拖动自身，不给服务端传错误分类锚点', () => {
  const rows = getBoardRows(fixture([['a', 'waiting', 'idle'], ['b', 'waiting', 'idle'], ['auto', 'focus', 'unread']]))
  assert.equal(moveAnchor(rows, 'a', 'before', 'waiting', 'b'), 'a')
  assert.equal(moveAnchor(rows, 'a', 'after', 'waiting', 'other'), 'b')
  assert.equal(moveAnchor(rows, 'a', 'after', 'waiting', 'b'), undefined)
  assert.equal(moveAnchor(rows, 'auto', 'before', 'waiting', 'other'), undefined)
  assert.equal(moveAnchor(rows, 'auto', 'after', 'waiting', 'other'), undefined)
})

test('自动项手动设为待处理会常驻，设为搁置立即退出归集', () => {
  const state = fixture([['a', 'focus', 'unread']])
  state.board.entries[0].columnId = 'waiting'
  state.sessions[0].status = 'idle'
  assert.equal(getBoardRows(state)[0].displayColumnId, 'waiting')
  state.board.entries[0].columnId = 'later'
  state.sessions[0].status = 'waiting'
  assert.equal(getBoardRows(state)[0].displayColumnId, 'later')
})
