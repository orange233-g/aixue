import type { ReactNode, SVGProps } from 'react'

export type AppIconName =
  | 'home'
  | 'library'
  | 'plus'
  | 'archive'
  | 'user'
  | 'book'
  | 'check'
  | 'chart'
  | 'file'
  | 'database'
  | 'more'
  | 'download'

const paths: Record<AppIconName, ReactNode> = {
  home: <><path d="M3 11.5 12 4l9 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 19.5z" /></>,
  library: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  archive: <><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" /></>,
  user: <><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="8" r="5" /></>,
  book: <><path d="M5 4h8a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3z" /><path d="M16 7h3v13h-3M8 8h5M8 12h5" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  chart: <><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7" /></>,
  file: <><path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  more: <><path d="M12 5.5h.01M12 12h.01M12 18.5h.01" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></>,
}

interface AppIconProps extends SVGProps<SVGSVGElement> {
  name: AppIconName
  size?: number
}

export default function AppIcon({ name, size = 20, ...props }: AppIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
