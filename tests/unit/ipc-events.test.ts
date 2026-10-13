import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (..._args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({ dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: (name: string, fn: (..._args: unknown[]) => unknown) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } }));

import { AppDatabase } from "../../src/main/db/database.js";
import { disposeIpcHandlers, initIpcHandlers } from "../../src/main/ipc.js";

const roots: string[] = [];
afterEach(() => { disposeIpcHandlers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("event IPC", () => {
  it("pushes committed sequence changes, supports replay, and unsubscribes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ipc-events-")); roots.push(root);
    const database = new AppDatabase(path.join(root, "app.db"));
    try {
      database.createProject({ id: "P1", name: "fixture", repoPath: root, repoRealPath: root, lastSeenHead: "a".repeat(40) });
      database.createTask({ id: "T1", projectId: "P1", title: "task", requestText: "task", status: "DRAFT", baseSha: "a".repeat(40) });
      initIpcHandlers(database, {} as never);
      const sender = new EventEmitter() as EventEmitter & { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
      sender.id = 7; sender.send = vi.fn(); sender.isDestroyed = () => false;
      const subscription = handlers.get("events:subscribe")!({ sender }, "T1") as string;
      database.transitionTask("T1", "DESIGNING");
      expect(sender.send).toHaveBeenCalledWith("events:changed", { subscriptionId: subscription, taskId: "T1", sequence: 1 });
      expect((handlers.get("events:since")!(null, "T1", 0) as Array<{ sequence: number }>).map(event => event.sequence)).toEqual([1]);
      handlers.get("events:unsubscribe")!({ sender }, subscription);
      database.transitionTask("T1", "SPEC_READY");
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect((handlers.get("events:since")!(null, "T1", 1) as Array<{ sequence: number }>).map(event => event.sequence)).toEqual([2]);
      expect(() => handlers.get("events:since")!(null, "T1", -1)).toThrow("INVALID_EVENT_SEQUENCE");
    } finally { database.close(); }
  });
});
