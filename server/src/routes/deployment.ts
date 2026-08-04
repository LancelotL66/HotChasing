import { Router, type Response } from 'express';
import { z } from 'zod';
import { createTasks, listTasks, listTasksByStatuses, requireTask, cancelTask, deleteTask, retryTask, markManual, listEvents, listLocalDeployments, getTask, blockTasksWithOfflineRunners, listProjectReports } from '../deployment/taskService.js';
import { listBatches, getBatch } from '../deployment/batchService.js';

const router = Router();

const createBatchSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1),
  name: z.string().max(200).optional(),
  agentId: z.string().max(100).optional(),
  testLevel: z.string().max(20).optional(),
  maxConcurrency: z.number().int().min(1).max(10).optional(),
  maxRepairIterations: z.number().int().min(0).max(10).optional(),
  allowModification: z.boolean().optional(),
  allowCommit: z.boolean().optional(),
  allowPush: z.boolean().optional(),
});

function handleError(res: Response, error: unknown) {
  const err = error as Error & { code?: string };
  if (err.code === 'TASK_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
  if (err.code === 'PROJECT_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
  if (err.code === 'TASK_NOT_CANCELLABLE' || err.code === 'TASK_NOT_RETRYABLE' || err.code === 'TASK_NOT_MANUAL' || err.code === 'NO_PROJECTS') {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  return res.status(502).json({ error: err.message || 'Deployment operation failed', code: 'DEPLOYMENT_FAILED' });
}

// POST /api/deployment/batches
router.post('/api/deployment/batches', (req, res) => {
  const parsed = createBatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid batch request', code: 'INVALID_BATCH_REQUEST' });
  try {
    const result = createTasks(parsed.data.projectIds, parsed.data);
    res.status(201).json({ batchId: result.batchId, tasks: result.tasks });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/batches
router.get('/api/deployment/batches', (_req, res) => {
  try {
    res.json({ batches: listBatches() });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/batches/:id
router.get('/api/deployment/batches/:id', (req, res) => {
  try {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found', code: 'BATCH_NOT_FOUND' });
    res.json({ batch });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/tasks?status=queued|running|done|failed
router.get('/api/deployment/tasks', (req, res) => {
  try {
    blockTasksWithOfflineRunners();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    let tasks;
    if (status === 'queued') tasks = listTasksByStatuses(['QUEUED']);
    else if (status === 'running') tasks = listTasksByStatuses(['CLAIMED', 'PREPARING', 'CLONING', 'AGENT_PLANNING', 'PLAN_VALIDATING', 'BUILDING', 'STARTING', 'VERIFYING', 'REPAIRING', 'REPORTING']);
    else if (status === 'done') tasks = listTasksByStatuses(['COMPLETED']);
    else if (status === 'failed') tasks = listTasksByStatuses(['FAILED', 'BLOCKED', 'MANUAL_REQUIRED']);
    else tasks = listTasks();
    res.json({ tasks });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/tasks/:id
router.get('/api/deployment/tasks/:id', (req, res) => {
  try {
    blockTasksWithOfflineRunners();
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
    res.json({ task, events: listEvents(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/deployment/tasks/:id/cancel
router.post('/api/deployment/tasks/:id/cancel', (req, res) => {
  try {
    res.json({ task: cancelTask(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// DELETE /api/deployment/tasks/:id — remove task and all execution records, retaining the Fork project and plan.
router.delete('/api/deployment/tasks/:id', (req, res) => {
  try {
    deleteTask(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/deployment/tasks/:id/retry
router.post('/api/deployment/tasks/:id/retry', (req, res) => {
  try {
    res.json({ task: retryTask(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/deployment/tasks/:id/manual
router.post('/api/deployment/tasks/:id/manual', (req, res) => {
  try {
    res.json({ task: markManual(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/tasks/:id/events
router.get('/api/deployment/tasks/:id/events', (req, res) => {
  try {
    requireTask(req.params.id);
    res.json({ events: listEvents(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/deployment/projects/:projectId/reports — persisted reports survive task workspace cleanup.
router.get('/api/deployment/projects/:projectId/reports', (req, res) => {
  try {
    res.json({ reports: listProjectReports(req.params.projectId) });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/local-deployments
router.get('/api/local-deployments', (_req, res) => {
  try {
    res.json({ deployments: listLocalDeployments() });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
