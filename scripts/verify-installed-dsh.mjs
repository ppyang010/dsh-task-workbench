import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

// 显式指定待验证的安装目录；所有测试记录只写当前工程的 .artifacts。
const installed = process.env.DSH_IMPLEMENTATION_ROOT
assert.ok(installed, '请设置 DSH_IMPLEMENTATION_ROOT 为要验证的 DSH 安装目录')
const root = resolve(new URL('../', import.meta.url).pathname)
const artifacts = join(root, '.artifacts', 'installed-dsh')
await mkdir(artifacts, { recursive: true })
const official = name => join(installed, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
const load = name => import(pathToFileURL(official(name)).href)
const { Context } = await load('cordis')
const { default: Storage } = await load('dsh-storage')
const storageJson = await load('dsh-storage-json')
const storageDomain = await load('dsh-storage-domain')
const { default: Typert } = await load('dsh-typert-registry')
const { default: Gateway } = await load('dsh-api-gateway')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: Tools } = await load('dsh-tools')
const NativeTools = await load('dsh-tool-executor-native')
const { default: WorkspaceRegistry } = await load('dsh-workspace')
await build({ entryPoints: [join(root, 'src/host/index.ts')], outfile: join(artifacts, 'host.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', minify: false, plugins: [{ name: '安装版本接口绑定', setup(builder) {
  builder.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: official(args.path.slice('@deepseek-ai/'.length)), external: true }))
} }] })
const host = await import(pathToFileURL(join(artifacts, 'host.mjs')).href)
const peer = { id: 'compat-fixture', principal: { kind: 'owner' }, signal: new AbortController().signal }
const nativeVersion = JSON.parse(await readFile(join(installed, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
async function open(withTools = true) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(artifacts, 'data') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  ctx.provide('sessionQuery', { listSessions: async () => [{ header: { id: 'fixture-main' }, formatStatus: 'current' }, { header: { id: 'fixture-fork', parentSession: 'fixture-main', isSeeded: true }, formatStatus: 'current' }] })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: id => id === 'fixture-workspace' ? { sessionIds: ['fixture-main'] } : id === 'fixture-other' ? { sessionIds: ['fixture-fork'] } : undefined })
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: '仅 owner 测试' }) })
  await ctx.plugin(Typert)
  await ctx.plugin(Gateway, {})
  if (withTools) {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools, {})
    await ctx.plugin(NativeTools)
  }
  const hostFiber = ctx.plugin(host)
  await hostFiber
  const call = async (method, args = {}) => {
    const wire = await ctx.get('typertGateway').invokeRpc(`ppyangTaskWorkbench/${method}`, { args }, new AbortController().signal, peer)
    if (!wire.ok) throw Object.assign(new Error(wire.error.message), wire.error)
    return wire.value
  }
  const callIdea = async (method, args = {}) => {
    const wire = await ctx.get('typertGateway').invokeRpc(`ppyangTaskWorkbenchIdeas/${method}`, { args }, new AbortController().signal, peer)
    if (!wire.ok) throw Object.assign(new Error(wire.error.message), wire.error)
    return wire.value
  }
  const callGroupOrder = async (method, args = {}) => {
    const wire = await ctx.get('typertGateway').invokeRpc(`ppyangTaskWorkbenchGroupOrder/${method}`, { args }, new AbortController().signal, peer)
    if (!wire.ok) throw Object.assign(new Error(wire.error.message), wire.error)
    return wire.value
  }
  const invalidGroupEnvelope = await ctx.get('typertGateway').invokeRpc('ppyangTaskWorkbenchGroupOrder/read', {}, new AbortController().signal, peer)
  assert.equal(invalidGroupEnvelope.ok, false, '分组排序 RPC 同样要求 args 信封')
  const invalidIdeaEnvelope = await ctx.get('typertGateway').invokeRpc('ppyangTaskWorkbenchIdeas/read', {}, new AbortController().signal, peer)
  assert.equal(invalidIdeaEnvelope.ok, false, '点子 RPC 同样要求 args 信封')
  const invalidEnvelope = await ctx.get('typertGateway').invokeRpc('ppyangTaskWorkbench/read', {}, new AbortController().signal, peer)
  assert.equal(invalidEnvelope.ok, false, '真实 RPC 必须拒绝缺少 args 的 payload')
  const initial = await call('read')
  assert.equal(initial.ok, true, JSON.stringify(initial))
  return { ctx, call, callIdea, callGroupOrder, hostFiber }
}
let current = await open()
try {
  await current.call('mutate', { request: { type: 'unfollow', sessionId: 'fixture-main' } })
  let result = await current.call('mutate', { request: { type: 'add', sessionIds: ['fixture-main'], columnId: 'later' } })
  assert.equal(result.ok, true)
  await current.call('mutate', { request: { type: 'settings', autoCollect: true } })
  await current.ctx.parallel('session/event', { id: 'fixture-fork', header: { id: 'fixture-fork', parentSession: 'fixture-main', isSeeded: true } }, { type: 'turn/start' })
  // 事件监听器不阻塞原会话，在存储队列排空后检查结果。
  result = await current.call('read')
  if (!result.value.entries.some(entry => entry.sessionId === 'fixture-fork')) {
    await new Promise(resolve => setTimeout(resolve, 50))
    result = await current.call('read')
  }
  assert.ok(result.value.entries.some(entry => entry.sessionId === 'fixture-fork'))
  assert.equal(result.value.entries.find(entry => entry.sessionId === 'fixture-main').columnId, 'later')
  const beforeSortBoard = structuredClone(result.value)
  const existingGroupOrder = await current.callGroupOrder('read')
  assert.equal(existingGroupOrder.ok, true)
  const activeIds = ['fixture-workspace', 'fixture-other']
  const savedIds = existingGroupOrder.value.columns.focus.filter(id => activeIds.includes(id))
  const workspaceIds = [...savedIds, ...activeIds.filter(id => !savedIds.includes(id))]
  const sortedGroups = await current.callGroupOrder('mutate', { request: { columnId: 'focus', workspaceIds, sourceId: workspaceIds[1], beforeId: workspaceIds[0], expectedOrderRevision: existingGroupOrder.value.revision, expectedBoardRevision: beforeSortBoard.revision } })
  assert.equal(sortedGroups.ok, true, JSON.stringify(sortedGroups))
  assert.deepEqual(sortedGroups.value.columns.focus.filter(id => activeIds.includes(id)), [workspaceIds[1], workspaceIds[0]])
  assert.deepEqual((await current.call('read')).value, beforeSortBoard, '分组排序不能更改关注记录或分类')
  const oldMove = await current.call('mutate', { request: { type: 'moveGroup', workspaceId: 'fixture-workspace', sessionIds: ['fixture-main'], columnId: 'waiting', expectedRevision: beforeSortBoard.revision } })
  assert.equal(oldMove.ok, false, '已撤销错误的整组跨分类接口')
  const invalid = await current.call('mutate', { request: { type: 'delete-session', sessionId: 'fixture-main' } })
  assert.equal(invalid.ok, false)
  await assert.rejects(current.call('mutate', { unknown: {} }), { code: 'gateway/arguments-invalid' })
  result = await current.call('read')
  const saved = result.value.entries.find(entry => entry.sessionId === 'fixture-main')
  result = await current.call('mutate', { request: { type: 'note', sessionId: saved.sessionId, note: '真实存储重开后的取消快照验证', expectedVersion: saved.version } })
  assert.equal(result.ok, true)
  result = await current.call('mutate', { request: { type: 'unfollow', sessionId: saved.sessionId } })
  assert.equal(result.ok, true)
  assert.equal(result.value.removedEntries.find(item => item.entry.sessionId === saved.sessionId).entry.note, '真实存储重开后的取消快照验证')
  const capture = current.ctx.get('tools').schemas().find(tool => tool.name === 'task_workbench_save_idea')
  assert.ok(capture, 'AI 会话点子工具应在真实注册表中可见')
  const assembly = await current.ctx.get('systemPrompt').assemble()
  assert.ok(assembly.sections.some(section => section.name === 'plugin:task-workbench-ideas' && section.text.includes('仅保存用户明确指定的内容')), '应向 AI 传达明确请求和隐私边界')
  assert.ok(assembly.tools.some(tool => tool.name === 'task_workbench_save_idea'), 'AI 系统提示应能看到点子工具')
  assert.equal(Object.hasOwn(capture.parameters.properties, 'session_id'), false)
  const captureCallId = randomUUID()
  const captureTitle = `合成会话点子 ${captureCallId}`
  const toolInput = { calls: [{ type: 'tool-call', id: captureCallId, name: 'task_workbench_save_idea', arguments: JSON.stringify({ title: captureTitle, content: '仅本次合成输入' }) }], agent: { session: { id: 'fixture-main' } }, signal: new AbortController().signal }
  const dispatched = await current.ctx.get('tools').execute(toolInput)
  assert.equal(dispatched.results.length, 1)
  assert.notEqual(dispatched.results[0].result.isError, true, JSON.stringify(dispatched.results[0].result))
  assert.match(dispatched.results[0].result.content[0].text, /已保存/)
  const repeated = await current.ctx.get('tools').execute({ ...toolInput, signal: new AbortController().signal })
  assert.notEqual(repeated.results[0].result.isError, true)
  const snapshotFromTool = await current.callIdea('read')
  const toolSaved = snapshotFromTool.value.ideas.filter(item => item.title === captureTitle && item.content === '仅本次合成输入' && item.sessionIds.includes('fixture-main'))
  assert.equal(toolSaved.length, 1, '同一调用重放不应重复保存')
  const capturedId = toolSaved[0].id
  const badInput = { calls: [{ type: 'tool-call', id: randomUUID(), name: 'task_workbench_save_idea', arguments: JSON.stringify({ title: '不可伪造', content: '合成内容', session_id: 'other-session' }) }], agent: { session: { id: 'fixture-main' } }, signal: new AbortController().signal }
  const rejected = await current.ctx.get('tools').execute(badInput)
  assert.equal(rejected.results[0].result.isError, true, '模型不能自行指定会话身份')
  const afterRejection = await current.callIdea('read')
  assert.equal(afterRejection.value.ideas.length, snapshotFromTool.value.ideas.length)
  const folderId = randomUUID(); const ideaId = randomUUID()
  const folderResult = await current.callIdea('mutate', { request: { type: 'createFolder', id: folderId, value: { title: '合成点子文件夹', summary: '合成摘要' } } })
  assert.equal(folderResult.ok, true)
  let ideaResult = await current.callIdea('mutate', { request: { type: 'createIdea', id: ideaId, value: { title: '合成点子', content: '合成内容', kind: 'spark', tags: ['测试'], folderIds: [folderId], sessionIds: ['fixture-main'] } } })
  assert.equal(ideaResult.ok, true)
  ideaResult = await current.callIdea('mutate', { request: { type: 'trashIdea', id: ideaId, expectedVersion: 1 } })
  assert.notEqual(ideaResult.value.ideas.find(item => item.id === ideaId).trashedAt, null)
  await current.ctx.fiber.dispose()
  current = await open()
  assert.deepEqual((await current.callGroupOrder('read')).value, sortedGroups.value, '分组顺序在宿主重开后应保留')
  ideaResult = await current.callIdea('read')
  assert.equal(ideaResult.value.ideas.find(item => item.id === capturedId)?.content, '仅本次合成输入', 'AI 会话保存重启后应保留')
  const replayAfterRestart = await current.ctx.get('tools').execute({ ...toolInput, signal: new AbortController().signal })
  assert.notEqual(replayAfterRestart.results[0].result.isError, true)
  assert.equal((await current.callIdea('read')).value.ideas.filter(item => item.id === capturedId).length, 1, '同一次工具调用在宿主重启后重放也不应重复')
  const storedIdea = ideaResult.value.ideas.find(item => item.id === ideaId)
  assert.equal(storedIdea.content, '合成内容'); assert.deepEqual(storedIdea.folderIds, [folderId]); assert.deepEqual(storedIdea.sessionIds, ['fixture-main'])
  ideaResult = await current.callIdea('mutate', { request: { type: 'restoreIdea', id: ideaId, expectedVersion: storedIdea.version } })
  assert.equal(ideaResult.value.ideas.find(item => item.id === ideaId).trashedAt, null)
  result = await current.call('read')
  assert.equal(result.value.settings.autoCollect, true)
  assert.ok(!result.value.entries.some(entry => entry.sessionId === saved.sessionId))
  assert.ok(result.value.excludedSessionIds.includes(saved.sessionId))
  assert.equal(result.value.removedEntries.find(item => item.entry.sessionId === saved.sessionId).entry.columnId, 'later')
  result = await current.call('mutate', { request: { type: 'restore', sessionId: saved.sessionId } })
  assert.equal(result.ok, true)
  assert.equal(result.value.entries.find(entry => entry.sessionId === saved.sessionId).columnId, 'later')
  assert.equal(result.value.entries.find(entry => entry.sessionId === saved.sessionId).note, '真实存储重开后的取消快照验证')
  assert.ok(!result.value.excludedSessionIds.includes(saved.sessionId))
  assert.ok(!result.value.removedEntries.some(item => item.entry.sessionId === saved.sessionId))
  current.ctx.get('workspaceRegistry').archivedSessionIds = [saved.sessionId]
  result = await current.call('read')
  assert.ok(!result.value.entries.some(entry => entry.sessionId === saved.sessionId))
  assert.equal(result.value.removedEntries.find(item => item.entry.sessionId === saved.sessionId).entry.note, '真实存储重开后的取消快照验证')
  current.ctx.get('workspaceRegistry').archivedSessionIds = []
  result = await current.call('read')
  assert.ok(!result.value.entries.some(entry => entry.sessionId === saved.sessionId), '取消归档不自动恢复关注')
  await current.hostFiber.dispose()
  assert.equal(current.ctx.get('tools').schemas().some(tool => tool.name === 'task_workbench_save_idea'), false, '卸载工作台应注销会话工具')
  assert.equal((await current.ctx.get('systemPrompt').assemble()).sections.some(section => section.name === 'plugin:task-workbench-ideas'), false, '卸载工作台应注销提示段')
  console.log(JSON.stringify({ groupOrder: '真实 RPC 分组排序不改变关注分类', ideaCapture: '真实工具注册、执行、会话关联与同次调用去重通过', ideaDomain: '真实 RPC 信封、独立存储、回收及重启恢复通过', archiveAutoUnfollow: '真实 RPC 读取清理与取消归档不复活通过', dshVersion: nativeVersion, passed: ['真实 Cordis 插件注入', '真实 Typert Gateway 认证 owner 调用及参数校验', '真实 storageDomain + JSON 原子落盘', '普通 fork 自动纳入且不改变已有分类', '关闭后重新挂载保留取消快照、排除及开关，再原子恢复备注与分类'], scope: '使用已安装 DSH 官方服务和合成会话；不接触运行中的 GUI 或真实会话。' }, null, 2))
} finally { await current.ctx.fiber.dispose() }
// 没有可选 tools 服务时，原有工作台和点子 RPC 仍可使用。
const withoutTools = await open(false)
try {
  assert.equal((await withoutTools.callIdea('read')).ok, true)
  await withoutTools.ctx.plugin(SystemPrompt, {})
  await withoutTools.ctx.plugin(Tools, {})
  await withoutTools.ctx.plugin(NativeTools)
  assert.ok(withoutTools.ctx.get('tools').schemas().some(tool => tool.name === 'task_workbench_save_idea'), '工具服务稍后上线时应自动注册')
} finally { await withoutTools.ctx.fiber.dispose() }
console.log('可选工具服务缺失时工作台仍可启动，服务稍后上线时工具自动注册。')

