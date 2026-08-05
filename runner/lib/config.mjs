import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(__dirname, '..');

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

export const config = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:8080/api',
  runnerName: process.env.RUNNER_NAME || `${os.hostname()}-runner`,
  runnerPlatform: process.env.RUNNER_PLATFORM || process.platform,
  workspaceRoot: process.env.WORKSPACE_ROOT || path.join(runnerRoot, 'workspace'),
  stateFile: process.env.RUNNER_STATE_FILE || path.join(runnerRoot, 'runner.json'),
  githubToken: process.env.GITHUB_TOKEN || '',
  agent: process.env.AGENT || 'manual',
  agentModel: process.env.AGENT_MODEL || '',
  agentAutoApprove: boolEnv('AGENT_AUTO_APPROVE', false),
  agentPureMode: boolEnv('AGENT_PURE_MODE', false),
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 30 * 60 * 1000),
  heartbeatMs: Number(process.env.HEARTBEAT_MS || 30 * 1000),
  pollMs: Number(process.env.POLL_MS || 10 * 1000),
  taskIds: (process.env.TASK_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  taskConcurrency: Math.min(4, Math.max(1, Number(process.env.TASK_CONCURRENCY || 2) || 2)),
  maxRepairIterations: Number(process.env.MAX_REPAIR_ITERATIONS || 1),
  apiSecret: process.env.API_SECRET || '',
  skipClone: boolEnv('SKIP_CLONE', false),
};
