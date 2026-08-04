import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

export interface ForkLabProjectRow {
  id: string;
  repo_id: number;
  source: string;
  upstream_full_name: string;
  fork_full_name: string | null;
  fork_status: string;
  upstream_commit_sha: string | null;
  test_branch: string | null;
  project_status: string;
  selected_at: string;
  forked_at: string | null;
  archived_at: string | null;
}

export interface ProjectView extends ForkLabProjectRow {
  repo: Record<string, unknown> | null;
  assessment: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  has_active_task: boolean;
}

export function toProjectView(project: ForkLabProjectRow): ProjectView {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  const assessment = db.prepare('SELECT * FROM deployment_assessments WHERE repo_id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  const plan = db.prepare('SELECT id,workspace_project_id,plan_json,plan_source,plan_version,locked,generated_at,updated_at FROM deployment_plans WHERE workspace_project_id=?').get(project.id) as Record<string, unknown> | undefined;
  const active = db.prepare("SELECT id FROM deployment_tasks WHERE workspace_project_id=? AND status IN ('QUEUED','CLAIMED','PREPARING','CLONING','AGENT_PLANNING','PLAN_VALIDATING','BUILDING','STARTING','VERIFYING','REPAIRING','REPORTING') LIMIT 1").get(project.id);
  return { ...project, repo: repo ?? null, assessment: assessment ?? null, plan: plan ?? null, has_active_task: Boolean(active) };
}

export interface CreateProjectResult {
  project: ProjectView;
  created: boolean;
}

export function createProject(repoId: number, source: string): CreateProjectResult {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId) as Record<string, unknown> | undefined;
  if (!repo) {
    const error = new Error('Repository not found');
    (error as Error & { code?: string }).code = 'REPOSITORY_NOT_FOUND';
    throw error;
  }
  const existing = db.prepare('SELECT * FROM fork_workspace_projects WHERE repo_id=?').get(repoId) as ForkLabProjectRow | undefined;
  if (existing) {
    return { project: toProjectView(existing), created: false };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO fork_workspace_projects (id,repo_id,source,upstream_full_name,fork_status,project_status,selected_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, repoId, source, String(repo.full_name ?? ''), 'NOT_REQUESTED', 'SELECTED', now);
  const row = db.prepare('SELECT * FROM fork_workspace_projects WHERE id=?').get(id) as ForkLabProjectRow;
  return { project: toProjectView(row), created: true };
}

export function listProjects(): ProjectView[] {
  const rows = getDb().prepare('SELECT * FROM fork_workspace_projects ORDER BY selected_at DESC').all() as ForkLabProjectRow[];
  return rows.map(toProjectView);
}

export function getProject(id: string): ProjectView | null {
  const row = getDb().prepare('SELECT * FROM fork_workspace_projects WHERE id=?').get(id) as ForkLabProjectRow | undefined;
  return row ? toProjectView(row) : null;
}

export function requireProject(id: string): ProjectView {
  const project = getProject(id);
  if (!project) {
    const error = new Error('Fork lab project not found');
    (error as Error & { code?: string }).code = 'PROJECT_NOT_FOUND';
    throw error;
  }
  return project;
}

export function setProjectStatus(id: string, status: string): void {
  getDb().prepare('UPDATE fork_workspace_projects SET project_status=? WHERE id=?').run(status, id);
}

export function deleteProject(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const taskIds = db.prepare('SELECT id FROM deployment_tasks WHERE workspace_project_id=?').all(id) as Array<{ id: string }>;
    for (const task of taskIds) {
      db.prepare('DELETE FROM deployment_task_events WHERE task_id=?').run(task.id);
      db.prepare('DELETE FROM deployment_runs WHERE task_id=?').run(task.id);
    }
    db.prepare('DELETE FROM local_deployments WHERE workspace_project_id=?').run(id);
    db.prepare('DELETE FROM project_test_reports WHERE workspace_project_id=?').run(id);
    db.prepare('DELETE FROM deployment_tasks WHERE workspace_project_id=?').run(id);
    db.prepare('DELETE FROM deployment_plans WHERE workspace_project_id=?').run(id);
    db.prepare('DELETE FROM fork_workspace_projects WHERE id=?').run(id);
  })();
}
