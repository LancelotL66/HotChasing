import { z } from 'zod';

/**
 * 主题研究唯一事实来源（Research State）的 Schema 与枚举。
 *
 * 设计约束（来自主题研究方案）：
 * - 主题研究是独立业务域，不引用日报 / Top100 / 热点分。
 * - 所有模块（对话、搜索、候选、工具链、主线、Fork 方案）只读取同一个 Research State。
 * - AI 只能产出结构化提案；写入必须经过 reducer 与一致性校验。
 *
 * 字段来源与锁定：为避免把每个字段都包装成 { value, valueSource, locked } 造成 Schema 膨胀，
 * 这里用路径索引的 locks / fieldSources 表达同一语义。路径约定见 statePaths.ts。
 */

export const RESEARCH_STATE_SCHEMA_VERSION = 1;

export const VALUE_SOURCES = [
  'SYSTEM_DEFAULT',
  'AI_INFERRED',
  'AI_PROPOSED',
  'USER_INPUT',
  'USER_CONFIRMED',
  'USER_MANUAL_EDIT',
] as const;

export const TOPIC_STATUSES = [
  'DRAFT',
  'PARSING',
  'READY',
  'SEARCHING',
  'REVIEWING_TOOLS',
  'BUILDING_TOOLKIT',
  'PLANNING_THEME',
  'READY_FOR_FORK_LAB',
  'ARCHIVED',
  'FAILED',
] as const;

export const CONSISTENCY_STATUSES = [
  'CONSISTENT',
  'NEEDS_RESEARCH_UPDATE',
  'NEEDS_TOOL_RECLASSIFICATION',
  'NEEDS_PARTIAL_SEARCH',
  'NEEDS_FULL_SEARCH',
  'NEEDS_WORKFLOW_UPDATE',
  'NEEDS_FORK_PLAN_VERSION',
  'CONFLICTED',
] as const;

export const STAGE_SOURCES = ['AI_GENERATED', 'USER_CREATED', 'AI_REVISED', 'USER_REVISED'] as const;

