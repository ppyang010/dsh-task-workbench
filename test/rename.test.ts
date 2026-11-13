import test from 'node:test'
import assert from 'node:assert/strict'
import { BoardController } from '../src/client/controller.ts'
import { createRuntime } from '../src/client/runtime.ts'
import { initialState, type RuntimeSnapshot } from '../src/shared/model.ts'

function fixture() {
  const snapshot: RuntimeSnapshot = { ready: true, connected: true, sessions: [{ id: 'a', title: '原名称', workspaceId: 'w', workspaceTitle: '工作区', updatedAt: 1, status: 'running', archived: false, missing: false, subagent: false, openable: true }] }
  const calls: string[][] = []
  let rename: (id: string, title: string) => Promise<void> = async (id, title) => { snapshot.sessions[0].title = title }
  let mutations = 0
  const board = { ...initialState(), entries: [{ sessionId: 'a', columnId: 'waiting' as const, source: 'manual' as const, note: '原备注', version: 1, addedAt: 1, updatedAt: 1 }] }
  const controller = new BoardController({ call: async (_channel, endpoint) => { if (!endpoint.endsWith('/read')) mutations++; return { ok: true, value: { ok: true, value: board } } } }, {
    snapshot: () => snapshot, subscribe: () => () => {}, refresh: async () => {}, open: async () => { throw new Error('不应导航') },
    rename: async (id, title) => { calls.push([id, title]); await rename(id, title) },
  })
  const dispose = controller.start()
  return { controller, dispose, snapshot, board, calls, mutations: () => mutations, setRename: (fn: typeof rename) => { rename = fn } }
}

test('改名去除首尾空白并同步原生标题，不改关注、备注和运行状态', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    assert.equal(await f.controller.renameSession('a', ' 新名称 '), true)
    assert.deepEqual(f.calls, [['a', '新名称']])
    assert.equal(f.controller.getSnapshot().sessions[0].title, '新名称')
    assert.equal(f.controller.getSnapshot().sessions[0].status, 'running')
    assert.deepEqual(f.controller.getSnapshot().board, f.board)
    assert.equal(f.mutations(), 0)
    assert.equal(await f.controller.renameSession('a', '新名称'), true)
    assert.equal(f.calls.length, 1)
  } finally { f.dispose() }
})

test('空名、缺失会话、断线、归档和未就绪目录不发送改名', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    assert.equal(await f.controller.renameSession('a', '  '), false)
    assert.equal(await f.controller.renameSession('missing', '新名称'), false)
    f.snapshot.connected = false; await f.controller.refresh()
    assert.equal(await f.controller.renameSession('a', '新名称'), false)
    f.snapshot.connected = true; f.snapshot.sessions[0].archived = true; await f.controller.refresh()
    assert.equal(await f.controller.renameSession('a', '新名称'), false)
    f.snapshot.sessions[0].archived = false; f.snapshot.ready = false; await f.controller.refresh()
    assert.equal(await f.controller.renameSession('a', '新名称'), false)
    assert.equal(f.calls.length, 0)
  } finally { f.dispose() }
})

test('保存中拒绝重复提交，宿主失败不伪报成功且允许重试', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    let reject!: (error: Error) => void
    f.setRename(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const first = f.controller.renameSession('a', '新名称')
    assert.equal(f.controller.getSnapshot().saving, true)
    assert.equal(await f.controller.renameSession('a', '重复名称'), false)
    reject(new Error('模拟权限拒绝'))
    assert.equal(await first, false)
    assert.equal(f.controller.getSnapshot().error, '模拟权限拒绝')
    assert.equal(f.controller.getSnapshot().sessions[0].title, '原名称')
    assert.equal(f.controller.getSnapshot().saving, false)
    f.setRename(async (_id, title) => { f.snapshot.sessions[0].title = title })
    assert.equal(await f.controller.renameSession('a', '重试名称'), true)
  } finally { f.dispose() }
})

test('适配层沿用原生 using 与 rename 契约，传播服务端错误', async () => {
  const calls: unknown[] = []
  let ok = true
  const services: Record<string, any> = { sessions: { using: async (id: string, options: unknown, run: (ref: any) => Promise<unknown>) => {
    calls.push([id, options])
    return run({ binding: { session: { rename: async (title: string) => { calls.push(title); return ok ? { ok: true, value: { title, seq: 1 } } : { ok: false, error: { message: '改名被拒绝' } } } } } })
  } }, workspaces: {}, uiSession: {}, connection: {}, uiWorkspace: {} }
  const runtime = createRuntime({ get: name => services[name] })
  await runtime.rename('a', '新名称')
  assert.deepEqual(calls, [['a', { source: 'workspaceOperation' }], '新名称'])
  ok = false
  await assert.rejects(runtime.rename('a', '失败名称'), /改名被拒绝/)
})
