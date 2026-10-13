import { describe, expect, it } from "vitest";
import { navigateBack, navigateTo, type NavigationState } from "../../src/renderer/src/navigation.js";

describe("application return navigation", () => {
  it("returns through the actual visited sections without adding duplicate destinations", () => {
    const initial: NavigationState = { section: "products", previous: [] };
    expect(navigateBack(initial)).toBe(initial);
    const task = navigateTo(initial, "tasks");
    expect(navigateTo(task, "tasks")).toBe(task);
    const runtime = navigateTo(task, "runtime");
    expect(navigateBack(runtime)).toEqual(task);
    expect(navigateBack(navigateBack(runtime))).toEqual(initial);
    expect(initial.previous).toEqual([]);
  });

  it("keeps a bounded history while repeated navigation continues", () => {
    let state: NavigationState = { section: "products", previous: [] };
    for (let index = 0; index < 100; index++) state = navigateTo(state, index % 2 ? "runtime" : "tasks");
    expect(state.previous).toHaveLength(20);
    for (let index = 0; index < 20; index++) state = navigateBack(state);
    expect(state.previous).toHaveLength(0);
    expect(navigateBack(state)).toBe(state);
  });
});
