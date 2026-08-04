/**
 * 校验器：Runner 最终成功的唯一依据。
 * - 必须有 output/result.json 且 status === 'passed'；
 * - 必须有 Agent 生成的简要 report.md；
 * - 仅在计划明确要求 HTTP 校验时探测端口。
 */
export async function verifyTask({ result, bundle, outputDir }) {
  const details = [];
  let passed = Boolean(result && result.status === 'passed');
  details.push(`result.status=${result?.status ?? 'missing'}`);

  const reportPath = path.join(outputDir, 'report.md');
  try {
    const report = fs.statSync(reportPath);
    if (report.size === 0) throw new Error('报告为空');
    details.push('report.md 已生成');
  } catch (error) {
    details.push(`report.md 缺失或不可读：${error.message}`);
    passed = false;
  }

  const plan = bundle.plan ?? {};
  const port = Number(result?.port) || (Array.isArray(plan.suspectedPorts) ? plan.suspectedPorts[0] : null);
  const wantsHttp = Array.isArray(plan.steps) && plan.steps.some((s) => s.type === 'http_check');

  if (wantsHttp && port) {
    const pathToCheck = '/';
    try {
      const response = await fetch(`http://localhost:${port}${pathToCheck}`, { signal: AbortSignal.timeout(5000) });
      details.push(`http ${pathToCheck} -> ${response.status}`);
      if (response.status !== 200) passed = false;
    } catch (error) {
      details.push(`http ${pathToCheck} -> 失败：${error.message}`);
      passed = false;
    }
  } else if (wantsHttp && !port) {
    details.push('计划包含 http_check 但未提供端口，跳过 HTTP 探测');
  }

  return { passed, details, port: port || null };
}
import fs from 'node:fs';
import path from 'node:path';
