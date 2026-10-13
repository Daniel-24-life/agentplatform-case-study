// Zero-model WSL process-group probe. It launches only /usr/bin/sleep.
const { spawn, spawnSync } = require("node:child_process");

const wsl = "C:\\Windows\\System32\\wsl.exe";
const prefix = ["--distribution", "Ubuntu", "--user", "agentplatform", "--exec"];
const script = `
import os, subprocess
child=subprocess.Popen(['/usr/bin/sleep','30'],start_new_session=True,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('PGID:'+str(os.getpgid(child.pid)),flush=True)
code=child.wait()
raise SystemExit(128-code if code<0 else code)`;
const start = Date.now();
const child = spawn(wsl, [...prefix, "/usr/bin/python3", "-c", script],
  { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "", pgid = null, stderrBytes = 0;
const closed = new Promise((resolve, reject) => {
  child.stdout.on("data", chunk => {
    output += chunk.toString("utf8");
    const match = /^PGID:(\d+)\r?\n/m.exec(output);
    if (match) pgid = Number(match[1]);
  });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});

function groupSignal(signal) {
  if (pgid === null) throw Error("PGID_NOT_OBSERVED");
  return spawnSync(wsl, [...prefix, "/usr/bin/kill", `-${signal}`, "--", `-${pgid}`],
    { shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
}

async function main() {
  try {
    while (pgid === null && Date.now() - start < 10_000) await new Promise(resolve => setTimeout(resolve, 25));
    if (pgid === null) throw Error("PGID_NOT_OBSERVED");
    const cancelAt = Date.now();
    const signal = groupSignal("TERM");
    if (signal.status !== 0) throw Error(`TERM_FAILED:${signal.status}`);
    const result = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error("CLOSE_TIMEOUT")), 10_000))]);
    const alive = groupSignal("0").status === 0;
    console.log(JSON.stringify({ status: !alive && result.code !== 0 ? "PASS" : "FAIL",
      cancel_to_close_ms: Date.now() - cancelAt, group_alive: alive,
      wrapper_exit_code: result.code, wrapper_signal: result.signal, stderr_bytes: stderrBytes }));
    if (alive || result.code === 0) process.exitCode = 1;
  } finally {
    if (pgid !== null) groupSignal("KILL");
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
