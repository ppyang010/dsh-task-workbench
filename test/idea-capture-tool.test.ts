import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IdeasStore } from '../src/host/ideas-store.ts'
import { createIdeaCaptureTool, IDEA_CAPTURE_TOOL, ideaIdForCall } from '../src/host/idea-capture-tool.ts'
import { initialIdeasState, type IdeasState } from '../src/shared/ideas.ts'

function fixture() {
  let data: IdeasState = initialIdeasState(); let writes = 0; let fail = false
  const store = new IdeasStore({ get: () => data, set: async next => { if (fail) throw new Error('存储异常'); data = next; writes++ } })
  const tool = createIdeaCaptureTool(Promise.resolve(store))
  const execute = (args: unknown, sessionId = 'session-real', callId = 'call-1') => tool.execute(args, { callId, signal: new AbortController().signal, agent: { session: { id: sessionId } } })
  return { tool, store, execute, writes: () => writes, fail: () => { fail = true } }
}
const input = { title: '新点子', content: '  用户指定的内容\n第二行  ' }

test('会话工具只保存明确传入内容，关联真实执行会话并保留原文', async () => {
  const f = fixture()
  const result = await f.execute({ ...input, kind: 'plugin', tags: ['DSH', '体验'] })
  const idea = f.store.snapshot().ideas[0]
  assert.match(result, /已保存到「我的任务工作台 → 点子」/); assert.match(result, /已关联当前会话/)
  assert.equal(idea.title, input.title); assert.equal(idea.content, input.content)
  assert.deepEqual(idea.sessionIds, ['session-real']); assert.deepEqual(idea.folderIds, [])
  assert.equal(idea.kind, 'plugin'); assert.deepEqual(idea.tags, ['DSH', '体验'])
  assert.equal(f.tool.name, IDEA_CAPTURE_TOOL)
  assert.equal(Object.hasOwn(f.tool.parameters.properties, 'session_id'), false)
  assert.equal(f.tool.parameters.additionalProperties, false)
})

test('相同会话和调用标识重放幂等，不同会话或不同调用可记录同名点子', async () => {
  const f = fixture()
  const [first, concurrent] = await Promise.all([f.execute(input), f.execute(input)])
  assert.equal(concurrent, first)
  assert.equal(await f.execute(input), first); assert.equal(f.writes(), 1)
  await f.execute(input, 'session-real', 'call-2'); await f.execute(input, 'other-session', 'call-1')
  assert.equal(f.store.snapshot().ideas.length, 3); assert.equal(f.writes(), 3)
  assert.notEqual(ideaIdForCall('session-real', 'call-1'), ideaIdForCall('other-session', 'call-1'))
  await assert.rejects(f.execute({ ...input, content: '不同内容' }), /可能已保存/)
  assert.equal(f.writes(), 3)
})

test('禁止模型指定会话 ID，缺失真实会话或调用身份时不保存', async () => {
  const f = fixture()
  await assert.rejects(f.tool.execute({ ...input, session_id: 'spoofed' }, { callId: '1', agent: { session: { id: 'real' } } }), /不能传入会话 ID/)
  await assert.rejects(f.tool.execute(input, { callId: '1' }), /会话身份/)
  await assert.rejects(f.tool.execute(input, { callId: '', agent: { session: { id: 'real' } } }), /调用标识/)
  await assert.rejects(f.tool.execute(input, { callId: '1', agent: { session: { id: ' invalid ' } } }), /会话身份/)
  assert.equal(f.writes(), 0)
})

test('空内容、非法分类、重复标签和超长内容均拒绝且不写数据', async () => {
  const f = fixture()
  for (const args of [{ ...input, content: ' \n ' }, { ...input, kind: 'other' }, { ...input, tags: ['a', 'a'] }, { ...input, content: 'x'.repeat(40001) }, { ...input, title: '' }]) {
    await assert.rejects(f.execute(args), /未保存/)
  }
  assert.equal(f.store.snapshot().ideas.length, 0)
})

test('工具不读取会话正文或历史，保存失败不伪报成功', async () => {
  const f = fixture()
  const session = new Proxy({ id: 'session-real' }, { get(target, key) { if (key !== 'id') throw new Error(`不应读取 ${String(key)}`); return target.id } })
  f.fail()
  await assert.rejects(f.tool.execute(input, { callId: 'call-1', agent: { session } }), /保存失败或状态不明/)
  assert.equal(f.store.snapshot().ideas.length, 0)
})

test('存储尚未就绪时用户取消，工具及时结束而不等待初始化', async () => {
  const abort = new AbortController()
  const tool = createIdeaCaptureTool(new Promise(() => {}))
  const pending = tool.execute(input, { callId: 'waiting', agent: { session: { id: 'session-real' } }, signal: abort.signal })
  abort.abort()
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
})

test('排队等待时用户取消，不写入点子', async () => {
  let data = initialIdeasState(); let enter!: () => void; let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstWrite = true
  const store = new IdeasStore({ get: () => data, set: async next => { if (firstWrite) { firstWrite = false; enter(); await gate }; data = next } })
  const blocker = store.command({ type: 'createFolder', id: randomUUID(), value: { title: '测试', summary: '' } })
  await entered
  const abort = new AbortController(); const tool = createIdeaCaptureTool(Promise.resolve(store))
  const pending = tool.execute(input, { callId: 'call-queued', agent: { session: { id: 'session-real' } }, signal: abort.signal })
  await Promise.resolve(); abort.abort(); release(); await blocker
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
  assert.equal(store.snapshot().ideas.length, 0); assert.equal(store.snapshot().folders.length, 1)
})
