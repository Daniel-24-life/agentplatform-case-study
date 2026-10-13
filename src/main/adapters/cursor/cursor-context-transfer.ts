import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { validateWorkerProposalRequest, type WorkerProposalRequest } from "../../../shared/core/worker-proposal.js";
import { minimalEnvironment } from "../../process/runner.js";

export type CursorProposalFixture = {
  workspace: string;
  contextSha256: string;
  contextBytes: number;
};

export type CursorContextTransferOptions = {
  wslProgram?: string;
  fixtureId?: string;
  timeoutMs?: number;
};

const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_CONTROL_BYTES = 4096;
const FIXTURE_ID = /^[0-9a-f-]{36}$/;
const LINUX_ROOT = "/opt/agentplatform-cursor-proposals";
const SANDBOX_CONFIG = "{\"type\":\"workspace_readonly\",\"networkPolicy\":{\"default\":\"deny\"}}\n";

// The only Linux write is this fixed root-owned context fixture. Source bytes arrive on stdin;
// Windows drives remain unmounted and no source text is placed in command-line arguments.
const writeContextScript = `
import hashlib,json,os,pathlib,stat,sys
base=pathlib.Path('/opt/agentplatform-cursor-proposals')
fixture_id=sys.argv[1]; expected=sys.argv[2]; maximum=int(sys.argv[3])
if not base.exists(): base.mkdir(mode=0o555)
if base.is_symlink() or base.stat().st_uid!=0 or stat.S_IMODE(base.stat().st_mode)!=0o555: raise SystemExit(31)
root=base/fixture_id
if root.exists() or root.is_symlink(): raise SystemExit(32)
data=sys.stdin.buffer.read(maximum+1)
if len(data)>maximum or hashlib.sha256(data).hexdigest()!=expected: raise SystemExit(33)
root.mkdir(mode=0o700)
cursor=root/'.cursor'; cursor.mkdir(mode=0o700)
config=cursor/'sandbox.json'; context=root/'context.json'
config.write_bytes(b'{"type":"workspace_readonly","networkPolicy":{"default":"deny"}}\\n')
context.write_bytes(data)
for p in (config,context): p.chmod(0o444)
cursor.chmod(0o555); root.chmod(0o555)
print(json.dumps({'workspace':str(root),'context_sha256':hashlib.sha256(context.read_bytes()).hexdigest(),
 'context_bytes':len(data),'config_sha256':hashlib.sha256(config.read_bytes()).hexdigest()}))`;

/** Transfer one validated proposal request into a fresh E-backed WSL read-only fixture. */
export async function prepareCursorProposalFixture(
  request: WorkerProposalRequest,
  options: CursorContextTransferOptions = {}
): Promise<CursorProposalFixture> {
  const checked = validateWorkerProposalRequest(request);
  if (!checked.valid) throw new Error(`CURSOR_PROPOSAL_REQUEST_INVALID:${checked.issues.map(issue => issue.path).join(",")}`);
  const payload = Buffer.from(`${JSON.stringify(checked.value)}\n`, "utf8");
  if (payload.length > MAX_CONTEXT_BYTES) throw new Error("CURSOR_CONTEXT_TOO_LARGE");
  const fixtureId = options.fixtureId ?? randomUUID();
  if (!FIXTURE_ID.test(fixtureId)) throw new Error("CURSOR_FIXTURE_ID_INVALID");
  const expectedSha = createHash("sha256").update(payload).digest("hex");
  const workspace = `${LINUX_ROOT}/${fixtureId}`;
  const program = options.wslProgram ?? "C:\\Windows\\System32\\wsl.exe";
  const args = ["--distribution", "Ubuntu", "--user", "root", "--exec", "/usr/bin/python3", "-c",
    writeContextScript, fixtureId, expectedSha, String(MAX_CONTEXT_BYTES)];
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("CURSOR_TRANSFER_TIMEOUT_INVALID");

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true,
      env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderrBytes = 0, overLimit = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdin.on("error", () => { /* early child exit is reported by close */ });
    child.stdin.end(payload);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_CONTROL_BYTES) { overLimit = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CONTROL_BYTES) { overLimit = true; child.kill(); }
    });
    child.once("error", error => { clearTimeout(timer); reject(new Error("CURSOR_CONTEXT_TRANSFER_START_FAILED", { cause: error })); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut || overLimit || code !== 0) { reject(new Error("CURSOR_CONTEXT_TRANSFER_FAILED")); return; }
      let result: unknown;
      try { result = JSON.parse(stdout.trim()) as unknown; } catch { reject(new Error("CURSOR_CONTEXT_TRANSFER_OUTPUT_INVALID")); return; }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        reject(new Error("CURSOR_CONTEXT_TRANSFER_OUTPUT_INVALID")); return;
      }
      const record = result as Record<string, unknown>;
      const configSha = createHash("sha256").update(SANDBOX_CONFIG).digest("hex");
      if (record.workspace !== workspace || record.context_sha256 !== expectedSha ||
          record.context_bytes !== payload.length || record.config_sha256 !== configSha) {
        reject(new Error("CURSOR_CONTEXT_TRANSFER_DRIFT")); return;
      }
      resolve({ workspace, contextSha256: expectedSha, contextBytes: payload.length });
    });
  });
}
