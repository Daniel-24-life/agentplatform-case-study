export type AppSection = "products" | "projects" | "tasks" | "runtime" | "agents";
export type NavigationState = { section: AppSection; previous: AppSection[] };

export function navigateTo(state: NavigationState, section: AppSection): NavigationState {
  if (state.section === section) return state;
  return { section, previous: [...state.previous, state.section].slice(-20) };
}

export function navigateBack(state: NavigationState): NavigationState {
  const section = state.previous.at(-1);
  return section ? { section, previous: state.previous.slice(0, -1) } : state;
}
