// One-use Phase 1.18 controller. The output root's exclusive creation prevents retries.
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const workspace = path.resolve(__dirname, "../..");
const readinessPath = path.join(workspace, "docs/PHASE_1_18_CURSOR_READONLY_READINESS.json");
const expectedReadinessSha = "143f1a76b0d795001e1758c69b4dfb556ba9c8cd1b7c9cf3f1a3ea174d410e8f";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const readinessBytes = fs.readFileSync(readinessPath);
if (sha(readinessBytes) !== expectedReadinessSha) throw Error("READINESS_DRIFT");
const readiness = JSON.parse(readinessBytes.toString("utf8"));
const wsl = readiness.request.executable;
const outputRoot = readiness.evidence.output_root;
const minimalEnv = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE
};
for (const key of Object.keys(minimalEnv)) if (!minimalEnv[key]) delete minimalEnv[key];

function probe(args, accepted = [0]) {
  const result = spawnSync(wsl, args, {
    shell: false, env: minimalEnv, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
    windowsHide: true
  });
  if (result.error || !accepted.includes(result.status)) throw Error(`PREFLIGHT_COMMAND_FAILED:${result.status}`);
  return result;
}

const fixtureScript = `
import hashlib, json, os, pathlib, stat, sys
r=pathlib.Path(sys.argv[1]); config=r/'.cursor/sandbox.json'; marker=r/'marker.txt'
paths=[r,r/'.cursor',config,marker]
files=sorted(str(p.relative_to(r)) for p in r.rglob('*') if p.is_file())
lines=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p)+'\\n' for p in (config,marker))
print(json.dumps({'uid':os.getuid(),'files':files,'modes':[oct(stat.S_IMODE(p.stat().st_mode)) for p in paths],
 'owners':[p.stat().st_uid for p in paths], 'config_sha256':hashlib.sha256(config.read_bytes()).hexdigest(),
 'marker_sha256':hashlib.sha256(marker.read_bytes()).hexdigest(),
 'digest':hashlib.sha256(lines.encode('utf-8')).hexdigest(),
 'wsl_conf_sha256':hashlib.sha256(pathlib.Path('/etc/wsl.conf').read_bytes()).hexdigest(),
 'wrapper_sha256':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/bin/agent').read_bytes()).hexdigest(),
 'entry_sha256':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/index.js').read_bytes()).hexdigest(),
 'node_sha256':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/node').read_bytes()).hexdigest(),
 'windows_mounts':any(os.path.ismount(p) for p in ('/mnt/c','/mnt/e')),
 'interop_enabled':pathlib.Path('/proc/sys/fs/binfmt_misc/WSLInterop').exists()}))`;

function fixtureProbe() {
  const args = ["--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/usr/bin/python3", "-c", fixtureScript, readiness.fixture.path];
  const data = JSON.parse(probe(args).stdout.trim());
  const f = readiness.fixture, r = readiness.runtime;
  const valid = data.uid === r.uid &&
    JSON.stringify(data.files) === JSON.stringify([".cursor/sandbox.json", "marker.txt"]) &&
    JSON.stringify(data.modes) === JSON.stringify(["0o555", "0o555", "0o444", "0o444"]) &&
    data.owners.every(owner => owner === 0) && data.config_sha256 === f.sandbox_config_sha256 &&
    data.marker_sha256 === f.marker_sha256 && data.digest === f.manifest_sha256 &&
    data.wsl_conf_sha256 === r.wsl_conf_sha256 && data.wrapper_sha256 === r.cursor_wrapper_sha256 &&
    data.entry_sha256 === r.cursor_entry_sha256 && data.node_sha256 === r.cursor_node_sha256 &&
    data.windows_mounts === false && data.interop_enabled === false;
  if (!valid) throw Error("FIXTURE_OR_RUNTIME_DRIFT");
  return { fixture_sha256: data.digest, marker_sha256: data.marker_sha256, files: data.files.length };
}

function noResidualProcess() {
  const result = probe(["--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/usr/bin/pgrep", "-f", "/home/agentplatform/.local/share/cursor-agent/versions"], [0, 1]);
  return result.status === 1;
}

