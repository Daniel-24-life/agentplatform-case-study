import React from "react";
import { Icon } from "./Icon.js";
export interface InlineErrorProps { children: React.ReactNode; id?: string; role?: "alert" | "status"; }
export const InlineError = ({ children, id, role = "alert" }: InlineErrorProps): React.JSX.Element => <div className="ui-inline-error" id={id} role={role}><Icon name="error" aria-hidden="true" /><p>{children}</p></div>;
