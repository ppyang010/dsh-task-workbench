import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { MyFocusBoard } from '../src/client/ui/Board.tsx'
import styles from '../src/client/ui/styles.css'
import { BoardController } from '../src/client/controller.ts'
import { WatchStore } from '../src/host/store.ts'
import { WorkbenchService } from '../src/host/service.ts'
import { initialState, type BoardState, type RuntimeSnapshot, type SessionView } from '../src/shared/model.ts'

// 此页只用于验证生产组件；目录和 RPC 均为本地合成数据，不连接真实 DSH。
const seed: Array<[string, string, string, SessionView['status']]> = [
  ['demo-1', '会话关注看板：需求与交互方案', '产品工作区', 'running'],
  ['demo-2', '侧栏体验优化与插件兼容', '插件实验室', 'running'],
  ['demo-3', '整理本周资料与阅读清单', '日常资料', 'unread'],
  ['demo-4', '新项目技术选型讨论', '个人项目', 'waiting'],
  ['demo-5', '产品发布说明与文案审核', '产品工作区', 'waiting'],
  ['demo-6', '周末旅行路线与预算', '日常资料', 'idle'],
  ['demo-7', '工作区目录整理与命名约定', '插件实验室', 'idle'],
  ['demo-8', '下月学习计划与书单', '日常资料', 'idle'],
]
const scenario = new URLSearchParams(location.search).get('scenario')
if (scenario === 'stress') for (let i = 9; i <= 32; i++) seed.push([`demo-${i}`, `滚动验证会话 ${i}：菜单与弹窗仍可操作`, '合成压力场景', 'idle'])
let board: BoardState = initialState()
const watched = scenario === 'focus-four' ? seed.slice(0, 4) : scenario === 'stress' ? seed : seed.slice(0, 6)
board.entries = watched.map((item, i) => ({ sessionId: item[0], columnId: scenario ? 'focus' : i < 3 ? 'focus' : i < 5 ? 'waiting' : 'later', note: scenario === 'focus-four' && i === 1 ? '这是一条用于验证长备注折叠的合成记录。'.repeat(18) : ['确认分类和入口，保留原有聊天方式。', '后台在跑，稍后回来查看结果。', '', '等我确认采用哪一种方案。', '先看看结果，再决定下一步。', '下周有空再继续。'][i] ?? '', source: i === 0 ? 'auto' : 'manual', addedAt: Date.now(), updatedAt: Date.now(), version: 1 }))
const store = new WatchStore({ get: () => board, set: async value => { board = value } })
const services = { sessionQuery: { listSessions: async () => seed.map(item => ({ header: { id: item[0] }, formatStatus: 'current' })) }, workspaceRegistry: { archivedSessionIds: [] as string[] } }
const service = new WorkbenchService(store, services)
const runtime: RuntimeSnapshot = { connected: true, ready: true, sessions: seed.map((item, i) => ({ id: item[0], title: item[1], workspaceId: item[2], workspaceTitle: item[2], updatedAt: Date.now() - i * 120000, status: item[3], archived: false, missing: false, subagent: false, openable: true, ...(item[3] === 'waiting' ? { waitingLabel: '等待回答' } : {}) })) }
const observers = new Set<() => void>()
const publish = () => { for (const listener of observers) listener() }
let failNext = false
const controller = new BoardController({ call: async (_channel, method, payload: any) => {
  await new Promise(resolve => setTimeout(resolve, 80))
  if (method.endsWith('/mutate') && failNext) { failNext = false; return { ok: true, value: { ok: false, error: { message: '模拟保存失败：草稿保留，请再次保存' } } } }
  try {
    const value = method.endsWith('/mutate') ? await service.mutate(payload.args.request) : service.read()
    document.documentElement.dataset.demoRevision = String(value.revision)
    return { ok: true, value: { ok: true, value } }
  }
  catch (error) { return { ok: true, value: { ok: false, error: { message: error instanceof Error ? error.message : '示例操作失败' } } } }
} }, {
  snapshot: () => runtime,
  subscribe: listener => { observers.add(listener); return () => { observers.delete(listener) } },
  refresh: async () => { publish() },
  open: async id => { const result = document.querySelector('#demo-result')!; result.textContent = `已验证导航目标：${id}（仅合成会话，实际插件打开原会话页）`; result.setAttribute('data-opened', id) },
})
const sheet = document.createElement('style'); sheet.textContent = styles; document.head.append(sheet)
controller.start(); controller.activate()
const sandbox = document.createElement('div')
sandbox.style.cssText = 'padding:10px 24px;background:#ebf1ff;color:#526b9b;font:12px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;'
sandbox.innerHTML = '<strong>合成会话验证 · 生产组件</strong><span>不连接真实 DSH，刷新重置。</span><button id="demo-offline">模拟断线</button><button id="demo-turn">模拟新一轮</button><button id="demo-failure">下一次保存失败</button><button id="demo-dark">切换深色</button><span id="demo-result" role="status"></span>'
document.body.prepend(sandbox)
document.querySelector('#demo-offline')!.addEventListener('click', () => { runtime.connected = !runtime.connected; document.querySelector('#demo-offline')!.textContent = runtime.connected ? '模拟断线' : '恢复连接'; publish() })
document.querySelector('#demo-failure')!.addEventListener('click', () => { failNext = true; document.querySelector('#demo-result')!.textContent = '下一次修改将模拟保存失败' })
document.querySelector('#demo-dark')!.addEventListener('click', () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; document.documentElement.style.setProperty('--dsw-bg', dark ? '#171c19' : '#f6f7f3'); document.documentElement.style.setProperty('--dsw-text-primary', dark ? '#e2e8de' : '#283226') })
document.querySelector('#demo-turn')!.addEventListener('click', async () => { const id = 'demo-7'; runtime.sessions.find(s => s.id === id)!.status = 'running'; publish(); await service.onSessionEvent({ id, header: { id } }, { type: 'turn/start' }); await controller.refresh(); document.querySelector('#demo-result')!.textContent = '已模拟 demo-7 开始新一轮' })
createRoot(document.querySelector('#app')!).render(<MyFocusBoard controller={controller} onNewSession={() => { document.querySelector('#demo-result')!.setAttribute('data-new-session', 'true') }} />)
