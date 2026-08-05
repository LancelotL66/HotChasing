/**
 * 校验器：Runner 最终成功的唯一依据。
 * - 必须有结构化 execution-result.json 和 USER_REPORT.md；
 * - 旧 result.json/report.md 仅作为兼容输入；
 * - 仅在计划明确要求 HTTP 校验时探测端口。
 */
export async function verifyTask({ result, bundle, outputDir }) {
  const details = [];
  let passed = Boolean(result && ['VERIFIED', 'PARTIALLY_VERIFIED'].includes(result.overallVerification?.status));
  details.push(`overallVerification=${result?.overallVerification?.status ?? 'missing'}`);

  const reportPath = path.join(outputDir, 'USER_REPORT.md');
  try {
    const report = fs.statSync(reportPath);
    if (report.size === 0) throw new Error('报告为空');
    details.push('USER_REPORT.md 已生成');
  } catch (error) {
    details.push(`USER_REPORT.md 缺失或不可读：${error.message}`);
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
