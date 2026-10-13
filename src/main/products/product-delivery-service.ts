import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../db/database.js";
import type { GitService } from "../git/git-service.js";
import type { TaskOrchestrator } from "../orchestrator/task-orchestrator.js";
import type { ProductService } from "./product-service.js";
import type { ProductPlanService } from "./product-plan-service.js";
import type { ProductExecutionService } from "./product-execution-service.js";
import { referenceFile, verifyAttemptManifest, type AttemptManifest } from "../evidence/attempt-manifest.js";
import { validateTaskSpec } from "../../shared/core/task-spec.js";
import { validateFinalGateResult } from "../../shared/core/final-gate.js";
import { canonicalProductJson } from "../../shared/core/product-validation.js";
import { assertProductDeliveryInput, assertProductDeliveryResponse } from "../../shared/core/product-delivery-validation.js";
import { ProductDeliveryError, type CreateProductDeliveryInput, type ProductDelivery, type ProductDeliveryState, type DeliveryEvidence } from "../../shared/contracts/product-delivery.js";

export type ProductPreviewEvidence = { goalRevision: number; goalHash: string; planRevision: number; planHash: string; evidence: DeliveryEvidence };
type Row = Record<string, unknown>;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown): string => digest(canonicalProductJson(value));

/** Records business acceptance against verified, unchanged technical evidence. Never publishes or executes instructions. */
export class ProductDeliveryService {
  private readonly database: AppDatabase;
  private readonly products: ProductService;
  private readonly plans: ProductPlanService;
  private readonly execution: ProductExecutionService;
  private readonly orchestrator: Pick<TaskOrchestrator, "detail">;
  private readonly git: Pick<GitService, "collectEvidence" | "getManagedRoot">;
  private readonly artifactRoot: string;
  constructor(database: AppDatabase, products: ProductService, plans: ProductPlanService, execution: ProductExecutionService, orchestrator: Pick<TaskOrchestrator, "detail">, git: Pick<GitService, "collectEvidence" | "getManagedRoot">, artifactRoot: string) {
    this.database = database;
    this.products = products;
    this.plans = plans;
    this.execution = execution;
    this.orchestrator = orchestrator;
    this.git = git;
    this.artifactRoot = artifactRoot;
  }

  async getState(input: { productId: string }): Promise<ProductDeliveryState> {
    assertProductDeliveryInput("getState", input);
    const overview = await this.products.getOverview(input);
    const plan = await this.plans.getState(input);
    const row = this.database.db.prepare("SELECT * FROM product_deliveries WHERE product_id=? ORDER BY rowid DESC LIMIT 1").get(input.productId) as Row | undefined;
    const latest = row ? this.readDelivery(row) : null;
    const link = await this.execution.getState(input);
    const detail = latest ? this.orchestrator.detail(latest.evidence.taskId) : null;
    let current = latest !== null && overview.goal.revision === latest.goalRevision && overview.goal.hash === latest.goalHash && plan.current && plan.saved?.confirmedAt !== null && plan.saved?.revision === latest.planRevision && plan.saved.hash === latest.planHash && link.link?.taskId === latest.evidence.taskId && detail?.task.status === "PASSED" && detail.attempt?.id === latest.evidence.attemptId && digest(detail.task.specJson ?? "") === latest.evidence.specHash;
    if(current && latest) {
      try { const evidence = await this.verifyEvidence(latest.evidence.taskId,latest.evidence.attemptId); current = hash(evidence) === hash(latest.evidence); }
      catch(error) { if(error instanceof ProductDeliveryError && ['EVIDENCE_CHANGED','TASK_NOT_PASSED'].includes(error.code)) current=false; else throw error; }
    }
    const state = { productId: input.productId, latest, current };
    assertProductDeliveryResponse("getState", { ok: true, value: state }, input.productId);
    return state;
  }

