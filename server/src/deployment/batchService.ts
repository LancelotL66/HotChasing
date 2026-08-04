import { getDb } from '../db/connection.js';
import { getTask } from './taskService.js';

export function listBatches(): Array<Record<string, unknown>> {
  const rows = getDb().prepare('SELECT * FROM deployment_batches ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((batch) => {
    const tasks = getDb().prepare('SELECT id,workspace_project_id,status,current_stage,progress,created_at FROM deployment_tasks WHERE batch_id=? ORDER BY created_at ASC').all(batch.id) as Array<Record<string, unknown>>;
    return { ...batch, tasks };
  });
}

export function getBatch(batchId: string): Record<string, unknown> | null {
  const batch = getDb().prepare('SELECT * FROM deployment_batches WHERE id=?').get(batchId) as Record<string, unknown> | undefined;
  if (!batch) return null;
  const taskRows = getDb().prepare('SELECT id FROM deployment_tasks WHERE batch_id=? ORDER BY created_at ASC').all(batchId) as Array<{ id: string }>;
  const tasks = taskRows.map((row) => getTask(row.id)).filter(Boolean);
  return { ...batch, tasks };
}
