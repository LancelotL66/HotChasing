import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  createTopic,
  deleteTopic,
  listTopics,
  parseTopic,
  requireTopic,
  updateTopic,
  setTopicStatus,
} from '../research/state/researchTopicService.js';
import {
  getCurrentState,
  getStateVersion,
  listVersions,
  restoreVersion,
  diffStates,
} from '../research/state/researchStateService.js';
import { validateResearchState } from '../research/state/researchConsistencyValidator.js';
import { buildToolFacts } from '../research/analysis/researchToolFacts.js';
import { applyAndSave } from '../research/state/researchStateWriter.js';
import { changeOperationSchema } from '../research/state/researchOperations.js';
import { RESEARCH_ROLES } from '../research/state/researchStateSchema.js';
import {
  createProposal,
  listProposals,
  requireProposal,
  updateProposal,
  reanalyzeProposal,
  applyProposal,
  rejectProposal,
} from '../research/conversation/researchChangeProposalService.js';
import {
  analyzeCandidate,
  getSearchRun,
  listCandidates,
  listSearchRuns,
  runSearch,
} from '../research/github/researchSearchService.js';
import {
  checkCompatibility,
  findAlternatives,
  getToolkit,
  removeTool,
  selectTool,
  updateTool,
} from '../research/toolkit/researchToolkitService.js';
import {
  generateThemePlan,
  saveThemePlan as saveThemePlanToState,
} from '../research/theme/themePlanGenerator.js';
import { themeWorkflowSchema } from '../research/state/researchStateSchema.js';
import {
  deleteTheme,
  getTheme,
  getThemeVersion,
  listThemeVersions,
  listThemes,
  lockThemeVersion,
  saveThemePlan,
} from '../research/theme/themePlanVersionService.js';

const router = Router();

function handleError(res: Response, error: unknown) {
  const err = error as Error & { code?: string };
  const map: Record<string, number> = {
    RESEARCH_TOPIC_NOT_FOUND: 404,
    RESEARCH_STATE_NOT_FOUND: 404,
    RESEARCH_VERSION_NOT_FOUND: 404,
    RESEARCH_PROPOSAL_NOT_FOUND: 404,
    RESEARCH_CANDIDATE_NOT_FOUND: 404,
    RESEARCH_REPOSITORY_NOT_CACHED: 409,
    RESEARCH_TOOL_NOT_FOUND: 404,
    RESEARCH_STAGE_NOT_FOUND: 404,
    THEME_NOT_FOUND: 404,
    THEME_VERSION_NOT_FOUND: 404,
    RESEARCH_PROPOSAL_APPLIED: 409,
    RESEARCH_PROPOSAL_REJECTED: 409,
    RESEARCH_PROPOSAL_EMPTY: 409,
    RESEARCH_PROPOSAL_STALE: 409,
    RESEARCH_PROPOSAL_CONFLICTED: 409,
    NO_RESEARCH_STAGE: 409,
    NO_TOOLS_SELECTED: 409,
    NO_THEME_WORKFLOW: 409,
    INVALID_REQUIREMENT: 400,
    INVALID_OPERATIONS: 400,
    THEME_NAME_REQUIRED: 400,
  };
  const status = map[err.code ?? ''] ?? 502;
  return res.status(status).json({ error: err.message || '研究模块操作失败', code: err.code ?? 'RESEARCH_FAILED' });
}

// ---------------------------------------------------------------------------
// 主题 CRUD
// ---------------------------------------------------------------------------

const createTopicSchema = z.object({
  requirement: z.string().min(1),
  title: z.string().max(60).optional(),
});

