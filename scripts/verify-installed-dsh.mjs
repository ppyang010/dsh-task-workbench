import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
await build({ entryPoints: [join(root, 'src/host/index.ts')], outfile: join(artifacts, 'host.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', minify: false, plugins: [{ name: '安装版本接口绑定', setup(builder) {
  builder.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: official(args.path.slice('@deepseek-ai/'.length)), external: true }))
} }] })
const host = await import(pathToFileURL(join(artifacts, 'host.mjs')).href)
const peer = { id: 'compat-fixture', principal: { kind: 'owner' }, signal: new AbortController().signal }
const nativeVersion = JSON.parse(await readFile(join(installed, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
async function open() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(artifacts, 'data') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  ctx.provide('sessionQuery', { listSessions: async () => [{ header: { id: 'fixture-main' }, formatStatus: 'current' }, { header: { id: 'fixture-fork', parentSession: 'fixture-main', isSeeded: true }, formatStatus: 'current' }] })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: '仅 owner 测试' }) })
  await ctx.plugin(Typert)
  await ctx.plugin(Gateway, {})
  await ctx.plugin(host)
  const call = async (method, args = {}) => {
    const wire = await ctx.get('typertGateway').invokeRpc(`ppyangTaskWorkbench/${method}`, { args }, new AbortController().signal, peer)
    if (!wire.ok) throw Object.assign(new Error(wire.error.message), wire.error)
    return wire.value
  }
  const invalidEnvelope = await ctx.get('typertGateway').invokeRpc('ppyangTaskWorkbench/read', {}, new AbortController().signal, peer)
  assert.equal(invalidEnvelope.ok, false, '真实 RPC 必须拒绝缺少 args 的 payload')
  const initial = await call('read')
  assert.equal(initial.ok, true, JSON.stringify(initial))
  return { ctx, call }
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
  const invalid = await current.call('mutate', { request: { type: 'delete-session', sessionId: 'fixture-main' } })
  assert.equal(invalid.ok, false)
  await assert.rejects(current.call('mutate', { unknown: {} }), { code: 'gateway/arguments-invalid' })
  await current.ctx.fiber.dispose()
  current = await open()
  result = await current.call('read')
  assert.equal(result.value.settings.autoCollect, true)
  assert.equal(result.value.entries.find(entry => entry.sessionId === 'fixture-main').columnId, 'later')
  console.log(JSON.stringify({ dshVersion: nativeVersion, passed: ['真实 Cordis 插件注入', '真实 Typert Gateway 认证 owner 调用及参数校验', '真实 storageDomain + JSON 原子落盘', '普通 fork 自动纳入且不改变已有分类', '关闭后重新挂载恢复关注与开关'], scope: '使用已安装 DSH 官方服务和合成会话；不接触运行中的 GUI 或真实会话。' }, null, 2))
} finally { await current.ctx.fiber.dispose() }
