import test from 'node:test'
import assert from 'node:assert/strict'
import { BoardController } from '../src/client/controller.ts'
import { createRuntime, type RuntimeFace } from '../src/client/runtime.ts'
import { initialState, type RuntimeSnapshot } from '../src/shared/model.ts'

function fixture() {
  const state: RuntimeSnapshot = { connected: true, ready: true, sessions: ['a', 'b', 'c'].map(id => ({ id, title: `会话${id}`, workspaceId: 'w', workspaceTitle: '工作区', updatedAt: 1, status: 'idle', archived: false, missing: false, subagent: false, openable: true })) }
  const calls: string[] = []; let failRead = false; let listener = () => {}
  let archive: (id: string) => Promise<void> = async id => { state.sessions.find(s => s.id === id)!.archived = true; listener() }
  const runtime: RuntimeFace = { snapshot: () => state, subscribe: fn => { listener = fn; return () => {} }, refresh: async () => {}, open: async () => {}, rename: async () => {}, archive: async id => { calls.push(id); await archive(id) } }
  const controller = new BoardController({ call: async (_channel, endpoint, payload) => {
    assert.ok(endpoint.endsWith('/read'), '归档不伪造关注写操作')
    assert.deepEqual(payload, { args: {} }, '沿用真实 RPC 信封')
    if (failRead) return { ok: false }
    return { ok: true, value: { ok: true, value: initialState() } }
  } }, runtime)
  const dispose = controller.start()
  return { controller, state, calls, dispose, notify: () => listener(), failSync: () => { failRead = true }, setArchive: (fn: typeof archive) => { archive = fn } }
}

test('批量归档逐项报告部分成功，去重且已经归档不重复调用', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    f.state.sessions[2].archived = true
    f.setArchive(async id => { if (id === 'b') throw new Error('会话仍在运行'); f.state.sessions[0].archived = true })
    const result = await f.controller.archiveSessions(['a', 'b', 'a', 'c'])
    assert.deepEqual(f.calls, ['a', 'b'])
    assert.deepEqual(result.items.map(x => [x.sessionId, x.ok]), [['a', true], ['b', false], ['c', true]])
    assert.equal(result.items[1].message, '会话仍在运行')
    assert.equal(f.controller.getSnapshot().saving, false)
  } finally { f.dispose() }
})

test('断线、缺失、子代理、目录未就绪不归档；无效数量提前拒绝', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    f.state.sessions[0].missing = true; f.state.sessions[1].subagent = true
    const result = await f.controller.archiveSessions(['a', 'b', 'missing'])
    assert.ok(result.items.every(x => !x.ok)); assert.deepEqual(f.calls, [])
    f.state.ready = false; f.notify(); assert.equal((await f.controller.archiveSessions(['c'])).items[0].ok, false)
    f.state.connected = false; f.notify(); assert.equal((await f.controller.archiveSessions(['c'])).items[0].ok, false)
    await assert.rejects(f.controller.archiveSessions([])); await assert.rejects(f.controller.archiveSessions(Array(501).fill('c')))
    assert.deepEqual(f.calls, [])
  } finally { f.dispose() }
})

test('在途归档锁定重复提交，断线后不继续发送剩余请求', async () => {
  const f = fixture(); let finish!: () => void
  try {
    await f.controller.refresh()
    f.setArchive(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = f.controller.archiveSessions(['a', 'b'])
    await assert.rejects(f.controller.archiveSessions(['c']))
    f.state.connected = false; f.notify(); finish()
    const result = await pending
    assert.deepEqual(f.calls, ['a']); assert.equal(result.items[0].ok, true); assert.equal(result.items[1].ok, false)
  } finally { f.dispose() }
})

test('原生归档成功但关注同步失败时保留成功结果并提示刷新', async () => {
  const f = fixture()
  try {
    await f.controller.refresh(); f.failSync()
    const result = await f.controller.archiveSessions(['a'])
    assert.equal(result.items[0].ok, true); assert.match(result.syncWarning!, /关注同步失败/)
  } finally { f.dispose() }
})

test('适配层调用 DSH 原生 workspaces.archiveSession，明确禁止强制停止且传播活动拒绝', async () => {
  const calls: unknown[] = []
  const services: Record<string, unknown> = { workspaces: { archiveSession: async (...args: unknown[]) => { calls.push(args) } } }
  const runtime = createRuntime({ get: name => services[name] })
  await runtime.archive!('native-id')
  assert.deepEqual(calls, [['native-id', { stopActivity: false }]])
  services.workspaces = { archiveSession: async () => { throw Object.assign(new Error('active'), { name: 'WorkspaceArchiveError', rpcError: { code: 'workspace/session-active' } }) } }
  await assert.rejects(runtime.archive!('native-id'), /未归档/)
  services.workspaces = {}
  await assert.rejects(runtime.archive!('native-id'), /不支持/)
})
