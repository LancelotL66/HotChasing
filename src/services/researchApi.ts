import { backend } from './backendAdapter';

// ---------- 类型（与后端 Schema 对应） ----------

export type TopicStatus =
  | 'DRAFT' | 'PARSING' | 'READY' | 'SEARCHING' | 'REVIEWING_TOOLS'
  | 'BUILDING_TOOLKIT' | 'PLANNING_THEME' | 'READY_FOR_FORK_LAB' | 'ARCHIVED' | 'FAILED';

export interface ResearchRequirements {
  domains: string[];
  languages: string[];
  platforms: string[];
  preferredExecution: string[];
  localDeploymentPreferred: boolean;
  gpuAllowed: boolean;
  paidApiAllowed: boolean;
  externalNetworkAllowed: boolean;
  licenseRequired: boolean;
  excludedProductForms: string[];
  extraConstraints: string[];
}

export interface ResearchStage {
  id: string;
  name: string;
  description: string;
  position: number;
  required: boolean;
  locked: boolean;
  source: string;
  inputs: string[];
  outputs: string[];
  toolRequirements: {
    languages: string[];
    minimumCandidates: number;
    localDeploymentPreferred: boolean;
    gpuAllowed: boolean;
    allowedProductForms: string[];
    keywords: string[];
  };
  searchStatus: string;
  candidateCount: number;
  selectedToolIds: string[];
  version: number;
}

export type SelectionRole = 'PRIMARY' | 'ALTERNATIVE' | 'OPTIONAL' | 'REQUIRED_INFRASTRUCTURE' | 'EXCLUDED';

export interface SelectedTool {
  githubNodeId: string;
  fullName: string;
  stageId: string;
  role: string;
  selectionRole: SelectionRole;
  status: string;
  acquisitionMode: string;
  notes: string;
  locked: boolean;
}

export interface WorkflowStage {
  id: string;
  name: string;
  researchStageId: string;
  toolIds: string[];
  inputs: string[];
  outputs: string[];
  manualStep: boolean;
  requiresCredentials: boolean;
  requiresUserData: boolean;
  locked: boolean;
  notes: string;
}

export interface ThemeWorkflow {
  name: string;
  description: string;
  testGoal: string;
  themeInputs: string[];
  finalOutputs: string[];
  stages: WorkflowStage[];
  connections: Array<{ from: string; to: string; mode: string; payload: string }>;
  successCriteria: string[];
  manualHandoffs: string[];
  missingStages: string[];
  duplicateTools: string[];
  source: string;
  version: number;
}

export interface ResearchState {
  schemaVersion: number;
  topicId: string;
  version: number;
  title: string;
  objective: string;
  originalRequirement: string;
  requirements: ResearchRequirements;
  stages: ResearchStage[];
  selectedTools: SelectedTool[];
  workflow: ThemeWorkflow | null;
  locks: Record<string, boolean>;
  fieldSources: Record<string, string>;
  assumptions: string[];
  unresolvedIssues: string[];
  consistencyStatus: string;
  updatedAt: string;
}

export interface ConsistencyIssue {
  code: string;
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  message: string;
  stageId?: string;
  toolId?: string;
  options?: string[];
}

export interface ResearchTopic {
  id: string;
  title: string;
  original_requirement: string;
  status: string;
  current_state_version: number;
  created_at: string;
  updated_at: string;
  state: ResearchState | null;
  consistency: { status: string; issues: ConsistencyIssue[] } | null;
  stageCount: number;
  selectedToolCount: number;
  hasWorkflow: boolean;
}

export interface ChangeProposal {
  id: string;
  topicId: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  proposal: {
    proposalId: string;
    topicId: string;
    baseVersion: number;
    userMessage: string;
    interpretation: { intent: string; summary: string; bullets: string[] };
    operations: Array<{ type: string; [key: string]: unknown }>;
    impact: {
      stagesAffected: string[];
      toolsAffected: string[];
      searchRequired: string[];
      fullSearchRequired: boolean;
      toolReclassificationRequired: boolean;
      workflowRegenerationRequired: boolean;
      forkPlanAffected: boolean;
      summaryRows: Array<{ item: string; impact: string }>;
    };
    conflicts: Array<{ code: string; severity: string; message: string; options: string[] }>;
    warnings: string[];
    assumptions: string[];
    requiresConfirmation: boolean;
  };
}

