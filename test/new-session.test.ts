import test from 'node:test'
import assert from 'node:assert/strict'
import { openNewSessionPage, type WorkspaceList } from '../src/client/runtime.ts'

function fixture() {
  const catalog: WorkspaceList = { phase: 'ready', archivedSessionIds: [], items: [
    { workspaceId: 'current-workspace', title: '同名工作区', sessionIds: ['current-session'] },
    { workspaceId: 'filtered-workspace', title: '同名工作区', sessionIds: ['other-session'] },
  ] }
  const selected: { sessionId?: string } = { sessionId: 'current-session' }
  const calls: string[] = []
  let open = async (_id: string) => {}
  const services: Record<string, unknown> = {
    workspaces: { list: { getSnapshot: () => catalog } },
    uiWorkspace: { selection: { getSnapshot: () => selected }, openWorkspace: async (id: string) => { calls.push(id); await open(id) }, clearMain: () => { calls.push('picker') } },
  }
  return { catalog, selected, calls, setOpen: (fn: typeof open) => { open = fn }, ctx: { get: (name: string) => { assert.ok(name in services, '不访问模型或直接创建/发送服务'); return services[name] } } }
}

test('筛选工作区优先于当前工作区，同名工作区按 ID 区分', async () => {
  const f = fixture()
  await openNewSessionPage(f.ctx, 'filtered-workspace')
  assert.deepEqual(f.calls, ['filtered-workspace'])
  assert.equal(f.selected.sessionId, 'current-session', '调用原生导航前不清除当前会话或草稿')
})

test('全部工作区或失效筛选回退到原生当前会话工作区', async () => {
  const f = fixture()
  await openNewSessionPage(f.ctx)
  await openNewSessionPage(f.ctx, 'removed-workspace')
  assert.deepEqual(f.calls, ['current-workspace', 'current-workspace'])
})

test('没有有效工作区时进入选择页；没有当前会话仍可采用有效筛选', async () => {
  const f = fixture()
  delete f.selected.sessionId
  await openNewSessionPage(f.ctx, 'filtered-workspace')
  await openNewSessionPage(f.ctx)
  f.selected.sessionId = 'deleted-session'
  await openNewSessionPage(f.ctx, 'removed-workspace')
  assert.deepEqual(f.calls, ['filtered-workspace', 'picker', 'picker'])
})

test('工作区目录未就绪时拒绝导航，不误选其他工作区', async () => {
  const f = fixture()
  f.catalog.phase = 'loading'
  await assert.rejects(openNewSessionPage(f.ctx, 'filtered-workspace'), /目录尚未就绪/)
  assert.deepEqual(f.calls, [])
})

test('等待原生异步导航，失败传播且不先清空当前会话', async () => {
  const f = fixture()
  let reject!: (error: Error) => void
  f.setOpen(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const attempt = openNewSessionPage(f.ctx, 'filtered-workspace')
  reject(new Error('工作区已移除'))
  await assert.rejects(attempt, /工作区已移除/)
  assert.deepEqual(f.calls, ['filtered-workspace'])
  assert.equal(f.selected.sessionId, 'current-session')
})
