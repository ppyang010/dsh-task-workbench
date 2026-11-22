import { z } from 'zod'

const watchSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), kind: z.string(),
  target: z.string(), note: z.string().optional(), pattern: z.string().optional(),
  live: z.boolean(), lastState: z.string().optional(), fireCount: z.number().int().nonnegative(),
})
const fireSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), at: z.string(),
  summary: z.string().optional(), state: z.string().optional(),
})
const stateSchema = z.object({
  watches: z.array(watchSchema), recentFires: z.array(fireSchema).default([]),
})
export type SentinelState = z.infer<typeof stateSchema>
export type SentinelFire = SentinelState['recentFires'][number]
export const watchKey = (watch: { sessionId: string; id: string }) => JSON.stringify([watch.sessionId, watch.id])

export async function loadSentinelState(signal: AbortSignal, request: typeof fetch = fetch): Promise<SentinelState> {
  const response = await request('/plugins/dsh-sentinel/state', {
    method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
    credentials: 'same-origin', redirect: 'error', signal,
  })
  if (response.status === 404) throw new Error('哨兵监控接口不可用，请确认已启用 DSH 哨兵插件。')
  if (response.status === 401 || response.status === 403) throw new Error('当前窗口没有查看哨兵监控的权限。')
  if (!response.ok) throw new Error('哨兵监控暂时无法读取，请刷新重试。')
  const payload = await response.json().catch(() => null)
  const parsed = stateSchema.safeParse(payload)
  if (!parsed.success) throw new Error('无法识别哨兵监控数据，请确认 DSH 哨兵插件已启用且版本兼容。')
  return parsed.data
}

export function sortSentinelFires(fires: SentinelFire[]): SentinelFire[] {
  const timestamp = (fire: SentinelFire) => Date.parse(fire.at) || 0
  return [...fires].sort((first, second) => timestamp(second) - timestamp(first))
}