export const STAGE_SEARCH_STATUSES = ['NOT_STARTED', 'QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'RATE_LIMITED', 'FAILED'] as const;

export const SEARCH_RUN_STATUSES = ['QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'RATE_LIMITED', 'FAILED', 'CANCELLED'] as const;

/** 研究角色：相对于当前主题动态生成，不复用日报分类。 */
export const RESEARCH_ROLES = [
  'DATA_SOURCE',
  'DATA_COLLECTION',
  'DATA_PROCESSING',
  'FEATURE_ENGINEERING',
  'ANALYSIS',
  'MODELING',
  'EVALUATION',
  'EXPERIMENT_TRACKING',
  'VISUALIZATION',
  'ORCHESTRATION',
  'USER_INTERFACE',
  'STORAGE',
  'SUPPORTING_INFRASTRUCTURE',
] as const;

export const SELECTION_ROLES = ['PRIMARY', 'ALTERNATIVE', 'OPTIONAL', 'REQUIRED_INFRASTRUCTURE', 'EXCLUDED'] as const;

export const TOOL_STATUSES = [
  'ACTIVE',
  'NEEDS_RECLASSIFICATION',
  'UNASSIGNED',
  'REDUNDANT',
  'INCOMPATIBLE',
  'REMOVED_BY_USER',
] as const;

export const PRODUCT_FORMS = ['LIBRARY', 'CLI', 'SERVICE', 'DESKTOP_APP', 'WEB_APP', 'NOTEBOOK', 'DATASET', 'PLATFORM', 'MCP_SERVER'] as const;

export const ACQUISITION_MODES = ['PACKAGE', 'RELEASE', 'CLONE_UPSTREAM', 'FORK_AND_CLONE', 'EXTERNAL_SERVICE', 'MANUAL'] as const;

export const CONNECTION_MODES = [
  'LIBRARY_CALL',
  'CLI_CALL',
  'FILE_EXCHANGE',
  'HTTP_API',
  'RPC',
  'MCP',
  'DATABASE',
  'MESSAGE_QUEUE',
  'MANUAL_HANDOFF',
] as const;

export const EXECUTION_MODES = ['LOCAL', 'DOCKER', 'REMOTE_SERVICE'] as const;

export const MATCH_LEVELS = ['高度匹配', '较为匹配', '专业候选', '可选补充', '需要进一步确认', '不符合当前限制'] as const;

export const CANDIDATE_TIERS = ['FEATURED', 'MORE', 'POOL'] as const;

export const REPLICATION_SUITABILITY = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;

export type ValueSource = (typeof VALUE_SOURCES)[number];
export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export type ConsistencyStatus = (typeof CONSISTENCY_STATUSES)[number];
export type ResearchRole = (typeof RESEARCH_ROLES)[number];
export type SelectionRole = (typeof SELECTION_ROLES)[number];
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export type AcquisitionMode = (typeof ACQUISITION_MODES)[number];
export type MatchLevel = (typeof MATCH_LEVELS)[number];
export type CandidateTier = (typeof CANDIDATE_TIERS)[number];

export const researchRequirementsSchema = z.object({
  domains: z.array(z.string()).max(20).default([]),
  languages: z.array(z.string()).max(12).default([]),
  platforms: z.array(z.string()).max(8).default([]),
  preferredExecution: z.array(z.enum(EXECUTION_MODES)).max(3).default(['LOCAL']),
  localDeploymentPreferred: z.boolean().default(true),
  gpuAllowed: z.boolean().default(true),
  paidApiAllowed: z.boolean().default(true),
  externalNetworkAllowed: z.boolean().default(true),
  licenseRequired: z.boolean().default(false),
  excludedProductForms: z.array(z.enum(PRODUCT_FORMS)).max(9).default([]),
  extraConstraints: z.array(z.string()).max(20).default([]),
}).default({
  domains: [],
  languages: [],
  platforms: [],
  preferredExecution: ['LOCAL'],
  localDeploymentPreferred: true,
  gpuAllowed: true,
  paidApiAllowed: true,
  externalNetworkAllowed: true,
  licenseRequired: false,
  excludedProductForms: [],
  extraConstraints: [],
});

export const stageToolRequirementsSchema = z.object({
  languages: z.array(z.string()).max(12).default([]),
  minimumCandidates: z.number().int().min(0).max(200).default(10),
  localDeploymentPreferred: z.boolean().default(true),
  gpuAllowed: z.boolean().default(true),
  allowedProductForms: z.array(z.enum(PRODUCT_FORMS)).max(9).default([]),
  keywords: z.array(z.string()).max(20).default([]),
}).default({
  languages: [],
  minimumCandidates: 10,
  localDeploymentPreferred: true,
  gpuAllowed: true,
  allowedProductForms: [],
  keywords: [],
});

export const researchStageSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  description: z.string().max(400).default(''),
  position: z.number().int().min(0).max(200),
  required: z.boolean().default(true),
  locked: z.boolean().default(false),
  source: z.enum(STAGE_SOURCES).default('AI_GENERATED'),
  inputs: z.array(z.string()).max(12).default([]),
  outputs: z.array(z.string()).max(12).default([]),
  toolRequirements: stageToolRequirementsSchema,
  searchStatus: z.enum(STAGE_SEARCH_STATUSES).default('NOT_STARTED'),
  candidateCount: z.number().int().min(0).default(0),
  selectedToolIds: z.array(z.string()).max(40).default([]),
  version: z.number().int().min(1).default(1),
});

export const selectedToolSchema = z.object({
  githubNodeId: z.string().min(1),
  fullName: z.string().min(1),
  stageId: z.string().default(''),
  role: z.enum(RESEARCH_ROLES).default('SUPPORTING_INFRASTRUCTURE'),
  selectionRole: z.enum(SELECTION_ROLES).default('PRIMARY'),
  status: z.enum(TOOL_STATUSES).default('ACTIVE'),
  acquisitionMode: z.enum(ACQUISITION_MODES).default('CLONE_UPSTREAM'),
  notes: z.string().max(400).default(''),
  locked: z.boolean().default(false),
});

export const workflowStageSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  researchStageId: z.string().max(80).default(''),
  toolIds: z.array(z.string()).max(10).default([]),
  inputs: z.array(z.string()).max(12).default([]),
  outputs: z.array(z.string()).max(12).default([]),
  manualStep: z.boolean().default(false),
  requiresCredentials: z.boolean().default(false),
  requiresUserData: z.boolean().default(false),
  locked: z.boolean().default(false),
  notes: z.string().max(400).default(''),
});

export const workflowConnectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  mode: z.enum(CONNECTION_MODES).default('FILE_EXCHANGE'),
  payload: z.string().max(200).default(''),
});

export const themeWorkflowSchema = z.object({
  name: z.string().max(120).default(''),
  description: z.string().max(600).default(''),
  testGoal: z.string().max(600).default(''),
  themeInputs: z.array(z.string()).max(12).default([]),
  finalOutputs: z.array(z.string()).max(12).default([]),
  stages: z.array(workflowStageSchema).max(40).default([]),
  connections: z.array(workflowConnectionSchema).max(80).default([]),
  successCriteria: z.array(z.string()).max(20).default([]),
  manualHandoffs: z.array(z.string()).max(20).default([]),
  missingStages: z.array(z.string()).max(20).default([]),
  duplicateTools: z.array(z.string()).max(20).default([]),
  source: z.enum(['AI_GENERATED', 'USER_REVISED']).default('AI_GENERATED'),
  version: z.number().int().min(1).default(1),
});

