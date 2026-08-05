import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { claimNextTask, claimTaskById, addEvent, completeTask, getTaskBundle, updateTaskStatus } from '../deployment/taskService.js';
import { executionResultSchema, userReportSchema } from '../local-testing/schemas.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  platform: z.string().max(100).optional(),
  capabilities: z.array(z.string()).optional(),
});

const eventSchema = z.object({
  eventType: z.string().min(1).max(50),
  stage: z.string().max(50).nullable().optional(),
  message: z.string().max(5000).optional(),
});

const logsSchema = z.object({
  lines: z.array(z.string().max(5000)).max(500),
});

const completeSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'MANUAL_REQUIRED']),
  stage: z.string().max(50).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  containerNames: z.array(z.string()).optional(),
  ports: z.array(z.number()).optional(),
  workspacePath: z.string().max(1000).optional(),
  errorMessage: z.string().max(5000).optional(),
  reportMarkdown: z.string().max(500_000).optional(),
  logsText: z.string().max(1_000_000).optional(),
  userReport: z.record(z.string(), z.unknown()).optional(),
  executionResult: z.record(z.string(), z.unknown()).optional(),
  artifactManifest: z.array(z.object({ type: z.string(), path: z.string(), sizeBytes: z.number().int().nonnegative().optional(), checksum: z.string().optional() })).optional(),
});

function handleError(res: Response, error: unknown) {
  const err = error as Error & { code?: string };
  if (err.code === 'TASK_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
  if (err.code === 'TASK_NOT_CLAIMABLE') return res.status(409).json({ error: err.message, code: err.code });
  return res.status(502).json({ error: err.message || 'Runner operation failed', code: 'RUNNER_FAILED' });
}

function requireRunner(runnerId: string): { id: string } | null {
  const row = getDb().prepare('SELECT id FROM runner_agents WHERE id=?').get(runnerId) as { id: string } | undefined;
  return row ?? null;
}

const stageProgress: Record<string, { status: string; progress: number }> = {
  PREPARING: { status: 'PREPARING', progress: 5 },
  CLONING: { status: 'CLONING', progress: 15 },
  AGENT_PLANNING: { status: 'AGENT_PLANNING', progress: 25 },
  WAITING_FOR_INPUT: { status: 'AGENT_PLANNING', progress: 25 },
  PLAN_VALIDATING: { status: 'PLAN_VALIDATING', progress: 35 },
  BUILDING: { status: 'BUILDING', progress: 55 },
  STARTING: { status: 'STARTING', progress: 70 },
  VERIFYING: { status: 'VERIFYING', progress: 85 },
  REPAIRING: { status: 'REPAIRING', progress: 90 },
  REPORTING: { status: 'REPORTING', progress: 95 },
};

const activeTaskStatuses = ['CLAIMED', 'PREPARING', 'CLONING', 'AGENT_PLANNING', 'PLAN_VALIDATING', 'BUILDING', 'STARTING', 'VERIFYING', 'REPAIRING', 'REPORTING'];

function pruneOfflineRunners(): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90_000).toISOString();
  const stale = db.prepare('SELECT id FROM runner_agents WHERE last_heartbeat_at IS NULL OR last_heartbeat_at < ?').all(cutoff) as Array<{ id: string }>;
  const activeCheck = db.prepare(`SELECT COUNT(*) AS c FROM deployment_tasks WHERE runner_id=? AND status IN (${activeTaskStatuses.map(() => '?').join(',')})`);
  const remove = db.prepare('DELETE FROM runner_agents WHERE id=?');
  for (const runner of stale) {
    const active = activeCheck.get(runner.id, ...activeTaskStatuses) as { c: number };
    if (active.c === 0) remove.run(runner.id);
  }
}

