import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSessions, createRuntime, type Source } from '../src/client/runtime.ts'
const list = { phase: 'ready', byId: {
  a: { id: 'a', displayTitle: '原对话', running: true, updatedAt: 100 },
  fork: { id: 'fork', parentId: 'a', displayTitle: '普通 fork', running: false },
  child: { id: 'child', parentId: 'a', origin: 'subagent', running: true },
  cold: { id: 'cold', displayTitle: '历史对话', running: false },
} }
const workspaces = { phase: 'ready', items: [{ workspaceId: 'one', title: '工作区一', sessionIds: ['a', 'fork'] }, { workspaceId: 'two', title: '工作区二', sessionIds: ['cold'] }], archivedSessionIds: ['cold'] }

test('跨工作区摘要与原会话 ID 保留，普通 fork 可关注', () => {
  const result = deriveSessions(list, workspaces, new Map(), true)
  assert.equal(result.ready, true)
  assert.equal(result.sessions.find(s => s.id === 'a')?.workspaceId, 'one')
  assert.equal(result.sessions.find(s => s.id === 'cold')?.workspaceId, 'two')
  assert.equal(result.sessions.find(s => s.id === 'fork')?.subagent, false)
  assert.equal(result.sessions.find(s => s.id === 'child')?.subagent, true)
})
test('等待交互优先于 running，原生未读优先于空闲', () => {
  for (const [kind, label] of [['approval', '等待审批'], ['plan-review', '等待方案确认'], ['question', '等待回答']]) {
    const result = deriveSessions(list, workspaces, new Map([['a', { running: true, pendingInteraction: { kind } }], ['fork', { running: false, completionUnread: true }]]), true)
    assert.equal(result.sessions[0].status, 'waiting'); assert.equal(result.sessions[0].waitingLabel, label)
    assert.equal(result.sessions.find(s => s.id === 'fork')?.status, 'unread')
  }
})
test('归档记录保留，不自动恢复；断线不伪报空闲', () => {
  const result = deriveSessions(list, workspaces, new Map(), true)
  assert.equal(result.sessions.find(s => s.id === 'cold')?.openable, false)
  const offline = deriveSessions(list, workspaces, new Map(), false)
  assert.ok(offline.sessions.every(s => s.status === 'unknown' && !s.openable))
})
test('首次目录未就绪不开放导航', () => {
  const result = deriveSessions({ ...list, phase: 'pending' }, workspaces, new Map(), true)
  assert.equal(result.ready, false); assert.ok(result.sessions.every(s => !s.openable))
})
test('原生跳转只调用 uiWorkspace.openSession，不创建或恢复 Agent', async () => {
  const source = <T>(value: T): Source<T> => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const calls: string[] = []
  const services: Record<string, unknown> = {
    sessions: { list: source(list), refresh: async () => {} }, workspaces: { list: source(workspaces) },
    uiSession: { sessionStatus: source(new Map()) }, connection: { state: source('connected') },
    uiWorkspace: { openSession: async (id: string) => { calls.push(id) } },
  }
  const runtime = createRuntime({ get: name => services[name] })
  assert.equal(runtime.snapshot().sessions.length, 4)
  await runtime.open('a'); assert.deepEqual(calls, ['a'])
})
