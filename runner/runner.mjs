#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config.mjs';
import { api, log } from './lib/api.mjs';
import { cloneRepository } from './lib/git.mjs';
import { writeBundle } from './lib/bundle.mjs';
import { createAdapter } from './lib/adapters.mjs';
import { verifyTask } from './lib/verify.mjs';

const adapter = createAdapter(config.agent);

let heartbeatInFlight = false;
let heartbeatTimer = null;
let shuttingDown = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendHeartbeat() {
  if (heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    await api(`/runners/${config.runnerId}/heartbeat`, { method: 'POST', body: {} });
  } catch (error) {
    log(`Heartbeat 失败：${error.message}`);
  } finally {
    heartbeatInFlight = false;
  }
}

async function registerRunner() {
  const result = await api('/runners/register', {
    method: 'POST',
    body: { name: config.runnerName, platform: config.runnerPlatform, capabilities: ['git', 'docker', 'http', config.agent] },
  });
  fs.writeFileSync(config.stateFile, JSON.stringify({ id: result.id }, null, 2), 'utf8');
  log(`Runner 自动注册成功：${result.id}`);
  return result.id;
}

async function loadOrRegisterRunner() {
  if (fs.existsSync(config.stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
      if (state.id) {
        try {
          await api(`/runners/${state.id}/heartbeat`, { method: 'POST', body: {} });
          return state.id;
        } catch (error) {
          log(`保存的 Runner ID 不可用，自动重新注册：${error.message}`);
        }
      }
    } catch {
      // 继续自动注册
    }
  }
  return registerRunner();
}

async function processTask(bundle) {
  const taskId = bundle.task.id;
  const workspaceDir = path.join(config.workspaceRoot, taskId);
  const logWithTask = (message) => log(`[${taskId}] ${message}`);
  const agentLogLines = [];

  try {
    logWithTask('开始处理任务');
    await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, { method: 'POST', body: { eventType: 'stage', stage: 'PREPARING', message: '准备任务包' } });
    await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, { method: 'POST', body: { eventType: 'stage', stage: 'CLONING', message: 'Clone 固定 Commit' } });

    const { inputDir, instructionsDir, outputDir, repoDir } = writeBundle(bundle, workspaceDir);
    if (!config.skipClone) {
      // A retry reuses its task workspace; only the cloned checkout must be reset.
      fs.rmSync(repoDir, { recursive: true, force: true });
      await cloneRepository(bundle, repoDir);
      fs.copyFileSync(path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md'), path.join(repoDir, '.hotchasing-task.md'));
      logWithTask(`Clone 完成：${repoDir}`);
    } else {
      fs.mkdirSync(repoDir, { recursive: true });
    }

    await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, { method: 'POST', body: { eventType: 'stage', stage: 'AGENT_PLANNING', message: `启动 ${config.agent} Agent` } });
    const taskLog = (message) => {
      agentLogLines.push(message);
      logWithTask(message);
      // Agent stdout/stderr is diagnostic evidence for the UI, not just the local terminal.
      void api(`/runners/${config.runnerId}/tasks/${taskId}/logs`, { method: 'POST', body: { lines: [message.slice(0, 5000)] } })
        .catch((error) => logWithTask(`日志上报失败：${error.message}`));
    };
    const { result } = await adapter({
      instructionsDir,
      inputDir,
      outputDir,
      repoDir,
      log: taskLog,
      onDecisionRequest: async (request) => {
        const requestId = String(request?.requestId ?? `${taskId}-${Date.now()}`);
        const question = typeof request?.question === 'string' ? request.question : 'Agent 需要人工决策后才能继续。';
        const options = Array.isArray(request?.options) ? request.options : [];
        await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, {
          method: 'POST',
          body: { eventType: 'stage', stage: 'WAITING_FOR_INPUT', message: JSON.stringify({ requestId, question, options, requestedAt: new Date().toISOString() }) },
        });
        logWithTask(`等待人工决策：${question}`);
        const deadline = Date.now() + config.agentTimeoutMs;
        while (Date.now() < deadline) {
          const detail = await api(`/deployment/tasks/${taskId}`);
          const response = [...(detail.events ?? [])].reverse().find((event) => {
            if (event.event_type !== 'decision_response') return false;
            try { return JSON.parse(event.message).requestId === requestId; } catch { return false; }
          });
          if (response?.message) {
            fs.writeFileSync(path.join(inputDir, 'decision-response.json'), response.message, 'utf8');
            await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, { method: 'POST', body: { eventType: 'stage', stage: 'AGENT_PLANNING', message: '已收到人工决策，Agent 继续执行' } });
            return;
          }
          await wait(2000);
        }
        throw new Error('等待人工决策超时');
      },
    });
    const reportPath = path.join(outputDir, 'report.md');
    const reportMarkdown = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : undefined;

    await api(`/runners/${config.runnerId}/tasks/${taskId}/events`, { method: 'POST', body: { eventType: 'stage', stage: 'VERIFYING', message: 'Runner 校验部署结果' } });
    const verified = await verifyTask({ result, bundle, outputDir });

    if (verified.passed) {
      await api(`/runners/${config.runnerId}/tasks/${taskId}/complete`, {
        method: 'POST',
        body: {
          status: 'COMPLETED',
          stage: 'REPORTING',
          result,
          ports: verified.port ? [verified.port] : [],
          workspacePath: workspaceDir,
          reportMarkdown,
          logsText: agentLogLines.join('\n').slice(-1_000_000),
        },
      });
      logWithTask(`任务完成：${verified.details.join('；')}`);
    } else {
      await api(`/runners/${config.runnerId}/tasks/${taskId}/complete`, {
        method: 'POST',
        body: {
          status: 'FAILED',
          stage: 'REPORTING',
          result,
          errorMessage: `校验失败：${verified.details.join('；')}`,
          workspacePath: workspaceDir,
          reportMarkdown,
          logsText: agentLogLines.join('\n').slice(-1_000_000),
        },
      });
      logWithTask(`任务校验失败：${verified.details.join('；')}`);
    }
  } catch (error) {
    logWithTask(`任务失败：${error.message}`);
    try {
      await api(`/runners/${config.runnerId}/tasks/${taskId}/complete`, {
        method: 'POST',
        body: { status: 'FAILED', errorMessage: error.message, workspacePath: workspaceDir },
      });
    } catch {
      // 忽略上报失败
    }
  }
}

