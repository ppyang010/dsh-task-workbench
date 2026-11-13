import { RPC_NAMESPACE, initialState, stateSchema, type BoardState, type BoardControllerFace, type ClientState, type Command, type SessionView } from '../shared/model.ts'
import type { RuntimeFace } from './runtime.ts'

export interface RemoteFace { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<any> }
export class BoardController implements BoardControllerFace {
  private state: ClientState = { board: initialState(), sessions: [], loading: true, saving: false, connected: false, runtimeReady: false }
  private listeners = new Set<() => void>()
  private stopped = false
  private unbind?: () => void
  private poll?: ReturnType<typeof setInterval>
  private active = 0
  private inflight?: Promise<void>
  private pending = new Set<AbortController>()
  constructor(private rpc: RemoteFace, private runtime: RuntimeFace) {}
  getSnapshot = (): ClientState => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(patch: Partial<ClientState>): void {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private syncRuntime = (): void => {
    const next = this.runtime.snapshot()
    const ids = new Set(next.sessions.map(session => session.id))
    const missing: SessionView[] = this.state.board.entries.filter(entry => !ids.has(entry.sessionId)).map(entry => ({
      id: entry.sessionId, title: next.ready ? '原会话已不可用' : '会话资料待同步', workspaceId: '', workspaceTitle: '待同步',
      updatedAt: 0, status: 'unknown', archived: false, missing: next.ready && next.connected, subagent: false, openable: false,
    }))
    const reconnected = next.connected && !this.state.connected
    this.patch({ sessions: [...next.sessions, ...missing], connected: next.connected, runtimeReady: next.ready })
    if (reconnected) void this.refresh()
  }
  start(): () => void {
    this.unbind = this.runtime.subscribe(this.syncRuntime)
    this.syncRuntime()
    void this.refresh()
    // 运行状态直接订阅宿主。这里只拉轻量关注关系，用于其他窗口与自动纳入同步。
    this.poll = setInterval(() => { if (this.active > 0 && globalThis.document?.visibilityState !== 'hidden' && this.state.connected && !this.state.saving) void this.refresh() }, 3000)
    return () => this.dispose()
  }
  activate(): () => void { this.active += 1; void this.refresh(); return () => { this.active = Math.max(0, this.active - 1) } }
  private async request(method: string, payload: unknown): Promise<BoardState> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 12000)
    this.pending.add(abort)
    try {
      const transport = await this.rpc.call('/api', `${RPC_NAMESPACE}/${method}`, { args: payload }, abort.signal)
      if (!transport?.ok) throw new Error('无法连接关注服务，请确认插件宿主已启用')
      const result = transport.value
      if (!result?.ok) throw new Error(result?.error?.message || '关注操作未保存，请稍后重试')
      return stateSchema.parse(result.value)
    } catch (error) {
      if (abort.signal.aborted) throw new Error('关注操作请求超时，请刷新确认保存结果')
      throw error
    } finally { clearTimeout(timer); this.pending.delete(abort) }
  }
  private accept(board: BoardState): void {
    if (board.revision < this.state.board.revision) return
    this.patch({ board, loading: false, error: undefined })
    this.syncRuntime()
  }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try { this.accept(await this.request('read', {})) }
      catch (error) { this.patch({ loading: false, error: error instanceof Error ? error.message : '关注数据同步失败，请稍后重试' }) }
    })().finally(() => { this.inflight = undefined })
    return this.inflight
  }
  async command(command: Command): Promise<boolean> {
    if (this.state.saving || this.state.loading || !this.state.connected) return false
    this.patch({ saving: true, error: undefined })
    try { this.accept(await this.request('mutate', { request: command })); return true }
    catch (error) { const message = error instanceof Error ? error.message : '关注操作未保存'; await this.refresh(); this.patch({ error: message }); return false }
    finally { this.patch({ saving: false }) }
  }
  async openSession(id: string): Promise<boolean> {
    try {
      if (!this.state.connected) throw new Error('与 DSH 的连接已断开，请等待重新连接')
      let target = this.state.sessions.find(session => session.id === id)
      if (!target || target.missing) { await this.runtime.refresh(); this.syncRuntime(); target = this.state.sessions.find(session => session.id === id) }
      if (!target || target.missing) throw new Error('原会话已不可用；关注记录保留，可以手动取消关注')
      if (target.archived) throw new Error('原会话已归档，请先在 DSH 原生界面恢复后再打开')
      if (!target.openable) throw new Error('会话目录尚未就绪或格式暂不兼容，请刷新后重试')
      // DSH 原子完成原会话选择、原生输入区域切换与主面板关闭。
      await this.runtime.open(id)
      return true
    } catch (error) { this.patch({ error: error instanceof Error ? error.message : '暂时无法打开原会话' }); return false }
  }
  async renameSession(id: string, title: string): Promise<boolean> {
    if (this.stopped || this.state.saving || this.state.loading) return false
    const name = title.trim()
    const target = this.state.sessions.find(session => session.id === id)
    if (!name) { this.patch({ error: '会话名不能为空' }); return false }
    if (!this.state.connected || !this.state.runtimeReady || !target?.openable || target.missing || target.archived || target.subagent) {
      this.patch({ error: '当前会话不可修改名称，请确认连接正常且会话未归档' }); return false
    }
    if (name === target.title) { this.clearError(); return true }
    this.patch({ saving: true, error: undefined })
    try {
      await this.runtime.rename(id, name)
      // 原生接口在确认后更新宿主标题投影，看板直接同步同一份目录。
      this.syncRuntime()
      return true
    } catch (error) { this.patch({ error: error instanceof Error ? error.message : '会话名未保存，请稍后重试' }); return false }
    finally { this.patch({ saving: false }) }
  }
  clearError(): void { this.patch({ error: undefined }) }
  dispose(): void {
    this.stopped = true
    this.unbind?.()
    clearInterval(this.poll)
    for (const abort of this.pending) abort.abort()
    this.pending.clear(); this.listeners.clear()
  }
}
