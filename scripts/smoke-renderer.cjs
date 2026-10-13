const port = Number(process.argv[2]);
const inspectActivity = process.argv[3] === "activity";
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 10000;

async function inspect() {
  let page;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* The local debug endpoint may still be starting. */ }
    await wait(100);
  }
  if (!page) throw new Error("Renderer debug target was not available");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Renderer socket failed")), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error || message.result?.exceptionDetails) entry.reject(new Error("Renderer evaluation failed"));
    else entry.resolve(message.result?.result?.value);
  });
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Renderer evaluation timed out")); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  const until = async (expression) => {
    const expires = Date.now() + 5000;
    while (Date.now() < expires) {
      if (await evaluate(expression)) return;
      await wait(100);
    }
    throw new Error(`Renderer condition did not appear: ${expression.slice(0, 100)}`);
  };
  try {
    await until('document.readyState === "complete" && document.body?.innerText?.toLowerCase().includes("agentplatform") && document.body.innerText.includes("本地后端已连接")');
    if (inspectActivity) {
      await evaluate('Array.from(document.querySelectorAll(".nav-rail .nav-button")).find(element => element.innerText.includes("任务"))?.click()');
      await until('Array.from(document.querySelectorAll(".task-list button.list-item")).some(element => element.innerText.includes("Phase 1.8 UI fixture"))');
      await evaluate('Array.from(document.querySelectorAll(".task-list button.list-item")).find(element => element.innerText.includes("Phase 1.8 UI fixture"))?.click()');
      await until('Boolean(document.querySelector("[role=tab][data-tab-id=activity]"))');
      await evaluate('document.querySelector("[role=tab][data-tab-id=activity]").click()');
      await until('document.querySelector(".activity-panel")?.innerText?.includes("RUN_FINISHED")');
      await evaluate('Array.from(document.querySelectorAll(".activity-panel ul button")).find(element => element.innerText.includes("builder"))?.click()');
      await until('document.querySelector(".run-log-window pre")?.innerText?.includes("SMOKE LOG LINE")');
    }
    process.stdout.write(JSON.stringify({ ready: "complete", appVisible: true, backendConnected: true, activityVisible: inspectActivity, targetUrl: page.url }));
  } finally { socket.close(); }
}

inspect().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
