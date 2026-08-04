import { backend } from './backendAdapter';

export type ForkLabProjectSource = 'digest' | 'top100' | 'manual';

export interface ForkLabAssessment {
  repo_id: number;
  value_score: number;
  difficulty_score: number;
  testability_score: number;
  risk_score: number;
  recommended_level: string;
  recommended_strategy: string | null;
  assessment_json: string;
  source_hash: string;
  ai_config_id: string | null;
  confidence: number | null;
  assessed_at: string;
}

export interface ForkLabPlan {
  id: string;
  workspace_project_id: string;
  plan_json: string;
  plan_source: string;
  plan_version: number;
  locked: number;
  generated_at: string;
  updated_at: string;
}

export interface ForkLabProject {
  id: string;
  repo_id: number;
  source: string;
  upstream_full_name: string;
  fork_full_name: string | null;
  fork_status: string;
  upstream_commit_sha: string | null;
  test_branch: string | null;
  project_status: string;
  has_active_task?: boolean;
  selected_at: string;
  forked_at: string | null;
  archived_at: string | null;
  repo: Record<string, unknown> | null;
  assessment: ForkLabAssessment | null;
  plan: ForkLabPlan | null;
}

export interface AddProjectResult {
  project: ForkLabProject;
  created: boolean;
  alreadyExists: boolean;
  autoFork?: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!backend.backendUrl) throw new Error('需要启动本地后端以使用 Fork 实验室');
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

export const forkLabApi = {
  addProject: (repoId: number, source: ForkLabProjectSource = 'manual') =>
    request<AddProjectResult>('/fork-lab/projects', { method: 'POST', body: JSON.stringify({ repoId, source }) }),
  listProjects: () => request<{ projects: ForkLabProject[] }>('/fork-lab/projects'),
  getProject: (id: string) => request<{ project: ForkLabProject }>(`/fork-lab/projects/${encodeURIComponent(id)}`),
  removeProject: (id: string) => request<{ deleted: boolean }>(`/fork-lab/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateAssessment: (id: string, force = false) =>
    request<{ assessment: ForkLabAssessment; cached: boolean; source: string }>(`/fork-lab/projects/${encodeURIComponent(id)}/assessment`, { method: 'POST', body: JSON.stringify({ force }) }),
  getAssessment: (id: string) => request<{ assessment: ForkLabAssessment }>(`/fork-lab/projects/${encodeURIComponent(id)}/assessment`),
  generatePlan: (id: string, force = false) =>
    request<{ plan: ForkLabPlan; cached: boolean; source: string }>(`/fork-lab/projects/${encodeURIComponent(id)}/plan`, { method: 'POST', body: JSON.stringify({ force }) }),
  getPlan: (id: string) => request<{ plan: ForkLabPlan }>(`/fork-lab/projects/${encodeURIComponent(id)}/plan`),
  updatePlan: (id: string, plan: Record<string, unknown>) =>
    request<{ plan: ForkLabPlan }>(`/fork-lab/projects/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) }),
  lockPlan: (id: string) => request<{ plan: ForkLabPlan }>(`/fork-lab/projects/${encodeURIComponent(id)}/plan/lock`, { method: 'POST', body: '{}' }),
  unlockPlan: (id: string) => request<{ plan: ForkLabPlan }>(`/fork-lab/projects/${encodeURIComponent(id)}/plan/unlock`, { method: 'POST', body: '{}' }),
  forkProject: (id: string) =>
    request<{ project: ForkLabProject; created: boolean }>(`/fork-lab/projects/${encodeURIComponent(id)}/fork`, { method: 'POST', body: '{}' }),
  getForkStatus: (id: string) => request<{ project: ForkLabProject; status: string }>(`/fork-lab/projects/${encodeURIComponent(id)}/fork-status`),
  syncUpstream: (id: string) =>
    request<{ project: ForkLabProject; synced: boolean }>(`/fork-lab/projects/${encodeURIComponent(id)}/sync-upstream`, { method: 'POST', body: '{}' }),
  createTask: (id: string, testLevel = 'L2') =>
    request<{ batchId: string; tasks: Array<{ id: string; status: string; workspace_project_id: string }> }>('/deployment/batches', { method: 'POST', body: JSON.stringify({ projectIds: [id], testLevel }) }),
};
