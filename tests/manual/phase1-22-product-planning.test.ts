import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";
import { CodexProductPlanner } from "../../src/main/products/product-planner.js";
import { canonicalProductJson } from "../../src/shared/core/product-validation.js";
import type { ProcessSpec } from "../../src/main/process/runner.js";
import { fileHash, verifyPlanningQualification } from "./phase1-22-registration.js";

const dispatch = vi.hoisted(() => ({ before: null as null | ((_spec: ProcessSpec) => void) }));
vi.mock("../../src/main/process/runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/main/process/runner.js")>();
  return { ...actual, runProcess: async (spec: ProcessSpec) => {
    if (!dispatch.before) throw new Error("Real planning dispatch is not registered.");
    dispatch.before(spec);
    return actual.runProcess(spec);
  } };
});

const qualificationPhase = process.env.RUN_PRODUCT_PLANNING_QUALIFICATION;
describe.skipIf(qualificationPhase !== "1.22" && qualificationPhase !== "1.23")("Authorized one-call product qualification", () => {
  it("freezes the production request before dispatch and records the real result without retry", async () => {
    const root = readFileSync(`docs/PHASE_${qualificationPhase?.replace(".", "_")}_EVIDENCE_ROOT.txt`, "utf8").trim();
    const approval = verifyPlanningQualification(root, qualificationPhase as "1.22" | "1.23");
    const database = new AppDatabase(path.join(root, "qualification.db"));
    const products = new ProductService(database);
    const original = await products.create({ requestId: "qualification-product", name: "合成反馈产品", initialRequest: approval.originalRequest });
    const context = { productId: original.product.id, workspaceRevision: 1, goalRevision: 1, goalHash: original.goal.hash, goal: original.goal.goal };
    const contextHash = createHash("sha256").update(canonicalProductJson(context)).digest("hex");
    const planner = new CodexProductPlanner(path.resolve("schemas"), path.join(root, "artifacts"), { qualified: true, program: approval.program });
    const service = new ProductPlanningService(database, products, planner);
    const grant = await service.authorize({ requestId: "qualification-grant", productId: original.product.id, expectedRevision: 1 });
    const input = { requestId: "qualification-proposal", productId: original.product.id, grantId: grant.id, expectedRevision: 1 };
    let calls = 0;
    let actionDirectory = "";
    const report: Record<string, unknown> = { status: "RUNNING", modelCalls: 0, productId: original.product.id, contextHash };
    dispatch.before = spec => {
      if (calls !== 0) throw new Error("Qualification call budget exhausted.");
      for (const source of approval.sourceHashes) if (fileHash(source.path) !== source.sha256) throw new Error("Source drift before dispatch.");
      if (fileHash(approval.program) !== approval.programHash || spec.program !== approval.program || spec.timeoutSeconds !== 300 ||
          spec.args[spec.args.indexOf("-m") + 1] !== approval.model || !spec.args.includes('model_reasoning_effort="medium"') ||
          spec.args[spec.args.indexOf("--sandbox") + 1] !== "read-only" || !spec.args.includes("multi_agent") || !spec.args.includes("agents.enabled=false")) {
        throw new Error("Actual planning command differs from approved bounds.");
      }
      const relative = path.relative(path.join(root, "artifacts"), spec.cwd);
      if (!relative || relative.includes(path.sep) || relative.startsWith("..") || path.isAbsolute(relative) || spec.runId !== relative) throw new Error("Invalid action directory.");
      const stored = JSON.parse(readFileSync(path.join(spec.cwd, "context.json"), "utf8"));
      if (canonicalProductJson(stored) !== canonicalProductJson({ context, contextHash })) throw new Error("Planning context changed.");
      const frozen = {
        actionId: spec.runId, grant, input, context, contextHash, program: spec.program, programHash: approval.programHash,
        args: spec.args, cwd: spec.cwd, timeoutSeconds: spec.timeoutSeconds, environmentKeys: Object.keys(spec.env ?? {}).sort(),
        files: readdirSync(spec.cwd).map(name => ({ name, sha256: fileHash(path.join(spec.cwd, name)) }))
      };
      const frozenPath = path.join(root, "frozen-request.json");
      writeFileSync(frozenPath, JSON.stringify(frozen, null, 2), { flag: "wx" });
      const seal = fileHash(frozenPath);
      writeFileSync(path.join(root, "frozen-request.sha256"), seal, { flag: "wx" });
      if (fileHash(frozenPath) !== seal) throw new Error("Request freeze failed.");
      writeFileSync(path.join(root, "dispatch.json"), JSON.stringify({ at: new Date().toISOString(), call: 1, requestHash: seal }), { flag: "wx" });
      calls = 1;
      actionDirectory = spec.cwd;
    };
    try {
      const action = await service.requestProposal(input);
      report.action = action;
      report.modelCalls = calls;
      if (actionDirectory) {
        const execution = JSON.parse(readFileSync(path.join(actionDirectory, "execution.json"), "utf8"));
        report.process = execution.process;
        report.usage = execution.usage ?? "UNAVAILABLE";
        const events = readFileSync(path.join(actionDirectory, "stdout.log"), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        const items = events.filter(event => event.item).map(event => event.item);
        const unknown = items.filter(item => !["reasoning", "agent_message"].includes(item.type));
        report.toolOrUnknownItems = unknown;
        expect(unknown).toEqual([]);
        expect(execution.process).toMatchObject({ status: "SUCCEEDED", closeObserved: true });
        if (execution.process.pid) {
          let alive = false;
          try { process.kill(execution.process.pid, 0); alive = true; } catch { /* The completed direct process must be gone. */ }
          expect(alive).toBe(false);
        }
      }
      expect(action.status).toBe("SUCCEEDED");
      expect(calls).toBe(1);
      expect(await products.getOverview({ productId: original.product.id })).toEqual(original);
      expect((await service.getState({ productId: original.product.id })).grant?.usedCalls).toBe(1);
      database.close();
      const reopened = new AppDatabase(path.join(root, "qualification.db"));
      try {
        const restored = new ProductPlanningService(reopened, new ProductService(reopened), planner);
        expect(await restored.requestProposal(input)).toEqual(action);
        expect(calls).toBe(1);
      } finally { reopened.close(); }
      report.status = "PASS";
    } catch (error) {
      report.status = "FAIL";
      report.error = error instanceof Error ? error.message : String(error);
      report.modelCalls = calls;
      throw error;
    } finally {
      dispatch.before = null;
      try { database.close(); } catch { /* Already closed for the restart check. */ }
      writeFileSync(path.join(root, "real-result.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    }
  }, 330000);
});
