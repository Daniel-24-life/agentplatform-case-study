import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import { createPhase111Preparation, executePhase111Cases, executePhase111RealRun, verifyPhase111Preparation } from "../manual/phase1-11-end-to-end.js";

const roots: string[] = [];
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Phase 1.11 zero-call preparation", () => {
  it("creates a clean immutable fixture and rejects source drift", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentplatform-p111-"));
    roots.push(root);
    const prep = path.join(root, "preparation-run1");
    const seal = createPhase111Preparation(path.resolve("."), prep);
    const sealHash = sha256(readFileSync(path.join(prep, "preparation-seal.json")));
    expect(seal.real_model_calls).toBe(0);
    expect(verifyPhase111Preparation(path.resolve("."), prep, sealHash).spec.task_id).toBe("P111-MVP-01");
    expect(() => createPhase111Preparation(path.resolve("."), prep)).toThrow("P111_PREPARATION_ROOT_NOT_FRESH");
    writeFileSync(path.join(prep, "source", "src", "normalize-lines.mjs"), "tampered\n");
    expect(() => verifyPhase111Preparation(path.resolve("."), prep, sealHash)).toThrow("P111_FIXTURE_FILE_DRIFT");
  });

  it("keeps the real entry unreachable without a separate approval", async () => {
    await expect(executePhase111RealRun({})).rejects.toThrow("P111_REAL_EXECUTION_NOT_APPROVED");
    await expect(executePhase111RealRun({}, "run2")).rejects.toThrow("P111_REAL_EXECUTION_NOT_APPROVED");
  });

  it("drives Architect, approved edit, Strong Worker, platform test, Gate and Final Gate with a fake CLI", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentplatform-p111-"));
    roots.push(root);
    const prep = path.join(root, "preparation-run1");
    createPhase111Preparation(path.resolve("."), prep);
    const sealHash = sha256(readFileSync(path.join(prep, "preparation-seal.json")));
    const { seal, spec, repo } = verifyPhase111Preparation(path.resolve("."), prep, sealHash);
    const fake = path.join(root, "fake-codex.cjs");
    const implementation = "export function normalizeLines(input) { if (typeof input !== 'string') throw new TypeError('input must be a string'); return input.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean).join('\\n'); }\n";
    writeFileSync(fake, [
      "const fs=require('node:fs'); const path=require('node:path');",
      "const args=process.argv.slice(2); const out=args[args.indexOf('--output-last-message')+1];",
      "const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));",
      "const cwd=args[args.indexOf('-C')+1];",
      `const spec=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(prep, "task-spec-approved.json"))},'utf8'));`,
      "let value;",
      "if(schema.properties.execution_policy){value=spec;}",
      `else if(schema.properties.status){fs.writeFileSync(path.join(cwd,'src','normalize-lines.mjs'),${JSON.stringify(implementation)});value={schema_version:'1.0',task_id:spec.task_id,status:'completed',summary:'Implemented normalizeLines',changed_files:['src/normalize-lines.mjs'],acceptance_notes:spec.acceptance_criteria.map(c=>({criterion_id:c.id,note:'implemented and verified'})),risks:[],blocker:null};}`,
      "else {value={schema_version:'1.0',task_id:spec.task_id,verdict:'PASS',summary:'All acceptance criteria satisfied',criteria:spec.acceptance_criteria.map(c=>({criterion_id:c.id,status:'satisfied',evidence:'platform TestRun and diff'})),findings:[],test_assessment:'passed',scope_assessment:'passed',rework_instructions:[]};}",
      "fs.writeFileSync(out,JSON.stringify(value)); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));",
    ].join("\n"));
    const outputRoot = path.join(root, "phase1-11-end-to-end-run1");
    const adapter = new CodexAdapter(process.execPath, [fake], () => ({}));
    const result = await executePhase111Cases({ sourceRoot: path.resolve("."), outputRoot, seal, spec, repo, sealHash, readinessHash: "offline-fake", approvalSha256: "offline-fake", adapter });
    expect(result).toMatchObject({ status: "PASS", taskStatus: "PASSED", modelCalls: 3 });
    const decision = JSON.parse(readFileSync(path.join(outputRoot, "run-decision.json"), "utf8")) as { status: string; source_clean: boolean; gate: boolean; final_verdict: string; run_stages: unknown[] };
    expect(decision).toMatchObject({ status: "PASS", source_clean: true, gate: true, final_verdict: "PASS" });
    expect(decision.run_stages).toHaveLength(3);
    const manifest = JSON.parse(readFileSync(path.join(outputRoot, "run-artifact-manifest.json"), "utf8")) as { artifacts: Array<{ path: string; sha256: string }> };
    expect(manifest.artifacts.length).toBeGreaterThan(8);
    expect(manifest.artifacts.every((item) => sha256(readFileSync(path.join(outputRoot, item.path))) === item.sha256)).toBe(true);
  }, 30000);
});
