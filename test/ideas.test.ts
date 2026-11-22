import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IdeasStore, openIdeasStore } from '../src/host/ideas-store.ts'
import { IDEAS_DOMAIN, initialIdeasState, ideasStateSchema, type IdeaValues, type IdeasState } from '../src/shared/ideas.ts'

function fixture() {
  let data: IdeasState = initialIdeasState(); let fail = false; let writes = 0; let time = 100
  const store = new IdeasStore({ get: () => data, set: async next => { if (fail) throw new Error('模拟存储失败'); data = next; writes++ } }, () => ++time)
  return { store, saved: () => data, writes: () => writes, fail: (on: boolean) => { fail = on } }
}
const value = (overrides: Partial<IdeaValues> = {}): IdeaValues => ({ title: '一个点子', content: '点子的正文', kind: 'spark', tags: ['AI'], folderIds: [], sessionIds: [], ...overrides })

test('点子与多文件夹创建、搜索字段及会话 ID 安全持久化', async () => {
  const f = fixture(); const a = randomUUID(); const b = randomUUID(); const id = randomUUID()
  await f.store.command({ type: 'createFolder', id: a, value: { title: '第一个', summary: '摘要' } })
  await f.store.command({ type: 'createFolder', id: b, value: { title: '第二个', summary: '' } })
  await f.store.command({ type: 'createIdea', id, value: value({ folderIds: [a, b], sessionIds: ['native-session'] }) })
  const idea = f.store.snapshot().ideas[0]
  assert.deepEqual(idea.folderIds, [a, b]); assert.deepEqual(idea.sessionIds, ['native-session']); assert.equal(idea.version, 1)
  const reopened = new IdeasStore({ get: f.saved, set: async () => {} })
  assert.deepEqual(reopened.snapshot(), f.store.snapshot())
  assert.equal(JSON.stringify(reopened.snapshot()).includes('聊天正文'), false)
})

test('回收和恢复保留关联关系、正文与创建时间，不影响文件夹', async () => {
  const f = fixture(); const folder = randomUUID(); const id = randomUUID()
  await f.store.command({ type: 'createFolder', id: folder, value: { title: '分类', summary: '' } })
  await f.store.command({ type: 'createIdea', id, value: value({ folderIds: [folder] }) })
  const created = f.store.snapshot().ideas[0]
  await f.store.command({ type: 'trashIdea', id, expectedVersion: 1 })
  assert.ok(f.store.snapshot().ideas[0].trashedAt !== null)
  await f.store.command({ type: 'restoreIdea', id, expectedVersion: 2 })
  const restored = f.store.snapshot().ideas[0]
  assert.equal(restored.trashedAt, null); assert.equal(restored.createdAt, created.createdAt)
  assert.equal(restored.content, created.content); assert.deepEqual(restored.folderIds, [folder]); assert.equal(restored.version, 3)
})

test('删除文件夹只移除归类，连回收站内的点子也保留，旧编辑版本失效', async () => {
  const f = fixture(); const folder = randomUUID(); const a = randomUUID(); const b = randomUUID()
  await f.store.command({ type: 'createFolder', id: folder, value: { title: '分类', summary: '' } })
  for (const id of [a, b]) await f.store.command({ type: 'createIdea', id, value: value({ folderIds: [folder] }) })
  await f.store.command({ type: 'trashIdea', id: b, expectedVersion: 1 })
  await f.store.command({ type: 'deleteFolder', id: folder, expectedVersion: 1 })
  assert.equal(f.store.snapshot().folders.length, 0); assert.equal(f.store.snapshot().ideas.length, 2)
  assert.deepEqual(f.store.snapshot().ideas.map(item => item.folderIds), [[], []])
  await assert.rejects(f.store.command({ type: 'updateIdea', id: a, expectedVersion: 1, value: value() }), /其他窗口/)
  await f.store.command({ type: 'restoreIdea', id: b, expectedVersion: 3 })
  assert.equal(f.store.snapshot().ideas.find(item => item.id === b)?.trashedAt, null)
})