// GET /api/runners
router.get('/api/runners', (_req, res) => {
  try {
    pruneOfflineRunners();
    const rows = getDb().prepare(`
      SELECT id,name,platform,status,capabilities_json,last_heartbeat_at,registered_at
      FROM runner_agents
      ORDER BY last_heartbeat_at DESC, registered_at DESC
    `).all() as Array<Record<string, unknown>>;
    const onlineAfter = Date.now() - 90_000;
    res.json({
      runners: rows.map((row) => ({
        ...row,
        status: row.last_heartbeat_at && Date.parse(String(row.last_heartbeat_at)) >= onlineAfter ? 'ONLINE' : 'OFFLINE',
      })),
    });
  } catch (error) {
    handleError(res, error);
  }
});

// DELETE /api/runners/:id — normal Runner shutdown unregisters itself.
router.delete('/api/runners/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM runner_agents WHERE id=?').run(req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/register
router.post('/api/runners/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid registration', code: 'INVALID_REGISTRATION' });
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO runner_agents (id,name,platform,status,capabilities_json,last_heartbeat_at,registered_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, parsed.data.name ?? 'local-runner', parsed.data.platform ?? 'windows', 'ONLINE', JSON.stringify(parsed.data.capabilities ?? ['git', 'docker', 'http']), now, now);
    res.status(201).json({ id, registered: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/heartbeat
router.post('/api/runners/:id/heartbeat', (req, res) => {
  try {
    if (!requireRunner(req.params.id)) return res.status(404).json({ error: 'Runner not found', code: 'RUNNER_NOT_FOUND' });
    getDb().prepare('UPDATE runner_agents SET status=?, last_heartbeat_at=? WHERE id=?').run('ONLINE', new Date().toISOString(), req.params.id);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/claim-task
router.post('/api/runners/:id/claim-task', (req, res) => {
  try {
    if (!requireRunner(req.params.id)) return res.status(404).json({ error: 'Runner not found', code: 'RUNNER_NOT_FOUND' });
    const task = claimNextTask(req.params.id);
    if (!task) return res.json({ task: null });
    res.json({ task: getTaskBundle(task.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/claim-task/:taskId — explicit execution only; no queue polling required.
router.post('/api/runners/:id/claim-task/:taskId', (req, res) => {
  try {
    if (!requireRunner(req.params.id)) return res.status(404).json({ error: 'Runner not found', code: 'RUNNER_NOT_FOUND' });
    const task = claimTaskById(req.params.id, req.params.taskId);
    res.json({ task: getTaskBundle(task.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/tasks/:taskId/events
router.post('/api/runners/:id/tasks/:taskId/events', (req, res) => {
  const parsed = eventSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid event', code: 'INVALID_EVENT' });
  try {
    addEvent(req.params.taskId, req.params.id, parsed.data.eventType, parsed.data.stage ?? null, parsed.data.message ?? '');
    const progress = parsed.data.eventType === 'stage' && parsed.data.stage ? stageProgress[parsed.data.stage] : null;
    if (progress) updateTaskStatus(req.params.taskId, progress.status, parsed.data.stage ?? null, progress.progress);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/tasks/:taskId/logs
router.post('/api/runners/:id/tasks/:taskId/logs', (req, res) => {
  const parsed = logsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid logs', code: 'INVALID_LOGS' });
  try {
    const tx = getDb().transaction(() => {
      for (const line of parsed.data.lines) {
        addEvent(req.params.taskId, req.params.id, 'log', 'AGENT', line);
      }
    });
    tx();
    res.json({ ok: true, count: parsed.data.lines.length });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/runners/:id/tasks/:taskId/complete
router.post('/api/runners/:id/tasks/:taskId/complete', (req, res) => {
  const parsed = completeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid completion', code: 'INVALID_COMPLETION' });
  if (parsed.data.executionResult && !executionResultSchema.safeParse(parsed.data.executionResult).success) return res.status(400).json({ error: 'Invalid execution result schema', code: 'INVALID_EXECUTION_RESULT' });
  if (parsed.data.userReport && !userReportSchema.safeParse(parsed.data.userReport).success) return res.status(400).json({ error: 'Invalid user report schema', code: 'INVALID_USER_REPORT' });
  try {
    const task = completeTask(req.params.taskId, req.params.id, parsed.data);
    res.json({ task });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
