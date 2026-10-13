import { Ajv2020 } from "ajv/dist/2020.js";
import goalSchema from "../../../schemas/product-goal.schema.json" with { type: "json" };
import planningSchema from "../../../schemas/product-planning.schema.json" with { type: "json" };
import proposalSchema from "../../../schemas/product-proposal.schema.json" with { type: "json" };
import { PlanningError, type PlanningAction, type PlanningApi, type PlanningContext, type PlanningErrorCode, type ProductProposal } from "../contracts/product-planning.js";
import planSchema from "../../../schemas/product-plan.schema.json" with { type: "json" };
import { validateProductPlan } from "./product-plan-validation.js";
import { canonicalProductJson } from "./product-validation.js";
import { validateDirection } from "./product-validation.js";
export { PlanningError } from "../contracts/product-planning.js";
export type PlanningMethod = keyof PlanningApi;

const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
for (const schema of [goalSchema, planSchema, proposalSchema, planningSchema]) ajv.addSchema(schema);
const methods: PlanningMethod[] = ["authorize", "revoke", "requestProposal", "getState"];
const inputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${planningSchema.$id}#/$defs/${method}` })]));
const outputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${planningSchema.$id}#/$defs/${method}Response` })]));
const proposalValidator = ajv.getSchema(proposalSchema.$id)!;

function checkSize(value: unknown, maximum: number, code: PlanningErrorCode): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new PlanningError(code, "数据不可序列化。"); }
  if (json === undefined) throw new PlanningError(code, "缺少数据。");
  if (new TextEncoder().encode(json).byteLength > maximum) {
    throw new PlanningError(code === "INVALID_INPUT" ? "INPUT_TOO_LARGE" : code, "数据超过允许大小。");
  }
}

export function assertPlanningInput(method: PlanningMethod, value: unknown): void {
  checkSize(value, 65536, "INVALID_INPUT");
  if (!inputs.get(method)!(value)) throw new PlanningError("INVALID_INPUT", "规划请求格式不正确。");
}

function checkProposalChoices(proposal: ProductProposal): void {
  if (!proposal.summary.trim() || proposal.options.some(item => !item.title.trim() || !item.rationale.trim()) ||
      proposal.questions.some(item => !item.trim()) || new Set(proposal.options.map(item => item.id)).size !== proposal.options.length ||
      !proposal.options.some(item => item.id === proposal.recommendedOptionId)) {
    throw new PlanningError("INVALID_PROPOSAL", "提案选项不完整或重复。");
  }
  const hasPlans = proposal.options.some(option => option.plan !== undefined);
  if (hasPlans && proposal.options.some(option => option.plan === undefined)) {
    throw new PlanningError("INVALID_PROPOSAL", "完整计划选项不能与方向选项混合。 ");
  }
  for (const option of proposal.options) {
    try {
      validateDirection(option.goal);
      if (option.plan) validateProductPlan(option.plan, option.goal, proposal);
    }
    catch { throw new PlanningError("INVALID_PROPOSAL", "提案目标或验收不完整。"); }
  }
}

export function assertProposal(value: unknown, context: PlanningContext, expectedContextHash: string): asserts value is ProductProposal {
  checkSize(value, 65536, "INVALID_PROPOSAL");
  if (!proposalValidator(value)) throw new PlanningError("INVALID_PROPOSAL", "提案格式不正确。");
  const proposal = value as ProductProposal;
  if (proposal.productId !== context.productId || proposal.goalRevision !== context.goalRevision ||
      proposal.goalHash !== context.goalHash || proposal.contextHash !== expectedContextHash ||
      proposal.options.some(item => item.goal.originalRequest !== context.goal.originalRequest)) {
    throw new PlanningError("INVALID_PROPOSAL", "提案与当前上下文不一致。");
  }
  const planMode = context.purpose === "plan";
  if (proposal.options.some(option => planMode
    ? option.plan === undefined || canonicalProductJson(option.goal) !== canonicalProductJson(context.goal)
    : option.plan !== undefined)) {
    throw new PlanningError("INVALID_PROPOSAL", "提案用途或计划目标不一致。");
  }
  checkProposalChoices(proposal);
}

function checkAction(action: PlanningAction): void {
  const running = action.status === "RUNNING";
  const succeeded = action.status === "SUCCEEDED";
  if ((running !== (action.finishedAt === null)) || (succeeded !== (action.proposal !== null)) ||
      ((running || succeeded) !== (action.errorCode === null))) {
    throw new PlanningError("INVALID_RESPONSE", "调用结果与终态不一致。");
  }
  if (action.proposal) {
    const proposal = action.proposal;
    if (proposal.productId !== action.productId || proposal.goalRevision !== action.goalRevision ||
        proposal.goalHash !== action.goalHash || proposal.contextHash !== action.contextHash) {
      throw new PlanningError("INVALID_RESPONSE", "调用结果归属不一致。");
    }
    try { checkProposalChoices(proposal); }
    catch { throw new PlanningError("INVALID_RESPONSE", "调用返回的方案无效。"); }
  }
}

export function assertPlanningResponse(method: PlanningMethod, value: unknown, request?: { productId: string }): void {
  checkSize(value, 1024 * 1024, "INVALID_RESPONSE");
  if (!outputs.get(method)!(value)) throw new PlanningError("INVALID_RESPONSE", "规划响应格式不正确。");
  const result = value as { ok: boolean; value: unknown };
  if (!result.ok) return;
  const records = method === "getState"
    ? [(result.value as { grant: unknown; action: unknown }).grant, (result.value as { grant: unknown; action: unknown }).action]
    : [result.value];
  if (request && records.some(record => record !== null && (record as { productId: string }).productId !== request.productId)) {
    throw new PlanningError("INVALID_RESPONSE", "规划响应归属不匹配。");
  }
  if (method === "requestProposal") checkAction(result.value as PlanningAction);
  if (method === "getState") {
    const state = result.value as { action: PlanningAction | null };
    if (state.action) checkAction(state.action);
  }
}
