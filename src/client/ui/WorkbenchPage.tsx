import { useEffect, useState } from 'react'
import type { BoardControllerFace } from '../../shared/model.ts'
import type { IdeasController } from '../ideas-controller.ts'
import type { GroupOrderController } from '../group-order-controller.ts'
import { MyFocusBoard } from './Board.tsx'
import { IdeasPage } from './IdeasPage.tsx'
import { SentinelPage } from './SentinelPage.tsx'
import type { SentinelState } from '../sentinel.ts'

/** 保留关注筛选与点子草稿，哨兵仅在当前页签读取。 */
export function WorkbenchPage({ board, ideas, groupOrder, onNewSession, onOpenMonitor, loadSentinels }: {
  board: BoardControllerFace
  ideas: IdeasController
  groupOrder: GroupOrderController
  onNewSession?: (workspaceId?: string) => void | Promise<void>
  onOpenMonitor?: () => void
  loadSentinels?: (signal: AbortSignal) => Promise<SentinelState>
}) {
  const [tab, setTab] = useState<'focus' | 'ideas' | 'sentinel'>('focus')
  const [ideasVisited, setIdeasVisited] = useState(false)
  useEffect(() => {
    if (tab !== 'focus') return
    return groupOrder.activate()
  }, [tab, groupOrder])
  useEffect(() => {
    if (tab !== 'ideas') return
    return ideas.activate()
  }, [tab, ideas])
  return <div className="dtw-root dtw-workbench-shell">
    <nav className="dtw-module-tabs" aria-label="工作台模块">
      <button type="button" aria-pressed={tab === 'focus'} onClick={() => setTab('focus')}>我的关注</button>
      <button type="button" aria-pressed={tab === 'ideas'} onClick={() => { setIdeasVisited(true); setTab('ideas') }}>点子</button>
      <button type="button" aria-pressed={tab === 'sentinel'} onClick={() => setTab('sentinel')}>哨兵</button>
    </nav>
    {tab === 'sentinel' && <div className="dtw-module-body"><SentinelPage board={board} onOpenMonitor={onOpenMonitor} load={loadSentinels} /></div>}
    <div className="dtw-module-body" hidden={tab !== 'focus'}><MyFocusBoard controller={board} groupOrder={groupOrder} onNewSession={onNewSession} /></div>
    {ideasVisited && <div className="dtw-module-body" hidden={tab !== 'ideas'}><IdeasPage controller={ideas} board={board} /></div>}
  </div>
}