async function main() {
  log(`Runner 启动：agent=${config.agent} backend=${config.backendUrl} workspace=${config.workspaceRoot}`);
  if (config.taskIds.length === 0) {
    log('未指定 TASK_IDS，不会自动领取测试任务。请在 HotChasing 项目库中选择项目后点击“开始测试”。');
    return;
  }
  config.runnerId = await loadOrRegisterRunner();
  log(`Runner ID：${config.runnerId}`);
  await sendHeartbeat();
  // Agent 执行可持续数十分钟，心跳必须独立于任务处理循环。
  heartbeatTimer = setInterval(() => void sendHeartbeat(), config.heartbeatMs);

  try {
    for (const taskId of config.taskIds) {
      try {
        const claim = await api(`/runners/${config.runnerId}/claim-task/${encodeURIComponent(taskId)}`, { method: 'POST', body: {} });
        log(`开始指定任务 ${claim.task.task.id}`);
        await processTask(claim.task);
      } catch (error) {
        log(`指定任务 ${taskId} 启动/处理失败：${error.message}`);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    try {
      if (config.runnerId) await api(`/runners/${config.runnerId}`, { method: 'DELETE' });
    } catch (error) {
      log(`Runner 注销失败：${error.message}`);
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  log(`Runner 收到 ${signal}，正在注销`);
  try {
    if (config.runnerId) await api(`/runners/${config.runnerId}`, { method: 'DELETE' });
  } catch (error) {
    log(`Runner 注销失败：${error.message}`);
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  console.error(`Runner 异常退出：${error.stack || error.message}`);
  process.exit(1);
});