export interface CandidateView {
  id: string;
  topic_id: string;
  research_state_version: number;
  search_run_id: string | null;
  github_node_id: string;
  full_name: string;
  stage_id: string | null;
  match_level: string | null;
  match_score: number | null;
  tier: string | null;
  source_query: string | null;
  selection_status: string;
  repo: {
    fullName: string;
    htmlUrl: string;
    description: string | null;
    primaryLanguage: string | null;
    topics: string[];
    licenseSpdx: string | null;
    stars: number;
    forks: number;
    pushedAt: string | null;
    archived: boolean;
  } | null;
  analysis: {
    stageIds: string[];
    roles: string[];
    summary: string;
    roleInTheme: string;
    howUserWouldUseIt: string[];
    inputs: string[];
    outputs: string[];
    productForm: string[];
    deployment: {
      localSupported: boolean;
      dockerAvailable: boolean;
      gpuRequired: boolean;
      credentialsRequired: boolean;
      paidApiRequired: boolean;
      preferredAcquisitionMode: string;
    };
    advantages: string[];
    limitations: string[];
    maintenance: { status: string; evidence: string };
    replicationSuitability: string;
    recommendationReason: string;
  } | null;
}

export interface ToolkitRow {
  stageId: string;
  stageName: string;
  required: boolean;
  primary: { githubNodeId: string; fullName: string; role: string; acquisitionMode: string } | null;
  alternatives: Array<{ githubNodeId: string; fullName: string; role: string }>;
  coverage: '已覆盖' | '缺失' | '待确认';
  compatibility: '正常' | '待分析' | '冲突';
  compatibilityNotes: string[];
}

export interface ToolkitView {
  rows: ToolkitRow[];
  unassigned: Array<{ githubNodeId: string; fullName: string; status: string }>;
  excluded: Array<{ githubNodeId: string; fullName: string; notes: string }>;
  reminders: string[];
  gaps: string[];
  duplicates: string[];
}

