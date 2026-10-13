import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture } from "../helpers/product-workflow.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";

const target = process.env.AGENTPLATFORM_PHASE30_UI_FIXTURE;
it.skipIf(!target)("prepares a registered complete-plan UI fixture with no real model qualification", async () => {
  const root = readFileSync("docs/PHASE_1_30_EVIDENCE_ROOT.txt", "utf8").trim();
  const relative = path.relative(path.resolve(root), path.resolve(target!));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || existsSync(target!)) throw Error("Fresh registered evidence child required");
  mkdirSync(target!, { recursive: true });
  const f = await createProductWorkflowFixture(target!);
  try {
    let calls = 0;
    const planning = new ProductPlanningService(f.database, f.products, {
      available: false, planAvailable: true,
      run: async ({ context, contextHash }) => {
        calls++;
        return {
          schemaVersion: "1.0", productId: context.productId, goalRevision: context.goalRevision, goalHash: context.goalHash, contextHash,
          summary: "Offline fixture complete plan", recommendedOptionId: "complete", questions: [],
          options: [{ id: "complete", title: "可编辑的完整计划夹具", rationale: "仅验证界面与合同，不代表真实模型资格。", goal: context.goal,
            plan: { schemaVersion: "1.0", productId: context.productId, goalRevision: context.goalRevision, goalHash: context.goalHash,
              summary: "主 Agent 计划草稿夹具", workItems: [{ id: "implement", title: "实现可验证增量", objective: "完成当前目标", deliverable: "可运行成果与证据", acceptanceCriterionIds: ["value-updated"], dependsOn: [] }] } }]
        };
      }
    });
    const overview = await f.products.getOverview({ productId: f.input.productId });
    const grant = await planning.authorize({ requestId: "fixture-plan-grant", productId: overview.product.id, expectedRevision: overview.product.revision });
    const action = await planning.requestProposal({ requestId: "fixture-plan-proposal", productId: overview.product.id, expectedRevision: overview.product.revision, grantId: grant.id, purpose: "plan" });
    expect(action.status).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    expect((f.database.db.prepare("SELECT COUNT(*) n FROM product_plan_revisions").get() as { n: number }).n).toBe(1);
  } finally { f.database.close(); }
  renameSync(path.join(target!, "app.db"), path.join(target!, "agentplatform.db"));
}, 30000);
