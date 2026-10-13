import React from "react";
export interface SpinnerProps { label?: string; size?: number; }
export const Spinner = ({ label = "加载中", size }: SpinnerProps): React.JSX.Element => <span aria-label={label} className="ui-spinner" role="status" style={size ? { height: size, width: size } : undefined} />;
