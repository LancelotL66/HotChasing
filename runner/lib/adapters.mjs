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
export async function openCodeAdapter({ instructionsDir, outputDir, repoDir, log }) {
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
    try {
      child = pty.spawn(resolveCli('opencode'), ['run', ...(config.agentPureMode ? ['--pure'] : []), ...(config.agentModel ? ['--model', config.agentModel] : []), ...(config.agentAutoApprove ? ['--auto'] : []), '--print-logs', instruction], { cwd: repoDir, env: process.env, name: 'xterm-color', cols: 120, rows: 36 });
    } catch (error) {
      reject(new Error(`无法启动 opencode：${error.message}。请安装 opencode 或改用 AGENT=manual`));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('opencode 运行超时'));
    }, config.agentTimeoutMs);
    initTimer = setTimeout(() => {
      if (initialized) return;
      child.kill();
      reject(new Error('OpenCode 初始化超过 60 秒，未创建会话。请检查项目配置或改用其他本地 Agent。'));
    }, 60_000);
    child.onData((data) => {
      const text = String(data).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      if (/message=(created|process)|stream providerID=/.test(text)) { initialized = true; clearTimeout(initTimer); }
      log(`[opencode] ${text.trimEnd()}`);
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer); clearTimeout(initTimer);
      const result = readResult(outputDir);
      if (!result) {
        reject(new Error(`opencode 退出（code=${exitCode}）但未生成 result.json`));
        return;
      }
      resolve({ result, adapter: 'opencode' });
    });
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
