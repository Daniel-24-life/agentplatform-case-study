import React, { useId, useRef, useState } from "react";
export interface TabItem { id: string;
  label: React.ReactNode; panel?: React.ReactNode; disabled?: boolean; }
export interface TabsProps { items: TabItem[]; value?: string; defaultValue?: string; onChange?: (id: string) => void; ariaLabel?: string; } // eslint-disable-line no-unused-vars
export const Tabs = ({ items, value, defaultValue, onChange, ariaLabel = "选项卡" }: TabsProps): React.JSX.Element => {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue ?? items.find(item => !item.disabled)?.id ?? "");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const active = value ?? internal;
  const select = (next: string) => { if (value === undefined) setInternal(next); onChange?.(next); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const enabled = items.filter(item => !item.disabled);
    const current = enabled.findIndex(item => item.id === event.currentTarget.dataset.tabId);
    if (current < 0 || enabled.length < 2) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % enabled.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    else return;
    event.preventDefault();
    const nextId = enabled[next].id;
    select(nextId);
    tabRefs.current[nextId]?.focus();
  };
  return <div><div aria-label={ariaLabel} className="ui-tabs" role="tablist">{items.map(item => <button aria-controls={`${baseId}-panel-${item.id}`} aria-disabled={item.disabled || undefined} aria-selected={active === item.id} className="ui-tabs__tab" data-tab-id={item.id} disabled={item.disabled} id={`${baseId}-tab-${item.id}`} key={item.id} onClick={() => select(item.id)} onKeyDown={onKeyDown} ref={element => { tabRefs.current[item.id] = element; }} role="tab" tabIndex={active === item.id ? 0 : -1} type="button">{item.label}</button>)}</div>{items.map(item => active === item.id && item.panel !== undefined ? <div aria-labelledby={`${baseId}-tab-${item.id}`} className="ui-tabs__panel" id={`${baseId}-panel-${item.id}`} key={item.id} role="tabpanel" tabIndex={0}>{item.panel}</div> : null)}</div>;
};