test('合并文件夹原子去重，包括回收站成员并保留目标信息', async () => {
  const f = fixture(); const source = randomUUID(); const target = randomUUID(); const a = randomUUID(); const b = randomUUID()
  await f.store.command({ type: 'createFolder', id: source, value: { title: '源', summary: '源摘要' } })
  await f.store.command({ type: 'createFolder', id: target, value: { title: '目标', summary: '目标摘要' } })
  await f.store.command({ type: 'createIdea', id: a, value: value({ folderIds: [source, target] }) })
  await f.store.command({ type: 'createIdea', id: b, value: value({ folderIds: [source] }) })
  await f.store.command({ type: 'trashIdea', id: b, expectedVersion: 1 })
  const command = { type: 'mergeFolder', sourceId: source, targetId: target, expectedSourceVersion: 1, expectedTargetVersion: 1 }
  const before = f.store.snapshot(); f.fail(true)
  await assert.rejects(f.store.command(command), /模拟存储失败/); assert.deepEqual(f.store.snapshot(), before)
  f.fail(false); await f.store.command(command)
  assert.deepEqual(f.store.snapshot().folders.map(folder => [folder.title, folder.summary]), [['目标', '目标摘要']])
  assert.deepEqual(f.store.snapshot().ideas.map(idea => idea.folderIds), [[target], [target]])
  assert.notEqual(f.store.snapshot().ideas.find(idea => idea.id === b)?.trashedAt, null)
})

test('创建按客户端 ID 幂等，冲突不覆盖，错误文件夹和非法数据不写入', async () => {
  const f = fixture(); const id = randomUUID(); const command = { type: 'createIdea', id, value: value() }
  await f.store.command(command); const writes = f.writes(); await f.store.command(command); assert.equal(f.writes(), writes)
  await assert.rejects(f.store.command({ ...command, value: value({ title: '不同标题' }) }), /已存在/)
  await assert.rejects(f.store.command({ type: 'createIdea', id: randomUUID(), value: value({ folderIds: [randomUUID()] }) }), /文件夹/)
  await assert.rejects(f.store.command({ type: 'createIdea', id: randomUUID(), value: value({ title: '  ' }) }), /参数无效/)
  await assert.rejects(f.store.command({ type: 'createIdea', id: randomUUID(), value: value({ sessionIds: [' bad '] }) }), /参数无效/)
  assert.equal(f.store.snapshot().ideas.length, 1); assert.equal(f.writes(), writes)
})

test('版本冲突、回收中编辑和保存失败均不覆盖数据，队列可继续写', async () => {
  const f = fixture(); const id = randomUUID(); await f.store.command({ type: 'createIdea', id, value: value() })
  await f.store.command({ type: 'updateIdea', id, expectedVersion: 1, value: value({ title: '新标题' }) })
  await assert.rejects(f.store.command({ type: 'updateIdea', id, expectedVersion: 1, value: value({ title: '旧窗口' }) }), /其他窗口/)
  const before = f.store.snapshot(); f.fail(true)
  await assert.rejects(f.store.command({ type: 'trashIdea', id, expectedVersion: 2 }), /模拟存储失败/)
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(f.saved(), before)
  f.fail(false); await f.store.command({ type: 'trashIdea', id, expectedVersion: 2 })
  await assert.rejects(f.store.command({ type: 'updateIdea', id, expectedVersion: 3, value: value() }), /回收站/)
})

test('独立存储域错误不清空、不触及关注域，关闭后拒绝写入', async () => {
  let spec: any; let closed = false
  const opened = await openIdeasStore({ open: async config => { spec = config; return { global: { get: initialIdeasState, set: async () => {} }, close: async () => { closed = true } } } })
  assert.equal(spec.name, IDEAS_DOMAIN); assert.notEqual(spec.name, 'ppyang010_task_workbench')
  await opened.close(); assert.equal(closed, true)
  await assert.rejects(opened.store.command({ type: 'createIdea', id: randomUUID(), value: value() }), /已关闭/)
  let failedClosed = false
  await assert.rejects(openIdeasStore({ open: async () => ({ global: { get: () => ({ schemaVersion: 99 }), set: async () => {} }, close: async () => { failedClosed = true } }) }))
  assert.equal(failedClosed, true)
  assert.equal(ideasStateSchema.safeParse({ ...initialIdeasState(), folders: [], ideas: [{ id: randomUUID(), ...value({ folderIds: [randomUUID()] }), version: 1, createdAt: 0, updatedAt: 0, trashedAt: null }] }).success, false)
})
