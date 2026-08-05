import { z } from 'zod';

export const executionStatusSchema = z.enum(['SUCCESS', 'PARTIAL', 'FAILED', 'BLOCKED', 'NOT_ATTEMPTED']);
export const capabilityStatusSchema = z.enum(['VERIFIED_LOCAL', 'VERIFIED_SANDBOX', 'PARTIALLY_VERIFIED', 'DOCUMENTATION_ONLY', 'INFERRED', 'NOT_TESTED', 'BLOCKED', 'FAILED', 'NOT_APPLICABLE']);

export const executionResultSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  deployment: z.object({ status: executionStatusSchema, summary: z.string() }),
  startup: z.object({ status: executionStatusSchema, summary: z.string() }),
  coreWorkflow: z.object({ status: capabilityStatusSchema, summary: z.string() }),
  testSuite: z.object({ status: executionStatusSchema, summary: z.string() }),
  overallVerification: z.object({ status: z.enum(['VERIFIED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'BLOCKED']) }),
  startedAt: z.string(),
  finishedAt: z.string(),
}).strict();

export const capabilityMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), importance: z.enum(['CORE', 'IMPORTANT', 'OPTIONAL']),
    userValue: z.string(), verificationStatus: capabilityStatusSchema, experience: z.string(),
    limitations: z.array(z.string()), evidence: z.array(z.string()),
  }).strict()),
}).strict();

export const usagePlaybookSchema = z.object({
  schemaVersion: z.literal(1),
  representativeExample: z.object({ title: z.string(), userGoal: z.string(), projectContext: z.string(), steps: z.array(z.string()), userVisibleResult: z.string(), verificationStatus: capabilityStatusSchema }).strict(),
  firstTimeSetup: z.object({ prerequisites: z.array(z.string()), steps: z.array(z.object({ title: z.string(), command: z.string().optional(), expectedResult: z.string(), verificationStatus: capabilityStatusSchema }).strict()) }).strict(),
  dailyWorkflows: z.array(z.object({ title: z.string(), userGoal: z.string(), steps: z.array(z.string()), expectedOutcome: z.string(), verificationStatus: capabilityStatusSchema }).strict()),
  advancedWorkflows: z.array(z.unknown()),
  stopAndRemove: z.object({ stopSteps: z.array(z.string()), dataLocations: z.array(z.string()), cleanupSteps: z.array(z.string()) }).strict(),
}).strict();

export const userReportSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.object({ deploymentValue: z.enum(['KEEP_LONG_TERM', 'WORTH_TRYING', 'CONDITIONAL_USE', 'NICHE_USE_ONLY', 'WATCH_ONLY', 'NOT_WORTH_DEPLOYING', 'UNSAFE']), label: z.string(), confidence: z.enum(['FULLY_VERIFIED', 'MOSTLY_VERIFIED', 'PARTIALLY_VERIFIED', 'DOCUMENTATION_HEAVY', 'LOW_CONFIDENCE']), summary: z.string(), keepRecommendation: z.string() }).strict(),
  bestFor: z.array(z.string()), notFor: z.array(z.string()), userProblemsSolved: z.array(z.string()), usageSummary: z.array(z.string()),
  featureTable: z.array(z.unknown()), deploymentCostTable: z.array(z.unknown()), comparisonTable: z.array(z.unknown()),
  mainAdvantages: z.array(z.string()), mainLimitations: z.array(z.string()), verifiedCapabilities: z.array(z.string()), documentationOnlyCapabilities: z.array(z.string()), untestedCapabilities: z.array(z.string()), failedCapabilities: z.array(z.string()), chooseThisWhen: z.array(z.string()), chooseAlternativesWhen: z.array(z.string()), nextActions: z.array(z.string()),
}).strict();

export type ExecutionResult = z.infer<typeof executionResultSchema>;
