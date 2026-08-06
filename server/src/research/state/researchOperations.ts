import { z } from 'zod';
import {
  ACQUISITION_MODES,
  CONNECTION_MODES,
  EXECUTION_MODES,
  PRODUCT_FORMS,
  RESEARCH_ROLES,
  SELECTION_ROLES,
} from './researchStateSchema.js';

/**
 * 统一变更协议：AI 对话与手动编辑都必须转换为这些结构化操作。
 * AI 不得直接写数据库；操作先进入提案，经影响分析、一致性校验与用户确认后由 reducer 应用。
 */

export const CHANGE_OPERATION_TYPES = [
  'UPDATE_OBJECTIVE',
  'UPDATE_REQUIREMENT',
  'ADD_STAGE',
  'UPDATE_STAGE',
  'DELETE_STAGE',
  'REORDER_STAGE',
  'SPLIT_STAGE',
  'MERGE_STAGES',
  'LOCK_FIELD',
  'UNLOCK_FIELD',
  'MARK_STAGE_REQUIRED',
  'MARK_STAGE_OPTIONAL',
  'ADD_TOOL_CONSTRAINT',
  'REMOVE_TOOL_CONSTRAINT',
  'SELECT_TOOL',
  'REMOVE_TOOL',
  'CHANGE_PRIMARY_TOOL',
  'ADD_ALTERNATIVE_TOOL',
  'REPLACE_TOOL',
  'UPDATE_WORKFLOW',
  'UPDATE_TEST_SCOPE',
] as const;

export type ChangeOperationType = (typeof CHANGE_OPERATION_TYPES)[number];

const requirementPatchSchema = z.object({
  domains: z.array(z.string()).max(20).optional(),
  languages: z.array(z.string()).max(12).optional(),
  platforms: z.array(z.string()).max(8).optional(),
  preferredExecution: z.array(z.enum(EXECUTION_MODES)).max(3).optional(),
  localDeploymentPreferred: z.boolean().optional(),
  gpuAllowed: z.boolean().optional(),
  paidApiAllowed: z.boolean().optional(),
  externalNetworkAllowed: z.boolean().optional(),
  licenseRequired: z.boolean().optional(),
  excludedProductForms: z.array(z.enum(PRODUCT_FORMS)).max(9).optional(),
  extraConstraints: z.array(z.string()).max(20).optional(),
});

const toolConstraintSchema = z.object({
  languages: z.array(z.string()).max(12).optional(),
  minimumCandidates: z.number().int().min(0).max(200).optional(),
  localDeploymentPreferred: z.boolean().optional(),
  gpuAllowed: z.boolean().optional(),
  allowedProductForms: z.array(z.enum(PRODUCT_FORMS)).max(9).optional(),
  keywords: z.array(z.string()).max(20).optional(),
});

const workflowPatchSchema = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(600).optional(),
  testGoal: z.string().max(600).optional(),
  themeInputs: z.array(z.string()).max(12).optional(),
  finalOutputs: z.array(z.string()).max(12).optional(),
  stageOrder: z.array(z.string()).max(40).optional(),
  removeStageIds: z.array(z.string()).max(40).optional(),
  successCriteria: z.array(z.string()).max(20).optional(),
  connections: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    mode: z.enum(CONNECTION_MODES).default('FILE_EXCHANGE'),
    payload: z.string().max(200).default(''),
  })).max(80).optional(),
  stagePatches: z.array(z.object({
    id: z.string().min(1),
    name: z.string().max(60).optional(),
    toolIds: z.array(z.string()).max(10).optional(),
    inputs: z.array(z.string()).max(12).optional(),
    outputs: z.array(z.string()).max(12).optional(),
    manualStep: z.boolean().optional(),
    locked: z.boolean().optional(),
    notes: z.string().max(400).optional(),
  })).max(40).optional(),
});

