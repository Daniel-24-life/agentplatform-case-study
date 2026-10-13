import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { prepareCursorProposalFixture } from "../../src/main/adapters/cursor/cursor-context-transfer.js";
import type { WorkerProposalRequest } from "../../src/shared/core/worker-proposal.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("Phase 1.19 WSL context transfer", () => {
  it.skipIf(process.env.PHASE119_CONTEXT_PROBE !== "1")("writes only one bounded root-owned context file over stdin", async () => {
    const content = "before\n";
    const request: WorkerProposalRequest = {
      schema_version: "1.0", task_id: "CURSOR-PROBE", base_sha: "b".repeat(40),
      task_spec_sha256: "a".repeat(64), goal: "Replace the fixture value.",
      scope: { allowed_paths: ["src/**"], forbidden_paths: [] },
      acceptance_criteria: [{ id: "AC-01", text: "The file contains ready." }],
      context_files: [{ path: "src/message.txt", byte_count: Buffer.byteLength(content), sha256: sha(content), content }],
      limits: { max_operations: 1, max_file_bytes: 1024, max_total_bytes: 1024 }
    };
    const fixtureId = randomUUID();
    const prepared = await prepareCursorProposalFixture(request, { fixtureId });
    expect(prepared.workspace).toBe(`/opt/agentplatform-cursor-proposals/${fixtureId}`);
    const inspection = spawnSync("C:\\Windows\\System32\\wsl.exe", [
      "--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/usr/bin/python3", "-c",
      "import hashlib,json,pathlib,stat,sys; r=pathlib.Path(sys.argv[1]); p=r/'context.json'; print(json.dumps({'sha':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':oct(stat.S_IMODE(p.stat().st_mode)),'owner':p.stat().st_uid,'files':sorted(str(x.relative_to(r)) for x in r.rglob('*') if x.is_file())}))",
      prepared.workspace
    ], { shell: false, encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    expect(inspection.status).toBe(0);
    const data = JSON.parse(inspection.stdout.trim()) as { sha: string; mode: string; owner: number; files: string[] };
    expect(data).toEqual({ sha: prepared.contextSha256, mode: "0o444", owner: 0,
      files: [".cursor/sandbox.json", "context.json"] });
    console.log(`fixture=${prepared.workspace} context_sha256=${prepared.contextSha256}`);
  });
});
