import React from "react";

export type IconName = "check" | "close" | "info" | "warning" | "error" | "plus" | "search" | "refresh" | "arrow-right" | "folder";
export interface IconProps extends React.SVGProps<SVGSVGElement> { name: IconName; size?: number; title?: string; }

const paths: Record<IconName, React.ReactNode> = {
  check: <path d="m5 12 4 4L19 6" />, close: <path d="m6 6 12 12M18 6 6 18" />, info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  warning: <><path d="m12 3 9 17H3L12 3Z" /><path d="M12 9v4M12 16h.01" /></>, error: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>, plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>, refresh: <path d="M20 11a8 8 0 0 0-14.7-4L3 10m0 0V4m0 6h6M4 13a8 8 0 0 0 14.7 4L21 14m0 0v6m0-6h-6" />, "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6" />, folder: <path d="M3 6h7l2 2h9v10H3V6Z" />
};

export const Icon = ({ name, size = 16, title, ...props }: IconProps): React.JSX.Element => <svg aria-hidden={title ? undefined : true} aria-label={title} className="ui-icon" fill="none" height={size} role={title ? "img" : undefined} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width={size} {...props}>{title && <title>{title}</title>}{paths[name]}</svg>;
