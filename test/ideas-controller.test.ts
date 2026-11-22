import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IdeasController } from '../src/client/ideas-controller.ts'
import { IdeasStore } from '../src/host/ideas-store.ts'
import { IDEAS_RPC, initialIdeasState, type IdeasState } from '../src/shared/ideas.ts'

function fixture() {
  let persisted: IdeasState = initialIdeasState(); let deny = false
  const store = new IdeasStore({ get: () => persisted, set: async next => { if (deny) throw new Error('模拟保存失败'); persisted = next } })
  const requests: Array<[string, string, unknown]> = []
  const rpc = { call: async (channel: string, endpoint: string, payload: any) => {
    requests.push([channel, endpoint, payload])
    assert.equal(channel, '/api'); assert.ok(endpoint.startsWith(`${IDEAS_RPC}/`))
    assert.deepEqual(Object.keys(payload), ['args'], '真实 RPC 只允许 args 信封')
    try {
      const value = endpoint.endsWith('/read') ? store.snapshot() : await store.command(payload.args.request)
      return { ok: true, value: { ok: true, value } }
    } catch (error) { return { ok: true, value: { ok: false, error: { message: error instanceof Error ? error.message : '失败' } } } }
  } }
  return { rpc, store, requests, setFail: (value: boolean) => { deny = value } }
}
const value = { title: '测试点子', content: '正文', kind: 'spark' as const, tags: ['笔记'], folderIds: [], sessionIds: [] }

test('点子读写使用独立认证 RPC 信封，并在成功后同步状态', async () => {
  const f = fixture(); const c = new IdeasController(f.rpc); const id = randomUUID()
  try {
    await c.refresh(); assert.deepEqual(f.requests[0], ['/api', `${IDEAS_RPC}/read`, { args: {} }])
    assert.equal(await c.command({ type: 'createIdea', id, value }), true)
    assert.equal(c.getSnapshot().data.ideas[0].title, '测试点子')
    assert.deepEqual(f.requests[1], ['/api', `${IDEAS_RPC}/mutate`, { args: { request: { type: 'createIdea', id, value } } }])
  } finally { c.dispose() }
})

test('保存失败和跨窗口版本冲突均保留服务端记录并显示错误', async () => {
  const f = fixture(); const a = new IdeasController(f.rpc); const b = new IdeasController(f.rpc); const id = randomUUID()
  try {
    await a.refresh(); await a.command({ type: 'createIdea', id, value }); await b.refresh()
    await a.command({ type: 'updateIdea', id, expectedVersion: 1, value: { ...value, title: '新版本' } })
    assert.equal(await b.command({ type: 'updateIdea', id, expectedVersion: 1, value: { ...value, title: '旧版本' } }), false)
    assert.match(b.getSnapshot().error ?? '', /其他窗口/); assert.equal(b.getSnapshot().data.ideas[0].title, '新版本')
    f.setFail(true)
    assert.equal(await a.command({ type: 'trashIdea', id, expectedVersion: 2 }), false)
    assert.match(a.getSnapshot().error ?? '', /模拟保存失败/); assert.equal(f.store.snapshot().ideas[0].trashedAt, null)
    assert.equal(a.getSnapshot().saving, false)
  } finally { a.dispose(); b.dispose() }
})

test('网络失败返回明确错误，不假装成功或覆盖现有状态', async () => {
  const c = new IdeasController({ call: async () => ({ ok: false }) })
  try { await c.refresh(); assert.match(c.getSnapshot().error ?? '', /无法连接点子服务/); assert.equal(c.getSnapshot().loading, false); assert.equal(c.getSnapshot().loaded, false); assert.equal(await c.command({ type: 'createIdea', id: randomUUID(), value }), false) }
  finally { c.dispose() }
})
