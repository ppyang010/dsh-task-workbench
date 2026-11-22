import { GROUP_ORDER_RPC, groupOrderStateSchema, initialGroupOrder, type GroupOrderClientState, type GroupOrderCommand, type GroupOrderControllerFace, type GroupOrderState } from '../shared/group-order.ts'
import type { RemoteFace } from './controller.ts'

/** 分组顺序单独同步；即使此服务不可用，关注看板仍可按原有顺序使用。 */
export class GroupOrderController implements GroupOrderControllerFace {
  private state: GroupOrderClientState = { data: initialGroupOrder(), loaded: false, loading: true, saving: false }
  private listeners = new Set<() => void>()
  private pending = new Set<AbortController>()
  private inflight?: Promise<void>
  private interval?: ReturnType<typeof setInterval>
  private active = 0
  private stopped = false
  private retainMutationError = false
  constructor(private rpc: RemoteFace) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(patch: Partial<GroupOrderClientState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
  activate = (): (() => void) => {
    if (this.stopped) return () => {}
    this.active++
    if (!this.interval) this.interval = setInterval(() => { if (this.active && !this.state.saving && globalThis.document?.visibilityState !== 'hidden') void this.refresh() }, 3000)
    void this.refresh()
    return () => { this.active = Math.max(0, this.active - 1); if (!this.active) { clearInterval(this.interval); this.interval = undefined } }
  }
  private async request(method: string, payload: unknown): Promise<GroupOrderState> {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 12000); this.pending.add(abort)
    try {
      const transport = await this.rpc.call('/api', `${GROUP_ORDER_RPC}/${method}`, { args: payload }, abort.signal)
      if (!transport?.ok) throw new Error('无法连接分组排序服务，关注数据不受影响')
      if (!transport.value?.ok) throw new Error(transport.value?.error?.message || '分组顺序未保存，请稍后重试')
      return groupOrderStateSchema.parse(transport.value.value)
    } catch (error) {
      if (abort.signal.aborted) throw new Error('分组排序请求超时，请刷新确认结果后重试')
      throw error
    } finally { clearTimeout(timer); this.pending.delete(abort) }
  }
  private accept(data: GroupOrderState) { if (data.revision >= this.state.data.revision) this.patch({ data, loaded: true, loading: false, ...(this.retainMutationError ? {} : { error: undefined }) }) }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try { this.accept(await this.request('read', {})) }
      catch (error) { this.patch({ loading: false, ...(this.retainMutationError ? {} : { error: error instanceof Error ? error.message : '分组顺序同步失败' }) }) }
    })().finally(() => { this.inflight = undefined })
    return this.inflight
  }
  async reorder(request: GroupOrderCommand): Promise<boolean> {
    if (this.stopped || !this.state.loaded || this.state.loading || this.state.saving) return false
    this.retainMutationError = false
    this.patch({ saving: true, error: undefined })
    try { this.accept(await this.request('mutate', { request })); return true }
    catch (error) { const message = error instanceof Error ? error.message : '分组顺序未保存'; await this.refresh(); this.retainMutationError = true; this.patch({ error: message }); return false }
    finally { this.patch({ saving: false }) }
  }
  clearError(): void { this.retainMutationError = false; this.patch({ error: undefined }) }
  dispose(): void { this.stopped = true; clearInterval(this.interval); for (const abort of this.pending) abort.abort(); this.pending.clear(); this.listeners.clear() }
}
