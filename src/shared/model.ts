import { z } from 'zod'

export const VERSION = '0.3.4'
export const PANEL_ID = 'ppyang010-task-workbench'
export const RPC_NAMESPACE = 'ppyangTaskWorkbench'
export const DOMAIN_NAME = 'ppyang010_task_workbench'
export const COLUMNS = [
  { id: 'focus', title: '我的关注', description: '最近要推进，随时回来继续' },
  { id: 'waiting', title: '等我处理', description: '需要我的决定、回复或下一步' },
  { id: 'later', title: '暂时搁置', description: '先留着，之后回来继续' },
] as const
export type ColumnId = typeof COLUMNS[number]['id']
export const columnSchema = z.enum(['focus', 'waiting', 'later'])
export const sessionIdSchema = z.string().min(1).max(300).refine(s => s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s), '会话 ID 无效')
export const entrySchema = z.object({
  sessionId: sessionIdSchema,
  columnId: columnSchema,
  note: z.string().max(2000),
  source: z.enum(['manual', 'auto']),
  addedAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  version: z.number().int().min(1),
}).strict()
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  settings: z.object({ autoCollect: z.boolean() }).strict(),
  entries: z.array(entrySchema).max(20000),
  excludedSessionIds: z.array(sessionIdSchema).max(100000),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const item of value.entries) {
    if (seen.has(item.sessionId)) ctx.addIssue({ code: 'custom', message: '关注记录不能重复' })
    seen.add(item.sessionId)
  }
  if (new Set(value.excludedSessionIds).size !== value.excludedSessionIds.length) ctx.addIssue({ code: 'custom', message: '排除名单不能重复' })
  if (value.excludedSessionIds.some(id => seen.has(id))) ctx.addIssue({ code: 'custom', message: '会话不能同时关注和排除' })
})
export type WatchEntry = z.infer<typeof entrySchema>
export type BoardState = z.infer<typeof stateSchema>
export function initialState(): BoardState {
  return { schemaVersion: 1, revision: 0, settings: { autoCollect: false }, entries: [], excludedSessionIds: [] }
}
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), sessionIds: z.array(sessionIdSchema).min(1).max(500), columnId: columnSchema }).strict(),
  z.object({ type: z.literal('unfollow'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('move'), sessionId: sessionIdSchema, columnId: columnSchema, beforeSessionId: sessionIdSchema.optional() }).strict(),
  z.object({ type: z.literal('note'), sessionId: sessionIdSchema, note: z.string().max(2000), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('settings'), autoCollect: z.boolean() }).strict(),
])
export type Command = z.infer<typeof commandSchema>
export type RuntimeStatus = 'running' | 'waiting' | 'unread' | 'idle' | 'unknown'
export interface SessionView {
  id: string
  title: string
  workspaceId: string
  workspaceTitle: string
  updatedAt: number
  status: RuntimeStatus
  archived: boolean
  missing: boolean
  subagent: boolean
  openable: boolean
  waitingLabel?: string
}
export const STATUS_LABELS: Record<RuntimeStatus, string> = { running: '运行中', waiting: '等待回应', unread: '完成未读', idle: '空闲', unknown: '状态未知' }
export interface RuntimeSnapshot { sessions: SessionView[]; ready: boolean; connected: boolean }
export interface ClientState {
  board: BoardState
  sessions: SessionView[]
  loading: boolean
  saving: boolean
  connected: boolean
  runtimeReady: boolean
  error?: string
}
export interface BoardControllerFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): ClientState
  refresh(): Promise<void>
  command(command: Command): Promise<boolean>
  openSession(sessionId: string): Promise<boolean>
  clearError(): void
}
