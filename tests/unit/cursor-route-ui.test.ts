import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskHeader } from "../../src/renderer/src/features/tasks/TaskHeader.js";
import { ActivityPanel } from "../../src/renderer/src/features/tasks/ActivityPanel.js";
import { taskStatusViewModel, type TaskViewModel } from "../../src/renderer/src/features/tasks/task-view-model.js";
import type { RunRecord } from "../../src/shared/contracts/records.js";

describe("explicit Cursor route review surface", () => {
  it("shows Cursor as a separate build action and displays the persisted run adapter", () => {
    const task: TaskViewModel = { ...taskStatusViewModel("SPEC_APPROVED"), id: "TASK-UI",
      title: "Fixture", requestText: "Change one file", baseSha: "a".repeat(40), updatedAt: "now",
      attemptLabel: null, hasSpec: true, hasEvidence: false, escalationPending: false };
    const header = renderToStaticMarkup(React.createElement(TaskHeader, { task, onPrimaryAction: () => undefined,
      onCursorAction: () => undefined }));
    expect(header).toContain("开始构建");
    expect(header).toContain("使用 Cursor 构建");
    const run = { id: "run-1", stage: "builder", adapter: "cursor-proposal", status: "SUCCEEDED", errorCode: null } as RunRecord;
    const activity = renderToStaticMarkup(React.createElement(ActivityPanel, { events: [], runs: [run] }));
    expect(activity).toContain("builder · cursor-proposal · SUCCEEDED");
  });
});
