import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("repairs reviewer REWORK in a new Attempt with bounded shared budget", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-product-repair-"));
  roots.push(root);
  const fixture = await createProductWorkflowFixture(root, { maxAttempts: 2 });
  try {
    const fake = path.join(root, "fake-codex.cjs");
    const reviewerCount = path.join(root, "reviewer-count.txt");
    const promptLog = path.join(root, "model-prompts.jsonl");
    const original = readFileSync(fake, "utf8");
    const capture = `if(schema.properties.status || schema.properties.verdict)fs.appendFileSync(${JSON.stringify(promptLog)},JSON.stringify(args.at(-1))+'\\n');`;
    const rework = `if(schema.properties.verdict){const count=fs.existsSync(${JSON.stringify(reviewerCount)})?Number(fs.readFileSync(${JSON.stringify(reviewerCount)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(reviewerCount)},String(count));if(count===1)value={schema_version:'1.0',task_id:spec.task_id,verdict:'REWORK',summary:'Repair required',criteria:[{criterion_id:'AC-01',status:'satisfied',evidence:'Platform test and diff'}],findings:[],test_assessment:'Passed',scope_assessment:'Passed',rework_instructions:['Address the review finding']};}`;
    expect(original).toContain("let value;");
    expect(original).toContain("fs.writeFileSync(out,JSON.stringify(value));");
    writeFileSync(fake, original.replace("let value;", `${capture}let value;`).replace("fs.writeFileSync(out,JSON.stringify(value));", `${rework}fs.writeFileSync(out,JSON.stringify(value));`));

    const started = await fixture.runs.start(fixture.input);
    const finished = await waitForProductRun(fixture);
    expect(finished).toMatchObject({ status: "SUCCEEDED", reservedModelCalls: 4, maxModelCalls: 4, usedModelCalls: 4 });
    expect(fixture.database.getLatestAttempt(fixture.link.taskId)?.number).toBe(2);
    const prompts = readFileSync(promptLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
    const workerPrompts = prompts.filter(prompt => prompt.startsWith("Implement only this approved TaskSpec."));
    const reviewerPrompts = prompts.filter(prompt => prompt.startsWith("Review approved TaskSpec"));
    expect(workerPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("REWORK EVIDENCE");
    expect(workerPrompts[1]).toContain('"verdict": "REWORK"');
    expect(workerPrompts[1]).toContain("Address the review finding");

    const attempts = fixture.database.db.prepare("SELECT id,number FROM attempts WHERE task_id=? ORDER BY number").all(fixture.link.taskId) as Array<{ id: string; number: number }>;
    expect(fixture.database.listRuns(attempts[0].id).some(run => run.stage === "reviewer")).toBe(true);
    const provenance = fixture.database.db.prepare("SELECT stage,product_run_action_id FROM runs WHERE task_id=? AND stage IN ('builder','reviewer') ORDER BY started_at,id").all(fixture.link.taskId) as Array<{ stage: string; product_run_action_id: string | null }>;
    expect(provenance).toHaveLength(4);
    expect(provenance.every(run => run.product_run_action_id === started.id)).toBe(true);
  } finally {
    fixture.database.close();
  }
}, 30000);

for (const failure of ["quota", "auth"] as const) {
  it(`stops ${failure} worker failures without automatic repair`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), `agentplatform-product-${failure}-`));
    roots.push(root);
    const fixture = await createProductWorkflowFixture(root, { maxAttempts: 2 });
    try {
      const fake = path.join(root, "fake-codex.cjs");
      const original = readFileSync(fake, "utf8");
      const marker = "if(schema.properties.execution_policy)value=spec;";
      const message = failure === "quota" ? "quota exceeded" : "not authenticated";
      expect(original).toContain(marker);
      writeFileSync(fake, original.replace(marker, `if(schema.properties.status){console.error(${JSON.stringify(message)});process.exit(1);}${marker}`));

      await fixture.runs.start(fixture.input);
      const finished = await waitForProductRun(fixture);
      expect(finished).toMatchObject({ status: "FAILED", reservedModelCalls: 1, maxModelCalls: 4, usedModelCalls: 1 });
      expect(fixture.database.getTask(fixture.link.taskId)?.status).toBe("BLOCKED");
      const attempts = fixture.database.db.prepare("SELECT id,number FROM attempts WHERE task_id=? ORDER BY number").all(fixture.link.taskId) as Array<{ id: string; number: number }>;
      expect(attempts).toHaveLength(1);
      const runs = fixture.database.listRuns(attempts[0].id);
      expect(runs.filter(run => run.stage === "builder")).toHaveLength(1);
      expect(runs.filter(run => run.stage === "reviewer")).toHaveLength(0);
      expect(runs.find(run => run.stage === "builder")?.errorCode).toBe(failure === "quota" ? "QUOTA_EXHAUSTED" : "CLI_NOT_AUTHENTICATED");
    } finally {
      fixture.database.close();
    }
  }, 30000);
}

it("stops a hard deterministic gate failure without automatic repair or review", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-product-hard-gate-"));
  roots.push(root);
  const fixture = await createProductWorkflowFixture(root, { maxAttempts: 2 });
  try {
    const fake = path.join(root, "fake-codex.cjs");
    const original = readFileSync(fake, "utf8");
    const workerWrite = "fs.writeFileSync(path.join(cwd,'value.txt'),'after\\n');";
    const workerClaims = "changed_files:['value.txt']";
    expect(original).toContain(workerWrite);
    expect(original).toContain(workerClaims);
    const withForbiddenChange = `${workerWrite}fs.writeFileSync(path.join(cwd,'extra.txt'),'unexpected\\n');`;
    writeFileSync(fake, original.replace(workerWrite, withForbiddenChange).replace(workerClaims, "changed_files:['value.txt','extra.txt']"));

    await fixture.runs.start(fixture.input);
    const finished = await waitForProductRun(fixture);
    expect(finished).toMatchObject({ status: "FAILED", reservedModelCalls: 1, maxModelCalls: 4, usedModelCalls: 1 });
    expect(fixture.database.getTask(fixture.link.taskId)?.status).toBe("BLOCKED");
    const snapshot = fixture.orchestrator.detail(fixture.link.taskId).snapshot;
    expect(snapshot?.gate?.failures).toEqual(expect.arrayContaining([expect.stringContaining("SCOPE_VIOLATION"), "MAX_CHANGED_FILES"]));
    const attempts = fixture.database.db.prepare("SELECT id FROM attempts WHERE task_id=?").all(fixture.link.taskId) as Array<{ id: string }>;
    expect(attempts).toHaveLength(1);
    const runs = fixture.database.listRuns(attempts[0].id);
    expect(runs.filter(run => run.stage === "reviewer")).toHaveLength(0);
  } finally {
    fixture.database.close();
  }
}, 30000);
