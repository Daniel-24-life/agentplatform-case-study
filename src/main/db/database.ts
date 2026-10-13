import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { ArtifactRecord, AttemptRecord, EventRecord, ProjectRecord, RunMetrics, RunRecord, TaskRecord } from "../../shared/contracts/records.js";
import type { TaskStatus } from "../../shared/core/task-state.js";
import { validateTaskStatusTransition } from "../../shared/core/task-state.js";
import { summarizeRunUsage } from "../../shared/core/run-usage-metrics.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const migrations: ReadonlyArray<[number, string]> = [[1, `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,repo_path TEXT NOT NULL,repo_real_path TEXT NOT NULL,created_at TEXT NOT NULL,last_seen_head TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,request_text TEXT NOT NULL,status TEXT NOT NULL,base_sha TEXT NOT NULL,spec_json TEXT,spec_approved_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),number INTEGER NOT NULL,branch TEXT NOT NULL,worktree_path TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,number));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,attempt_id TEXT REFERENCES attempts(id),stage TEXT NOT NULL,adapter TEXT NOT NULL,model TEXT,reasoning TEXT,cwd TEXT NOT NULL,pid INTEGER,status TEXT NOT NULL,exit_code INTEGER,started_at TEXT NOT NULL,ended_at TEXT,error_code TEXT);
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT REFERENCES runs(id),sequence INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,sequence));
`], [2, ``], [3, `ALTER TABLE runs ADD COLUMN task_id TEXT;`], [4, `ALTER TABLE runs ADD COLUMN failure_domain TEXT;`], [5, `ALTER TABLE tasks ADD COLUMN spec_revision INTEGER NOT NULL DEFAULT 0;`], [6, `
CREATE TABLE product_workspaces(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_project_id TEXT REFERENCES projects(id),
  current_cycle_id TEXT REFERENCES product_cycles(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE product_cycles(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES product_workspaces(id),
  cycle_number INTEGER NOT NULL CHECK(cycle_number >= 1),
  state TEXT NOT NULL CHECK(state='ALIGNING'),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  UNIQUE(workspace_id, cycle_number),
  UNIQUE(workspace_id, id)
);
CREATE TABLE product_goal_revisions(
  cycle_id TEXT NOT NULL REFERENCES product_cycles(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin='USER'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(cycle_id, revision)
);
CREATE TABLE product_decisions(
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES product_cycles(id),
  kind TEXT NOT NULL CHECK(kind='DIRECTION_CONFIRMED'),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(cycle_id, kind, goal_revision)
);
CREATE TABLE product_command_receipts(
  request_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  workspace_id TEXT REFERENCES product_workspaces(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE product_events(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES product_workspaces(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  type TEXT NOT NULL CHECK(type IN ('PRODUCT_CREATED','GOAL_REVISED','DIRECTION_CONFIRMED')),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, sequence)
);
`], [7, `
CREATE TABLE product_planning_grants(
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  goal_hash TEXT NOT NULL,
  max_calls INTEGER NOT NULL CHECK(max_calls = 1),
  used_calls INTEGER NOT NULL CHECK(used_calls IN (0,1)),
  timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds = 300),
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX product_planning_grants_product_created ON product_planning_grants(product_id, created_at, id);
CREATE TABLE product_planning_actions(
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES product_planning_grants(id),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  goal_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED')),
  proposal_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX product_planning_actions_product_created ON product_planning_actions(product_id, created_at, id);
`], [8, `
CREATE TABLE product_plan_revisions(
  cycle_id TEXT NOT NULL REFERENCES product_cycles(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  goal_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY(cycle_id, revision)
);
CREATE INDEX product_plan_revisions_cycle_latest ON product_plan_revisions(cycle_id, revision DESC);
CREATE TABLE product_plan_receipts(
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`], [9, `
CREATE TABLE product_events_v9(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES product_workspaces(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  type TEXT NOT NULL CHECK(type IN ('PRODUCT_CREATED','GOAL_REVISED','DIRECTION_CONFIRMED','REPOSITORY_BOUND')),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, sequence)
);
INSERT INTO product_events_v9 (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at)
  SELECT id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at FROM product_events;
DROP TABLE product_events;
ALTER TABLE product_events_v9 RENAME TO product_events;
CREATE TABLE product_task_links(
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  cycle_id TEXT NOT NULL REFERENCES product_cycles(id),
  plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(cycle_id, plan_revision)
);
CREATE TABLE product_execution_receipts(
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`], [10, `
CREATE TABLE product_run_actions(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  spec_revision INTEGER NOT NULL CHECK(spec_revision >= 1),
  spec_hash TEXT NOT NULL,
  spec_approved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED','PAUSED','CANCELLED','SUCCEEDED','FAILED','INTERRUPTED')),
  stage TEXT CHECK(stage IN ('build','tests','review')),
  reserved_model_calls INTEGER NOT NULL CHECK(reserved_model_calls BETWEEN 0 AND 2),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT
);
CREATE UNIQUE INDEX product_run_actions_active_task ON product_run_actions(task_id)
  WHERE status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED');
CREATE INDEX product_run_actions_product_created ON product_run_actions(product_id, created_at DESC);
`], [11, `
CREATE TABLE product_deliveries(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES product_workspaces(id),payload_json TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX product_deliveries_latest ON product_deliveries(product_id,created_at DESC);
CREATE TABLE product_delivery_receipts(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,delivery_id TEXT NOT NULL REFERENCES product_deliveries(id));
`], [12, `
ALTER TABLE product_workspaces ADD COLUMN deleted_at TEXT DEFAULT NULL;
CREATE TABLE product_events_v12(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES product_workspaces(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  type TEXT NOT NULL CHECK(type IN ('PRODUCT_CREATED','GOAL_REVISED','DIRECTION_CONFIRMED','REPOSITORY_BOUND','PRODUCT_TRASHED','PRODUCT_RESTORED')),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, sequence)
);
INSERT INTO product_events_v12 SELECT * FROM product_events;
DROP TABLE product_events;
ALTER TABLE product_events_v12 RENAME TO product_events;
`], [13, `
ALTER TABLE runs ADD COLUMN product_run_action_id TEXT;
CREATE TABLE product_run_actions_v13(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  spec_revision INTEGER NOT NULL CHECK(spec_revision >= 1),
  spec_hash TEXT NOT NULL,
  spec_approved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED','PAUSED','CANCELLED','SUCCEEDED','FAILED','INTERRUPTED')),
  stage TEXT CHECK(stage IN ('build','tests','review')),
  reserved_model_calls INTEGER NOT NULL CHECK(reserved_model_calls BETWEEN 0 AND max_model_calls),
  max_model_calls INTEGER NOT NULL DEFAULT 2 CHECK(max_model_calls BETWEEN 2 AND 6),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT
);
INSERT INTO product_run_actions_v13(id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,max_model_calls,created_at,finished_at,error_code)
SELECT id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,2,created_at,finished_at,error_code FROM product_run_actions;
DROP TABLE product_run_actions;
ALTER TABLE product_run_actions_v13 RENAME TO product_run_actions;
CREATE UNIQUE INDEX product_run_actions_active_task ON product_run_actions(task_id)
  WHERE status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED');
CREATE INDEX product_run_actions_product_created ON product_run_actions(product_id, created_at DESC);
`], [14, `
CREATE TABLE product_preview_sessions(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES product_workspaces(id),
  evidence_json TEXT NOT NULL,
  build_directory TEXT NOT NULL CHECK(build_directory IN ('dist','build','out')),
  snapshot_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('STARTING','RUNNING','STOPPING','STOPPED','FAILED','INTERRUPTED')),
  pid INTEGER CHECK(pid IS NULL OR pid>0),
  port INTEGER CHECK(port IS NULL OR port BETWEEN 1 AND 65535),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT
);
CREATE UNIQUE INDEX product_preview_sessions_active_product ON product_preview_sessions(product_id)
  WHERE status IN ('STARTING','RUNNING','STOPPING');
`]];

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

export class AppDatabase {
  readonly db: DatabaseSyncType;
  private readonly eventListeners = new Set<(_event: EventRecord) => void>();
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);");
    const applied = new Set((this.db.prepare("SELECT version FROM migrations ORDER BY version").all() as Row[]).map((row) => Number(row.version)));
    try {
      for (const [version, sql] of migrations) {
        if (applied.has(version)) continue;
        this.transaction(() => {
          this.db.exec(sql);

          if (version === 2) this.ensureRunColumns();
          this.db.prepare("INSERT INTO migrations(version) VALUES(?)").run(version);
        });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private ensureRunColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((row) => String(row.name)));
    const additions: ReadonlyArray<[string, string]> = [["worker_class", "TEXT"], ["duration_ms", "INTEGER"], ["is_escalation", "INTEGER NOT NULL DEFAULT 0"], ["is_high_tier", "INTEGER NOT NULL DEFAULT 0"], ["usage_json", "TEXT"]];
    for (const [name, definition] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
  close(): void { this.eventListeners.clear(); this.db.close(); }
  subscribeEvents(listener: (_event: EventRecord) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  private emitEvent(event: EventRecord): void { for (const listener of this.eventListeners) { try { listener(event); } catch { /* a UI subscriber cannot roll back persisted state */ } } }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  createProject(input: Omit<ProjectRecord, "createdAt">): ProjectRecord {
    const record = { ...input, createdAt: now() };
    this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(record.id, record.name, record.repoPath, record.repoRealPath, record.createdAt, record.lastSeenHead);
    return record;
  }
  listProjects(): ProjectRecord[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map((r) => ({ id:String(r.id),name:String(r.name),repoPath:String(r.repo_path),repoRealPath:String(r.repo_real_path),createdAt:String(r.created_at),lastSeenHead:String(r.last_seen_head) }));
  }
  createTask(input: Omit<TaskRecord,"createdAt"|"updatedAt"|"specJson"|"specRevision"|"specApprovedAt">): TaskRecord {
    const timestamp=now(); const record:TaskRecord={...input,specJson:null,specRevision:0,specApprovedAt:null,createdAt:timestamp,updatedAt:timestamp};
    this.db.prepare("INSERT INTO tasks (id,project_id,title,request_text,status,base_sha,spec_json,spec_approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(record.id,record.projectId,record.title,record.requestText,record.status,record.baseSha,null,null,timestamp,timestamp);
    return record;
  }
  getTask(id:string): TaskRecord | undefined {
    const r=this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Row|undefined; if(!r)return undefined;
    return {id:String(r.id),projectId:String(r.project_id),title:String(r.title),requestText:String(r.request_text),status:String(r.status) as TaskStatus,baseSha:String(r.base_sha),specJson:r.spec_json===null?null:String(r.spec_json),specRevision:Number(r.spec_revision),specApprovedAt:r.spec_approved_at===null?null:String(r.spec_approved_at),createdAt:String(r.created_at),updatedAt:String(r.updated_at)};
  }
  listTasks(projectId:string):TaskRecord[]{return (this.db.prepare("SELECT id FROM tasks WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Row[]).map(r=>this.getTask(String(r.id))!);}
  getProject(id:string):ProjectRecord|undefined{return this.listProjects().find(project=>project.id===id);}
  transitionTask(id:string,next:TaskStatus,eventType="STATUS_CHANGED"): TaskRecord {
    const result=this.transaction(()=>{ const current=this.getTask(id); if(!current)throw new Error("Task not found"); const checked=validateTaskStatusTransition(current.status,next); if(!checked.valid)throw new Error(checked.issues[0]?.message); const timestamp=now(); this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?").run(next,timestamp,id); const seq=(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM events WHERE task_id=?").get(id) as Row).n as number; this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(),id,null,seq,eventType,JSON.stringify({from:current.status,to:next}),timestamp); return this.getTask(id)!; });
    const last=this.listEventsAfter(id,0).at(-1); if(last)this.emitEvent(last);
    return result;
  }
  saveSpec(id:string,specJson:string):TaskRecord{const timestamp=now();this.db.prepare("UPDATE tasks SET spec_json=?,spec_revision=spec_revision+1,spec_approved_at=NULL,updated_at=? WHERE id=?").run(specJson,timestamp,id);const task=this.getTask(id);if(!task)throw new Error("Task not found");return task;}
  approveSpec(id:string,expectedJson:string):TaskRecord{const task=this.getTask(id);if(!task||task.specJson!==expectedJson)throw new Error("Spec revision changed");const timestamp=now();this.db.prepare("UPDATE tasks SET spec_approved_at=?,updated_at=? WHERE id=?").run(timestamp,timestamp,id);return this.getTask(id)!;}
  createAttempt(record:AttemptRecord):void{this.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?)").run(record.id,record.taskId,record.number,record.branch,record.worktreePath,record.status,record.createdAt);}
  getLatestAttempt(taskId:string):AttemptRecord|undefined{const r=this.db.prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY number DESC LIMIT 1").get(taskId) as Row|undefined;if(!r)return undefined;return{id:String(r.id),taskId:String(r.task_id),number:Number(r.number),branch:String(r.branch),worktreePath:String(r.worktree_path),status:String(r.status),createdAt:String(r.created_at)};}
  listRuns(attemptId:string):RunRecord[]{return(this.db.prepare("SELECT * FROM runs WHERE attempt_id=? ORDER BY started_at, id").all(attemptId) as Row[]).map(r=>this.toRunRecord(r));}
  listTaskRuns(taskId:string):RunRecord[]{return(this.db.prepare("SELECT r.* FROM runs r LEFT JOIN attempts a ON a.id=r.attempt_id WHERE r.task_id=? OR a.task_id=? ORDER BY r.started_at, r.id").all(taskId,taskId) as Row[]).map(r=>this.toRunRecord(r));}
  listArtifacts(runId:string):ArtifactRecord[]{return(this.db.prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY kind").all(runId) as Row[]).map(r=>({id:String(r.id),runId:String(r.run_id),kind:String(r.kind),path:String(r.path),sha256:String(r.sha256),sizeBytes:Number(r.size_bytes)}));}
  listEvents(taskId:string):EventRecord[]{return(this.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY sequence").all(taskId) as Row[]).map(r=>({id:String(r.id),taskId:String(r.task_id),runId:r.run_id===null?null:String(r.run_id),sequence:Number(r.sequence),type:String(r.type),payloadJson:String(r.payload_json),createdAt:String(r.created_at)}));}
  listEventsAfter(taskId:string,sequence:number,limit=256):EventRecord[]{return(this.db.prepare("SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(taskId,sequence,limit) as Row[]).map(r=>({id:String(r.id),taskId:String(r.task_id),runId:r.run_id===null?null:String(r.run_id),sequence:Number(r.sequence),type:String(r.type),payloadJson:String(r.payload_json),createdAt:String(r.created_at)}));}
  getRun(runId:string):RunRecord|undefined{const row=this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Row|undefined;return row?this.toRunRecord(row):undefined;}
  createRun(record:RunRecord):void{this.db.prepare("INSERT INTO runs (id,task_id,attempt_id,stage,adapter,model,reasoning,worker_class,cwd,pid,status,exit_code,started_at,ended_at,error_code,failure_domain,duration_ms,is_escalation,is_high_tier,usage_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(record.id,record.taskId??null,record.attemptId,record.stage,record.adapter,record.model,record.reasoning,record.workerClass,record.cwd,record.pid,record.status,record.exitCode,record.startedAt,record.endedAt,record.errorCode,record.failureDomain??null,record.durationMs,record.isEscalation?1:0,record.isHighTier?1:0,record.usageJson);}
  private toRunRecord(r:Row):RunRecord{return{id:String(r.id),taskId:r.task_id===null?"":String(r.task_id),attemptId:r.attempt_id===null?null:String(r.attempt_id),stage:String(r.stage),adapter:String(r.adapter),model:r.model===null?null:String(r.model),reasoning:r.reasoning===null?null:String(r.reasoning),workerClass:r.worker_class===null?null:String(r.worker_class) as "cheap"|"strong",cwd:String(r.cwd),pid:r.pid===null?null:Number(r.pid),status:String(r.status),exitCode:r.exit_code===null?null:Number(r.exit_code),startedAt:String(r.started_at),endedAt:r.ended_at===null?null:String(r.ended_at),errorCode:r.error_code===null?null:String(r.error_code),failureDomain:r.failure_domain===null?null:String(r.failure_domain) as "runtime"|"task"|"user",durationMs:r.duration_ms===null?null:Number(r.duration_ms),isEscalation:Boolean(r.is_escalation),isHighTier:Boolean(r.is_high_tier),usageJson:r.usage_json===null?null:String(r.usage_json)};}
  taskRunMetrics(taskId: string): RunMetrics {
    const runs = this.listTaskRuns(taskId);
    const attemptRow = this.db.prepare("SELECT COALESCE(MAX(number),0) n FROM attempts WHERE task_id=?").get(taskId) as Row;
    const agentRuns = runs.filter(run => run.adapter !== "test-runner");
    const highTierRuns = agentRuns.filter(run => run.isHighTier);
    const usage = summarizeRunUsage(agentRuns.map(run => run.usageJson));
    const highUsage = summarizeRunUsage(highTierRuns.map(run => run.usageJson));
    return {
      runCount: runs.length,
      highTierCalls: highTierRuns.length,
      highTierInputTokens: highUsage.inputTokens,
      highTierOutputTokens: highUsage.outputTokens,
      highTierTotalTokens: highUsage.totalTokens,
      escalationCount: runs.filter(run => run.isEscalation).length,
      totalDurationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
      workerRuns: runs.filter(run => run.workerClass !== null).length,
      cheapRuns: runs.filter(run => run.workerClass === "cheap").length,
      strongRuns: runs.filter(run => run.workerClass === "strong").length,
      retryCount: Math.max(0, Number(attemptRow.n) - 1),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      usageAvailableRuns: usage.availableRuns,
      agentRunCount: agentRuns.length
    };
  }
  createArtifact(record:ArtifactRecord):void{this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)").run(record.id,record.runId,record.kind,record.path,record.sha256,record.sizeBytes);}

  updateRun(id:string,patch:{pid?:number|null;status?:string;exitCode?:number|null;endedAt?:string|null;errorCode?:string|null;failureDomain?:"runtime"|"task"|"user"|null;durationMs?:number|null;usageJson?:string|null}):void{
    const current=this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Row|undefined;if(!current)throw new Error("Run not found");
    const pid=patch.pid!==undefined?patch.pid:(current.pid===null?null:Number(current.pid));
    const status=patch.status??String(current.status);
    const exitCode=patch.exitCode!==undefined?patch.exitCode:(current.exit_code===null?null:Number(current.exit_code));
    const endedAt=patch.endedAt!==undefined?patch.endedAt:(current.ended_at===null?null:String(current.ended_at));
    const errorCode=patch.errorCode!==undefined?patch.errorCode:(current.error_code===null?null:String(current.error_code));
    const failureDomain=patch.failureDomain!==undefined?patch.failureDomain:(current.failure_domain===null?null:String(current.failure_domain));
    const durationMs=patch.durationMs!==undefined?patch.durationMs:(current.duration_ms===null?null:Number(current.duration_ms));
    const usageJson=patch.usageJson!==undefined?patch.usageJson:(current.usage_json===null?null:String(current.usage_json));
    this.db.prepare("UPDATE runs SET pid=?,status=?,exit_code=?,ended_at=?,error_code=?,failure_domain=?,duration_ms=?,usage_json=? WHERE id=?").run(pid,status,exitCode,endedAt,errorCode,failureDomain,durationMs,usageJson,id);
  }
  updateAttemptStatus(id:string,status:string):void{this.db.prepare("UPDATE attempts SET status=? WHERE id=?").run(status,id);}
  appendEvent(record:EventRecord):void{if(Buffer.byteLength(record.payloadJson)>65536)throw new Error("Event payload too large");this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(record.id,record.taskId,record.runId,record.sequence,record.type,record.payloadJson,record.createdAt);this.emitEvent(record);}
  recoverInterrupted(): number {
    const timestamp=now();
    return this.transaction(()=>{
      const result=this.db.prepare("UPDATE runs SET status='INTERRUPTED',ended_at=?,error_code='RUN_INTERRUPTED' WHERE status IN ('STARTING','RUNNING','CANCELLING')").run(timestamp);
      const active=["DESIGNING","PREPARING_WORKTREE","BUILDING","TESTING","DETERMINISTIC_GATE","REVIEWING"];
      const placeholders=active.map(()=>"?").join(",");
      const tasks=this.db.prepare(`SELECT id,status FROM tasks WHERE status IN (${placeholders})`).all(...active) as Row[];
      for(const task of tasks){
        this.db.prepare("UPDATE tasks SET status='INTERRUPTED',updated_at=? WHERE id=?").run(timestamp,String(task.id));
        const seq=(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM events WHERE task_id=?").get(String(task.id)) as Row).n as number;
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(),String(task.id),null,seq,"STATUS_CHANGED",JSON.stringify({from:String(task.status),to:"INTERRUPTED",reason:"APP_RESTART"}),timestamp);
      }
      return Number(result.changes);
    });
  }
}

export const ensureArtifactLayout = (root:string, runId:string): string => { const target=path.resolve(root,"runs",runId); mkdirSync(target,{recursive:true}); return target; };
