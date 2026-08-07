import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import {
  changeProposalSchema,
  changeOperationSchema,
  type ChangeConflict,
  type ChangeOperation,
  type ChangeProposal,
} from '../state/researchOperations.js';
import { requireCurrentState } from '../state/researchStateService.js';
import { applyOperations } from '../state/researchStateReducer.js';
import { validateResearchState } from '../state/researchConsistencyValidator.js';
import { applyAndSave, type ApplyResult } from '../state/researchStateWriter.js';
import { buildToolFacts } from '../analysis/researchToolFacts.js';
import { interpretUserMessage } from './researchChangeInterpreter.js';
import { analyzeImpact } from './researchImpactAnalyzer.js';
import { setTopicStatus } from '../state/researchTopicService.js';

/**
 * Research Change Proposal 生命周期。
 *
 * AI 不得直接修改数据库：
 * 用户消息 → AI 解释 → 提案 → 一致性检查 → 影响分析 → 修改预览 → 用户确认 → Reducer → 新版本。
 */

export interface ProposalRow {
  id: string;
  topic_id: string;
  base_version: number;
  user_message: string | null;
  proposal_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface ProposalView {
  id: string;
  topicId: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  proposal: ChangeProposal;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function toView(row: ProposalRow): ProposalView {
  return {
    id: row.id,
    topicId: row.topic_id,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    proposal: changeProposalSchema.parse(JSON.parse(row.proposal_json)),
  };
}

function saveProposal(proposal: ChangeProposal, status: string): ProposalView {
  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO research_change_proposals (id, topic_id, base_version, user_message, proposal_json, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(proposal.proposalId, proposal.topicId, proposal.baseVersion, proposal.userMessage, JSON.stringify(proposal), status, now);
  return { id: proposal.proposalId, topicId: proposal.topicId, status, createdAt: now, resolvedAt: null, proposal };
}

function updateProposalRow(proposalId: string, proposal: ChangeProposal, status: string, resolved = false): ProposalView {
  const db = getDb();
  db.prepare('UPDATE research_change_proposals SET proposal_json=?, status=?, resolved_at=? WHERE id=?')
    .run(JSON.stringify(proposal), status, resolved ? new Date().toISOString() : null, proposalId);
  return requireProposal(proposalId);
}

export function getProposal(proposalId: string): ProposalView | null {
  const row = getDb().prepare('SELECT * FROM research_change_proposals WHERE id=?').get(proposalId) as ProposalRow | undefined;
  return row ? toView(row) : null;
}

export function requireProposal(proposalId: string): ProposalView {
  const view = getProposal(proposalId);
  if (!view) throw codedError('RESEARCH_PROPOSAL_NOT_FOUND', '变更提案不存在');
  return view;
}

export function listProposals(topicId: string, limit = 30): ProposalView[] {
  const rows = getDb()
    .prepare('SELECT * FROM research_change_proposals WHERE topic_id=? ORDER BY created_at DESC')
    .all(topicId) as ProposalRow[];
  return rows.slice(0, limit).map(toView);
}

/** 干跑：用 reducer + validator 预测冲突，不写库。 */
export function dryRun(topicId: string, operations: ChangeOperation[]): { conflicts: ChangeConflict[]; warnings: string[] } {
  const current = requireCurrentState(topicId);
  const reduced = applyOperations(current, operations, 'AI_PROPOSED');
  const consistency = validateResearchState(reduced.state, buildToolFacts(topicId));
  const conflicts: ChangeConflict[] = [];
  for (const rejected of reduced.rejectedOperations) {
    conflicts.push({ code: 'OPERATION_REJECTED', severity: 'BLOCKING', message: rejected.reason, options: ['解锁该字段后重试', '修改理解', '取消'] });
  }
  for (const issue of consistency.issues) {
    if (issue.severity === 'INFO') continue;
    conflicts.push({
      code: issue.code,
      severity: issue.severity === 'BLOCKING' ? 'BLOCKING' : 'WARNING',
      message: issue.message,
      options: issue.options ?? [],
    });
  }
  return { conflicts, warnings: reduced.warnings };
}

export interface CreateProposalInput {
  userMessage: string;
  pageContext?: string;
  origin?: 'AI_CONVERSATION' | 'MANUAL_EDIT';
  operations?: ChangeOperation[];
}

/**
 * 创建提案。origin=MANUAL_EDIT 时直接使用调用方给出的结构化操作（手动编辑也走同一协议）。
 */
export async function createProposal(topicId: string, input: CreateProposalInput): Promise<ProposalView> {
  const state = requireCurrentState(topicId);
  let operations: ChangeOperation[] = [];
  let interpretation = { intent: 'UNKNOWN' as ChangeProposal['interpretation']['intent'], summary: '', bullets: [] as string[] };
  let assumptions: string[] = [];
  let warnings: string[] = [];
  let needsClarification = false;
  let clarificationQuestion = '';
  let source: 'ai' | 'rule' = 'rule';

  if (input.origin === 'MANUAL_EDIT') {
    operations = (input.operations ?? []).map((operation) => changeOperationSchema.parse(operation));
    if (operations.length === 0) throw codedError('INVALID_OPERATIONS', '手动编辑必须提供至少一个结构化操作');
    interpretation = {
      intent: operations.length > 1 ? 'MIXED' : 'ADJUST_RESEARCH_STAGES',
      summary: input.userMessage || '手动编辑',
      bullets: operations.map((operation) => operation.type),
    };
  } else {
    const result = await interpretUserMessage(state, input.userMessage, input.pageContext ?? '');
    operations = result.output.operations;
    interpretation = { intent: result.output.intent, summary: result.output.summary, bullets: result.output.bullets };
    assumptions = result.output.assumptions;
    warnings = result.output.warnings;
    needsClarification = result.output.needsClarification;
    clarificationQuestion = result.output.clarificationQuestion;
    source = result.source;
  }

  const { conflicts, warnings: reducerWarnings } = operations.length > 0
    ? dryRun(topicId, operations)
    : { conflicts: [] as ChangeConflict[], warnings: [] as string[] };
  const impact = analyzeImpact(state, operations);

  const proposal = changeProposalSchema.parse({
    proposalId: `proposal-${randomUUID().slice(0, 8)}`,
    topicId,
    baseVersion: state.version,
    userMessage: input.userMessage,
    origin: input.origin ?? 'AI_CONVERSATION',
    interpretation,
    operations,
    impact,
    conflicts,
    warnings: [...warnings, ...reducerWarnings, ...(clarificationQuestion ? [clarificationQuestion] : [])],
    assumptions,
    requiresConfirmation: true,
    source,
  });

  const status = needsClarification || operations.length === 0
    ? 'NEEDS_CLARIFICATION'
    : conflicts.some((conflict) => conflict.severity === 'BLOCKING')
      ? 'CONFLICTED'
      : 'READY_FOR_CONFIRMATION';
  return saveProposal(proposal, status);
}

/** 重新计算影响与冲突（状态在提案创建后被其他操作改动时使用）。 */
export function reanalyzeProposal(proposalId: string): ProposalView {
  const view = requireProposal(proposalId);
  const state = requireCurrentState(view.topicId);
  const { conflicts, warnings } = view.proposal.operations.length > 0
    ? dryRun(view.topicId, view.proposal.operations)
    : { conflicts: [] as ChangeConflict[], warnings: [] as string[] };
  const proposal = changeProposalSchema.parse({
    ...view.proposal,
    baseVersion: state.version,
    impact: analyzeImpact(state, view.proposal.operations),
    conflicts,
    warnings: [...new Set([...view.proposal.warnings, ...warnings])],
  });
  const status = view.proposal.operations.length === 0
    ? 'NEEDS_CLARIFICATION'
    : conflicts.some((conflict) => conflict.severity === 'BLOCKING')
      ? 'CONFLICTED'
      : 'READY_FOR_CONFIRMATION';
  return updateProposalRow(proposalId, proposal, status);
}

export interface UpdateProposalInput {
  operations?: ChangeOperation[];
  removeOperationIndexes?: number[];
  interpretationSummary?: string;
}

/** 用户「修改理解」或「保留某个工具」时编辑提案内容，仍需再次确认。 */
export function updateProposal(proposalId: string, input: UpdateProposalInput): ProposalView {
  const view = requireProposal(proposalId);
  if (view.status === 'APPLIED') throw codedError('RESEARCH_PROPOSAL_APPLIED', '提案已应用，无法修改');
  let operations = view.proposal.operations;
  if (input.operations) operations = input.operations.map((operation) => changeOperationSchema.parse(operation));
  if (input.removeOperationIndexes?.length) {
    const remove = new Set(input.removeOperationIndexes);
    operations = operations.filter((_, index) => !remove.has(index));
  }
  const state = requireCurrentState(view.topicId);
  const { conflicts, warnings } = operations.length > 0 ? dryRun(view.topicId, operations) : { conflicts: [] as ChangeConflict[], warnings: [] as string[] };
  const proposal = changeProposalSchema.parse({
    ...view.proposal,
    operations,
    interpretation: {
      ...view.proposal.interpretation,
      summary: input.interpretationSummary ?? view.proposal.interpretation.summary,
    },
    impact: analyzeImpact(state, operations),
    conflicts,
    warnings: [...new Set([...view.proposal.warnings, ...warnings])],
  });
  const status = operations.length === 0
    ? 'NEEDS_CLARIFICATION'
    : conflicts.some((conflict) => conflict.severity === 'BLOCKING')
      ? 'CONFLICTED'
      : 'READY_FOR_CONFIRMATION';
  return updateProposalRow(proposalId, proposal, status);
}

export interface ApplyProposalResult extends ApplyResult {
  proposal: ProposalView;
}

/**
 * 用户确认后应用。allowConflicts 为 true 时只跳过警告级冲突；
 * BLOCKING 冲突必须先解决（例如替换工具或放宽约束）。
 */
export function applyProposal(proposalId: string, options: { allowWarnings?: boolean } = {}): ApplyProposalResult {
  const view = requireProposal(proposalId);
  if (view.status === 'APPLIED') throw codedError('RESEARCH_PROPOSAL_APPLIED', '提案已应用');
  if (view.status === 'REJECTED') throw codedError('RESEARCH_PROPOSAL_REJECTED', '提案已被拒绝');
  if (view.proposal.operations.length === 0) throw codedError('RESEARCH_PROPOSAL_EMPTY', '提案没有可应用的操作');
  const state = requireCurrentState(view.topicId);
  if (state.version !== view.proposal.baseVersion) {
    updateProposalRow(proposalId, view.proposal, 'CONFLICTED');
    throw codedError('RESEARCH_PROPOSAL_STALE', `提案基于版本 v${view.proposal.baseVersion}，当前已是 v${state.version}，请重新分析后再确认`);
  }
  const { conflicts } = dryRun(view.topicId, view.proposal.operations);
  const blocking = conflicts.filter((conflict) => conflict.severity === 'BLOCKING');
  if (blocking.length > 0) {
    updateProposalRow(proposalId, { ...view.proposal, conflicts }, 'CONFLICTED');
    throw codedError('RESEARCH_PROPOSAL_CONFLICTED', `存在需要先处理的冲突：${blocking.map((conflict) => conflict.message).join('；')}`);
  }
  if (!options.allowWarnings && conflicts.length > 0 && view.proposal.conflicts.length === 0) {
    // 首次发现新的警告时回写，让用户在预览中看到再确认。
    updateProposalRow(proposalId, { ...view.proposal, conflicts }, 'READY_FOR_CONFIRMATION');
  }
  updateProposalRow(proposalId, view.proposal, 'APPLYING');
  try {
    const result = applyAndSave(view.topicId, view.proposal.operations, {
      actor: 'USER_CONFIRMED',
      summary: view.proposal.interpretation.summary || '应用变更提案',
      proposalId,
    });
    const proposal = updateProposalRow(proposalId, view.proposal, 'APPLIED', true);
    if (result.consistency.status === 'NEEDS_PARTIAL_SEARCH' || result.consistency.status === 'NEEDS_FULL_SEARCH') {
      setTopicStatus(view.topicId, 'READY');
    }
    return { ...result, proposal };
  } catch (error) {
    updateProposalRow(proposalId, view.proposal, 'FAILED');
    throw error;
  }
}

export function rejectProposal(proposalId: string): ProposalView {
  const view = requireProposal(proposalId);
  if (view.status === 'APPLIED') throw codedError('RESEARCH_PROPOSAL_APPLIED', '提案已应用，无法拒绝');
  return updateProposalRow(proposalId, view.proposal, 'REJECTED', true);
}