// 用官方工作区服务和合成会话检验 get(id).sessionIds 的真实契约；所有文件仅在 artifacts 内。
const isolated = join(artifacts, `native-workspace-${randomUUID()}`)
const workspacePaths = [join(isolated, 'work-a'), join(isolated, 'work-b')]
for (const path of workspacePaths) await mkdir(path, { recursive: true })
const nativeCtx = new Context()
try {
  await nativeCtx.plugin(Storage)
  await nativeCtx.plugin(storageJson, { root: join(isolated, 'data') })
  await nativeCtx.plugin(storageDomain, { backend: 'json' })
  const headers = ['native-fixture-a', 'native-fixture-b'].map((id, index) => ({ id, cwd: workspacePaths[index], createdAt: Date.now() + index }))
  nativeCtx.provide('sessionPersistence', { list: async () => headers.map(header => ({ header })) })
  nativeCtx.provide('sessionQuery', { listSessions: async () => headers.map(header => ({ header, formatStatus: 'current' })) })
  nativeCtx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: '仅 owner 测试' }) })
  await nativeCtx.plugin(WorkspaceRegistry)
  await nativeCtx.plugin(Typert)
  await nativeCtx.plugin(Gateway, {})
  await nativeCtx.plugin(host)
  const registry = nativeCtx.get('workspaceRegistry')
  const workspaces = headers.map(header => registry.list().find(item => item.sessionIds.includes(header.id)))
  assert.ok(workspaces.every(Boolean), '官方工作区注册表应提供两个合成工作区')
  assert.notEqual(workspaces[0].id, workspaces[1].id)
  const invoke = async (method, args = {}) => {
    const wire = await nativeCtx.get('typertGateway').invokeRpc(`ppyangTaskWorkbench/${method}`, { args }, new AbortController().signal, peer)
    assert.equal(wire.ok, true, JSON.stringify(wire)); return wire.value
  }
  const added = await invoke('mutate', { request: { type: 'add', sessionIds: headers.map(header => header.id), columnId: 'focus' } })
  assert.equal(added.ok, true)
  const groupInvoke = async (method, args = {}) => {
    const wire = await nativeCtx.get('typertGateway').invokeRpc(`ppyangTaskWorkbenchGroupOrder/${method}`, { args }, new AbortController().signal, peer)
    assert.equal(wire.ok, true, JSON.stringify(wire)); return wire.value
  }
  const initial = await groupInvoke('read')
  const ids = workspaces.map(item => item.id)
  const sorted = await groupInvoke('mutate', { request: { columnId: 'focus', workspaceIds: ids, sourceId: ids[1], beforeId: ids[0], expectedOrderRevision: initial.value.revision, expectedBoardRevision: added.value.revision } })
  assert.equal(sorted.ok, true, JSON.stringify(sorted))
  assert.deepEqual(sorted.value.columns.focus, [ids[1], ids[0]])
  assert.deepEqual((await invoke('read')).value, added.value, '排序不能改变关注记录及分类')
  for (let i = 0; i < workspaces.length; i++) assert.ok(registry.get(workspaces[i].id).sessionIds.includes(headers[i].id), '原生工作区成员不应改变')
  console.log('官方 WorkspaceRegistry + 真实 RPC：合成分组排序通过，关注分类与原生工作区保持不变。')
} finally { await nativeCtx.fiber.dispose() }
