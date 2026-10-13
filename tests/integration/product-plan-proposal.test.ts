import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture } from "../helpers/product-workflow.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";
import type { ProductPlanner, ProductPlannerInput } from "../../src/main/products/product-planner.js";

it("uses an independent one-call complete-plan grant without saving, confirming or refreshing its budget", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "product-complete-plan-"));
  const f = await createProductWorkflowFixture(root);
  try {
    const overview = await f.products.getOverview({ productId: f.input.productId });
    let calls = 0;
    let malformed = false;
    const planner: ProductPlanner = { available: false, planAvailable: true, run: async ({ context, contextHash }: ProductPlannerInput) => {
      calls++;
      return { schemaVersion: "1.0", productId: context.productId, goalRevision: context.goalRevision, goalHash: context.goalHash, contextHash,
        summary: "Complete plan", options: [{ id: "plan", title: "Plan", rationale: "Verifiable increment", goal: context.goal,
          plan: { schemaVersion: "1.0", productId: context.productId, goalRevision: context.goalRevision, goalHash: malformed ? "0".repeat(64) : context.goalHash,
            summary: "Implement and verify", workItems: [{ id: "implement", title: "Implement", objective: "Meet goal", deliverable: "Runnable increment", acceptanceCriterionIds: ["value-updated"], dependsOn: [] }] } }], recommendedOptionId: "plan", questions: [] };
    } };
    const service = new ProductPlanningService(f.database, f.products, planner);
    const input = { requestId: "authorize-plan", productId: overview.product.id, expectedRevision: overview.product.revision };
    const grant = await service.authorize(input);
    const denied = new ProductPlanningService(f.database, f.products, { ...planner, planAvailable: false });
    await expect(denied.requestProposal({ ...input, requestId: "unqualified", grantId: grant.id, purpose: "plan" })).rejects.toMatchObject({ code: "RUNTIME_NOT_QUALIFIED" });
    expect((await service.getState({ productId: overview.product.id })).grant?.usedCalls).toBe(0);
    const request = { ...input, requestId: "plan", grantId: grant.id, purpose: "plan" as const };
    const [first, duplicate] = await Promise.all([service.requestProposal(request), service.requestProposal(request)]);
    expect(first.id).toBe(duplicate.id);
    const settled = await service.getState({ productId: overview.product.id });
    expect(settled).toMatchObject({ available: false, planAvailable: true, grant: { usedCalls: 1 }, action: { status: "SUCCEEDED" } });
    expect(calls).toBe(1);
    await expect(service.requestProposal({ ...request, requestId: "again" })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    const reopened = new ProductPlanningService(f.database, f.products, planner);
    expect((await reopened.requestProposal(request)).status).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    expect((f.database.db.prepare("SELECT COUNT(*) n FROM product_plan_revisions").get() as { n: number }).n).toBe(1);
    expect((await f.plans.getState({ productId: overview.product.id })).saved?.revision).toBe(1);
    malformed = true;
    const next = await service.authorize({ ...input, requestId: "new-grant" });
    const failed = await service.requestProposal({ ...request, requestId: "invalid-plan", grantId: next.id });
    expect(failed).toMatchObject({ status: "FAILED", proposal: null, errorCode: "INVALID_PROPOSAL" });
    expect(calls).toBe(2);
    const changed = await f.products.reviseGoal({ requestId: "unconfirmed", productId: overview.product.id, expectedRevision: overview.product.revision, goal: { ...overview.goal.goal, scope: "New scope" } });
    await expect(service.requestProposal({ ...request, requestId: "new-direction", expectedRevision: changed.product.revision })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    expect(calls).toBe(2);
  } finally { f.database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