export const changeOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('UPDATE_OBJECTIVE'), objective: z.string().min(1).max(600), title: z.string().max(120).optional() }),
  z.object({ type: z.literal('UPDATE_REQUIREMENT'), patch: requirementPatchSchema }),
  z.object({
    type: z.literal('ADD_STAGE'),
    temporaryId: z.string().max(80).optional(),
    name: z.string().min(1).max(60),
    description: z.string().max(400).default(''),
    required: z.boolean().default(true),
    inputs: z.array(z.string()).max(12).default([]),
    outputs: z.array(z.string()).max(12).default([]),
    keywords: z.array(z.string()).max(20).default([]),
    positionAfter: z.string().max(80).optional(),
    positionBefore: z.string().max(80).optional(),
  }),
  z.object({
    type: z.literal('UPDATE_STAGE'),
    stageId: z.string().min(1),
    name: z.string().max(60).optional(),
    description: z.string().max(400).optional(),
    inputs: z.array(z.string()).max(12).optional(),
    outputs: z.array(z.string()).max(12).optional(),
  }),
  z.object({ type: z.literal('DELETE_STAGE'), stageId: z.string().min(1) }),
  z.object({ type: z.literal('REORDER_STAGE'), stageOrder: z.array(z.string()).min(1).max(40) }),
  z.object({
    type: z.literal('SPLIT_STAGE'),
    stageId: z.string().min(1),
    parts: z.array(z.object({
      name: z.string().min(1).max(60),
      description: z.string().max(400).default(''),
      keywords: z.array(z.string()).max(20).default([]),
    })).min(2).max(5),
  }),
  z.object({ type: z.literal('MERGE_STAGES'), stageIds: z.array(z.string()).min(2).max(6), name: z.string().max(60).optional() }),
  z.object({ type: z.literal('LOCK_FIELD'), path: z.string().min(1).max(160) }),
  z.object({ type: z.literal('UNLOCK_FIELD'), path: z.string().min(1).max(160) }),
  z.object({ type: z.literal('MARK_STAGE_REQUIRED'), stageId: z.string().min(1) }),
  z.object({ type: z.literal('MARK_STAGE_OPTIONAL'), stageId: z.string().min(1) }),
  z.object({ type: z.literal('ADD_TOOL_CONSTRAINT'), stageId: z.string().min(1), constraint: toolConstraintSchema }),
  z.object({ type: z.literal('REMOVE_TOOL_CONSTRAINT'), stageId: z.string().min(1), fields: z.array(z.string()).min(1).max(8) }),
  z.object({
    type: z.literal('SELECT_TOOL'),
    githubNodeId: z.string().min(1),
    fullName: z.string().min(1),
    stageId: z.string().min(1),
    role: z.enum(RESEARCH_ROLES).optional(),
    selectionRole: z.enum(SELECTION_ROLES).default('PRIMARY'),
    acquisitionMode: z.enum(ACQUISITION_MODES).optional(),
    notes: z.string().max(400).default(''),
  }),
  z.object({ type: z.literal('REMOVE_TOOL'), githubNodeId: z.string().min(1), reason: z.string().max(200).default('') }),
  z.object({ type: z.literal('CHANGE_PRIMARY_TOOL'), stageId: z.string().min(1), githubNodeId: z.string().min(1) }),
  z.object({
    type: z.literal('ADD_ALTERNATIVE_TOOL'),
    githubNodeId: z.string().min(1),
    fullName: z.string().min(1),
    stageId: z.string().min(1),
    role: z.enum(RESEARCH_ROLES).optional(),
    acquisitionMode: z.enum(ACQUISITION_MODES).optional(),
  }),
  z.object({
    type: z.literal('REPLACE_TOOL'),
    githubNodeId: z.string().min(1),
    replacementGithubNodeId: z.string().min(1),
    replacementFullName: z.string().min(1),
    stageId: z.string().max(80).optional(),
    role: z.enum(RESEARCH_ROLES).optional(),
    acquisitionMode: z.enum(ACQUISITION_MODES).optional(),
  }),
  z.object({ type: z.literal('UPDATE_WORKFLOW'), patch: workflowPatchSchema }),
  z.object({ type: z.literal('UPDATE_TEST_SCOPE'), testGoal: z.string().max(600).optional(), successCriteria: z.array(z.string()).max(20).optional() }),
]);

