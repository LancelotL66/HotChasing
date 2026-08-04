import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';

const execFileP = promisify(execFile);

function authUrl(fullName) {
  const base = `https://github.com/${fullName}.git`;
  if (!config.githubToken) return base;
  return `https://x-access-token:${config.githubToken}@github.com/${fullName}.git`;
}

async function git(args, cwd) {
  const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout || stderr;
}

/**
 * clone 上游或 fork，checkout 固定 commit，并创建测试分支。
 * bundle: 领取任务时的完整任务包（含 project/repo）。
 */
export async function cloneRepository(bundle, repoDir) {
  const project = bundle.project || {};
  const fullName = project.fork_full_name || project.upstream_full_name || bundle.repo?.full_name;
  if (!fullName) throw new Error('未找到仓库 full_name，无法 Clone');
  const url = authUrl(fullName);
  const commitSha = project.upstream_commit_sha || bundle.repo?.default_branch || 'HEAD';
  const testBranch = project.test_branch || `hotchasing/test/${bundle.task.id.slice(0, 8)}`;

  await git(['clone', '--depth', '1', url, repoDir]);
  try {
    await git(['checkout', commitSha], repoDir);
  } catch {
    await git(['fetch', '--depth', '1', 'origin', commitSha], repoDir);
    await git(['checkout', commitSha], repoDir);
  }
  try {
    await git(['checkout', '-b', testBranch], repoDir);
  } catch {
    // 分支可能已存在，忽略
  }
  return { repoDir, url, commitSha, testBranch };
}
