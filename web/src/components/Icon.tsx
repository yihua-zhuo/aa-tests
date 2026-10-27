import type { ReactNode } from 'react';

export type IconName =
  | 'overview'
  | 'analytics'
  | 'projects'
  | 'activity'
  | 'users'
  | 'settings'
  | 'search'
  | 'plus'
  | 'check'
  | 'close'
  | 'menu'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowRight'
  | 'calendar'
  | 'download'
  | 'upload'
  | 'file'
  | 'trash'
  | 'edit'
  | 'logout'
  | 'bell'
  | 'lock'
  | 'mail'
  | 'globe'
  | 'filter'
  | 'refresh'
  | 'spark'
  | 'clock'
  | 'userPlus'
  | 'alert'
  | 'shield'
  | 'database'
  | 'server'
  | 'rocket'
  | 'dots'
  | 'folder'
  | 'trend'
  | 'eye'
  | 'star'
  | 'key';

const paths: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3.6" y="3.6" width="7.2" height="7.2" rx="2.6" />
      <rect x="13.2" y="3.6" width="7.2" height="7.2" rx="2.6" />
      <rect x="3.6" y="13.2" width="7.2" height="7.2" rx="2.6" />
      <rect x="13.2" y="13.2" width="7.2" height="7.2" rx="2.6" />
    </>
  ),
  analytics: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7.2" y="12.5" width="3.1" height="5.2" rx="1.4" />
      <rect x="12.2" y="8.5" width="3.1" height="9.2" rx="1.4" />
      <rect x="17.2" y="6" width="3.1" height="11.7" rx="1.4" />
    </>
  ),
  projects: (
    <>
      <path d="M3.8 7.4a2.4 2.4 0 012.4-2.4h3.2l2 2.3h6.4a2.4 2.4 0 012.4 2.4v7.1a2.4 2.4 0 01-2.4 2.4H6.2a2.4 2.4 0 01-2.4-2.4z" />
      <path d="M3.8 10.6h16.4" />
    </>
  ),
  activity: <path d="M3.5 12.5h3.2l2.4-6.4 4.1 11.4 2.3-5h5" />,
  users: (
    <>
      <circle cx="9.2" cy="8.5" r="3.3" />
      <path d="M3.6 19.4c.5-3.1 2.9-5 5.6-5s5.1 1.9 5.6 5" />
      <circle cx="17" cy="9.6" r="2.4" />
      <path d="M16.4 14.6c2 .3 3.5 2 3.9 4.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.4v2.2M12 18.4v2.2M4.9 7.4l1.9 1.1M17.2 15.5l1.9 1.1M4.9 16.6l1.9-1.1M17.2 8.5l1.9-1.1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="M15.2 15.2L20 20" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5.5 12.5l4.2 4.2L18.5 7.6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronLeft: <path d="M14.5 5.5l-6.5 6.5 6.5 6.5" />,
  chevronRight: <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  arrowUp: <path d="M12 19V5m0 0l-6 6m6-6l6 6" />,
  arrowDown: <path d="M12 5v14m0 0l6-6m-6 6l-6-6" />,
  arrowRight: <path d="M4.5 12h15m0 0l-5.5-5.5M19.5 12l-5.5 5.5" />,
  calendar: (
    <>
      <rect x="4" y="5.6" width="16" height="14.4" rx="4" />
      <path d="M8 3.5v4M16 3.5v4M4 10.2h16" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10.5m0 0l-4-4m4 4l4-4" />
      <path d="M4.5 17.5v1.1a1.9 1.9 0 001.9 1.9h11.2a1.9 1.9 0 001.9-1.9v-1.1" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4.5m0 0l-4 4m4-4l4 4" />
      <path d="M4.5 17.5v1.1a1.9 1.9 0 001.9 1.9h11.2a1.9 1.9 0 001.9-1.9v-1.1" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.6a1.6 1.6 0 011.6-1.6h1.8a1.6 1.6 0 011.6 1.6V7" />
      <path d="M6.6 7l.8 11.2a2 2 0 002 1.8h5.2a2 2 0 002-1.8L17.4 7" />
      <path d="M10.2 10.8v5.4M13.8 10.8v5.4" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4.2L19 9.2a2.5 2.5 0 00-3.5-3.5L4.7 16.5z" />
      <path d="M14.4 6.8l3 3" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 8V5.8a2 2 0 00-2-2H6.3a2 2 0 00-2 2v12.4a2 2 0 002 2h6.2a2 2 0 002-2V16" />
      <path d="M9.5 12h10.5m0 0l-3.4-3.4M20 12l-3.4 3.4" />
    </>
  ),
  bell: (
    <>
      <path d="M6.4 9.8a5.6 5.6 0 1111.2 0c0 4 1.4 5.3 1.9 5.8H4.5c.5-.5 1.9-1.8 1.9-5.8z" />
      <path d="M10 19a2.2 2.2 0 004 0" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="3.2" />
      <path d="M8.4 10.5V8a3.6 3.6 0 017.2 0v2.5" />
      <path d="M12 14.5v2" />
    </>
  ),
  key: (
    <>
      <circle cx="8.2" cy="8.2" r="4.2" />
      <path d="M11.2 11.2L20 20m-3.2-3.2l2-2m-4.2.7l2-2" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="3.2" />
      <path d="M4.6 7.4l6.2 5a2 2 0 002.4 0l6.2-5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8M12 3.6c2.3 2.3 3.5 5.2 3.5 8.4s-1.2 6.1-3.5 8.4c-2.3-2.3-3.5-5.2-3.5-8.4S9.7 5.9 12 3.6z" />
    </>
  ),
  filter: <path d="M4 6h16l-6.2 7.2v5.4l-3.6 1.8v-7.2z" />,
  refresh: (
    <>
      <path d="M19.2 12a7.2 7.2 0 11-2.1-5.1" />
      <path d="M19.6 4.4v4.2h-4.2" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z" />
      <path d="M18.3 15.7l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5V12l3 1.9" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="9.2" cy="8.5" r="3.3" />
      <path d="M3.6 19.4c.5-3.1 2.9-5 5.6-5s5.1 1.9 5.6 5" />
      <path d="M17.5 7.5v5M20 10h-5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2l8.2 14.4H3.8z" />
      <path d="M12 9.4v4M12 16.4h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.6l7 2.7v5.4c0 4-2.8 7.4-7 8.7-4.2-1.3-7-4.7-7-8.7V6.3z" />
      <path d="M8.8 12l2.1 2.1 4.3-4.3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.3" rx="7.5" ry="2.9" />
      <path d="M4.5 6.3v11.4c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9V6.3" />
      <path d="M4.5 12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6.2" rx="2.6" />
      <rect x="3.5" y="13.3" width="17" height="6.2" rx="2.6" />
      <path d="M7.2 7.6h.01M7.2 16.4h.01" />
    </>
  ),
  rocket: (
    <>
      <path d="M12.5 15.5l-4-4c1.3-4.6 4.6-7.5 9.2-8.1.6 4.6-2.3 8-6.9 9.2z" />
      <path d="M9.2 12.2L5.4 13l-1.6 3.4 4.1-.7M12.4 15.4l-.8 3.8 3.4-1.6.7-4.1" />
      <path d="M5.5 18.5c.5-1.6 1.6-2.7 3.2-3.2" />
    </>
  ),
  dots: (
    <>
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18" cy="12" r="1.3" />
    </>
  ),
  folder: (
    <>
      <path d="M3.8 7.4a2.4 2.4 0 012.4-2.4h3.2l2 2.3h6.4a2.4 2.4 0 012.4 2.4v7.1a2.4 2.4 0 01-2.4 2.4H6.2a2.4 2.4 0 01-2.4-2.4z" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.8h7.2l4 4v12.4H6.5z" />
      <path d="M13.5 3.8v4.2h4.2" />
    </>
  ),
  trend: (
    <>
      <path d="M3.8 17.5l5.2-5.4 3.4 3 7.4-7.4" />
      <path d="M15.2 7.7h4.6V12" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.3-5.8 9.2-5.8 9.2 5.8 9.2 5.8-3.3 5.8-9.2 5.8S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  star: <path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z" />,
};

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}

export type Tone = 'lilac' | 'mint' | 'peach' | 'sky' | 'lemon' | 'coral' | 'stone';

export function IconTile({
  name,
  tone = 'lilac',
  size = 42,
}: {
  name: IconName;
  tone?: Tone;
  size?: number;
}) {
  return (
    <span
      className="icon-tile"
      data-tone={tone}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.34) }}
      aria-hidden="true"
    >
      <Icon name={name} size={Math.round(size * 0.48)} />
    </span>
  );
}