  async create(input: CreateProductDeliveryInput): Promise<ProductDelivery> {
    assertProductDeliveryInput("create", input);
    const requestHash = hash(input);
    const historical = this.receipt(input.requestId, requestHash);
    if (historical) return historical;
    const overview = await this.products.getOverview({ productId: input.productId });
    const plan = await this.plans.getState({ productId: input.productId });
    const execution = await this.execution.getState({ productId: input.productId });
    if (!plan.current || !plan.directionConfirmed || !plan.saved?.confirmedAt || plan.saved.revision !== input.planRevision || execution.link?.taskId !== input.taskId) throw new ProductDeliveryError("PLAN_STALE", "请使用当前已确认计划的任务。");
    const criteria = overview.goal.goal.acceptanceCriteria;
    if (!criteria.length || input.reviews.length !== criteria.length || new Set(input.reviews.map(r => r.criterionId)).size !== criteria.length || input.reviews.some(r => !criteria.some(c => c.id === r.criterionId) || !r.note.trim() || (r.accepted && !r.taskCriterionIds.length)) || !input.runInstructions.trim() || !input.limitations.trim()) throw new ProductDeliveryError("REVIEW_INCOMPLETE", "请逐条记录产品验收、相关任务标准和观察说明，并填写运行说明与限制。");
    const evidence = await this.verifyEvidence(input.taskId, input.attemptId);
    const detail = this.orchestrator.detail(input.taskId);
    const satisfied = new Set(detail.snapshot!.final!.criteria.filter(c => c.status === "satisfied").map(c => c.criterion_id));
    if (input.reviews.some(r => r.taskCriterionIds.some(id => !satisfied.has(id)))) throw new ProductDeliveryError("REVIEW_INCOMPLETE", "只能引用当前任务已通过的验收标准。");
    const delivery: ProductDelivery = { id: randomUUID(), productId: input.productId, goalRevision: overview.goal.revision, goalHash: overview.goal.hash, planRevision: plan.saved.revision, planHash: plan.saved.hash,
      criteria, reviews: input.reviews, evidence, runInstructions: input.runInstructions, limitations: input.limitations,
      status: criteria.every(c => !c.required || input.reviews.find(r => r.criterionId === c.id)?.accepted) ? "ACCEPTED_UNPUBLISHED" : "REVIEW_REQUIRED", previewStatus: "NOT_RUN", publicationStatus: "NOT_RUN", createdAt: new Date().toISOString() };
    assertProductDeliveryResponse("create", { ok: true, value: delivery }, input.productId);
    return this.database.transaction(() => {
      const raced = this.receipt(input.requestId, requestHash); if (raced) return raced;
      this.products.assertActive(input.productId);
      // Recheck current identities after awaited Git work, before the atomic immutable record and receipt.
      const row = this.database.db.prepare(`SELECT c.goal_revision,g.sha256 goal_hash,p.revision,p.sha256 plan_hash,p.confirmed_at,g.payload_json goal_json,p.payload_json plan_json
        FROM product_workspaces w JOIN product_cycles c ON c.id=w.current_cycle_id
        JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision
        JOIN product_plan_revisions p ON p.cycle_id=c.id
        WHERE w.id=? ORDER BY p.revision DESC LIMIT 1`).get(input.productId) as Row | undefined;
      const task = this.database.getTask(input.taskId), attempt = this.database.getLatestAttempt(input.taskId);
      if (!row || Number(row.goal_revision) !== delivery.goalRevision || String(row.goal_hash) !== delivery.goalHash || Number(row.revision) !== delivery.planRevision || String(row.plan_hash) !== delivery.planHash || !row.confirmed_at || hash(JSON.parse(String(row.goal_json))) !== delivery.goalHash || hash(JSON.parse(String(row.plan_json))) !== delivery.planHash) throw new ProductDeliveryError("PLAN_STALE", "验收期间产品目标或计划已改变。");
      if (task?.status !== "PASSED" || attempt?.id !== evidence.attemptId || task.specRevision !== evidence.specRevision || digest(task.specJson ?? "") !== evidence.specHash) throw new ProductDeliveryError("EVIDENCE_CHANGED", "验收期间任务证据已改变。");
      const payload = canonicalProductJson(delivery);
      this.database.db.prepare("INSERT INTO product_deliveries VALUES(?,?,?,?,?)").run(delivery.id, delivery.productId, payload, digest(payload), delivery.createdAt);
      this.database.db.prepare("INSERT INTO product_delivery_receipts VALUES(?,?,?)").run(input.requestId, requestHash, delivery.id);
      return delivery;
    });
  }

  /** Technical evidence is available before business acceptance so the product can be experienced. */
  async readPreviewEvidence(productId: string): Promise<ProductPreviewEvidence> {
    const overview = await this.products.getOverview({ productId });
    const plan = await this.plans.getState({ productId });
    const execution = await this.execution.getState({ productId });
    if (!plan.current || !plan.directionConfirmed || !plan.saved?.confirmedAt || !execution.link) throw new ProductDeliveryError("PLAN_STALE", "请使用当前已确认计划的任务。");
    const detail = this.orchestrator.detail(execution.link.taskId);
    if (!detail.attempt || detail.task.status !== "PASSED") throw new ProductDeliveryError("TASK_NOT_PASSED", "当前任务尚未通过技术检查。");
    const evidence = await this.verifyEvidence(detail.task.id, detail.attempt.id);
    const result = { goalRevision: overview.goal.revision, goalHash: overview.goal.hash, planRevision: plan.saved.revision, planHash: plan.saved.hash, evidence };
    this.assertPreviewEvidenceCurrent(productId, result);
    return result;
  }

