// One-use real proposal controller. --execute requires its own exact approval.
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const preparation = path.join(root, "phase1-19-proposal-preparation-run1");
const readinessFile = path.join(preparation, "readiness.json");
const expectedReadinessSha = "ef18931940db6e83141ad212b46224bdc572536d986a1c47b68d392eb1f6ceb6";
const sha = value => createHash("sha256").update(value).digest("hex");
if (sha(fs.readFileSync(readinessFile)) !== expectedReadinessSha) throw Error("READINESS_DRIFT");
const readiness = JSON.parse(fs.readFileSync(readinessFile, "utf8"));
const wsl = "C:\\Windows\\System32\\wsl.exe";
const prefix = ["--distribution", "Ubuntu", "--user", "agentplatform"];
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, TEMP: process.env.TEMP,
  TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE };
for (const key of Object.keys(env)) if (!env[key]) delete env[key];
const probe = (args, accepted = [0]) => {
  const result = spawnSync(wsl, args, { shell: false, env, encoding: "utf8", timeout: 20_000,
    maxBuffer: 64 * 1024, windowsHide: true });
  if (result.error || !accepted.includes(result.status)) throw Error(`PREFLIGHT_COMMAND_FAILED:${result.status}`);
  return result;
};
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, timeout: 10_000 });
  if (result.status !== 0) throw Error("GIT_PROBE_FAILED");
  return result.stdout.trim();
};
const fixtureScript = `
import hashlib,json,os,pathlib,stat,sys
r=pathlib.Path(sys.argv[1]); c=r/'context.json'; s=r/'.cursor/sandbox.json'
print(json.dumps({'uid':os.getuid(),'files':sorted(str(p.relative_to(r)) for p in r.rglob('*') if p.is_file()),
 'owners':[p.stat().st_uid for p in (r,r/'.cursor',s,c)],
 'modes':[oct(stat.S_IMODE(p.stat().st_mode)) for p in (r,r/'.cursor',s,c)],
 'context':hashlib.sha256(c.read_bytes()).hexdigest(),'config':hashlib.sha256(s.read_bytes()).hexdigest(),
 'wsl_conf':hashlib.sha256(pathlib.Path('/etc/wsl.conf').read_bytes()).hexdigest(),
 'wrapper':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/bin/agent').read_bytes()).hexdigest(),
 'entry':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/index.js').read_bytes()).hexdigest(),
 'node':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/node').read_bytes()).hexdigest(),
 'mounts':any(os.path.ismount(p) for p in ('/mnt/c','/mnt/e')),
 'interop':pathlib.Path('/proc/sys/fs/binfmt_misc/WSLInterop').exists()}))`;
const fixture = () => {
  const f = readiness.fixture, r = readiness.runtime;
  const data = JSON.parse(probe([...prefix, "--exec", "/usr/bin/python3", "-c", fixtureScript, f.workspace]).stdout.trim());
  if (data.uid !== 1000 || JSON.stringify(data.files) !== JSON.stringify([".cursor/sandbox.json", "context.json"]) ||
      data.owners.some(owner => owner !== 0) ||
      JSON.stringify(data.modes) !== JSON.stringify(["0o555", "0o555", "0o444", "0o444"]) ||
      data.context !== f.context_sha256 || data.config !== f.sandbox_config_sha256 ||
      data.wsl_conf !== r.wsl_conf_sha256 || data.wrapper !== r.cursor_wrapper_sha256 ||
      data.entry !== r.cursor_entry_sha256 || data.node !== r.cursor_node_sha256 ||
      data.mounts !== false || data.interop !== false) throw Error("FIXTURE_OR_RUNTIME_DRIFT");
  return data.context;
};
const noResidual = () => probe([...prefix, "--exec", "/usr/bin/pgrep", "-f", readiness.fixture.workspace], [0, 1]).status === 1;
const signalGroup = (pgid, signal) => probe([...prefix, "--exec", "/usr/bin/kill", `-${signal}`, "--", `-${pgid}`], [0, 1]).status === 0;
const groupAlive = pgid => signalGroup(pgid, "0");

function preflight() {
  if (fs.existsSync(readiness.evidence.output_root)) throw Error("OUTPUT_ROOT_EXISTS");
  if (git(root, "rev-parse", "HEAD") !== readiness.git_head) throw Error("GIT_HEAD_DRIFT");
  if (git(readiness.fixture.checkout, "rev-parse", "HEAD") !== readiness.fixture.base_sha ||
      git(readiness.fixture.checkout, "rev-parse", "HEAD^{tree}") !== readiness.fixture.base_tree ||
      git(readiness.fixture.checkout, "status", "--porcelain=v1") !== "") throw Error("CHECKOUT_DRIFT");
  for (const [relative, expected] of [
    ["src/message.txt", readiness.fixture.source_file_sha256], ["verify.mjs", readiness.fixture.test_file_sha256]
  ]) if (sha(fs.readFileSync(path.join(readiness.fixture.checkout, relative))) !== expected) throw Error("CHECKOUT_CONTENT_DRIFT");
  for (const [relative, expected] of [
    ["src/shared/core/cursor-proposal-trace.ts", readiness.source.parser_sha256],
    ["src/main/adapters/cursor/cursor-context-transfer.ts", readiness.source.transfer_sha256]
  ]) if (sha(fs.readFileSync(path.join(root, relative))) !== expected) throw Error("SOURCE_DRIFT");
  const taskSpec = JSON.parse(fs.readFileSync(path.join(preparation, "task-spec.json"), "utf8"));
  const request = JSON.parse(fs.readFileSync(path.join(preparation, "worker-proposal-request.json"), "utf8"));
  if (sha(JSON.stringify(request)) !== readiness.source.request_sha256 ||
      request.task_spec_sha256 !== readiness.source.task_spec_sha256 ||
      sha(readiness.request.prompt) !== readiness.source.prompt_sha256) throw Error("REQUEST_DRIFT");
  if (taskSpec.base_sha !== readiness.fixture.base_sha || taskSpec.task_id !== request.task_id) throw Error("TASK_SPEC_DRIFT");
  const before = fixture();
  if (!noResidual()) throw Error("RESIDUAL_PROCESS_BEFORE_RUN");
  const version = probe([...prefix, "--exec", "/home/agentplatform/.local/bin/agent", "--version"]);
  if (!version.stdout.includes(readiness.runtime.cursor_cli_version)) throw Error("CLI_VERSION_DRIFT");
  const status = probe([...prefix, "--exec", "/usr/bin/env", "-u", "CURSOR_API_KEY", "-u", "CURSOR_API_ENDPOINT",
    "/home/agentplatform/.local/bin/agent", "status"]);
  if (!/logged in/i.test(status.stdout)) throw Error("CLI_NOT_LOGGED_IN");
  return before;
}

