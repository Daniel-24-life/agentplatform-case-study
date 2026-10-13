const { DatabaseSync } = require("node:sqlite");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const [mode, file] = process.argv.slice(2);
if (!file || !["insert", "verify"].includes(mode)) process.exit(2);
const database = new DatabaseSync(file);
try {
  if (mode === "insert") {
    database.prepare("INSERT INTO projects(id,name,repo_path,repo_real_path,created_at,last_seen_head) VALUES(?,?,?,?,?,?)")
      .run("PHASE18-SMOKE", "Package restart fixture", "fixture", "fixture", new Date().toISOString(), "0".repeat(40));
    database.prepare("INSERT INTO tasks(id,project_id,title,request_text,status,base_sha,spec_json,spec_approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("PHASE18-TASK", "PHASE18-SMOKE", "Phase 1.8 UI fixture", "Verify activity and logs", "DRAFT", "0".repeat(40), null, null, new Date().toISOString(), new Date().toISOString());
    database.prepare("INSERT INTO runs(id,task_id,attempt_id,stage,adapter,model,reasoning,cwd,pid,status,exit_code,started_at,ended_at,error_code,worker_class,duration_ms,is_escalation,is_high_tier,usage_json,failure_domain) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("SMOKE-RUN", "PHASE18-TASK", null, "builder", "fake", null, null, "fixture", null, "SUCCEEDED", 0, new Date().toISOString(), new Date().toISOString(), null, null, 1, 0, 0, null, null);
    database.prepare("INSERT INTO events(id,task_id,run_id,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("SMOKE-EVENT", "PHASE18-TASK", "SMOKE-RUN", 1, "RUN_FINISHED", '{"runId":"SMOKE-RUN","status":"SUCCEEDED"}', new Date().toISOString());
    const logDir = path.join(process.env.AGENTPLATFORM_USER_DATA_DIR, "artifacts", "runs", "SMOKE-RUN");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "stdout.log"), "SMOKE LOG LINE\n");
    writeFileSync(path.join(logDir, "stderr.log"), "");
  } else {
    const row = database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id=?").get("PHASE18-SMOKE");
    const task = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id=?").get("PHASE18-TASK");
    if (row.count !== 1 || task.count !== 1) process.exitCode = 2;
  }
} finally {
  database.close();
}