  assertPreviewEvidenceCurrent(productId: string, value: ProductPreviewEvidence): void {
    this.products.assertActive(productId);
    const row = this.database.db.prepare(`SELECT c.goal_revision,g.sha256 goal_hash,p.revision,p.sha256 plan_hash,p.confirmed_at,l.task_id,t.status,t.spec_revision,t.spec_json,a.id attempt_id
      FROM product_workspaces w JOIN product_cycles c ON c.id=w.current_cycle_id
      JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision
      JOIN product_plan_revisions p ON p.cycle_id=c.id AND p.revision=(SELECT MAX(revision) FROM product_plan_revisions WHERE cycle_id=c.id)
      JOIN product_task_links l ON l.product_id=w.id AND l.cycle_id=c.id AND l.plan_revision=p.revision
      JOIN tasks t ON t.id=l.task_id LEFT JOIN attempts a ON a.task_id=t.id
      WHERE w.id=? ORDER BY p.revision DESC,a.number DESC LIMIT 1`).get(productId) as Row | undefined;
    if (!row || Number(row.goal_revision) !== value.goalRevision || row.goal_hash !== value.goalHash || Number(row.revision) !== value.planRevision || row.plan_hash !== value.planHash || !row.confirmed_at || row.task_id !== value.evidence.taskId || row.status !== "PASSED" || row.attempt_id !== value.evidence.attemptId || Number(row.spec_revision) !== value.evidence.specRevision || digest(String(row.spec_json)) !== value.evidence.specHash) throw new ProductDeliveryError("EVIDENCE_CHANGED", "产品或技术证据已变化，请重新核对成果。");
  }

