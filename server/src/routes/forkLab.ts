import { Router, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { createProject, deleteProject, listProjects, requireProject } from '../fork-lab/forkLabService.js';
import { ensureAssessment, getAssessment } from '../fork-lab/deploymentAssessmentService.js';
import { generatePlan, getPlan, updatePlan, lockPlan, unlockPlan } from '../fork-lab/deploymentPlanService.js';
import { createFork, getForkStatus, syncUpstream } from '../fork-lab/githubForkService.js';

const router = Router();

const createProjectSchema = z.object({
  repoId: z.number().int().positive(),
  source: z.enum(['digest', 'top100', 'manual']).default('manual'),
});

function handleError(res: Response, error: unknown) {
  const err = error as Error & { code?: string };
  if (err.code === 'PROJECT_NOT_FOUND' || err.code === 'PLAN_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
  if (err.code === 'PLAN_LOCKED') return res.status(409).json({ error: err.message, code: err.code });
  if (err.code === 'ASSESSMENT_REQUIRED') return res.status(409).json({ error: err.message, code: err.code });
  if (err.code === 'REPOSITORY_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
  if (err.code === 'GITHUB_TOKEN_NOT_CONFIGURED' || err.code === 'GITHUB_TOKEN_DECRYPT_FAILED') return res.status(400).json({ error: err.message, code: err.code });
  if (err.code === 'FORK_CREATE_FAILED' || err.code === 'FORK_TIMEOUT') return res.status(502).json({ error: err.message, code: err.code });
  if (err.code === 'FORK_NOT_READY' || err.code === 'SYNC_FAILED') return res.status(409).json({ error: err.message, code: err.code });
  return res.status(502).json({ error: err.message || 'Fork lab operation failed', code: 'FORK_LAB_FAILED' });
}

// POST /api/fork-lab/projects — 加入 Fork 实验室并自动创建 GitHub Fork（已配置 Token 时）
router.post('/api/fork-lab/projects', (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid project request', code: 'INVALID_PROJECT_REQUEST' });
  try {
    const result = createProject(parsed.data.repoId, parsed.data.source);
    let autoFork = false;
    if (result.created) {
      const tokenRow = getDb().prepare('SELECT value FROM settings WHERE key=?').get('github_token') as { value?: string } | undefined;
      if (tokenRow?.value) {
        autoFork = true;
        getDb().prepare("UPDATE fork_workspace_projects SET fork_status='CREATING' WHERE id=?").run(result.project.id);
        void createFork(result.project.id).catch(() => {
          try {
            getDb().prepare("UPDATE fork_workspace_projects SET fork_status='FAILED' WHERE id=? AND fork_status='CREATING'").run(result.project.id);
          } catch {
            // 忽略清理失败
          }
        });
      }
    }
    res.status(result.created ? 201 : 200).json({ project: requireProject(result.project.id), created: result.created, alreadyExists: !result.created, autoFork });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/fork-lab/projects
router.get('/api/fork-lab/projects', (_req, res) => {
  try {
    res.json({ projects: listProjects() });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/fork-lab/projects/:id
router.get('/api/fork-lab/projects/:id', (req, res) => {
  try {
    res.json({ project: requireProject(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// DELETE /api/fork-lab/projects/:id — 从实验室移除（保留 GitHub Fork，清理关联本地任务数据）
router.delete('/api/fork-lab/projects/:id', (req, res) => {
  try {
    deleteProject(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/assessment — 生成或复用 AI 部署分析
router.post('/api/fork-lab/projects/:id/assessment', async (req, res) => {
  const force = Boolean((req.body ?? {}).force);
  try {
    const result = await ensureAssessment(req.params.id, force);
    res.json({ assessment: result.assessment, cached: result.cached, source: result.source });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/fork-lab/projects/:id/assessment
router.get('/api/fork-lab/projects/:id/assessment', (req, res) => {
  try {
    const assessment = getAssessment(req.params.id);
    if (!assessment) return res.status(404).json({ error: 'Assessment not found', code: 'ASSESSMENT_NOT_FOUND' });
    res.json({ assessment });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/plan — 生成建议部署测试流程
router.post('/api/fork-lab/projects/:id/plan', async (req, res) => {
  const force = Boolean((req.body ?? {}).force);
  try {
    const result = await generatePlan(req.params.id, force);
    res.json({ plan: result.plan, cached: result.cached, source: result.source });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/fork-lab/projects/:id/plan
router.get('/api/fork-lab/projects/:id/plan', (req, res) => {
  try {
    const plan = getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found', code: 'PLAN_NOT_FOUND' });
    res.json({ plan });
  } catch (error) {
    handleError(res, error);
  }
});

// PUT /api/fork-lab/projects/:id/plan — 手动编辑（未锁定时）
router.put('/api/fork-lab/projects/:id/plan', (req, res) => {
  const planJson = (req.body ?? {}).plan;
  if (!planJson || typeof planJson !== 'object' || Array.isArray(planJson)) {
    return res.status(400).json({ error: 'Invalid plan body', code: 'INVALID_PLAN' });
  }
  try {
    res.json({ plan: updatePlan(req.params.id, planJson as Record<string, unknown>) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/plan/lock
router.post('/api/fork-lab/projects/:id/plan/lock', (req, res) => {
  try {
    res.json({ plan: lockPlan(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/plan/unlock
router.post('/api/fork-lab/projects/:id/plan/unlock', (req, res) => {
  try {
    res.json({ plan: unlockPlan(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/fork — 创建 GitHub Fork（M3）
router.post('/api/fork-lab/projects/:id/fork', async (req, res) => {
  try {
    const result = await createFork(req.params.id);
    res.json({ project: result.project, created: result.created });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/fork-lab/projects/:id/fork-status
router.get('/api/fork-lab/projects/:id/fork-status', async (req, res) => {
  try {
    res.json(await getForkStatus(req.params.id));
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/fork-lab/projects/:id/sync-upstream — 同步上游到 Fork
router.post('/api/fork-lab/projects/:id/sync-upstream', async (req, res) => {
  try {
    res.json(await syncUpstream(req.params.id));
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