export interface ThemePlanView {
  id: string;
  name: string;
  description: string | null;
  researchTopicId: string | null;
  status: string;
  localStatus: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThemeVersionView {
  id: string;
  themeId: string;
  version: number;
  researchStateVersion: number;
  objective: string;
  planJson: Record<string, unknown>;
  locked: boolean;
  createdAt: string;
  tools: Array<{ githubNodeId: string; fullName: string; role: string; acquisitionMode: string; position: number; config: Record<string, unknown> | null }>;
}

// ---------- 请求封装 ----------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!backend.backendUrl) throw new Error('需要启动本地后端以使用主题研究');
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

export const researchApi = {
  // 主题 CRUD
  createTopic: (requirement: string, title?: string) =>
    request<{ topic: ResearchTopic }>('/research/topics', { method: 'POST', body: JSON.stringify({ requirement, title }) }),
  listTopics: () => request<{ topics: ResearchTopic[] }>('/research/topics'),
  getTopic: (id: string) => request<{ topic: ResearchTopic }>(`/research/topics/${encodeURIComponent(id)}`),
  deleteTopic: (id: string) => request<{ deleted: boolean }>(`/research/topics/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  parseTopic: (id: string) => request<{ topic: ResearchTopic; source: 'ai' | 'rule' }>(`/research/topics/${encodeURIComponent(id)}/parse`, { method: 'POST', body: '{}' }),

  // 状态与版本
  getState: (id: string) => request<{ state: ResearchState; consistency: { status: string; issues: ConsistencyIssue[] } }>(`/research/topics/${encodeURIComponent(id)}/state`),
  listVersions: (id: string) => request<{ versions: Array<{ version: number; parentVersion: number | null; changeSummary: string | null; createdBy: string; createdAt: string }> }>(`/research/topics/${encodeURIComponent(id)}/versions`),
  diffVersion: (id: string, version: number) => request<{ diff: Array<{ field: string; from: string; to: string }> }>(`/research/topics/${encodeURIComponent(id)}/versions/${version}/diff`),
  restoreVersion: (id: string, version: number) => request<{ state: ResearchState }>(`/research/topics/${encodeURIComponent(id)}/versions/${version}/restore`, { method: 'POST', body: '{}' }),

  // 对话与变更提案
  createProposal: (id: string, body: { userMessage: string; pageContext?: string; origin?: 'AI_CONVERSATION' | 'MANUAL_EDIT'; operations?: Array<Record<string, unknown>> }) =>
    request<ChangeProposal>(`/research/topics/${encodeURIComponent(id)}/change-proposals`, { method: 'POST', body: JSON.stringify(body) }),
  listProposals: (id: string) => request<{ proposals: ChangeProposal[] }>(`/research/topics/${encodeURIComponent(id)}/change-proposals`),
  applyProposal: (topicId: string, proposalId: string, allowWarnings = false) =>
    request<{ state: ResearchState; consistency: { status: string; issues: ConsistencyIssue[] }; warnings: string[] }>(`/research/topics/${encodeURIComponent(topicId)}/change-proposals/${encodeURIComponent(proposalId)}/apply`, { method: 'POST', body: JSON.stringify({ allowWarnings }) }),
  rejectProposal: (topicId: string, proposalId: string) => request<{ id: string; status: string }>(`/research/topics/${encodeURIComponent(topicId)}/change-proposals/${encodeURIComponent(proposalId)}/reject`, { method: 'POST', body: '{}' }),
  manualOperations: (id: string, operations: Array<Record<string, unknown>>, summary: string) =>
    request<{ state: ResearchState; consistency: { status: string; issues: ConsistencyIssue[] } }>(`/research/topics/${encodeURIComponent(id)}/manual-operations`, { method: 'POST', body: JSON.stringify({ operations, summary }) }),

  // GitHub 搜索
  runSearch: (id: string, stageId?: string) =>
    request<{ outcome: { runId: string; status: string; queryCount: number; rawCount: number; uniqueCount: number; analyzedCount: number; excludedCount: number; rateLimitResetAt: string | null } }>(`/research/topics/${encodeURIComponent(id)}/search`, { method: 'POST', body: JSON.stringify({ stageId }) }),
  listCandidates: (id: string, params?: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    return request<{ candidates: CandidateView[] }>(`/research/topics/${encodeURIComponent(id)}/candidates${query ? `?${query}` : ''}`);
  },
  analyzeCandidate: (id: string, githubNodeId: string) =>
    request<{ candidate: CandidateView }>(`/research/topics/${encodeURIComponent(id)}/candidates/${encodeURIComponent(githubNodeId)}/analyze`, { method: 'POST', body: '{}' }),

  // 工具链
  getToolkit: (id: string) => request<{ toolkit: ToolkitView }>(`/research/topics/${encodeURIComponent(id)}/toolkit`),
  selectTool: (id: string, body: { githubNodeId: string; stageId?: string; selectionRole?: SelectionRole; acquisitionMode?: string }) =>
    request<{ state: ResearchState }>(`/research/topics/${encodeURIComponent(id)}/tools`, { method: 'POST', body: JSON.stringify(body) }),
  updateTool: (id: string, githubNodeId: string, body: { selectionRole?: SelectionRole; stageId?: string }) =>
    request<{ state: ResearchState }>(`/research/topics/${encodeURIComponent(id)}/tools/${encodeURIComponent(githubNodeId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeTool: (id: string, githubNodeId: string) =>
    request<{ state: ResearchState }>(`/research/topics/${encodeURIComponent(id)}/tools/${encodeURIComponent(githubNodeId)}`, { method: 'DELETE', body: JSON.stringify({}) }),
  findAlternatives: (id: string, githubNodeId: string) =>
    request<{ candidates: CandidateView[] }>(`/research/topics/${encodeURIComponent(id)}/tools/${encodeURIComponent(githubNodeId)}/find-alternatives`, { method: 'POST', body: JSON.stringify({}) }),
  checkCompatibility: (id: string) =>
    request<{ report: { runtimeLanguages: string[]; gaps: string[]; duplicates: string[]; conflicts: string[]; handoffs: string[] } }>(`/research/topics/${encodeURIComponent(id)}/tools/compatibility-check`, { method: 'POST', body: '{}' }),

  // 主题主线
  generateThemePlan: (id: string) =>
    request<{ workflow: ThemeWorkflow; source: 'ai' | 'rule'; model: string | null }>(`/research/topics/${encodeURIComponent(id)}/generate-theme-plan`, { method: 'POST', body: '{}' }),
  getThemePlan: (id: string) => request<{ workflow: ThemeWorkflow | null }>(`/research/topics/${encodeURIComponent(id)}/theme-plan`),

  // 保存到 Fork 实验室
  saveToForkLab: (id: string, body: { name: string; description?: string; testGoal?: string; allowAgentModification?: boolean; shouldCreateFork?: boolean; retainEnvironment?: boolean }) =>
    request<{ theme: ThemePlanView; version: ThemeVersionView }>(`/research/topics/${encodeURIComponent(id)}/save-to-fork-lab`, { method: 'POST', body: JSON.stringify(body) }),
};
