import React from "react";
import type { ProjectRecord } from "../../../../shared/contracts/records.js";
import { Button, EmptyState, InlineError, Spinner } from "../../ui/index.js";

export type ProjectListProps = {
  projects: ProjectRecord[];
  selectedProjectId?: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (_project: ProjectRecord) => void;
  onAdd?: () => void;
};

export const ProjectList = ({ projects, selectedProjectId, loading = false, error, onSelect: _onSelect, onAdd }: ProjectListProps): React.JSX.Element => (
  <section aria-labelledby="projects-heading" className="project-list">
    <div className="section-heading">
      <h2 id="projects-heading">Projects</h2>
      {onAdd && <Button type="button" onClick={onAdd}>添加本地 Git 仓库</Button>}
    </div>
    {loading && <Spinner label="正在加载项目" />}
    {error && <InlineError>加载项目失败：{error}</InlineError>}
    {!loading && !error && projects.length === 0 && <EmptyState title="尚未注册项目" description="添加一个本地 Git 仓库开始。" action={onAdd && <Button type="button" onClick={onAdd}>添加项目</Button>} />}
    {!loading && projects.length > 0 && (
      <ul aria-label="已注册项目">
        {projects.map((project) => (
          <li key={project.id}>
            <Button
              type="button"
              className="list-item"
              aria-current={selectedProjectId === project.id ? "true" : undefined}
              onClick={() => _onSelect(project)}
            >
              <span>{project.name}</span>
              <small title={project.repoRealPath}>{project.lastSeenHead.slice(0, 8)}</small>
            </Button>
          </li>
        ))}
      </ul>
    )}
  </section>
);
