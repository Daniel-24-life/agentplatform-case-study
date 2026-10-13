import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppDatabase } from "../../src/main/db/database.js";
import { GitService } from "../../src/main/git/git-service.js";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import { TaskOrchestrator } from "../../src/main/orchestrator/task-orchestrator.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductExecutionService } from "../../src/main/products/product-execution-service.js";
import { ProductRunService } from "../../src/main/products/product-run-service.js";
import { RunControl } from "../../src/main/runs/run-control.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

// A real local Git/CLI/TestRun fixture; only model reasoning is simulated.
export async function createProductWorkflowFixture(root: string, options: { maxAttempts?: number; staticWeb?: boolean } = {}) {
  const repo = path.join(root, "repo"); mkdirSync(repo, { recursive: true });
  const gitCommand = (args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  gitCommand(["init"]); writeFileSync(path.join(repo, "value.txt"), "before\n");
  if (options.staticWeb) { writeFileSync(path.join(repo, "index.html"), "<!doctype html><html><head><meta charset='utf-8'><title>Fixture preview</title></head><body><h1>可体验成果夹具</h1></body></html>"); writeFileSync(path.join(repo, ".gitignore"), "dist/\n"); }
  gitCommand(["add", "."]);
  gitCommand(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Baseline"]);
  const database = new AppDatabase(path.join(root, "app.db"));
  database.createProject({ id: "fixture-repo", name: "Fixture", repoPath: repo, repoRealPath: repo, lastSeenHead: gitCommand(["rev-parse", "HEAD"]) });
  const products = new ProductService(database), plans = new ProductPlanService(database, products);
  const git = new GitService("git", path.join(root, "managed-worktrees"));
  const execution = new ProductExecutionService(database, products, plans, git);
  let overview = await products.create({ requestId: "create-product", name: "Fixture product", initialRequest: "Deliver a verifiable increment" });
  overview = await products.reviseGoal({ requestId: "save-goal", productId: overview.product.id, expectedRevision: overview.product.revision, goal: { ...overview.goal.goal, goal: "Update the value", scope: "Local file", acceptanceCriteria: [{ id: "value-updated", description: "The value becomes after", verification: "platform", required: true }] } });
  overview = await products.confirmDirection({ requestId: "direction", productId: overview.product.id, expectedRevision: overview.product.revision, goalRevision: overview.goal.revision });
  await products.getOverview({ productId: overview.product.id });
  const saved = await plans.save({ requestId: "save-plan", productId: overview.product.id, expectedPlanRevision: 0, plan: { schemaVersion: "1.0", productId: overview.product.id, goalRevision: overview.goal.revision, goalHash: overview.goal.hash, summary: "Runnable increment", workItems: [{ id: "implement", title: "Update value", objective: "Make after", deliverable: "Updated file and evidence", acceptanceCriterionIds: ["value-updated"], dependsOn: [] }] } });
  await plans.confirm({ requestId: "confirm-plan", productId: overview.product.id, planRevision: saved.revision });
  await execution.bindRepository({ requestId: "bind", productId: overview.product.id, expectedRevision: overview.product.revision, repositoryId: "fixture-repo" });
  const link = await execution.createTask({ requestId: "create-task", productId: overview.product.id, planRevision: saved.revision });
  const testProgram = "const fs=require('fs');if(fs.readFileSync('value.txt','utf8')!=='after\\n')process.exit(1)" + (options.staticWeb ? ";fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('index.html','dist/index.html')" : "");
  const spec: TaskSpec = { schema_version: "2.0", task_id: link.taskId, title: "Update value", goal: "Set value.txt to after", base_sha: gitCommand(["rev-parse", "HEAD"]), context_paths: ["value.txt"], scope: { allowed_paths: ["value.txt"], forbidden_paths: [] }, acceptance_criteria: [{ id: "AC-01", text: "The file contains after" }], test_commands: [{ id: "verification", program: "node", args: ["-e", testProgram], cwd: ".", timeout_seconds: 10, required: true }], execution_policy: { planner_recommendation: "strong", planner_confidence: "high", recommendation_reasons: ["Controlled fixture"], user_lock: "strong" }, limits: { max_attempts: options.maxAttempts ?? 1, run_timeout_seconds: 60, max_changed_files: 1, max_diff_bytes: 4096 } };
  const specFile = path.join(root, "fake-spec.json"); writeFileSync(specFile, JSON.stringify(spec));
  const fake = path.join(root, "fake-codex.cjs");
  writeFileSync(fake, [
    "const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const out=args[args.indexOf('--output-last-message')+1],cwd=args[args.indexOf('-C')+1];const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));",
    `const spec=JSON.parse(fs.readFileSync(${JSON.stringify(specFile)},'utf8'));let value;`,
    "if(schema.properties.execution_policy)value=spec;",
    "else if(schema.properties.status){fs.writeFileSync(path.join(cwd,'value.txt'),'after\\n');value={schema_version:'1.0',task_id:spec.task_id,status:'completed',summary:'Updated value',changed_files:['value.txt'],acceptance_notes:[{criterion_id:'AC-01',note:'Implemented'}],risks:[],blocker:null};}",
    "else value={schema_version:'1.0',task_id:spec.task_id,verdict:'PASS',summary:'Verified',criteria:[{criterion_id:'AC-01',status:'satisfied',evidence:'Platform test and diff'}],findings:[],test_assessment:'Passed',scope_assessment:'Passed',rework_instructions:[]};",
    "fs.writeFileSync(out,JSON.stringify(value));console.log(JSON.stringify({type:'thread.started',thread_id:'fake'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));"
  ].join("\n"));
  const adapter = new CodexAdapter(process.execPath, [fake], () => ({}));
  const artifacts = path.join(root, "artifacts");
  const orchestrator = new TaskOrchestrator(database, git, adapter, adapter, [adapter], undefined, undefined, artifacts, path.resolve("schemas"));
  const runs = new ProductRunService(database, execution, orchestrator, { assertReady: () => {}, invoke: async action => await action() }, new RunControl(database, artifacts));
  await orchestrator.startDesign(link.taskId); orchestrator.approveSpec(link.taskId);
  const task = database.getTask(link.taskId)!;
  const input = { requestId: "run", productId: overview.product.id, planRevision: saved.revision, taskId: task.id, specRevision: task.specRevision, specHash: createHash("sha256").update(task.specJson!).digest("hex") };
  return { database, products, plans, execution, git, orchestrator, runs, artifacts, repo, link, input };
}

export async function waitForProductRun(fixture: Awaited<ReturnType<typeof createProductWorkflowFixture>>) {
  for (let index = 0; index < 300; index++) {
    const action = await fixture.runs.getState({ productId: fixture.input.productId });
    if (action && !["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED"].includes(action.status)) return action;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Product fixture execution did not converge");
}
