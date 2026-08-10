import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pty from 'node-pty';
import { config } from './config.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readResult(outputDir) {
  const file = path.join(outputDir, 'result.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveCli(command) {
  if (process.platform !== 'win32' || command !== 'opencode') return command;
  const npmBinary = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return fs.existsSync(npmBinary) ? npmBinary : command;
}

/**
 * ManualAdapter：生成任务包并提示用户在本地手动执行 Agent，
 * 轮询 output/result.json 直到超时。
 */
export async function manualAdapter({ instructionsDir, outputDir, repoDir, log }) {
  const workflow = path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md');
  log(`[manual] 请在工作目录手动完成部署测试：${repoDir}`);
  log(`[manual] 阅读任务说明：${workflow}`);
  log(`[manual] 完成后将 result.json 写入：${outputDir}/result.json`);
  const deadline = Date.now() + config.agentTimeoutMs;
  while (Date.now() < deadline) {
    const result = readResult(outputDir);
    if (result) return { result, adapter: 'manual' };
    await sleep(3000);
  }
  throw new Error(`ManualAdapter 超时（${config.agentTimeoutMs / 1000}s）：未在 ${outputDir}/result.json 发现结果`);
}

/**
 * OpenCodeAdapter：以非交互方式调用 opencode CLI 处理部署任务。
 */
export async function openCodeAdapter({ instructionsDir, inputDir, outputDir, repoDir, log, onDecisionRequest }) {
  if (!config.agentModel) {
    throw new Error('OpenCode 未配置 AGENT_MODEL。请在“设置 -> 本地 Agent”填写 provider/model 后重启 Runner。');
  }
  if (!config.agentAutoApprove) {
    throw new Error('OpenCode 非交互测试需要 AGENT_AUTO_APPROVE=1。请在“设置 -> 本地 Agent”开启自动批准测试工作区权限后重启 Runner。');
  }
  const instruction = 'Read .hotchasing-task.md in the current repository. Complete the local test task and write result.json and report.md to ../output/ as instructed.';
  log(`[opencode] 启动 opencode（cwd=${repoDir}）`);
  return new Promise((resolve, reject) => {
    let child;
    let initialized = false;
    let initTimer;
    let decisionRequest = '';
    let decisionInFlight = false;
    let waitingForDecision = false;
    let agentExitedWhileWaiting = false;
    let restartAfterDecision = false;
    let exitRecoveryCount = 0;
    let settled = false;
    const MAX_EXIT_RECOVERIES = 3;
    const decisionDir = path.join(outputDir, 'decisions', 'decision-requests');
    const decisionFile = path.join(outputDir, 'decision-request.json');
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(initTimer);
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const launchAgent = (continuation = false) => {
      if (settled) return;
      let prompt = instruction;
      if (continuation) {
        fs.rmSync(path.join(outputDir, 'result.json'), { force: true });
        fs.rmSync(path.join(outputDir, 'report.md'), { force: true });
        log('[opencode] 已收到人工决策，重新唤起 Agent 读取 decision-response.json');
        // Tell the restarted agent an operator has just answered a pending decision so it
        // resumes with the approval applied instead of re-deriving the policy gate from scratch.
        prompt = `${instruction}\n\nAn operator has answered the pending approval request. Read the decision file at ${path.join(inputDir, 'decision-response.json')} and continue the task under the approved scope (follow the decision's choice and note). Do not re-ask for the same approval.`;
      }
      try {
        child = pty.spawn(resolveCli('opencode'), ['run', ...(config.agentPureMode ? ['--pure'] : []), ...(config.agentModel ? ['--model', config.agentModel] : []), ...(config.agentAutoApprove ? ['--auto'] : []), '--print-logs', prompt], { cwd: repoDir, env: process.env, name: 'xterm-color', cols: 120, rows: 36 });
      } catch (error) {
        finish(new Error(`无法启动 opencode：${error.message}。请安装 opencode 或改用 AGENT=manual`));
        return;
      }
      child.onData((data) => {
        const text = String(data).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
        if (/message=(created|process)|stream providerID=/.test(text)) { initialized = true; clearTimeout(initTimer); }
        log(`[opencode] ${text.trimEnd()}`);
      });
      child.onExit(async ({ exitCode }) => {
        if (settled) return;
        if (waitingForDecision) {
          agentExitedWhileWaiting = true;
          log(`[opencode] 等待人工决策期间退出（code=${exitCode}），收到响应后将继续。`);
          return;
        }
        if (restartAfterDecision) {
          restartAfterDecision = false;
          launchAgent(true);
          return;
        }
        const result = readResult(outputDir);
        if (result) {
          finish(null, { result, adapter: 'opencode' });
          return;
        }
        if (!onDecisionRequest || exitRecoveryCount >= MAX_EXIT_RECOVERIES) {
          finish(new Error(`opencode 退出（code=${exitCode}）但未生成 result.json`));
          return;
        }
        // Agent 异常退出且未产出结果：通常由上游 API 瞬时故障引起。
        // 不直接结束任务，而是请用户在 App 中选择是否继续，确认后重启 Agent。
        exitRecoveryCount += 1;
        try {
          await onDecisionRequest({
            requestId: `opencode-exit-retry-${exitRecoveryCount}`,
            question: `opencode 异常退出（code=${exitCode}）且未生成 result.json，通常是上游 API 瞬时故障。是否重新继续执行？`,
            options: [
              { id: 'retry', label: '继续', description: '重新启动 opencode 继续执行当前测试任务。' },
              { id: 'stop', label: '停止', description: '结束当前任务，转人工处理。' },
            ],
          });
          const decisionPath = path.join(inputDir, 'decision-response.json');
          let choice = '';
          try {
            choice = String(JSON.parse(fs.readFileSync(decisionPath, 'utf8')).choice ?? '');
          } catch {
            // 未能读取决策响应，按停止处理。
          }
          if (choice === 'retry') {
            log(`[opencode] 用户选择继续，重启 Agent（第 ${exitRecoveryCount} 次恢复）`);
            launchAgent(true);
            return;
          }
          finish(new Error(`opencode 退出（code=${exitCode}）但未生成 result.json；用户选择停止`));
        } catch (error) {
          finish(new Error(`opencode 退出（code=${exitCode}）但未生成 result.json；等待用户决策超时：${error.message}`));
        }
      });
    };
    const decisionTimer = setInterval(async () => {
      if (!onDecisionRequest || decisionInFlight) return;
      let requestFile = null;
      try {
        if (fs.existsSync(decisionFile)) requestFile = decisionFile;
        else if (fs.existsSync(decisionDir)) {
          const files = fs.readdirSync(decisionDir).filter((name) => name.endsWith('.json')).sort();
          const latest = files[files.length - 1];
          if (latest) requestFile = path.join(decisionDir, latest);
        }
      } catch {
        requestFile = null;
      }
      if (!requestFile) return;
      try {
        const raw = fs.readFileSync(requestFile, 'utf8').trim();
        if (!raw || raw === decisionRequest) return;
        const request = JSON.parse(raw);
        decisionRequest = raw;
        decisionInFlight = true;
        waitingForDecision = true;
        await onDecisionRequest(request);
        waitingForDecision = false;
        if (agentExitedWhileWaiting) {
          agentExitedWhileWaiting = false;
          launchAgent(true);
        } else {
          // A fresh invocation is required so OpenCode cannot continue with stale pre-decision context.
          restartAfterDecision = true;
          child.kill();
        }
      } catch (error) {
        log(`[opencode] 人工决策请求处理失败：${error.message}`);
      } finally {
        decisionInFlight = false;
      }
    }, 1000);
    const cleanup = () => clearInterval(decisionTimer);
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('opencode 运行超时'));
    }, config.agentTimeoutMs * 2);
    initTimer = setTimeout(() => {
      if (initialized) return;
      child.kill();
      finish(new Error('OpenCode 初始化超过 60 秒，未创建会话。请检查项目配置或改用其他本地 Agent。'));
    }, 60_000);
    launchAgent();
  });
}

