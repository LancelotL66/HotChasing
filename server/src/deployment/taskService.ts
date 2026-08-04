import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { logger } from '../services/logger.js';
import { requireProject, toProjectView, type ForkLabProjectRow } from '../fork-lab/forkLabService.js';

export const TASK_STATUS = [
  'QUEUED', 'CLAIMED', 'PREPARING', 'CLONING', 'AGENT_PLANNING', 'PLAN_VALIDATING',
  'BUILDING', 'STARTING', 'VERIFYING', 'REPAIRING', 'REPORTING', 'COMPLETED', 'FAILED',
  'BLOCKED', 'CANCELLED', 'MANUAL_REQUIRED',
] as const;
export type TaskStatus = typeof TASK_STATUS[number];

export interface CreateTasksOptions {
  name?: string;
  agentId?: string;
  testLevel?: string;
  maxConcurrency?: number;
  maxRepairIterations?: number;
  allowModification?: boolean;
  allowCommit?: boolean;
  allowPush?: boolean;
}

export interface TaskView {
  id: string;
  batch_id: string | null;
  workspace_project_id: string;
  runner_id: string | null;
  agent_id: string;
  status: string;
  current_stage: string | null;
  progress: number;
  max_repair_iterations: number;
  allow_modification: number;
  allow_commit: number;
  allow_push: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  project: Record<string, unknown> | null;
  repo: Record<string, unknown> | null;
}

export interface ProjectTestReport {
  id: string;
  workspace_project_id: string;
  task_id: string;
  runner_id: string | null;
  status: string;
  report_markdown: string;
  result_json: string | null;
  logs_text: string | null;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
}

function toTaskView(task: Record<string, unknown>): TaskView {
  const projectRow = requireProjectRow(task.workspace_project_id as string);
  const project = toProjectView(projectRow);
  return { ...(task as unknown as TaskView), project: project as unknown as Record<string, unknown>, repo: project.repo };
}

function requireProjectRow(id: string): ForkLabProjectRow {
  const row = getDb().prepare('SELECT * FROM fork_workspace_projects WHERE id=?').get(id) as ForkLabProjectRow | undefined;
  if (!row) {
    const error = new Error('Fork lab project not found');
    (error as Error & { code?: string }).code = 'PROJECT_NOT_FOUND';
    throw error;
  }
  return row;
}

export function getTaskRow(taskId: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM deployment_tasks WHERE id=?').get(taskId) as Record<string, unknown> | undefined;
}

export function getTask(taskId: string): TaskView | null {
  const row = getTaskRow(taskId);
  return row ? toTaskView(row) : null;
}

export function requireTask(taskId: string): TaskView {
  const task = getTask(taskId);
  if (!task) {
    const error = new Error('Deployment task not found');
    (error as Error & { code?: string }).code = 'TASK_NOT_FOUND';
    throw error;
  }
  return task;
}

export function createTasks(projectIds: string[], options: CreateTasksOptions = {}): { batchId: string | null; tasks: TaskView[] } {
  const db = getDb();
  if (projectIds.length === 0) {
    const error = new Error('No projects selected');
    (error as Error & { code?: string }).code = 'NO_PROJECTS';
    throw error;
  }
  const batchId = randomUUID();
  const now = new Date().toISOString();
  const batchTx = db.transaction(() => {
    db.prepare(`INSERT INTO deployment_batches (id,name,agent_id,test_level,max_concurrency,status,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(batchId, options.name ?? '批量部署', options.agentId ?? 'manual', options.testLevel ?? 'L2', options.maxConcurrency ?? 2, 'QUEUED', now);
    for (const projectId of projectIds) {
      requireProject(projectId);
      db.prepare(`INSERT INTO deployment_tasks
        (id,batch_id,workspace_project_id,agent_id,status,max_repair_iterations,allow_modification,allow_commit,allow_push,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), batchId, projectId, options.agentId ?? 'manual', 'QUEUED', options.maxRepairIterations ?? 3, options.allowModification === false ? 0 : 1, options.allowCommit === false ? 0 : 1, options.allowPush === true ? 1 : 0, now);
      db.prepare("UPDATE fork_workspace_projects SET project_status='QUEUED' WHERE id=?").run(projectId);
    }
  });
  batchTx();
  const tasks = db.prepare('SELECT * FROM deployment_tasks WHERE batch_id=? ORDER BY created_at ASC').all(batchId) as Record<string, unknown>[];
  return { batchId, tasks: tasks.map(toTaskView) };
}

