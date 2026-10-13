import React from "react";
export interface EmptyStateProps { title: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode; action?: React.ReactNode; }
export const EmptyState = ({ title, description, icon, action }: EmptyStateProps): React.JSX.Element => <section aria-live="polite" className="ui-empty-state"><div aria-hidden={icon ? true : undefined}>{icon}</div><h2 className="ui-empty-state__title">{title}</h2>{description && <p className="ui-empty-state__description">{description}</p>}{action}</section>;
