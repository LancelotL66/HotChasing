import { describe, expect, it } from 'vitest';
import { executionResultSchema, userReportSchema } from '../../src/local-testing/schemas.js';

describe('local testing report schemas', () => {
  it('requires separate deployment, startup, core workflow, and test suite statuses', () => {
    const result = {
      schemaVersion: 1, taskId: 'task-1',
      deployment: { status: 'SUCCESS', summary: '构建完成' },
      startup: { status: 'SUCCESS', summary: 'CLI 已启动' },
      coreWorkflow: { status: 'NOT_TESTED', summary: '缺少凭据' },
      testSuite: { status: 'PARTIAL', summary: '仅执行部分测试' },
      overallVerification: { status: 'PARTIALLY_VERIFIED' },
      startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T00:01:00.000Z',
    };
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect(executionResultSchema.safeParse({ ...result, status: 'passed' }).success).toBe(false);
  });

  it('rejects an unknown user-report verdict and unknown fields', () => {
    const base = {
      schemaVersion: 1,
      verdict: { deploymentValue: 'CONDITIONAL_USE', label: '有条件使用', confidence: 'PARTIALLY_VERIFIED', summary: '核心流程未验证', keepRecommendation: '继续测试' },
      bestFor: [], notFor: [], userProblemsSolved: [], usageSummary: [], featureTable: [], deploymentCostTable: [], comparisonTable: [], mainAdvantages: [], mainLimitations: [], verifiedCapabilities: [], documentationOnlyCapabilities: [], untestedCapabilities: [], failedCapabilities: [], chooseThisWhen: [], chooseAlternativesWhen: [], nextActions: [],
    };
    expect(userReportSchema.safeParse(base).success).toBe(true);
    expect(userReportSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(userReportSchema.safeParse({ ...base, verdict: { ...base.verdict, deploymentValue: '99' } }).success).toBe(false);
  });
});