export function listTasks(status?: string): TaskView[] {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM deployment_tasks WHERE status=? ORDER BY created_at DESC').all(status) as Record<string, unknown>[]
    : db.prepare('SELECT * FROM deployment_tasks ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.flatMap((row) => {
    try {
      return [toTaskView(row)];
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'PROJECT_NOT_FOUND') {
        logger.warn('deployment.task', `Skipping orphaned task ${String(row.id)}`);
        return [];
      }
      throw error;
    }
  });
}

export function listTasksByStatuses(statuses: string[]): TaskView[] {
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM deployment_tasks WHERE status IN (${placeholders}) ORDER BY created_at DESC`).all(...statuses) as Record<string, unknown>[];
  return rows.flatMap((row) => {
    try {
      return [toTaskView(row)];
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'PROJECT_NOT_FOUND') {
        logger.warn('deployment.task', `Skipping orphaned task ${String(row.id)}`);
        return [];
      }
      throw error;
    }
  });
}

export function blockTasksWithOfflineRunners(): void {
  const db = getDb();
  const activeStatuses = ['CLAIMED', 'PREPARING', 'CLONING', 'AGENT_PLANNING', 'PLAN_VALIDATING', 'BUILDING', 'STARTING', 'VERIFYING', 'REPAIRING', 'REPORTING'];
  const tasks = db.prepare(`SELECT * FROM deployment_tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')})`).all(...activeStatuses) as Record<string, unknown>[];
  const cutoff = Date.now() - 90_000;
  for (const task of tasks) {
    const runnerId = task.runner_id as string | null;
    const runner = runnerId ? db.prepare('SELECT last_heartbeat_at FROM runner_agents WHERE id=?').get(runnerId) as { last_heartbeat_at?: string | null } | undefined : undefined;
    const heartbeat = runner?.last_heartbeat_at ? Date.parse(runner.last_heartbeat_at) : NaN;
    if (!runner || !Number.isFinite(heartbeat) || heartbeat < cutoff) {
      const message = 'Runner 已离线超过 90 秒，任务已暂停。请重新启动 Runner 后重试，或转人工处理。';
      updateTaskStatus(String(task.id), 'BLOCKED', 'RUNNER_OFFLINE', Number(task.progress ?? 0), message);
      addEvent(String(task.id), runnerId, 'runner_offline', 'RUNNER_OFFLINE', message);
    }
  }
}

export function cancelTask(taskId: string): TaskView {
  const task = requireTask(taskId);
  if (!['QUEUED', 'CLAIMED', 'PREPARING', 'CLONING', 'AGENT_PLANNING', 'PLAN_VALIDATING', 'BUILDING', 'STARTING', 'VERIFYING', 'REPAIRING'].includes(task.status)) {
    const error = new Error(`Task cannot be cancelled from status ${task.status}`);
    (error as Error & { code?: string }).code = 'TASK_NOT_CANCELLABLE';
    throw error;
  }
  const db = getDb();
  db.prepare("UPDATE deployment_tasks SET status='CANCELLED', finished_at=?, error_message='用户取消' WHERE id=?").run(new Date().toISOString(), taskId);
  db.prepare('UPDATE deployment_runs SET status=? WHERE task_id=? AND status NOT IN (?,?)').run('CANCELLED', taskId, 'COMPLETED', 'FAILED');
  db.prepare("UPDATE fork_workspace_projects SET project_status='ARCHIVED' WHERE id=?").run(task.workspace_project_id);
  return requireTask(taskId);
}

export function deleteTask(taskId: string): void {
  const task = requireTask(taskId);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM deployment_task_events WHERE task_id=?').run(taskId);
    db.prepare('DELETE FROM deployment_runs WHERE task_id=?').run(taskId);
    db.prepare('DELETE FROM local_deployments WHERE task_id=?').run(taskId);
    db.prepare('DELETE FROM deployment_tasks WHERE id=?').run(taskId);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM deployment_tasks WHERE workspace_project_id=?').get(task.workspace_project_id) as { c: number };
    if (remaining.c === 0) db.prepare("UPDATE fork_workspace_projects SET project_status='PLAN_READY' WHERE id=?").run(task.workspace_project_id);
  })();
}

export function listProjectReports(projectId: string): ProjectTestReport[] {
  requireProject(projectId);
  return getDb().prepare(`SELECT * FROM project_test_reports WHERE workspace_project_id=? ORDER BY created_at DESC`)
    .all(projectId) as ProjectTestReport[];
}

