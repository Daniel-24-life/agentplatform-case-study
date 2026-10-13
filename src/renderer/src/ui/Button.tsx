import React from "react";
import { Spinner } from "./Spinner.js";
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; loading?: boolean; }
export const Button = ({ variant = "primary", size = "md", loading = false, disabled, children, className = "", ...props }: ButtonProps): React.JSX.Element => <button className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading && <Spinner label="处理中" />}{children}</button>;