function cliAdapter(command, argsForInstruction, label) {
  return async ({ instructionsDir, outputDir, repoDir, log }) => {
    const workflow = path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md');
    const instruction = `请阅读 ${workflow} 完成本地功能测试任务，并在任务说明指定的绝对路径写入 result.json 和 report.md。`;
    log(`[${label}] 启动 ${command}（cwd=${repoDir}）`);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(resolveCli(command), argsForInstruction(instruction), { cwd: repoDir, shell: false });
      } catch (error) {
        reject(new Error(`无法启动 ${label}：${error.message}`));
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${label} 运行超时`));
      }, config.agentTimeoutMs);
      child.stdout?.on('data', (chunk) => log(`[${label}] ${String(chunk).trimEnd()}`));
      child.stderr?.on('data', (chunk) => log(`[${label}] ${String(chunk).trimEnd()}`));
      child.on('error', (error) => { clearTimeout(timer); reject(new Error(`${label} 启动失败：${error.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = readResult(outputDir);
        if (!result) {
          reject(new Error(`${label} 退出（code=${code}）但未生成 result.json`));
          return;
        }
        resolve({ result, adapter: label });
      });
    });
  };
}

export const claudeCodeAdapter = cliAdapter('claude', (instruction) => ['-p', ...(config.agentModel ? ['--model', config.agentModel] : []), instruction], 'claude-code');
export const codexAdapter = cliAdapter('codex', (instruction) => ['exec', '--full-auto', ...(config.agentModel ? ['--model', config.agentModel] : []), instruction], 'codex');

export function createAdapter(agentName) {
  if (agentName === 'opencode') return openCodeAdapter;
  if (agentName === 'claude-code') return claudeCodeAdapter;
  if (agentName === 'codex') return codexAdapter;
  return manualAdapter;
}
