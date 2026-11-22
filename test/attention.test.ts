import test from 'node:test'
import assert from 'node:assert/strict'
import { getBoardRows, groupWorkspaces, isRunningMirror, isWaitingPaneRow, matchesRow, moveAnchor } from '../src/client/ui/board-helpers.ts'
import { initialState, type ClientState, type ColumnId, type RuntimeStatus, type SessionView } from '../src/shared/model.ts'

function fixture(items: Array<[string, ColumnId, RuntimeStatus]>, mirrorActivity = true): ClientState {
  return { board: { ...initialState(), settings: { ...initialState().settings, mirrorActivity }, entries: items.map(([id, columnId]) => ({ sessionId: id, columnId, note: '保留备注', source: 'manual', version: 1, addedAt: 1, updatedAt: 1 })) }, sessions: items.map(([id, _columnId, status]): SessionView => ({ id, status, title: id, workspaceId: 'w', workspaceTitle: '工作区', updatedAt: 1, archived: false, missing: false, subagent: false, openable: true })), connected: true, runtimeReady: true, loading: false, saving: false }
}

test('默认同步展示：关注原卡片不离开，运行中与待处理分别出现在中间列两块', () => {
  const state = fixture([['unread', 'focus', 'unread'], ['question', 'focus', 'waiting'], ['manual', 'waiting', 'idle'], ['later', 'later', 'unread'], ['running', 'focus', 'running'], ['parked', 'later', 'running']])
  const before = structuredClone(state.board)
  const rows = getBoardRows(state)
  assert.deepEqual(rows.filter(r => r.displayColumnId === 'focus' && !r.mirrored).map(r => r.entry.sessionId), ['unread', 'question', 'running'])
  assert.deepEqual(rows.filter(isRunningMirror).map(r => r.entry.sessionId), ['running'])
  assert.deepEqual(rows.filter(isWaitingPaneRow).map(r => r.entry.sessionId), ['unread', 'question', 'manual'])
  assert.equal(rows.find(r => r.entry.sessionId === 'later')!.displayColumnId, 'later')
  assert.equal(rows.filter(r => r.entry.sessionId === 'parked').length, 1)
  assert.equal(rows.filter(r => r.entry.sessionId === 'parked')[0].displayColumnId, 'later')
  assert.deepEqual(state.board, before)
})

test('关闭同步后，中间列只保留手动放入的待处理', () => {
  const state = fixture([['unread', 'focus', 'unread'], ['running', 'focus', 'running'], ['manual', 'waiting', 'idle']], false)
  const rows = getBoardRows(state)
  assert.equal(rows.filter(r => r.mirrored).length, 0)
  assert.deepEqual(rows.filter(r => r.displayColumnId === 'focus').map(r => r.entry.sessionId), ['unread', 'running'])
  assert.deepEqual(rows.filter(r => r.displayColumnId === 'waiting').map(r => r.entry.sessionId), ['manual'])
})

test('活动结束后同步卡片消失，关注原位置保留；手动待处理不跟随状态', () => {
  const state = fixture([['before', 'focus', 'idle'], ['a', 'focus', 'unread'], ['after', 'focus', 'idle'], ['manual', 'waiting', 'unread']])
  const original = structuredClone(state.board)
  assert.equal(getBoardRows(state).filter(r => r.entry.sessionId === 'a' && r.mirrored).length, 1)
  for (const status of ['idle', 'unknown'] as const) {
    state.sessions[1].status = status; state.sessions[3].status = status
    const rows = getBoardRows(state)
    assert.deepEqual(rows.filter(r => r.displayColumnId === 'focus').map(r => r.entry.sessionId), ['before', 'a', 'after'])
    assert.equal(rows.find(r => r.entry.sessionId === 'manual')!.displayColumnId, 'waiting')
    assert.equal(rows.filter(r => r.entry.sessionId === 'a' && r.mirrored).length, 0)
  }
  assert.deepEqual(state.board, original)
})

test('未关注会话不进入中间列，断线、同步中和不可用记录不同步', () => {
  const state = fixture([['a', 'focus', 'unread']])
  state.sessions.push({ ...state.sessions[0], id: 'unwatched' })
  assert.equal(getBoardRows(state).filter(r => !r.mirrored).length, 1)
  for (const flags of [{ connected: false }, { runtimeReady: false }]) assert.equal(getBoardRows({ ...state, ...flags }).filter(r => r.mirrored).length, 0)
  for (const flags of [{ archived: true }, { missing: true }, { subagent: true }, { openable: false }]) assert.equal(getBoardRows({ ...state, sessions: [{ ...state.sessions[0], ...flags }] }).filter(r => r.mirrored).length, 0)
})

test('筛选、分组和计数可按中间列展示位置，原分类与备注仍可用', () => {
  const rows = getBoardRows(fixture([['a', 'focus', 'unread'], ['b', 'focus', 'waiting'], ['c', 'later', 'unread']]))
  const waiting = rows.filter(isWaitingPaneRow)
  assert.equal(groupWorkspaces(waiting)[0].rows.length, 2)
  assert.equal(waiting.filter(r => matchesRow(r, '保留备注', 'w', 'unread')).length, 1)
  assert.ok(waiting.every(r => r.entry.columnId === 'focus' && r.mirrored))
})

test('跨列排序锚点跳过同步卡片与拖动自身，不给服务端传错误分类锚点', () => {
  const rows = getBoardRows(fixture([['a', 'waiting', 'idle'], ['b', 'waiting', 'idle'], ['auto', 'focus', 'unread']]))
  const waiting = rows.filter(isWaitingPaneRow)
  assert.equal(moveAnchor(waiting, 'a', 'before', 'waiting', 'b'), 'a')
  assert.equal(moveAnchor(waiting, 'a', 'after', 'waiting', 'other'), 'b')
  assert.equal(moveAnchor(waiting, 'a', 'after', 'waiting', 'b'), undefined)
  assert.equal(moveAnchor(waiting, 'auto', 'before', 'waiting', 'other'), undefined)
  assert.equal(moveAnchor(waiting, 'auto', 'after', 'waiting', 'other'), undefined)
})

test('手动设为待处理会常驻下块，设为搁置立即退出同步', () => {
  const state = fixture([['a', 'focus', 'unread']])
  state.board.entries[0].columnId = 'waiting'
  state.sessions[0].status = 'idle'
  assert.equal(getBoardRows(state).filter(isWaitingPaneRow).length, 1)
  assert.equal(getBoardRows(state).filter(r => r.mirrored).length, 0)
  state.board.entries[0].columnId = 'later'
  state.sessions[0].status = 'waiting'
  assert.equal(getBoardRows(state)[0].displayColumnId, 'later')
  assert.equal(getBoardRows(state).filter(r => r.mirrored).length, 0)
})