export function retryTask(taskId: string): TaskView {
  const task = requireTask(taskId);
  if (!['FAILED', 'BLOCKED', 'CANCELLED', 'MANUAL_REQUIRED'].includes(task.status)) {
    const error = new Error(`Task cannot be retried from status ${task.status}`);
    (error as Error & { code?: string }).code = 'TASK_NOT_RETRYABLE';
    throw error;
  }
  const db = getDb();
  db.prepare(`UPDATE deployment_tasks SET status='QUEUED', current_stage=NULL, progress=0, runner_id=NULL, started_at=NULL, finished_at=NULL, error_message=NULL WHERE id=?`).run(taskId);
  db.prepare("UPDATE fork_workspace_projects SET project_status='QUEUED' WHERE id=?").run(task.workspace_project_id);
  return requireTask(taskId);
}

export function markManual(taskId: string): TaskView {
  const task = requireTask(taskId);
  if (!['FAILED', 'BLOCKED'].includes(task.status)) {
    const error = new Error(`Task cannot be marked manual from status ${task.status}`);
    (error as Error & { code?: string }).code = 'TASK_NOT_MANUAL';
    throw error;
  }
  getDb().prepare("UPDATE deployment_tasks SET status='MANUAL_REQUIRED', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId);
  return requireTask(taskId);
}

export function claimNextTask(runnerId: string): TaskView | null {
  const db = getDb();
  const candidates = db.prepare("SELECT * FROM deployment_tasks WHERE status='QUEUED' ORDER BY created_at ASC").all() as Record<string, unknown>[];
  const row = candidates.find((candidate) => {
    try {
      requireProjectRow(candidate.workspace_project_id as string);
      return true;
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'PROJECT_NOT_FOUND') {
        logger.warn('deployment.task', `Skipping orphaned queued task ${String(candidate.id)}`);
        return false;
      }
      throw error;
    }
  });
  if (!row) return null;
  const attemptCount = (db.prepare('SELECT COUNT(*) AS c FROM deployment_runs WHERE task_id=?').get(row.id) as { c: number }).c;
  const runId = randomUUID();
  db.transaction(() => {
    db.prepare(`UPDATE deployment_tasks SET status='CLAIMED', runner_id=?, current_stage='PREPARING', progress=2, started_at=? WHERE id=? AND status='QUEUED'`)
      .run(runnerId, new Date().toISOString(), row.id);
    db.prepare('INSERT INTO deployment_runs (id,task_id,attempt,status,started_at) VALUES (?,?,?,?,?)')
      .run(runId, row.id, attemptCount + 1, 'CLAIMED', new Date().toISOString());
  })();
  db.prepare("UPDATE fork_workspace_projects SET project_status='TESTING' WHERE id=?").run(row.workspace_project_id as string);
  const task = getTask(row.id as string);
  if (!task) return null;
  addEvent(task.id, runnerId, 'claim', 'PREPARING', `任务被 Runner ${runnerId} 领取，第 ${attemptCount + 1} 次尝试`);
  return task;
}

