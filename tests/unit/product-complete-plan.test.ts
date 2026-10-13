import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { CodexProductPlanner } from "../../src/main/products/product-planner.js";
import { assertProposal } from "../../src/shared/core/planning-validation.js";
import type { PlanningContext } from "../../src/shared/contracts/product-planning.js";

it("requires separate complete-plan qualification and emits a resolvable strict schema for one read-only fake CLI call", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "complete-plan-cli-"));
  try {
    const context: PlanningContext = { purpose: "plan", productId: "product", workspaceRevision: 2, goalRevision: 1, goalHash: "a".repeat(64),
      goal: { schemaVersion: "1.0", originalRequest: "Create product", goal: "Deliver product", scope: "One increment", assumptions: [], acceptanceCriteria: [{ id: "core", description: "Runnable", verification: "platform", required: true }] } };
    const script = path.join(root, "fake.cjs");
    writeFileSync(script, `const fs=require('fs'),path=require('path');const args=process.argv.slice(2),dir=args[args.indexOf('-C')+1];fs.writeFileSync(path.join(dir,'observed-args.json'),JSON.stringify(args));const {context:c,contextHash}=JSON.parse(fs.readFileSync(path.join(dir,'context.json'),'utf8'));const plan={schemaVersion:'1.0',productId:c.productId,goalRevision:c.goalRevision,goalHash:c.goalHash,summary:'Complete plan',workItems:[{id:'build',title:'Build',objective:'Meet goal',deliverable:'Runnable',acceptanceCriterionIds:['core'],dependsOn:[]}]};const result={schemaVersion:'1.0',productId:c.productId,goalRevision:c.goalRevision,goalHash:c.goalHash,contextHash,summary:'Complete proposal',options:[{id:'plan',title:'Plan',rationale:'Verifiable',goal:c.goal,plan}],recommendedOptionId:'plan',questions:[]};fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`);
    const input = { actionId: "plan", context, contextHash: "b".repeat(64), timeoutSeconds: 300 as const, signal: new AbortController().signal };
    const options = { program: process.execPath, prefixArgs: [script], proxyEnvironment: () => ({}) };
    await expect(new CodexProductPlanner(path.resolve("schemas"), path.join(root, "denied"), { ...options, qualified: true }).run(input)).rejects.toMatchObject({ code: "RUNTIME_NOT_QUALIFIED" });
    const planner = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "allowed"), { ...options, planQualified: true });
    expect(planner.available).toBe(false);
    const output = await planner.run(input);
    assertProposal(output, context, input.contextHash);
    const directory = path.join(root, "allowed", "plan");
    const schema = JSON.parse(readFileSync(path.join(directory, "product-proposal-input.schema.json"), "utf8"));
    expect(Object.keys(schema.$defs).sort()).toEqual(["productGoal", "productPlan", "workItem"]);
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
    const args = JSON.parse(readFileSync(path.join(directory, "observed-args.json"), "utf8")) as string[];
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("multi_agent");
    await expect(planner.run(input)).rejects.toThrow(); // The unique artifact directory cannot be overwritten.
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
