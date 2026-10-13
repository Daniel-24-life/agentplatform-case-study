import React, { useEffect, useRef, useState } from "react";
import type { ProjectRecord, TaskDetailRecord, TaskRecord } from "../../shared/contracts/records.js";
import type { RuntimePreflightSummary } from "../../preload/types.js";
import { AgentsPanel } from "./features/agents/index.js";
import { CreateTaskForm, ProjectList, TaskList } from "./features/projects/index.js";
import { RuntimePanel } from "./features/runtime/index.js";
import { ProductPanel } from "./features/products/ProductPanel.js";
import { navigateBack, navigateTo, type AppSection, type NavigationState } from "./navigation.js";
import {
  createTaskViewModel,
  EscalationCard,
  EvidenceWorkspace,
  StageProgress,
  TaskHeader
} from "./features/tasks/index.js";
import { Button, EmptyState, Icon, InlineError, Spinner, StatusBadge } from "./ui/index.js";


const SECTION_LABELS: Record<AppSection, string> = {
  products: "产品",
  projects: "项目",
  tasks: "任务",
  runtime: "运行环境",
  agents: "Agents"
};

const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value);

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
};

export const App = (): React.JSX.Element => {
  const [navigation, setNavigation] = useState<NavigationState>({ section: "products", previous: [] });
  const section = navigation.section;
  const setSection = (destination: AppSection): void => setNavigation(current => navigateTo(current, destination));
  const goBack = (): void => setNavigation(current => navigateBack(current));
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [runtime, setRuntime] = useState<RuntimePreflightSummary | null>(null);
  const [doctor, setDoctor] = useState<RuntimePreflightSummary | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [requestText, setRequestText] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [specText, setSpecText] = useState("");
  const [specError, setSpecError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandInputRef = useRef<HTMLInputElement>(null);

  const replaceDetail = (value: TaskDetailRecord): void => {
    setDetail(value);
    setSpecText(value.task.specJson ? JSON.stringify(JSON.parse(value.task.specJson), null, 2) : "");
  };

  const loadProjects = async (): Promise<ProjectRecord[]> => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const values = await window.platform.projects.list();
      setProjects(values);
      return values;
    } catch (value) {
      setProjectsError(errorMessage(value));
      return [];
    } finally {
      setProjectsLoading(false);
    }
  };

  const loadTasks = async (project: ProjectRecord): Promise<void> => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      setTasks(await window.platform.tasks.list(project.id));
    } catch (value) {
      setTasks([]);
      setTasksError(errorMessage(value));
    } finally {
      setTasksLoading(false);
    }
  };

  const selectProject = async (project: ProjectRecord, destination: AppSection = section): Promise<void> => {
    setSelectedProject(project);
    setDetail(null);
    setDetailLoading(false);
    setActionError(null);
    setSpecError(null);
    setSection(destination);
    await loadTasks(project);
  };

  const chooseProject = async (): Promise<void> => {
    setProjectsError(null);
    try {
      const chosen = await window.platform.projects.chooseAndRegister();
      const values = await loadProjects();
      if (chosen) {
        const registered = values.find(project => project.id === chosen.id) ?? chosen;
        await selectProject(registered, "projects");
      }
    } catch (value) {
      setProjectsError(errorMessage(value));
    }
  };

  const openTask = async (task: TaskRecord): Promise<void> => {
    setDetailLoading(true);
    setActionError(null);
    setSpecError(null);
    setNotice(null);
    try {
      replaceDetail(await window.platform.tasks.detail(task.id));
    } catch (value) {
      setActionError(errorMessage(value));
    } finally {
      setDetailLoading(false);
    }
  };

  const openProductTask = async (taskId: string): Promise<void> => {
    try {
      const task = await window.platform.tasks.get(taskId);
      if (!task) throw new Error("关联任务不存在。");
      const values = await loadProjects();
      const project = values.find(item => item.id === task.projectId);
      if (!project) throw new Error("关联仓库不存在。");
      await selectProject(project, "tasks");
      await openTask(task);
    } catch (value) { setActionError(errorMessage(value)); }
  };

  const refreshCurrentTask = async (taskId: string): Promise<void> => {
    replaceDetail(await window.platform.tasks.detail(taskId));
    if (selectedProject) await loadTasks(selectedProject);
  };

  const createTask = async (): Promise<void> => {
    if (!selectedProject || !title.trim() || !requestText.trim()) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await window.platform.tasks.create({
        projectId: selectedProject.id,
        title: title.trim(),
        requestText: requestText.trim()
      });
      setTitle("");
      setRequestText("");
      await loadTasks(selectedProject);
      await openTask(created);
      setNotice("任务已创建，可以开始设计。");
    } catch (value) {
      setCreateError(errorMessage(value));
    } finally {
      setCreateBusy(false);
    }
  };

  const runTaskAction = async (): Promise<void> => {
    if (!detail) return;
    setActionBusy(true);
    setActionError(null);
    setNotice(null);
    const taskId = detail.task.id;
    try {
      switch (detail.task.status) {
        case "DRAFT": await window.platform.tasks.startDesign(taskId); break;
        case "SPEC_READY": await window.platform.tasks.approveSpec(taskId); break;
        case "SPEC_APPROVED":
        case "REWORK": await window.platform.tasks.startBuild(taskId); break;
        case "BUILT": await window.platform.tasks.startTests(taskId); break;
        case "GATE_READY": await window.platform.tasks.startFinalGate(taskId); break;
        default: return;
      }
      await refreshCurrentTask(taskId);
    } catch (value) {
      setActionError(errorMessage(value));
      window.platform.runtime.status().then(setRuntime).catch(() => undefined);
      try { replaceDetail(await window.platform.tasks.detail(taskId)); } catch { /* Keep the last proven detail. */ }
    } finally {
      setActionBusy(false);
    }
  };

  const runCursorBuild = async (): Promise<void> => {
    if (!detail || detail.task.status !== "SPEC_APPROVED" || detail.attempt) return;
    setActionBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await window.platform.tasks.startCursorBuild(detail.task.id);
      await refreshCurrentTask(detail.task.id);
    } catch (value) {
      setActionError(errorMessage(value));
      try { replaceDetail(await window.platform.tasks.detail(detail.task.id)); } catch { /* Keep the last proven detail. */ }
    } finally {
      setActionBusy(false);
    }
  };

  const saveSpec = async (): Promise<void> => {
    if (!detail) return;
    setActionBusy(true);
    setSpecError(null);
    try {
      const revision: unknown = JSON.parse(specText);
      await window.platform.tasks.updateSpec(detail.task.id, revision);
      await refreshCurrentTask(detail.task.id);
      setNotice("TaskSpec revision 已校验并保存。");
    } catch (value) {
      setSpecError(errorMessage(value));
    } finally {
      setActionBusy(false);
    }
  };

  const cancelSpecEdit = (): void => {
    setSpecText(detail?.task.specJson ? JSON.stringify(JSON.parse(detail.task.specJson), null, 2) : "");
    setSpecError(null);
  };

  const approveEscalation = async (): Promise<void> => {
    if (!detail) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await window.platform.tasks.approveEscalation(detail.task.id);
      await refreshCurrentTask(detail.task.id);
    } catch (value) {
      setActionError(errorMessage(value));
    } finally {
      setActionBusy(false);
    }
  };

  const cancelRun = async (): Promise<void> => {
    setActionError(null);
    try {
      const run = detail?.runs.slice().reverse().find(value => ["STARTING", "RUNNING", "CANCELLING"].includes(value.status));
      if (!run) { setNotice("当前任务没有可取消的运行。"); return; }
      const result = await window.platform.runs.cancel(run.id);
      setNotice(result.cancelled ? `已请求取消 ${run.stage} 运行。` : "该运行已经结束或无法取消。");
      if (detail) await refreshCurrentTask(detail.task.id);
    } catch (value) {
      setActionError(errorMessage(value));
    }
  };

  const runPreflight = async (): Promise<void> => {
    setRuntimeBusy(true);
    setRuntimeError(null);
    try {
      setRuntime(await window.platform.runtime.preflight());
    } catch (value) {
      setRuntimeError(errorMessage(value));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const runDoctor = async (): Promise<void> => {
    setDoctorBusy(true);
    setRuntimeError(null);
    try { setDoctor(await window.platform.runtime.doctor()); }
    catch (value) { setRuntimeError(errorMessage(value)); }
    finally { setDoctorBusy(false); }
  };

  useEffect(() => {
    window.platform.ping().then(() => setConnection("connected")).catch(() => setConnection("disconnected"));
    window.platform.runtime.status().then(setRuntime).catch(value => setRuntimeError(errorMessage(value)));
    window.platform.runtime.doctorStatus().then(setDoctor).catch(value => setRuntimeError(errorMessage(value)));
    loadProjects().then(values => {
      if (values.length > 0) {
        setSelectedProject(values[0]);
        void loadTasks(values[0]);
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (section !== "tasks" || !detail) return;
    const taskId = detail.task.id;
    let lastSequence = detail.events.at(-1)?.sequence ?? 0;
    let alive = true;
    const unsubscribe = window.platform.events.subscribe(taskId, event => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      void window.platform.tasks.detail(taskId).then(value => {
        if (alive) setDetail(current => current?.task.id === taskId ? value : current);
      }).catch(() => undefined);
    });
    return () => { alive = false; unsubscribe(); };
  }, [section, detail?.task.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(value => !value);
      } else if (event.key === "Escape") {
        setCommandOpen(false);
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (commandOpen) window.setTimeout(() => commandInputRef.current?.focus(), 0);
    else setCommandQuery("");
  }, [commandOpen]);

  const taskViewModel = detail ? { ...createTaskViewModel(detail.task, detail), updatedAt: formatDate(detail.task.updatedAt) } : null;
  const connectionLabel = connection === "connected" ? "本地后端已连接" : connection === "disconnected" ? "本地后端未连接" : "正在连接本地后端";
  const connectionTone = connection === "connected" ? "success" : connection === "disconnected" ? "danger" : "neutral";

  const commands = [
    { id: "products", label: "转到产品", keywords: "products 产品 目标", run: () => setSection("products") },
    { id: "projects", label: "转到项目", keywords: "projects 项目", run: () => setSection("projects") },
    { id: "tasks", label: "转到任务", keywords: "tasks 任务", run: () => setSection("tasks") },
    { id: "runtime", label: "转到运行环境", keywords: "runtime preflight 运行环境", run: () => setSection("runtime") },
    { id: "agents", label: "转到 Agents", keywords: "agents codex cursor workbuddy", run: () => setSection("agents") },
    { id: "doctor", label: "运行零额度 CLI 诊断", keywords: "check 检查 runtime", run: () => { setSection("runtime"); runDoctor().catch(() => undefined); } },
    { id: "preflight", label: "运行模型资格探针（消耗额度）", keywords: "probe 模型", run: () => { setSection("runtime"); runPreflight().catch(() => undefined); } }
  ];
  const filteredCommands = commands.filter(command => `${command.label} ${command.keywords}`.toLowerCase().includes(commandQuery.trim().toLowerCase()));
  const runCommand = (command: (typeof commands)[number]): void => {
    command.run();
    setCommandOpen(false);
  };

  const renderProjectWorkspace = (): React.JSX.Element => selectedProject ? (
    <section className="project-overview surface-panel" aria-labelledby="project-title">
      <div className="eyebrow">本地 Git 仓库</div>
      <h2 id="project-title">{selectedProject.name}</h2>
      <p>仓库已登记。AgentPlatform 只会通过受控任务流程创建隔离 Attempt，不会自动合并或修改你的主 checkout。</p>
      <dl>
        <dt>位置</dt><dd><code>{selectedProject.repoRealPath}</code></dd>
        <dt>当前 HEAD</dt><dd><code>{selectedProject.lastSeenHead}</code></dd>
        <dt>任务数</dt><dd>{tasksLoading ? "加载中…" : tasks.length}</dd>
      </dl>
      <Button type="button" onClick={() => setSection("tasks")}><Icon name="arrow-right" />查看项目任务</Button>
    </section>
  ) : <EmptyState title="选择一个项目" description="从左侧选择已登记项目，或添加一个本地 Git 仓库。" action={<Button type="button" onClick={chooseProject}><Icon name="plus" />添加项目</Button>} />;

  const renderTaskWorkspace = (): React.JSX.Element => {
    if (!selectedProject) return <EmptyState title="先选择项目" description="任务始终属于一个本地 Git 项目。请先在项目页添加或选择仓库。" action={<Button type="button" onClick={() => setSection("projects")}>前往项目</Button>} />;
    if (detailLoading) return <div className="workspace-loading"><Spinner label="正在加载任务" /></div>;
    if (!detail || !taskViewModel) return <EmptyState title="选择一个任务" description="从任务列表打开 Task Workspace，查看规范、变更、检查和活动证据。" />;
    let cursorSelectable = detail.task.status === "SPEC_APPROVED" && !detail.attempt;
    if (cursorSelectable) {
      try {
        const approvedSpec = JSON.parse(detail.task.specJson ?? "null") as { execution_policy?: { user_lock?: string | null } } | null;
        cursorSelectable = approvedSpec?.execution_policy?.user_lock !== "strong";
      } catch { cursorSelectable = false; }
    }
    return (
      <div className="task-workspace">
        <TaskHeader task={taskViewModel} onPrimaryAction={runTaskAction}
          onCursorAction={cursorSelectable ? runCursorBuild : undefined} busy={actionBusy} />
        <StageProgress task={taskViewModel} />
        <EscalationCard pending={detail.escalationPending} onApprove={approveEscalation} busy={actionBusy} />
        {actionError && <InlineError>{actionError}</InlineError>}
        {notice && <p className="workspace-notice" role="status"><Icon name="info" />{notice}</p>}
        <section className="metrics-strip" aria-label="执行效率">
          <span><strong>{detail.metrics.runCount}</strong> runs</span>
          <span><strong>{detail.metrics.highTierCalls}</strong> 高级调用</span>
          <span><strong>{detail.metrics.retryCount}</strong> retry</span>
          <span><strong>{detail.metrics.totalDurationMs}ms</strong> 总耗时</span>
          <span><strong>{detail.metrics.totalTokens ?? "不可用"}</strong> tokens</span>
        </section>
        <EvidenceWorkspace
          key={detail.task.id}
          detail={detail}
          specText={specText}
          specEditable={detail.task.status === "SPEC_READY"}
          onSpecChange={setSpecText}
          onSpecSave={saveSpec}
          onSpecCancel={cancelSpecEdit}
          specError={specError}
          busy={actionBusy}
        />
        {actionBusy && <div className="run-control" role="status"><span><Spinner label="任务操作正在进行" />任务操作正在进行</span>{detail.runs.some(run => ["STARTING", "RUNNING", "CANCELLING"].includes(run.status)) && <Button type="button" variant="danger" onClick={cancelRun}>取消当前任务运行</Button>}</div>}
      </div>
    );
  };

  return (
    <main className={`app-shell app-shell--${section}`}>
      <nav className="nav-rail" aria-label="主导航">
        <div className="brand-mark" aria-label="AgentPlatform">AP</div>
        {(["products", "projects", "tasks", "runtime", "agents"] as const).map(item => (
          <Button key={item} type="button" variant="ghost" className="nav-button" aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)}>
            <Icon name={item === "projects" ? "folder" : item === "tasks" ? "check" : item === "runtime" ? "refresh" : item === "products" ? "plus" : "info"} />
            <span>{SECTION_LABELS[item]}</span>
          </Button>
        ))}
      </nav>

      <header className="top-toolbar">
        <div><span className="eyebrow">AgentPlatform</span><h1>{SECTION_LABELS[section]}</h1></div>
        <div className="toolbar-actions">
          <Button type="button" variant="secondary" size="sm" disabled={navigation.previous.length === 0}
            title="返回上一页（Alt+←），保留当前产品草稿" onClick={goBack}>返回</Button>
          <StatusBadge tone={connectionTone}>{connectionLabel}</StatusBadge>
          <Button type="button" variant="secondary" size="sm" onClick={() => setCommandOpen(true)}><Icon name="search" />命令 <kbd>Ctrl K</kbd></Button>
        </div>
      </header>

      {section === "projects" && <aside className="context-pane"><ProjectList projects={projects} selectedProjectId={selectedProject?.id} loading={projectsLoading} error={projectsError} onSelect={project => { selectProject(project, "projects").catch(() => undefined); }} onAdd={chooseProject} /></aside>}

      {section === "tasks" && <aside className="context-pane task-context">
        <div className="project-switcher">
          <label htmlFor="project-switcher">当前项目</label>
          <select id="project-switcher" value={selectedProject?.id ?? ""} onChange={event => {
            const project = projects.find(value => value.id === event.target.value);
            if (project) selectProject(project, "tasks").catch(() => undefined);
          }}>
            <option value="" disabled>选择项目</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        {selectedProject ? <>
          <CreateTaskForm title={title} requestText={requestText} submitting={createBusy} error={createError} onTitleChange={setTitle} onRequestTextChange={setRequestText} onSubmit={createTask} />
          <TaskList tasks={tasks} selectedTaskId={detail?.task.id} loading={tasksLoading} error={tasksError} onSelect={task => { openTask(task).catch(() => undefined); }} />
        </> : <EmptyState title="尚未选择项目" description="前往项目页添加或选择仓库。" action={<Button type="button" onClick={() => setSection("projects")}>前往项目</Button>} />}
      </aside>}

      <section className="workspace" aria-label={`${SECTION_LABELS[section]}工作区`}>
        <div hidden={section !== "products"}>
          <ProductPanel onOpenTask={taskId => { void openProductTask(taskId); }} onOpenRuntime={() => setSection("runtime")} />
        </div>
        {section === "projects" && renderProjectWorkspace()}
        {section === "tasks" && renderTaskWorkspace()}
        {section === "runtime" && <RuntimePanel summary={runtime} doctor={doctor} loading={runtimeBusy} doctorLoading={doctorBusy} error={runtimeError} onRunPreflight={runPreflight} onRunDoctor={runDoctor} />}
        {section === "agents" && <AgentsPanel />}
      </section>

      {commandOpen && <div className="command-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCommandOpen(false); }}>
        <section className="command-menu" role="dialog" aria-modal="true" aria-labelledby="command-title">
          <div className="command-search"><Icon name="search" /><label id="command-title" className="visually-hidden" htmlFor="command-query">命令菜单</label><input ref={commandInputRef} id="command-query" value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="搜索命令…" /></div>
          <div className="command-results" role="menu" aria-label="可用命令">
            {filteredCommands.map(command => <Button key={command.id} type="button" variant="ghost" role="menuitem" onClick={() => runCommand(command)}>{command.label}<Icon name="arrow-right" /></Button>)}
            {filteredCommands.length === 0 && <p>没有匹配的命令。</p>}
          </div>
          <footer><span><kbd>Tab</kbd> 浏览</span><span><kbd>Esc</kbd> 关闭</span></footer>
        </section>
      </div>}
    </main>
  );
};
