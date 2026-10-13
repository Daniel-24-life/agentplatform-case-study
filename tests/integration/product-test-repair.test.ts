import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

for (const repairs of [true, false]) {
  it(repairs ? "repairs an authoritative failed TestRun using its evidence" : "stops repeated TestRun failures at the approved Attempt limit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-test-repair-"));
    const f = await createProductWorkflowFixture(root, { maxAttempts: 2 });
    const counter = path.join(root, "worker-count.txt");
    const prompts = path.join(root, "worker-prompts.jsonl");
    const fake = path.join(root, "fake-codex.cjs");
    const original = readFileSync(fake, "utf8");
    const statement = "fs.writeFileSync(path.join(cwd,'value.txt'),'after\\n');";
    const replacement = `const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(counter)},String(n));fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(args.at(-1))+'\\n');fs.writeFileSync(path.join(cwd,'value.txt'),${repairs ? "n===1?'incorrect\\n':'after\\n'" : "'incorrect\\n'"});`;
    expect(original).toContain(statement);
    writeFileSync(fake, original.replace(statement, replacement));
    try {
      await f.runs.start(f.input);
      const action = await waitForProductRun(f);
      expect(action).toMatchObject({ status: repairs ? "SUCCEEDED" : "FAILED", usedModelCalls: repairs ? 3 : 2, maxModelCalls: 4 });
      expect(f.database.getLatestAttempt(f.input.taskId)?.number).toBe(2);
      const attempts = f.database.db.prepare("SELECT id FROM attempts WHERE task_id=? ORDER BY number").all(f.input.taskId) as Array<{ id: string }>;
      const first = f.database.listRuns(attempts[0].id);
      expect(first.some(run => run.stage === "reviewer")).toBe(false);
      expect(first.find(run => run.stage === "test:verification")).toMatchObject({ status: "FAILED", exitCode: 1 });
      const second = f.database.listRuns(attempts[1].id);
      expect(second.filter(run => run.stage === "reviewer")).toHaveLength(repairs ? 1 : 0);
      const contexts = readFileSync(prompts, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]).toContain("REWORK EVIDENCE");
      expect(contexts[1]).toContain('"exit_code": 1');
      if (!repairs) {
        await expect(f.runs.start({ ...f.input, requestId: "cannot-reset-attempts" })).rejects.toMatchObject({ code: "TASK_NOT_READY" });
        expect(f.database.getLatestAttempt(f.input.taskId)?.number).toBe(2);
      }
    } finally { f.database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
}
