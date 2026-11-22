import { IDEAS_RPC, ideasStateSchema, initialIdeasState, type IdeaCommand, type IdeasClientState, type IdeasControllerFace, type IdeasState } from '../shared/ideas.ts'
import type { RemoteFace } from './controller.ts'

/** 和关注控制器独立：点子读取失败不影响原看板。 */
export class IdeasController implements IdeasControllerFace {
  private state: IdeasClientState = { data: initialIdeasState(), loaded: false, loading: true, saving: false }
  private listeners = new Set<() => void>()
  private pending = new Set<AbortController>()
  private inflight?: Promise<void>
  private interval?: ReturnType<typeof setInterval>
  private active = 0
  private stopped = false
  constructor(private rpc: RemoteFace) {}
  getSnapshot = (): IdeasClientState => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(patch: Partial<IdeasClientState>) {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  activate = (): (() => void) => {
    if (this.stopped) return () => {}
    this.active++
    if (!this.interval) this.interval = setInterval(() => { if (this.active && !this.state.saving && globalThis.document?.visibilityState !== 'hidden') void this.refresh() }, 3000)
    void this.refresh()
    return () => { this.active = Math.max(0, this.active - 1); if (!this.active) { clearInterval(this.interval); this.interval = undefined } }
  }
  private async request(method: string, payload: unknown): Promise<IdeasState> {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 12000); this.pending.add(abort)
    try {
      const transport = await this.rpc.call('/api', `${IDEAS_RPC}/${method}`, { args: payload }, abort.signal)
      if (!transport?.ok) throw new Error('无法连接点子服务，请检查宿主是否已启用')
      if (!transport.value?.ok) throw new Error(transport.value?.error?.message || '点子数据未保存，请稍后重试')
      return ideasStateSchema.parse(transport.value.value)
    } catch (error) {
      if (abort.signal.aborted) throw new Error('点子请求超时，请刷新确认结果后重试')
      throw error
    } finally { clearTimeout(timer); this.pending.delete(abort) }
  }
  private accept(data: IdeasState) {
    if (data.revision < this.state.data.revision) return
    this.patch({ data, loaded: true, loading: false, error: undefined })
  }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try { this.accept(await this.request('read', {})) }
      catch (error) { this.patch({ loading: false, error: error instanceof Error ? error.message : '点子数据同步失败' }) }
    })().finally(() => { this.inflight = undefined })
    return this.inflight
  }
  async command(command: IdeaCommand): Promise<boolean> {
    if (this.stopped || !this.state.loaded || this.state.loading || this.state.saving) return false
    this.patch({ saving: true, error: undefined })
    try { this.accept(await this.request('mutate', { request: command })); return true }
    catch (error) {
      const message = error instanceof Error ? error.message : '点子操作未保存'
      await this.refresh(); this.patch({ error: message }); return false
    } finally { this.patch({ saving: false }) }
  }
  clearError(): void { this.patch({ error: undefined }) }
  dispose(): void {
    this.stopped = true; clearInterval(this.interval)
    for (const abort of this.pending) abort.abort()
    this.pending.clear(); this.listeners.clear()
  }
}