  private async verifyEvidence(taskId: string, attemptId: string): Promise<DeliveryEvidence> {
    const detail = this.orchestrator.detail(taskId), { task, attempt, snapshot } = detail;
    if (task.status !== "PASSED" || !attempt || attempt.id !== attemptId || !snapshot || snapshot.attemptId !== attempt.id || snapshot.final?.verdict !== "PASS" || snapshot.gate?.passed !== true || !task.specApprovedAt || !task.specJson) throw new ProductDeliveryError("TASK_NOT_PASSED", "仅通过平台测试和最终审查的当前任务可进入交付。");
    try {
      const managedRoot = realpathSync(this.git.getManagedRoot()), worktree = realpathSync(attempt.worktreePath);
      const relative = path.relative(managedRoot, worktree);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || worktree !== path.resolve(attempt.worktreePath) || snapshot.worktreePath !== attempt.worktreePath || snapshot.branch !== attempt.branch) throw Error("Worktree identity");
      const specResult = validateTaskSpec(JSON.parse(task.specJson)); if (!specResult.valid) throw Error("Invalid TaskSpec");
      const spec = specResult.value!;
      if(spec.task_id!==taskId || spec.base_sha!==task.baseSha || !detail.runs.some(r=>r.attemptId===attempt.id && r.stage==='reviewer' && r.status==='SUCCEEDED' && r.exitCode===0))throw Error('Review identity');
      const refs = snapshot.artifacts.map(entry => {
        const current = referenceFile(this.artifactRoot, attempt.id, entry.kind, "attempt", entry.path);
        if (current.sha256 !== entry.sha256 || current.sizeBytes !== entry.sizeBytes) throw Error("Artifact changed");
        return current;
      });
      const artifact = (kind: string): string => {
        const matches = refs.filter(r => r.kind === kind); if(matches.length !== 1)throw Error("Artifact missing or duplicate");
        return readFileSync(path.join(this.artifactRoot,"attempts",attempt.id,matches[0].path),"utf8");
      };
      const manifest = JSON.parse(artifact("manifest")) as AttemptManifest; verifyAttemptManifest(this.artifactRoot, manifest);
      const git = await this.git.collectEvidence(worktree);
      if (git.head !== snapshot.git.head || git.diff !== snapshot.git.diff || git.stat !== snapshot.git.stat || canonicalProductJson(git.changedFiles) !== canonicalProductJson(snapshot.git.changedFiles) || git.invalidPaths.length) throw Error("Git drift");
      for(const ref of refs) {
        const now=referenceFile(this.artifactRoot,attempt.id,ref.kind,'attempt',ref.path);
        if(now.sha256!==ref.sha256 || now.sizeBytes!==ref.sizeBytes)throw Error('Artifact changed during Git read');
      }
      const specHash = digest(task.specJson);
      if (manifest.project_id !== task.projectId || manifest.task_id !== taskId || manifest.attempt_id !== attempt.id || manifest.base_sha !== task.baseSha || manifest.branch !== attempt.branch || manifest.worktree_head !== git.head || manifest.task_spec.revision !== task.specRevision || manifest.task_spec.sha256 !== specHash || manifest.task_spec.approved_at !== task.specApprovedAt || !manifest.deterministic_gate.passed || canonicalProductJson(manifest.changed_files) !== canonicalProductJson(git.changedFiles)) throw Error("Manifest identity");
      if (artifact("task-spec-approved") !== task.specJson || artifact("diff") !== git.diff || artifact("diff-stat") !== git.stat || artifact("changed-files") !== JSON.stringify(git.changedFiles,null,2) || artifact("deterministic-gate") !== JSON.stringify(snapshot.gate,null,2) || hash(JSON.parse(artifact("final-gate"))) !== hash(snapshot.final)) throw Error("Evidence content");
      if(refs.filter(r=>r.kind!=="manifest"&&r.kind!=="final-gate").some(r=>!manifest.artifacts.some(m=>m.root==="attempt"&&m.kind===r.kind&&m.path===r.path&&m.sha256===r.sha256&&m.sizeBytes===r.sizeBytes)))throw Error("Manifest coverage");
      const tests = snapshot.tests ?? [];
      if (manifest.test_runs.length !== tests.length || spec.test_commands.some(command => command.required && !tests.some(t => t.id === command.id && t.required && t.result.status === "SUCCEEDED" && t.result.exitCode === 0))) throw Error("Required test missing");
      for (const test of tests) {
        const entry = manifest.test_runs.find(t=>t.id===test.id), run = detail.runs.find(r=>r.id===test.runId);
        if(!entry || entry.run_id!==test.runId || entry.required!==test.required || entry.status!==test.result.status || run?.attemptId!==attempt.id || run.stage!==`test:${test.id}` || run.status!==test.result.status || run.exitCode!==test.result.exitCode || artifact(`test-${test.id}-result`)!==JSON.stringify(test,null,2))throw Error("Test evidence");
      }
      const final = validateFinalGateResult(snapshot.final,{taskId,validCriterionIds:spec.acceptance_criteria.map(c=>c.id),deterministicGatePassed:true,requiredTestsPassed:tests.every(t=>!t.required||(t.result.status==="SUCCEEDED"&&t.result.exitCode===0)),scopePassed:git.invalidPaths.length===0});
      if(!final.valid)throw Error("Final criteria");
      return {taskId,specRevision:task.specRevision,specHash,attemptId:attempt.id,branch:attempt.branch,worktreePath:attempt.worktreePath,head:git.head,diffHash:digest(git.diff),manifestHash:refs.find(r=>r.kind==="manifest")!.sha256,finalGateHash:refs.find(r=>r.kind==="final-gate")!.sha256,testRunIds:tests.map(t=>t.runId!)};
    } catch { throw new ProductDeliveryError("EVIDENCE_CHANGED", "任务内容或工件与通过测试和审查时的证据不一致，请重新验证。"); }
  }

  private receipt(requestId: string, requestHash: string): ProductDelivery | null {
    const row = this.database.db.prepare("SELECT r.request_hash,d.* FROM product_delivery_receipts r JOIN product_deliveries d ON d.id=r.delivery_id WHERE r.request_id=?").get(requestId) as Row | undefined;
    if(!row)return null;
    if(String(row.request_hash)!==requestHash)throw new ProductDeliveryError("REQUEST_ID_CONFLICT","此请求编号已用于不同的验收记录。");
    return this.readDelivery(row);
  }
  private readDelivery(row: Row): ProductDelivery {
    try {
      const raw = String(row.payload_json); if(digest(raw)!==String(row.sha256))throw Error("Hash changed");
      const delivery = JSON.parse(raw) as ProductDelivery;
      assertProductDeliveryResponse("create",{ok:true,value:delivery},String(row.product_id));
      if(delivery.id!==row.id || delivery.createdAt!==row.created_at)throw Error("Identity changed");
      return delivery;
    } catch { throw new ProductDeliveryError("DATA_CORRUPT","保存的产品交付记录校验失败。"); }
  }
}
