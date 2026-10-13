import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexProductPlanner } from "../../src/main/products/product-planner.js";
import type { PlanningContext } from "../../src/shared/contracts/product-planning.js";

const roots: string[] = [];
const context: PlanningContext = {
  productId: "P1", workspaceRevision: 1, goalRevision: 1, goalHash: "a".repeat(64),
  goal: { schemaVersion: "1.0", originalRequest: "Build a useful product", goal: "Build", scope: "", assumptions: [], acceptanceCriteria: [] }
};
const fakeScript = `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), output=args[args.indexOf('--output-last-message')+1];
const pack=JSON.parse(fs.readFileSync(path.join(path.dirname(output),'context.json'),'utf8'));
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
fs.writeFileSync(path.join(path.dirname(output),'fake-observation.json'),JSON.stringify({args,schema,secret:process.env.PLANNING_TEST_SECRET??null}));
fs.writeFileSync(output,JSON.stringify({schemaVersion:'1.0',productId:pack.context.productId,goalRevision:pack.context.goalRevision,goalHash:pack.context.goalHash,contextHash:pack.contextHash,summary:'A grounded direction',options:[{id:'local',title:'Local app',rationale:'Simple first scope',goal:{...pack.context.goal,scope:'Local workflow',acceptanceCriteria:[{id:'done',description:'Can reopen data',verification:'platform',required:true}]}}],recommendedOptionId:'local',questions:[]}));
console.log(JSON.stringify({type:'thread.started',thread_id:'fake'}));
`;

afterEach(() => { delete process.env.PLANNING_TEST_SECRET; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = (): { root: string; script: string } => {
  const root = mkdtempSync(path.join(os.tmpdir(), "product-planner-")); roots.push(root);
  const script = path.join(root, "fake.cjs"); writeFileSync(script, fakeScript);
  return { root, script };
};

describe("bounded Codex product planner", () => {
  it("classifies exhausted account usage without retrying or exposing raw process errors", async () => {
    const { root, script } = setup();
    writeFileSync(script, `console.log(JSON.stringify({type:'turn.failed',error:{message:"You have hit your usage limit"}}));process.exit(1);`);
    const planner = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "artifacts"), {
      qualified: true, program: process.execPath, prefixArgs: [script], proxyEnvironment: () => ({})
    });
    await expect(planner.run({ actionId: "quota", context, contextHash: "b".repeat(64), timeoutSeconds: 300, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    expect(JSON.parse(readFileSync(path.join(root, "artifacts/quota/execution.json"), "utf8")).process.status).toBe("FAILED");
    expect(readdirSync(path.join(root, "artifacts"))).toEqual(["quota"]);
  });
  it("uses the existing read-only transport, local runtime schema and minimal environment", async () => {
    const { root, script } = setup();
    process.env.PLANNING_TEST_SECRET = "must-not-inherit";
    const planner = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "artifacts"), {
      qualified: true, program: process.execPath, prefixArgs: [script], proxyEnvironment: () => ({})
    });
    const output = await planner.run({ actionId: "A1", context, contextHash: "b".repeat(64), timeoutSeconds: 300, signal: new AbortController().signal });
    expect(output).toMatchObject({ productId: "P1", recommendedOptionId: "local" });
    const observation = JSON.parse(readFileSync(path.join(root, "artifacts/A1/fake-observation.json"), "utf8"));
    expect(observation.args).toContain("--skip-git-repo-check");
    expect(observation.args.slice(observation.args.indexOf("--sandbox"), observation.args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(observation.args.slice(0, 4)).toEqual(["--ask-for-approval", "never", "--disable", "multi_agent"]);
    expect(observation.schema.$defs.productGoal).toBeDefined();
    expect(observation.schema.properties.schemaVersion.type).toBe("string");
    expect(observation.schema.$defs.productGoal.properties.schemaVersion.type).toBe("string");
    expect(observation.schema.$defs.productGoal.properties.acceptanceCriteria.items.properties.verification.type).toBe("string");
    expect(JSON.stringify(observation.schema)).not.toContain("https://agentplatform.local/schemas/product-goal/1.0");
    expect(observation.secret).toBeNull();
    expect(JSON.parse(readFileSync(path.join(root, "artifacts/A1/execution.json"), "utf8")).process.status).toBe("SUCCEEDED");
  });

  it("blocks unqualified and already-aborted calls before artifacts or process launch", async () => {
    const { root, script } = setup();
    const planner = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "artifacts"), { program: process.execPath, prefixArgs: [script] });
    await expect(planner.run({ actionId: "A1", context, contextHash: "b".repeat(64), timeoutSeconds: 300, signal: new AbortController().signal })).rejects.toMatchObject({ code: "RUNTIME_NOT_QUALIFIED" });
    expect(readdirSync(root)).toEqual(["fake.cjs"]);
    const controller = new AbortController(); controller.abort();
    const available = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "artifacts"), { qualified: true, program: process.execPath, prefixArgs: [script] });
    await expect(available.run({ actionId: "A1", context, contextHash: "b".repeat(64), timeoutSeconds: 300, signal: controller.signal })).rejects.toMatchObject({ code: "GRANT_REVOKED" });
    expect(readdirSync(root)).toEqual(["fake.cjs"]);
  });
});