export const researchStateSchema = z.object({
  schemaVersion: z.number().int().default(RESEARCH_STATE_SCHEMA_VERSION),
  topicId: z.string().min(1),
  version: z.number().int().min(1),
  title: z.string().min(1).max(120),
  objective: z.string().max(600).default(''),
  originalRequirement: z.string().default(''),
  requirements: researchRequirementsSchema,
  stages: z.array(researchStageSchema).max(40).default([]),
  selectedTools: z.array(selectedToolSchema).max(80).default([]),
  workflow: themeWorkflowSchema.nullable().default(null),
  locks: z.record(z.string(), z.boolean()).default({}),
  fieldSources: z.record(z.string(), z.enum(VALUE_SOURCES)).default({}),
  assumptions: z.array(z.string()).max(20).default([]),
  unresolvedIssues: z.array(z.string()).max(20).default([]),
  consistencyStatus: z.enum(CONSISTENCY_STATUSES).default('CONSISTENT'),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type ResearchRequirements = z.infer<typeof researchRequirementsSchema>;
export type ResearchStage = z.infer<typeof researchStageSchema>;
export type SelectedTool = z.infer<typeof selectedToolSchema>;
export type ThemeWorkflow = z.infer<typeof themeWorkflowSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type ResearchState = z.infer<typeof researchStateSchema>;

/** AI 初始解析输出：只描述需求与研究环节，不包含具体 GitHub 仓库。 */
export const initialParseSchema = z.object({
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(600),
  requirements: z.object({
    domains: z.array(z.string()).max(20).default([]),
    languages: z.array(z.string()).max(12).default([]),
    platforms: z.array(z.string()).max(8).default([]),
    localDeploymentPreferred: z.boolean().default(true),
    gpuAllowed: z.boolean().default(true),
    paidApiAllowed: z.boolean().default(true),
    externalNetworkAllowed: z.boolean().default(true),
    licenseRequired: z.boolean().default(false),
  }),
  stages: z.array(z.object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(60),
    description: z.string().max(400).default(''),
    required: z.boolean().default(true),
    inputs: z.array(z.string()).max(12).default([]),
    outputs: z.array(z.string()).max(12).default([]),
    keywords: z.array(z.string()).max(20).default([]),
  })).min(1).max(20),
  assumptions: z.array(z.string()).max(20).default([]),
  unresolvedIssues: z.array(z.string()).max(20).default([]),
});

export type InitialParseResult = z.infer<typeof initialParseSchema>;

/** ResearchToolAnalyzer 的结构化输出。 */
export const toolAnalysisSchema = z.object({
  schemaVersion: z.number().int().default(1),
  githubNodeId: z.string().default(''),
  repository: z.string().default(''),
  name: z.string().default(''),
  stageIds: z.array(z.string()).max(10).default([]),
  roles: z.array(z.enum(RESEARCH_ROLES)).max(6).default([]),
  summary: z.string().max(600).default(''),
  roleInTheme: z.string().max(600).default(''),
  howUserWouldUseIt: z.array(z.string()).max(10).default([]),
  inputs: z.array(z.string()).max(12).default([]),
  outputs: z.array(z.string()).max(12).default([]),
  productForm: z.array(z.enum(PRODUCT_FORMS)).max(4).default([]),
  deployment: z.object({
    localSupported: z.boolean().default(true),
    dockerAvailable: z.boolean().default(false),
    gpuRequired: z.boolean().default(false),
    credentialsRequired: z.boolean().default(false),
    paidApiRequired: z.boolean().default(false),
    preferredAcquisitionMode: z.enum(ACQUISITION_MODES).default('CLONE_UPSTREAM'),
  }).default({
    localSupported: true,
    dockerAvailable: false,
    gpuRequired: false,
    credentialsRequired: false,
    paidApiRequired: false,
    preferredAcquisitionMode: 'CLONE_UPSTREAM',
  }),
  advantages: z.array(z.string()).max(8).default([]),
  limitations: z.array(z.string()).max(8).default([]),
  maintenance: z.object({
    status: z.enum(['ACTIVE', 'SLOW', 'STALE', 'UNKNOWN']).default('UNKNOWN'),
    evidence: z.string().max(200).default(''),
  }).default({ status: 'UNKNOWN', evidence: '' }),
  replicationSuitability: z.enum(REPLICATION_SUITABILITY).default('UNKNOWN'),
  evidenceLevel: z.enum(['METADATA_ONLY', 'README_ONLY', 'README_AND_REPOSITORY_ANALYSIS']).default('METADATA_ONLY'),
  recommendationReason: z.string().max(400).default(''),
});

export type ToolAnalysis = z.infer<typeof toolAnalysisSchema>;