function preflight() {
  if (fs.existsSync(outputRoot)) throw Error("OUTPUT_ROOT_EXISTS");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", timeout: 10_000, shell: false });
  if (head.status !== 0 || head.stdout.trim() !== readiness.git_head) throw Error("GIT_HEAD_DRIFT");
  for (const [file, digest] of [
    [readiness.qualification_contract.checker_path, readiness.qualification_contract.checker_sha256],
    [readiness.qualification_contract.test_path, readiness.qualification_contract.test_sha256]
  ]) if (sha(fs.readFileSync(path.join(workspace, file))) !== digest) throw Error("CONTRACT_SOURCE_DRIFT");
  const fixture = fixtureProbe();
  const version = probe(["--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/home/agentplatform/.local/bin/agent", "--version"]);
  if (!version.stdout.includes(readiness.runtime.cursor_cli_version)) throw Error("CLI_VERSION_DRIFT");
  const status = probe(["--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/usr/bin/env", "-u", "CURSOR_API_KEY", "-u", "CURSOR_API_ENDPOINT", "/home/agentplatform/.local/bin/agent", "status"]);
  if (!/logged in/i.test(status.stdout)) throw Error("CLI_NOT_LOGGED_IN");
  if (!noResidualProcess()) throw Error("RESIDUAL_CLI_BEFORE_RUN");
  return fixture;
}

function terminateTree(child) {
  if (!child.pid) return;
  spawnSync(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ["/PID", String(child.pid), "/T", "/F"],
    { shell: false, env: minimalEnv, timeout: 10_000, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 });
  try { child.kill(); } catch { /* Preserve the actual close/error state below. */ }
}

async function execute() {
  const before = preflight();
  fs.mkdirSync(outputRoot, { recursive: false });
  const stdoutPath = path.join(outputRoot, "stdout.ndjson");
  const stderrPath = path.join(outputRoot, "stderr.raw");
  const outFd = fs.openSync(stdoutPath, "wx");
  const errFd = fs.openSync(stderrPath, "wx");
  const started = new Date();
  const startedAt = Date.now();
  let stdoutBytes = 0, stderrBytes = 0, limitHit = false, outerTimeout = false, launchError = null;
  const child = spawn(wsl, [...readiness.request.args_without_prompt, readiness.request.prompt],
    { shell: false, env: minimalEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  function record(stream, fd, limit, kind) {
    stream.on("data", chunk => {
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      const current = kind === "stdout" ? stdoutBytes : stderrBytes;
      const prior = current - chunk.length;
      if (prior < limit) fs.writeSync(fd, chunk.subarray(0, Math.min(chunk.length, limit - prior)));
      if (current > limit && !limitHit) { limitHit = true; terminateTree(child); }
    });
  }
  record(child.stdout, outFd, readiness.evidence.stdout_max_bytes, "stdout");
  record(child.stderr, errFd, readiness.evidence.stderr_max_bytes, "stderr");
  const timer = setTimeout(() => { outerTimeout = true; terminateTree(child); }, readiness.request.windows_outer_deadline_seconds * 1000);
  const closed = await new Promise(resolve => {
    child.on("error", error => { launchError = error.code || error.message; });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  fs.closeSync(outFd); fs.closeSync(errFd);
  const durationMs = Date.now() - startedAt;
  const after = fixtureProbe();
  const residualProcess = !noResidualProcess();
  const controller = {
    state: launchError ? "launch_error" : outerTimeout ? "outer_timeout" : limitHit ? "output_limit" : "process_exited",
    started_at_utc: started.toISOString(), finished_at_utc: new Date().toISOString(),
    process_exit_code: closed.code, process_signal: closed.signal, launch_error: launchError,
    duration_ms: durationMs, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
    process_converged: !residualProcess, fixture_sha256_before: before.fixture_sha256,
    fixture_sha256_after: after.fixture_sha256, request_sha256: expectedReadinessSha
  };
  fs.writeFileSync(path.join(outputRoot, "controller.json"), `${JSON.stringify(controller, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ state: controller.state, exit_code: closed.code, duration_ms: durationMs,
    stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, process_converged: !residualProcess,
    fixture_unchanged: before.fixture_sha256 === after.fixture_sha256 }));
}

const mode = process.argv[2];
if (mode === "--preflight") {
  const result = preflight();
  console.log(JSON.stringify({ status: "PREFLIGHT_PASS", fixture_sha256: result.fixture_sha256, output_root_absent: true }));
} else if (mode === "--execute") {
  execute().catch(error => { console.error(String(error)); process.exitCode = 1; });
} else {
  throw Error("Use --preflight or --execute");
}