export type ChangeOperation = z.infer<typeof changeOperationSchema>;

export const CHANGE_INTENTS = [
  'ADJUST_RESEARCH_OBJECTIVE',
  'ADJUST_RESEARCH_STAGES',
  'ADJUST_CONSTRAINTS',
  'ADJUST_TOOLS',
  'ADJUST_WORKFLOW',
  'ADJUST_TEST_SCOPE',
  'MIXED',
  'UNKNOWN',
] as const;

export const PROPOSAL_STATUSES = [
  'DRAFT',
  'ANALYZING',
  'NEEDS_CLARIFICATION',
  'READY_FOR_CONFIRMATION',
  'APPLYING',
  'APPLIED',
  'REJECTED',
  'CONFLICTED',
  'FAILED',
] as const;

export const changeImpactSchema = z.object({
  stagesAffected: z.array(z.string()).default([]),
  toolsAffected: z.array(z.string()).default([]),
  searchRequired: z.array(z.string()).default([]),
  fullSearchRequired: z.boolean().default(false),
  toolReclassificationRequired: z.boolean().default(false),
  workflowRegenerationRequired: z.boolean().default(false),
  forkPlanAffected: z.boolean().default(false),
  summaryRows: z.array(z.object({ item: z.string(), impact: z.string() })).default([]),
}).default({
  stagesAffected: [],
  toolsAffected: [],
  searchRequired: [],
  fullSearchRequired: false,
  toolReclassificationRequired: false,
  workflowRegenerationRequired: false,
  forkPlanAffected: false,
  summaryRows: [],
});

export const changeConflictSchema = z.object({
  code: z.string(),
  severity: z.enum(['BLOCKING', 'WARNING']),
  message: z.string(),
  options: z.array(z.string()).default([]),
});

export const changeProposalSchema = z.object({
  schemaVersion: z.number().int().default(1),
  proposalId: z.string().min(1),
  topicId: z.string().min(1),
  baseVersion: z.number().int().min(1),
  userMessage: z.string().default(''),
  origin: z.enum(['AI_CONVERSATION', 'MANUAL_EDIT']).default('AI_CONVERSATION'),
  interpretation: z.object({
    intent: z.enum(CHANGE_INTENTS).default('UNKNOWN'),
    summary: z.string().max(600).default(''),
    bullets: z.array(z.string()).max(12).default([]),
  }),
  operations: z.array(changeOperationSchema).max(30).default([]),
  impact: changeImpactSchema,
  conflicts: z.array(changeConflictSchema).max(20).default([]),
  warnings: z.array(z.string()).max(20).default([]),
  assumptions: z.array(z.string()).max(20).default([]),
  requiresConfirmation: z.boolean().default(true),
  source: z.enum(['ai', 'rule']).default('rule'),
});

export type ChangeProposal = z.infer<typeof changeProposalSchema>;
export type ChangeImpact = z.infer<typeof changeImpactSchema>;
export type ChangeConflict = z.infer<typeof changeConflictSchema>;

/** AI 解释器输出（不含 proposalId / topicId 等由后端补全的字段）。 */
export const interpretationOutputSchema = z.object({
  intent: z.enum(CHANGE_INTENTS).default('UNKNOWN'),
  summary: z.string().max(600).default(''),
  bullets: z.array(z.string()).max(12).default([]),
  operations: z.array(changeOperationSchema).max(30).default([]),
  assumptions: z.array(z.string()).max(20).default([]),
  warnings: z.array(z.string()).max(20).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().max(300).default(''),
});

export type InterpretationOutput = z.infer<typeof interpretationOutputSchema>;