router.post('/api/research/topics', (req, res) => {
  const parsed = createTopicSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid research topic request', code: 'INVALID_REQUEST' });
  try {
    res.status(201).json({ topic: createTopic(parsed.data.requirement, parsed.data.title) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics', (_req, res) => {
  try {
    res.json({ topics: listTopics() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id', (req, res) => {
  try {
    res.json({ topic: requireTopic(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

const updateTopicSchema = z.object({
  title: z.string().max(60).optional(),
  status: z.enum(['DRAFT', 'PARSING', 'READY', 'SEARCHING', 'REVIEWING_TOOLS', 'BUILDING_TOOLKIT', 'PLANNING_THEME', 'READY_FOR_FORK_LAB', 'ARCHIVED', 'FAILED']).optional(),
});

router.patch('/api/research/topics/:id', (req, res) => {
  const parsed = updateTopicSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid topic update', code: 'INVALID_REQUEST' });
  try {
    res.json({ topic: updateTopic(req.params.id, parsed.data) });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/api/research/topics/:id', (req, res) => {
  try {
    deleteTopic(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// 初始解析 / 状态 / 版本
// ---------------------------------------------------------------------------

router.post('/api/research/topics/:id/parse', async (req, res) => {
  try {
    const result = await parseTopic(req.params.id);
    res.json({ topic: result.topic, source: result.source });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/state', (req, res) => {
  try {
    const state = getCurrentState(req.params.id);
    if (!state) return res.status(404).json({ error: '未找到研究状态', code: 'RESEARCH_STATE_NOT_FOUND' });
    res.json({ state, consistency: validateResearchState(state, buildToolFacts(req.params.id)) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/versions', (req, res) => {
  try {
    res.json({ versions: listVersions(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/versions/:version', (req, res) => {
  try {
    const state = getStateVersion(req.params.id, Number(req.params.version));
    if (!state) return res.status(404).json({ error: '版本不存在', code: 'RESEARCH_VERSION_NOT_FOUND' });
    res.json({ state });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/versions/:version/diff', (req, res) => {
  try {
    const base = getCurrentState(req.params.id);
    const target = getStateVersion(req.params.id, Number(req.params.version));
    if (!base || !target) return res.status(404).json({ error: '版本不存在', code: 'RESEARCH_VERSION_NOT_FOUND' });
    res.json({ diff: diffStates(target, base) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/versions/:version/restore', (req, res) => {
  try {
    const state = restoreVersion(req.params.id, Number(req.params.version));
    res.json({ state });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// 对话与变更提案
// ---------------------------------------------------------------------------

const proposalBodySchema = z.object({
  userMessage: z.string().min(1).max(4000),
  pageContext: z.string().max(500).optional(),
  origin: z.enum(['AI_CONVERSATION', 'MANUAL_EDIT']).optional(),
  operations: z.array(z.unknown()).optional(),
});

router.post('/api/research/topics/:id/change-proposals', async (req, res) => {
  const parsed = proposalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid proposal request', code: 'INVALID_REQUEST' });
  try {
    const operations = parsed.data.origin === 'MANUAL_EDIT'
      ? parsed.data.operations?.map((operation) => changeOperationSchema.parse(operation))
      : undefined;
    if (parsed.data.origin === 'MANUAL_EDIT' && (!operations || operations.length === 0)) {
      return res.status(400).json({ error: '手动编辑必须提供至少一个操作', code: 'INVALID_OPERATIONS' });
    }
    const proposal = await createProposal(req.params.id, {
      userMessage: parsed.data.userMessage,
      pageContext: parsed.data.pageContext,
      origin: parsed.data.origin,
      operations,
    });
    res.status(201).json(proposal);
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/change-proposals', (req, res) => {
  try {
    res.json({ proposals: listProposals(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/change-proposals/:proposalId', (req, res) => {
  try {
    res.json(requireProposal(req.params.proposalId));
  } catch (error) {
    handleError(res, error);
  }
});

const updateProposalBodySchema = z.object({
  operations: z.array(z.unknown()).optional(),
  removeOperationIndexes: z.array(z.number().int().min(0)).optional(),
  interpretationSummary: z.string().max(600).optional(),
});

router.patch('/api/research/topics/:id/change-proposals/:proposalId', (req, res) => {
  const parsed = updateProposalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid proposal update', code: 'INVALID_REQUEST' });
  try {
    res.json(updateProposal(req.params.proposalId, {
      operations: parsed.data.operations?.map((operation) => changeOperationSchema.parse(operation)),
      removeOperationIndexes: parsed.data.removeOperationIndexes,
      interpretationSummary: parsed.data.interpretationSummary,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/change-proposals/:proposalId/analyze-impact', (req, res) => {
  try {
    res.json(reanalyzeProposal(req.params.proposalId));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/change-proposals/:proposalId/apply', (req, res) => {
  try {
    const result = applyProposal(req.params.proposalId, { allowWarnings: Boolean((req.body ?? {}).allowWarnings) });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/change-proposals/:proposalId/reject', (req, res) => {
  try {
    res.json(rejectProposal(req.params.proposalId));
  } catch (error) {
    handleError(res, error);
  }
});

// 手动编辑辅助入口：应用结构化操作（不经过自然语言解释，但同样经一致性校验与用户确认）。
const manualOpsSchema = z.object({
  operations: z.array(z.unknown()).min(1),
  summary: z.string().max(300).default('手动编辑'),
});

router.post('/api/research/topics/:id/manual-operations', (req, res) => {
  const parsed = manualOpsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid operations', code: 'INVALID_OPERATIONS' });
  try {
    const operations = parsed.data.operations.map((operation) => changeOperationSchema.parse(operation));
    const result = applyAndSave(req.params.id, operations, { actor: 'USER_MANUAL_EDIT', summary: parsed.data.summary });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GitHub 搜索
// ---------------------------------------------------------------------------

const searchBodySchema = z.object({ stageId: z.string().optional() });

router.post('/api/research/topics/:id/search', async (req, res) => {
  const parsed = searchBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid search request', code: 'INVALID_REQUEST' });
  try {
    const outcome = await runSearch(req.params.id, parsed.data.stageId);
    res.json({ outcome });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/search-runs', (req, res) => {
  try {
    res.json({ runs: listSearchRuns(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/search-runs/:runId', (req, res) => {
  try {
    const run = getSearchRun(req.params.runId);
    if (!run) return res.status(404).json({ error: '搜索运行不存在', code: 'RESEARCH_RUN_NOT_FOUND' });
    res.json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

const candidatesQuerySchema = z.object({
  stageId: z.string().optional(),
  tier: z.string().optional(),
  language: z.string().optional(),
  productForm: z.string().optional(),
  localOnly: z.enum(['true', 'false']).optional(),
  dockerOnly: z.enum(['true', 'false']).optional(),
  excludeGpu: z.enum(['true', 'false']).optional(),
  excludeCredentials: z.enum(['true', 'false']).optional(),
  maintenance: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/api/research/topics/:id/candidates', (req, res) => {
  const parsed = candidatesQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid candidate filters', code: 'INVALID_FILTERS' });
  try {
    const q = parsed.data;
    res.json({
      candidates: listCandidates(req.params.id, {
        stageId: q.stageId,
        tier: q.tier,
        language: q.language,
        productForm: q.productForm,
        localOnly: q.localOnly === 'true',
        dockerOnly: q.dockerOnly === 'true',
        excludeGpu: q.excludeGpu === 'true',
        excludeCredentials: q.excludeCredentials === 'true',
        maintenance: q.maintenance,
        limit: q.limit,
      }),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/candidates/:githubNodeId/analyze', async (req, res) => {
  try {
    res.json({ candidate: await analyzeCandidate(req.params.id, req.params.githubNodeId) });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// 工具链
// ---------------------------------------------------------------------------

router.get('/api/research/topics/:id/toolkit', (req, res) => {
  try {
    res.json({ toolkit: getToolkit(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

const selectToolSchema = z.object({
  githubNodeId: z.string().min(1),
  stageId: z.string().optional(),
  selectionRole: z.enum(['PRIMARY', 'ALTERNATIVE', 'OPTIONAL', 'REQUIRED_INFRASTRUCTURE', 'EXCLUDED']).optional(),
  role: z.enum(RESEARCH_ROLES).optional(),
  acquisitionMode: z.enum(['PACKAGE', 'RELEASE', 'CLONE_UPSTREAM', 'FORK_AND_CLONE', 'EXTERNAL_SERVICE', 'MANUAL']).optional(),
  notes: z.string().max(400).optional(),
});

router.post('/api/research/topics/:id/tools', (req, res) => {
  const parsed = selectToolSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tool selection', code: 'INVALID_REQUEST' });
  try {
    res.json(selectTool(req.params.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
});

const updateToolSchema = selectToolSchema.partial().extend({});

router.patch('/api/research/topics/:id/tools/:githubNodeId', (req, res) => {
  const parsed = updateToolSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tool update', code: 'INVALID_REQUEST' });
  try {
    res.json(updateTool(req.params.id, req.params.githubNodeId, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/api/research/topics/:id/tools/:githubNodeId', (req, res) => {
  try {
    const reason = (req.body ?? {}).reason ? String((req.body ?? {}).reason) : '';
    res.json(removeTool(req.params.id, req.params.githubNodeId, reason));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/tools/:githubNodeId/find-alternatives', (req, res) => {
  try {
    const limit = Number((req.body ?? {}).limit) || 8;
    res.json({ candidates: findAlternatives(req.params.id, req.params.githubNodeId, limit) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/topics/:id/tools/compatibility-check', (req, res) => {
  try {
    res.json({ report: checkCompatibility(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// 主题主线
// ---------------------------------------------------------------------------

router.post('/api/research/topics/:id/generate-theme-plan', async (req, res) => {
  try {
    const result = await generateThemePlan(req.params.id);
    const saved = saveThemePlanToState(req.params.id, result.workflow, result.source === 'ai' ? 'AI 生成主题主线' : '规则生成主题主线');
    res.json({ workflow: saved, source: result.source, model: result.model });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/topics/:id/theme-plan', (req, res) => {
  try {
    const state = getCurrentState(req.params.id);
    if (!state) return res.status(404).json({ error: '未找到研究状态', code: 'RESEARCH_STATE_NOT_FOUND' });
    res.json({ workflow: state.workflow });
  } catch (error) {
    handleError(res, error);
  }
});

const workflowPatchSchemaStub = z.object({});

router.patch('/api/research/topics/:id/theme-plan', (req, res) => {
  const parsed = workflowPatchSchemaStub.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid workflow update', code: 'INVALID_REQUEST' });
  const workflow = (req.body ?? {}).workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return res.status(400).json({ error: '缺少 workflow 对象', code: 'INVALID_WORKFLOW' });
  }
  try {
    const parsedWorkflow = themeWorkflowSchema.parse(workflow);
    const saved = saveThemePlanToState(req.params.id, parsedWorkflow, '手动编辑主题主线');
    setTopicStatus(req.params.id, 'PLANNING_THEME');
    res.json({ workflow: saved });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------------------------------------------------------------------------
// 保存到 Fork 实验室
// ---------------------------------------------------------------------------

const saveThemeSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  testGoal: z.string().max(600).optional(),
  allowAgentModification: z.boolean().optional(),
  shouldCreateFork: z.boolean().optional(),
  retainEnvironment: z.boolean().optional(),
});

router.post('/api/research/topics/:id/save-to-fork-lab', (req, res) => {
  const parsed = saveThemeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid theme save request', code: 'INVALID_REQUEST' });
  try {
    const result = saveThemePlan(req.params.id, parsed.data);
    setTopicStatus(req.params.id, 'READY_FOR_FORK_LAB');
    res.json({ theme: result.theme, version: result.version });
  } catch (error) {
    handleError(res, error);
  }
});

// Fork 实验室主题（只读浏览 + 版本 + 锁定 + 删除）
router.get('/api/research/themes', (_req, res) => {
  try {
    res.json({ themes: listThemes() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/themes/:themeId', (req, res) => {
  try {
    const theme = getTheme(req.params.themeId);
    if (!theme) return res.status(404).json({ error: '主题方案不存在', code: 'THEME_NOT_FOUND' });
    res.json({ theme });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/themes/:themeId/versions', (req, res) => {
  try {
    res.json({ versions: listThemeVersions(req.params.themeId) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/api/research/themes/:themeId/versions/:version', (req, res) => {
  try {
    const version = getThemeVersion(req.params.themeId, Number(req.params.version));
    if (!version) return res.status(404).json({ error: '主题版本不存在', code: 'THEME_VERSION_NOT_FOUND' });
    res.json({ version });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/api/research/themes/:themeId/versions/:versionId/lock', (req, res) => {
  try {
    res.json({ version: lockThemeVersion(req.params.versionId) });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/api/research/themes/:themeId', (req, res) => {
  try {
    deleteTheme(req.params.themeId);
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;