const wrapper = `
import os,subprocess,sys
p=subprocess.Popen(sys.argv[1:],start_new_session=True)
print('AP_PGID:'+str(os.getpgid(p.pid)),file=sys.stderr,flush=True)
code=p.wait()
raise SystemExit(128-code if code<0 else code)`;

async function execute() {
  const before = preflight();
  const output = readiness.evidence.output_root;
  fs.mkdirSync(output, { recursive: false });
  const outFd = fs.openSync(path.join(output, "stdout.ndjson"), "wx");
  const errFd = fs.openSync(path.join(output, "stderr.raw"), "wx");
  const started = Date.now();
  let pgid = null, stdoutBytes = 0, stderrBytes = 0, outputLimit = false, outerTimeout = false, launchError = null;
  let stderrBuffer = "", cleanupTimer = null;
  const r = readiness.request;
  const linux = ["/usr/bin/timeout", "--signal=TERM", `--kill-after=${r.linux_kill_after_seconds}s`, `${r.linux_timeout_seconds}s`,
    "/usr/bin/env", "-u", "CURSOR_API_KEY", "-u", "CURSOR_API_ENDPOINT", "/home/agentplatform/.local/bin/agent",
    "--print", "--mode", "ask", "--sandbox", "enabled", "--output-format", "stream-json", "--model", "auto",
    "--workspace", readiness.fixture.workspace, "--trust", r.prompt];
  const args = [...prefix, "--cd", readiness.fixture.workspace, "--exec", "/usr/bin/python3", "-c", wrapper, ...linux];
  const child = spawn(wsl, args, { shell: false, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => {
    if (pgid !== null) signalGroup(pgid, "TERM");
    cleanupTimer = setTimeout(() => { if (pgid !== null && groupAlive(pgid)) signalGroup(pgid, "KILL");
      try { child.kill(); } catch { /* preserve failure outcome */ } }, r.cleanup_deadline_seconds * 1000);
  };
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= r.stream_max_bytes) fs.writeSync(outFd, chunk);
    else if (!outputLimit) { outputLimit = true; stop(); }
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= r.stream_max_bytes) fs.writeSync(errFd, chunk);
    else if (!outputLimit) { outputLimit = true; stop(); }
    stderrBuffer += chunk.toString("utf8");
    const match = /AP_PGID:(\d+)\r?\n/.exec(stderrBuffer);
    if (match && pgid === null) pgid = Number(match[1]);
    if (stderrBuffer.length > 1024) stderrBuffer = stderrBuffer.slice(-1024);
  });
  const outer = setTimeout(() => { outerTimeout = true; stop(); }, r.windows_outer_deadline_seconds * 1000);
  const closed = await new Promise(resolve => {
    child.once("error", error => { launchError = error.code || error.message; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(outer);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  fs.closeSync(outFd); fs.closeSync(errFd);
  if (pgid !== null && groupAlive(pgid)) signalGroup(pgid, "KILL");
  const after = fixture();
  const converged = noResidual() && (pgid === null || !groupAlive(pgid));
  const evaluation = { version: "phase1-19-cursor-proposal-controller.v1", started_at_utc: new Date(started).toISOString(),
    finished_at_utc: new Date().toISOString(), duration_ms: Date.now() - started, exit_code: closed.code,
    exit_signal: closed.signal, pgid, process_converged: converged, fixture_sha256_before: before,
    fixture_sha256_after: after, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
    output_limit: outputLimit, outer_timeout: outerTimeout, launch_error: launchError,
    readiness_sha256: expectedReadinessSha, real_calls: 1, retry: 0 };
  fs.writeFileSync(path.join(output, "controller.json"), `${JSON.stringify(evaluation, null, 2)}\n`, { flag: "wx" });
  const pass = !launchError && !outputLimit && !outerTimeout && closed.code === 0 && converged && before === after;
  console.log(JSON.stringify({ status: pass ? "PROCESS_PASS" : "PROCESS_FAIL", exit_code: closed.code,
    duration_ms: evaluation.duration_ms, process_converged: converged, fixture_unchanged: before === after }));
  if (!pass) process.exitCode = 1;
}

if (process.argv[2] === "--preflight") console.log(JSON.stringify({ status: "PREFLIGHT_PASS", fixture_sha256: preflight(), output_root_absent: true }));
else if (process.argv[2] === "--execute") execute().catch(error => { console.error(String(error)); process.exitCode = 1; });
else throw Error("Use --preflight or --execute");
