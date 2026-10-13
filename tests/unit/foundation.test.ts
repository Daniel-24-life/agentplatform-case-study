import { describe, expect, it } from "vitest";

import { initIpcHandlers } from "../../src/main/ipc";

describe("foundation contracts", () => {
  it("phase 0 baseline keeps only startup IPC contract", () => {
    expect(typeof initIpcHandlers).toBe("function");
  });
});
