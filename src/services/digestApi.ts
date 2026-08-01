import { backend } from './backendAdapter';

export interface DailyDigestItem {
  repo_id: number; name: string; full_name: string; html_url: string; description: string | null;
  language: string | null; stargazers_count: number; forks_count?: number; owner_login: string; owner_avatar_url: string;
  created_at: string; updated_at: string; pushed_at: string; topics: string; hot_summary_zh: string | null;
  hot_summary_zh_status: string; hot_summary_zh_source: string | null; section: string; ranking: number; reason: string; score: number;
  primary_category: string | null; secondary_categories: string | null; function_tags: string | null;
  product_forms: string | null; platform_tags: string | null; target_users: string | null;
  deployment_modes: string | null; deployment_difficulty: string | null; hot_reason_tags: string | null;
  maturity_tag: string | null; cost_tags: string | null; license_tag: string | null; privacy_tags: string | null;
  classification_confidence: number | null; classification_reason: string | null; classification_source: string | null;
  is_top100?: number;
}
export interface DailyDigest { id: string; digest_date: string; title: string; summary: string; generated_at: string; status: string; items: DailyDigestItem[]; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!backend.backendUrl) throw new Error('需要启动本地后端以使用每日合集');
  const response = await fetch(`${backend.backendUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}
export const digestApi = {
  list: () => request<Array<Pick<DailyDigest, 'id' | 'digest_date' | 'title' | 'summary' | 'generated_at' | 'status'>>>('/digests'),
  get: (date: string) => request<DailyDigest>(`/digests/${encodeURIComponent(date)}`),
  generate: (force = false) => request<{ digestDate: string; archived: boolean }>('/digests/generate', { method: 'POST', body: JSON.stringify({ force }) }),
  rebuildAll: () => request<{ rebuilt: number; failed: Array<{ date: string; error: string }> }>('/digests/rebuild-all', { method: 'POST', body: '{}' }),
  collectHotProjects: () => request<{ id: string; channels: string[]; itemsFound: number; itemsSaved: number }>('/discovery/run', { method: 'POST', body: '{}' }),
  regenerateSummary: (repoId: number) => request(`/projects/${repoId}/hot-summary-zh/regenerate`, { method: 'POST', body: '{}' }),
};
