import type { ReactNode, SVGProps } from 'react'

export type IconName = 'board' | 'plus' | 'search' | 'folder' | 'arrow' | 'close' | 'info' | 'link' | 'lock' | 'refresh' | 'edit' | 'grip' | 'up' | 'down' | 'warning' | 'undo' | 'more' | 'collapse' | 'expand'

const paths: Record<IconName, ReactNode> = {
  board: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9 5v14M15 5v14" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  folder: <path d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h5L12 8h7.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />,
  arrow: <path d="M6 18 18 6M7 6h11v11" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  refresh: <><path d="M20 10a8 8 0 0 0-13-4L4 9M4 4v5h5M4 14a8 8 0 0 0 13 4l3-3M20 20v-5h-5" /></>,
  edit: <><path d="m14.5 4.5 5 5M4 20l4.5-1 12-12a1.8 1.8 0 0 0 0-2.5l-1-1a1.8 1.8 0 0 0-2.5 0l-12 12Z" /></>,
  grip: <><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" /></>,
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  warning: <><path d="m10.3 4-8 14A1.4 1.4 0 0 0 3.5 20h17a1.4 1.4 0 0 0 1.2-2l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 16h.01" /></>,
  undo: <><path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  collapse: <path d="m14 6-6 6 6 6" />,
  expand: <path d="m10 6 6 6-6 6" />,
}

export function Icon({ name, className = '', ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg className={`dtw-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>
}
