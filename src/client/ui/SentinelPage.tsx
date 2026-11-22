import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { BoardControllerFace } from '../../shared/model.ts'
import { loadSentinelState, sortSentinelFires, watchKey, type SentinelFire, type SentinelState } from '../sentinel.ts'
import { formatUpdatedAt } from './board-helpers.ts'

const kinds: Partial<Record<string, string>> = {
  file: '文件', command: '命令', http: '网页', process: '进程', port: '端口', session: '会话结束', webhook: 'Webhook',
}

export function SentinelPage({ board, onOpenMonitor, load = loadSentinelState }: {
  board: BoardControllerFace
  onOpenMonitor?: () => void
  load?: (signal: AbortSignal) => Promise<SentinelState>
}) {
  const catalog = useSyncExternalStore(board.subscribe, board.getSnapshot)
  const [data, setData] = useState<SentinelState>()
  const [error, setError] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [revision, refresh] = useState(0)
  const [filter, setFilter] = useState('all')
  const [opening, setOpening] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const detailsPrefix = useId()

  const toggleDetails = (key: string) => setExpanded(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const snapshot = await load(controller.signal)
        if (!controller.signal.aborted) {
          setData(snapshot)
          setError('')
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof TypeError ? '无法连接哨兵监控，请刷新重试。' : '无法读取哨兵监控。' + (reason instanceof Error ? ` ${reason.message}` : ''))
        return
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void read() }, 5000)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [load, revision])

  const sessions = useMemo(() => new Map(catalog.sessions.map(session => [session.id, session])), [catalog.sessions])
  const fires = useMemo(() => sortSentinelFires(data?.recentFires ?? []), [data])
  const latestFires = useMemo(() => {
    const latest = new Map<string, SentinelFire>()
    for (const fire of fires) if (!latest.has(watchKey(fire))) latest.set(watchKey(fire), fire)
    return latest
  }, [fires])
  const watches = (data?.watches ?? []).filter(watch => filter === 'all' || watch.live === (filter === 'live'))

  const openSession = async (id: string) => {
    setOpening(true)
    setNavigationError('')
    try {
      if (!await board.openSession(id)) setNavigationError(board.getSnapshot().error ?? '暂时无法打开关联会话。')
    } catch {
      setNavigationError('暂时无法打开关联会话。')
    } finally {
      setOpening(false)
    }
  }
  const sessionButton = (id: string) => <button type="button" className="dtw-button dtw-button-small" disabled={opening || !sessions.get(id)?.openable} onClick={() => { void openSession(id) }}>打开关联会话</button>

  return <section className="dtw-sentinel" aria-label="哨兵">
    <header className="dtw-sentinel-toolbar">
      <h2>哨兵 <small>{data?.watches.length ?? ''}</small></h2>
      <select aria-label="按会话状态筛选哨兵" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">全部会话状态</option><option value="live">活跃会话</option><option value="dormant">休眠会话</option>
      </select>
      <button type="button" className="dtw-button" onClick={() => { setError(''); refresh(value => value + 1) }}>刷新</button>
      {onOpenMonitor && <button type="button" className="dtw-button" onClick={onOpenMonitor}>打开哨兵监控</button>}
    </header>
    {error && <p role="alert">{error}{data && ' 当前显示上次读取的记录。'}</p>}
    {navigationError && <p role="alert">{navigationError}</p>}
    {!data && !error && <p role="status">正在读取哨兵监控…</p>}
    {data && <>
      {watches.length === 0 && <p className="dtw-sentinel-empty">{data.watches.length ? '没有符合筛选的哨兵。' : '当前没有值守中的哨兵。'}</p>}
      <div className="dtw-sentinel-list">
        {watches.map(watch => {
          const key = watchKey(watch)
          const latest = latestFires.get(key)
          const owner = sessions.get(watch.sessionId)
          const note = watch.note?.trim()
          const target = (watch.kind === 'session' ? sessions.get(watch.target)?.title : undefined) || watch.target || '未提供对象'
          const title = `${kinds[watch.kind] ?? watch.kind} · ${target}`
          const expandedHere = expanded.has(key)
          const detailsId = `${detailsPrefix}-${encodeURIComponent(key)}`
          const triggerTime = latest ? `最近触发 ${formatUpdatedAt(Date.parse(latest.at))}` : watch.fireCount ? '暂无近期记录' : '尚未触发'
          return <article className="dtw-sentinel-item" key={key}>
            <button type="button" className="dtw-sentinel-summary" aria-expanded={expandedHere} aria-controls={detailsId} onClick={() => toggleDetails(key)}>
              <strong title={title}>{title}</strong>
              <span className="dtw-sentinel-trigger-time">{triggerTime}</span>
            </button>
            <div className="dtw-sentinel-meta">
              {note && <span className="dtw-sentinel-note" title={note}>{note.split(/\r?\n/, 1)[0]}</span>}
              <span className="dtw-sentinel-owner">
                <span>唤醒会话</span>
                <button type="button" className="dtw-text-button" disabled={opening || !owner?.openable} title={owner?.title ?? watch.sessionId} onClick={() => { void openSession(watch.sessionId) }}>{owner?.title ?? watch.sessionId}</button>
              </span>
            </div>
            <dl id={detailsId} hidden={!expandedHere}>
              <dt>哨兵编号</dt><dd>{watch.id}</dd>
              <dt>监控对象</dt><dd>{watch.target || '未提供对象'}</dd>
              <dt>会话状态</dt><dd>{watch.live ? '会话活跃' : '会话休眠'}</dd>
              {note && <><dt>备注</dt><dd>{note}</dd></>}
              <dt>触发条件</dt><dd>{watch.pattern || (watch.kind === 'session' ? '监控会话回合结束时' : '由监控类型决定')}</dd>
              {watch.lastState && <><dt>探测状态</dt><dd>{watch.lastState}</dd></>}
              {latest && <><dt>最近触发结果</dt><dd>{latest.summary || latest.state || '已触发'}</dd></>}
            </dl>
          </article>
        })}
      </div>
      {fires.length > 0 && <section className="dtw-sentinel-history" aria-label="最近触发">
        <h3>最近触发</h3>
        {fires.slice(0, 12).map((fire, index) => <div className="dtw-sentinel-event" key={`${watchKey(fire)}:${fire.at}:${index}`}>
          <div><strong>{sessions.get(fire.sessionId)?.title ?? fire.sessionId}</strong><p>{fire.summary || fire.state || '已触发'}</p></div>
          <span>{formatUpdatedAt(Date.parse(fire.at))}</span>
          {sessionButton(fire.sessionId)}
        </div>)}
      </section>}
    </>}
  </section>
}
