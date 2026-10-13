import React from "react";
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";
export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> { tone?: StatusTone; }
export const StatusBadge = ({ tone = "neutral", children, className = "", ...props }: StatusBadgeProps): React.JSX.Element => <span className={`ui-status-badge ui-status-badge--${tone} ${className}`.trim()} {...props}>{children}</span>;