export function claimTaskById(runnerId: string, taskId: string): TaskView {
  const db = getDb();
  const row = getTaskRow(taskId);
  if (!row) {
    const error = new Error('Deployment task not found');
    (error as Error & { code?: string }).code = 'TASK_NOT_FOUND';
    throw error;
  }
  if (row.status !== 'QUEUED') {
    const error = new Error(`Task cannot be started from status ${String(row.status)}`);
    (error as Error & { code?: string }).code = 'TASK_NOT_CLAIMABLE';
    throw error;
  }
  requireProjectRow(row.workspace_project_id as string);
  const attemptCount = (db.prepare('SELECT COUNT(*) AS c FROM deployment_runs WHERE task_id=?').get(taskId) as { c: number }).c;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE deployment_tasks SET status='CLAIMED', runner_id=?, current_stage='PREPARING', progress=2, started_at=? WHERE id=? AND status='QUEUED'`)
      .run(runnerId, now, taskId);
    db.prepare('INSERT INTO deployment_runs (id,task_id,attempt,status,started_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), taskId, attemptCount + 1, 'CLAIMED', now);
  })();
  db.prepare("UPDATE fork_workspace_projects SET project_status='TESTING' WHERE id=?").run(row.workspace_project_id as string);
  const task = getTask(taskId);
  if (!task) throw new Error('Deployment task could not be claimed');
  addEvent(task.id, runnerId, 'claim', 'PREPARING', `任务由用户明确启动，Runner ${runnerId} 正在执行，第 ${attemptCount + 1} 次尝试`);
  return task;
}

export function addEvent(taskId: string, runnerId: string | null, eventType: string, stage: string | null, message: string): void {
  getDb().prepare('INSERT INTO deployment_task_events (task_id,runner_id,event_type,stage,message,created_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, runnerId, eventType, stage, message, new Date().toISOString());
}

export function listEvents(taskId: string): Array<Record<string, unknown>> {
  return getDb().prepare('SELECT id,task_id,runner_id,event_type,stage,message,created_at FROM deployment_task_events WHERE task_id=? ORDER BY id ASC').all(taskId) as Array<Record<string, unknown>>;
}

export function updateTaskStatus(taskId: string, status: string, stage: string | null, progress: number, message?: string): void {
  getDb().prepare('UPDATE deployment_tasks SET status=?, current_stage=?, progress=?, error_message=? WHERE id=?')
    .run(status, stage, progress, message ?? null, taskId);
  if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'MANUAL_REQUIRED'].includes(status)) {
    getDb().prepare('UPDATE deployment_tasks SET finished_at=? WHERE id=?').run(new Date().toISOString(), taskId);
  }
}

export function completeTask(
  taskId: string,
  runnerId: string,
  input: { status: string; stage?: string; result?: Record<string, unknown>; containerNames?: string[]; ports?: number[]; workspacePath?: string; errorMessage?: string; reportMarkdown?: string; logsText?: string },
): TaskView {
  const task = requireTask(taskId);
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE deployment_runs SET status=?, finished_at=?, result_json=? WHERE task_id=? AND status NOT IN (?,?)')
      .run(input.status, now, input.result ? JSON.stringify(input.result) : null, taskId, 'COMPLETED', 'FAILED');
    db.prepare('UPDATE deployment_tasks SET status=?, current_stage=?, progress=?, finished_at=?, error_message=? WHERE id=?')
      .run(input.status, input.stage ?? null, input.status === 'COMPLETED' ? 100 : 90, now, input.errorMessage ?? null, taskId);
    if (input.status === 'COMPLETED') {
      db.prepare("UPDATE fork_workspace_projects SET project_status='DEPLOYED' WHERE id=?").run(task.workspace_project_id);
      const existing = db.prepare('SELECT id FROM local_deployments WHERE task_id=?').get(taskId);
      if (!existing) {
        db.prepare(`INSERT INTO local_deployments (id,workspace_project_id,task_id,runner_id,workspace_path,container_names_json,ports_json,status,started_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), task.workspace_project_id, taskId, runnerId, input.workspacePath ?? null, JSON.stringify(input.containerNames ?? []), JSON.stringify(input.ports ?? []), 'RUNNING', now);
      }
    } else {
      db.prepare("UPDATE fork_workspace_projects SET project_status='FAILED' WHERE id=?").run(task.workspace_project_id);
    }
    if (input.reportMarkdown?.trim()) {
      db.prepare(`INSERT INTO project_test_reports
        (id,workspace_project_id,task_id,runner_id,status,report_markdown,result_json,logs_text,workspace_path,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
          status=excluded.status, report_markdown=excluded.report_markdown, result_json=excluded.result_json,
          logs_text=excluded.logs_text, workspace_path=excluded.workspace_path, updated_at=excluded.updated_at`)
        .run(randomUUID(), task.workspace_project_id, taskId, runnerId, input.status, input.reportMarkdown,
          input.result ? JSON.stringify(input.result) : null, input.logsText ?? null, input.workspacePath ?? null, now, now);
    }
  })();
  logger.info('deployment.task', `Task ${taskId} completed with status ${input.status}`);
  return requireTask(taskId);
}

export function listLocalDeployments(): Array<Record<string, unknown>> {
  const rows = getDb().prepare('SELECT * FROM local_deployments ORDER BY started_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const project = row.workspace_project_id ? toProjectView(requireProjectRow(row.workspace_project_id as string)) : null;
    return { ...row, project };
  });
}

export function getTaskBundle(taskId: string): Record<string, unknown> {
  const task = requireTask(taskId);
  const project = requireProject(task.workspace_project_id);
  const planRow = getDb().prepare('SELECT id,plan_json,plan_source,plan_version,locked FROM deployment_plans WHERE workspace_project_id=?').get(task.workspace_project_id) as Record<string, unknown> | undefined;
  const planJson = (() => {
    try { return planRow?.plan_json ? JSON.parse(String(planRow.plan_json)) : null; } catch { return null; }
  })();
  return {
    task,
    project,
    repo: project.repo,
    assessment: project.assessment,
    plan: planJson,
    verification: {
      projectType: 'local-exploratory',
      checks: [
        { id: 'agent-result', type: 'result_json', required: true },
        { id: 'test-report', type: 'report_markdown', required: true },
      ],
      artifacts: { collect: ['report.md', 'result.json', 'patch.diff', 'stdout', 'stderr'] },
    },
  };
}
