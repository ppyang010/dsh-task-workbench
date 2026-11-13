import test from 'node:test'
import assert from 'node:assert/strict'
import { BoardController } from '../src/client/controller.ts'
import { initialState, type RuntimeSnapshot, type BoardState } from '../src/shared/model.ts'
function fixture() {
  let board: BoardState = initialState()
  const runtimeState: RuntimeSnapshot = { sessions: [{ id: 'a', title: '原对话', workspaceId: 'one', workspaceTitle: '工作区', updatedAt: 1, status: 'running', archived: false, missing: false, subagent: false, openable: true }], ready: true, connected: true }
  let notify = () => {}; const opened: string[] = []; let error: string | undefined
  const controller = new BoardController({ call: async (_channel, endpoint, payload: any) => {
    assert.deepEqual(Object.keys(payload), ['args'], '真实 RPC payload 只允许 args 信封')
    if (endpoint.endsWith('/mutate')) {
      if (error) return { ok: true, value: { ok: false, error: { message: error } } }
      board = { ...board, revision: board.revision + 1, settings: { ...board.settings, autoCollect: payload.args.request.autoCollect ?? board.settings.autoCollect, copySessionName: payload.args.request.includeName ?? board.settings.copySessionName } }
    }
    return { ok: true, value: { ok: true, value: structuredClone(board) } }
  } }, { snapshot: () => runtimeState, subscribe: cb => { notify = cb; return () => {} }, refresh: async () => {}, open: async id => { opened.push(id) }, rename: async (id, title) => { if (error) throw new Error(error); runtimeState.sessions.find(s => s.id === id)!.title = title; notify() } })
  const dispose = controller.start()
  return { controller, dispose, runtimeState, opened, notify: () => notify(), setBoard: (next: BoardState) => { board = next }, fail: (message: string) => { error = message } }
}
test('初始化仅拉关注状态，不触发原生导航或模型', async () => {
  const f = fixture(); try { await f.controller.refresh(); assert.equal(f.controller.getSnapshot().loading, false); assert.deepEqual(f.opened, []) } finally { f.dispose() }
})
test('保存只在服务端确认后更新开关，失败保留原值', async () => {
  const f = fixture(); try {
    await f.controller.refresh()
    assert.equal(await f.controller.command({ type: 'settings', autoCollect: true }), true)
    assert.equal(f.controller.getSnapshot().board.settings.autoCollect, true)
    f.fail('模拟保存失败')
    assert.equal(await f.controller.command({ type: 'settings', autoCollect: false }), false)
    assert.equal(f.controller.getSnapshot().board.settings.autoCollect, true)
    assert.equal(f.controller.getSnapshot().error, '模拟保存失败')
  } finally { f.dispose() }
})
test('首次同步不会把缺少的摘要报成已删除，ready 后才标不可用', async () => {
  const f = fixture(); try {
    await f.controller.refresh()
    f.setBoard({ ...initialState(), revision: 1, entries: [{ sessionId: 'missing', columnId: 'focus', note: '', source: 'manual', addedAt: 1, updatedAt: 1, version: 1 }] })
    f.runtimeState.ready = false; await f.controller.refresh()
    assert.equal(f.controller.getSnapshot().sessions.find(s => s.id === 'missing')?.missing, false)
    f.runtimeState.ready = true; f.notify()
    assert.equal(f.controller.getSnapshot().sessions.find(s => s.id === 'missing')?.missing, true)
  } finally { f.dispose() }
})
test('断线保留卡片和分类，并禁止写操作', async () => {
  const f = fixture(); try {
    await f.controller.refresh(); f.runtimeState.connected = false; f.notify()
    assert.equal(f.controller.getSnapshot().connected, false)
    assert.equal(await f.controller.command({ type: 'settings', autoCollect: true }), false)
  } finally { f.dispose() }
})
test('打开原会话直接导航，归档和删除项不自动恢复', async () => {
  const f = fixture(); try {
    await f.controller.refresh(); assert.equal(await f.controller.openSession('a'), true); assert.deepEqual(f.opened, ['a'])
    f.runtimeState.sessions[0].archived = true; f.notify()
    assert.equal(await f.controller.openSession('a'), false); assert.deepEqual(f.opened, ['a'])
    assert.equal(await f.controller.openSession('missing'), false)
  } finally { f.dispose() }
})
