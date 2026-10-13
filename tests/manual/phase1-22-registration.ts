import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type PlanningQualificationApproval = {
  phase: "1.22" | "1.23";
  authorized: true;
  maxCalls: 1;
  timeoutSeconds: 300;
  program: string;
  programHash: string;
  model: "gpt-5.6-sol";
  reasoning: "medium";
  originalRequest: string;
  sourceHashes: Array<{ path: string; sha256: string }>;
};

export const fileHash = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export function verifyPlanningQualification(root: string, phase: "1.22" | "1.23" = "1.22"): PlanningQualificationApproval {
  const approval = JSON.parse(readFileSync(path.join(root, "approval.json"), "utf8")) as PlanningQualificationApproval;
  const seal = readFileSync(path.join(root, "approval.sha256"), "utf8").trim();
  if (fileHash(path.join(root, "approval.json")) !== seal || approval.phase !== phase || approval.authorized !== true ||
      approval.maxCalls !== 1 || approval.timeoutSeconds !== 300 || approval.model !== "gpt-5.6-sol" || approval.reasoning !== "medium" ||
      !path.isAbsolute(approval.program) || fileHash(approval.program) !== approval.programHash || !approval.originalRequest ||
      !Array.isArray(approval.sourceHashes) || approval.sourceHashes.length === 0) throw new Error("Qualification approval is invalid.");
  for (const source of approval.sourceHashes) {
    if (fileHash(source.path) !== source.sha256) throw new Error("Qualification source drift.");
  }
  if (existsSync(path.join(root, "dispatch.json")) || existsSync(path.join(root, "qualification.db"))) {
    throw new Error("Qualification output or budget was already used.");
  }
  return approval;
}
