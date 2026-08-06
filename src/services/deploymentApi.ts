import { backend } from './backendAdapter';
import type { ForkLabProject } from './forkLabApi';

export type DeploymentTaskStatus =
  | 'QUEUED' | 'CLAIMED' | 'PREPARING' | 'CLONING' | 'AGENT_PLANNING' | 'PLAN_VALIDATING'
  | 'BUILDING' | 'STARTING' | 'VERIFYING' | 'REPAIRING' | 'REPORTING'
  | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'MANUAL_REQUIRED';

export interface DeploymentTask {
  id: string;
  batch_id: string | null;
  workspace_project_id: string;
  runner_id: string | null;
  agent_id: string;
  status: DeploymentTaskStatus;
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
  project?: {
    upstream_full_name: string;
    source: string;
    fork_status: string;
    repo?: { language?: string | null; stargazers_count?: number } | null;
  } | null;
  events?: Array<{ event_type: string; stage: string | null; message: string; created_at: string }>;
}

export interface DeploymentBatch {
  id: string;
  name: string | null;
  test_level: string;
  status: string;
  created_at: string;
  tasks: DeploymentTask[];
}

export interface LocalDeployment {
  id: string;
  workspace_project_id: string;
  task_id: string | null;
  runner_id: string;
  workspace_path: string | null;
  container_names_json: string | null;
  ports_json: string | null;
  status: string;
  started_at: string;
  stopped_at: string | null;
  project?: ForkLabProject | null;
}

export interface RunnerAgent {
  id: string;
  name: string;
  platform: string;
  status: 'ONLINE' | 'OFFLINE';
  capabilities_json: string;
  last_heartbeat_at: string | null;
  registered_at: string;
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
  user_report_json?: string | null;
  report_status?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!backend.backendUrl) throw new Error('需要启动本地后端以使用部署任务');
  const response = await fetch(`${backend.backendUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `请求失败：${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const deploymentApi = {
  createBatch: (projectIds: string[], options: { testLevel?: string; name?: string; maxConcurrency?: number } = {}) =>
    request<{ batchId: string; tasks: DeploymentTask[] }>('/deployment/batches', { method: 'POST', body: JSON.stringify({ projectIds, ...options }) }),
  listBatches: () => request<{ batches: DeploymentBatch[] }>('/deployment/batches'),
  listTasks: (status?: 'queued' | 'running' | 'done' | 'failed') =>
    request<{ tasks: DeploymentTask[] }>(status ? `/deployment/tasks?status=${status}` : '/deployment/tasks'),
  getTask: (id: string) => request<{ task: DeploymentTask; events: DeploymentTask['events'] }>(`/deployment/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => request<{ task: DeploymentTask }>(`/deployment/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  deleteTask: (id: string) => request<{ deleted: boolean }>(`/deployment/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' }),
  retryTask: (id: string) => request<{ task: DeploymentTask }>(`/deployment/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  markManual: (id: string) => request<{ task: DeploymentTask }>(`/deployment/tasks/${encodeURIComponent(id)}/manual`, { method: 'POST', body: '{}' }),
  submitDecision: (id: string, requestId: string | undefined, choice: string, note?: string) => request<{ ok: true }>(`/deployment/tasks/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify({ requestId, choice, note }) }),
  listDeployments: () => request<{ deployments: LocalDeployment[] }>('/local-deployments'),
  listRunners: () => request<{ runners: RunnerAgent[] }>('/runners'),
  listProjectReports: (projectId: string) => request<{ reports: ProjectTestReport[] }>(`/deployment/projects/${encodeURIComponent(projectId)}/reports`),
  listTaskArtifacts: (taskId: string) => request<{ artifacts: Array<{ artifact_type: string; relative_path: string; size_bytes: number | null; created_at: string }> }>(`/deployment/tasks/${encodeURIComponent(taskId)}/artifacts`),
};
