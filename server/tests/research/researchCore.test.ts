import { describe, expect, it } from 'vitest';
import { researchStateSchema, researchRequirementsSchema, type ResearchState } from '../../src/research/state/researchStateSchema.js';
import { applyOperations } from '../../src/research/state/researchStateReducer.js';
import { validateResearchState } from '../../src/research/state/researchConsistencyValidator.js';
import { buildStageQueries, buildSearchStrategy } from '../../src/research/github/githubQueryGenerator.js';
import { deduplicateCandidates, applyRuleFilters } from '../../src/research/github/githubCandidateFilter.js';
import { parseRequirementByRules } from '../../src/research/conversation/researchInitialParser.js';
import { analyzeImpact } from '../../src/research/conversation/researchImpactAnalyzer.js';
import { interpretByRules } from '../../src/research/conversation/researchChangeInterpreter.js';
import type { GithubSearchRepo } from '../../src/research/github/githubResearchClient.js';

function baseState(overrides: Partial<ResearchState> = {}): ResearchState {
  return researchStateSchema.parse({
    topicId: 'topic-1',
    version: 1,
    title: '运动想象 EEG 分类工具研究',
    objective: '建立可在 Windows 本地运行的 EEG 分类研究工具链',
    originalRequirement: '我想研究使用深度学习识别运动想象脑电信号。',
    requirements: {
      domains: ['EEG', 'Signal Processing', 'Deep Learning'],
      languages: ['Python'],
      platforms: ['Windows'],
      localDeploymentPreferred: true,
      gpuAllowed: false,
      paidApiAllowed: false,
    },
    stages: [
      { id: 'data-processing', name: '数据处理', position: 0, required: true, inputs: ['EEG 文件'], outputs: ['Epochs'], toolRequirements: { keywords: ['eeg preprocessing'], languages: ['Python'] } },
      { id: 'modeling', name: '模型训练', position: 1, required: true, inputs: ['Epochs'], outputs: ['模型'] },
      { id: 'experiment-tracking', name: '实验追踪', position: 2, required: true },
      { id: 'visualization', name: '结果展示', position: 3, required: false },
    ],
    ...overrides,
  });
}

describe('Research State schema', () => {
  it('parses a valid minimal state and applies defaults', () => {
    const state = researchStateSchema.parse({ topicId: 't', version: 1, title: '主题', originalRequirement: '研究' });
    expect(state.requirements.languages).toEqual([]);
    expect(state.stages).toEqual([]);
    expect(state.workflow).toBeNull();
    expect(state.consistencyStatus).toBe('CONSISTENT');
    expect(typeof state.updatedAt).toBe('string');
  });

  it('rejects missing required fields and unknown enum values', () => {
    expect(() => researchStateSchema.parse({ topicId: 't', title: '主题' })).toThrow();
    expect(() => researchRequirementsSchema.parse({ gpuAllowed: 'yes' })).toThrow();
  });
});

describe('Research State reducer', () => {
  it('deleting a stage moves its tools to UNASSIGNED instead of deleting them', () => {
    const state = baseState();
    const withTool = applyOperations(state, [{
      type: 'SELECT_TOOL',
      githubNodeId: 'node-mlflow',
      fullName: 'mlflow/mlflow',
      stageId: 'experiment-tracking',
      selectionRole: 'PRIMARY',
    }], 'USER_CONFIRMED');
    expect(withTool.state.selectedTools).toHaveLength(1);

    const afterDelete = applyOperations(withTool.state, [{ type: 'DELETE_STAGE', stageId: 'experiment-tracking' }], 'USER_CONFIRMED');
    const tool = afterDelete.state.selectedTools[0];
    expect(tool.status).toBe('UNASSIGNED');
    expect(tool.stageId).toBe('');
    expect(afterDelete.state.stages.some((stage) => stage.id === 'experiment-tracking')).toBe(false);
  });

  it('does not overwrite locked objective or locked stages', () => {
    const state = baseState({ locks: { objective: true, 'stage:modeling': true } });
    const result = applyOperations(state, [
      { type: 'UPDATE_OBJECTIVE', objective: 'AI 试图改写目标' },
      { type: 'DELETE_STAGE', stageId: 'modeling' },
    ], 'AI_PROPOSED');
    expect(result.state.objective).toBe('建立可在 Windows 本地运行的 EEG 分类研究工具链');
    expect(result.state.stages.some((stage) => stage.id === 'modeling')).toBe(true);
    expect(result.rejectedOperations).toHaveLength(2);
  });

  it('splitting a stage keeps tools on the first part and marks them for reclassification', () => {
    const state = baseState();
    const withTool = applyOperations(state, [{
      type: 'SELECT_TOOL',
      githubNodeId: 'node-a',
      fullName: 'owner/tool-a',
      stageId: 'data-processing',
      selectionRole: 'PRIMARY',
    }], 'USER_CONFIRMED');
    const split = applyOperations(withTool.state, [{
      type: 'SPLIT_STAGE',
      stageId: 'data-processing',
      parts: [{ name: '数据清洗' }, { name: '特征提取' }],
    }], 'USER_CONFIRMED');
    expect(split.state.stages).toHaveLength(5);
    const tool = split.state.selectedTools[0];
    expect(tool.stageId).toBe(split.state.stages[0].id);
    expect(tool.status).toBe('NEEDS_RECLASSIFICATION');
  });

  it('merging stages consolidates tools with unique new stage', () => {
    const state = baseState();
    const withTools = applyOperations(state, [
      { type: 'SELECT_TOOL', githubNodeId: 'node-a', fullName: 'owner/a', stageId: 'data-processing', selectionRole: 'PRIMARY' },
      { type: 'SELECT_TOOL', githubNodeId: 'node-b', fullName: 'owner/b', stageId: 'modeling', selectionRole: 'PRIMARY' },
    ], 'USER_CONFIRMED');
    const merged = applyOperations(withTools.state, [{ type: 'MERGE_STAGES', stageIds: ['data-processing', 'modeling'], name: '数据处理与建模' }], 'USER_CONFIRMED');
    expect(merged.state.stages).toHaveLength(3);
    expect(merged.state.selectedTools.every((tool) => tool.stageId === merged.state.stages[0].id)).toBe(true);
  });

  it('marks stages with no candidates as NOT_STARTED after an add constraint', () => {
    const state = baseState({
      stages: [{ id: 'modeling', name: '模型训练', position: 0, required: true, searchStatus: 'COMPLETED', candidateCount: 26 }],
    });
    const result = applyOperations(state, [{ type: 'ADD_TOOL_CONSTRAINT', stageId: 'modeling', constraint: { minimumCandidates: 40 } }], 'USER_CONFIRMED');
    expect(result.state.stages[0].searchStatus).toBe('NOT_STARTED');
  });
});

describe('Consistency validator', () => {
  it('flags a GPU conflict when the constraint forbids GPU', () => {
    const state = researchStateSchema.parse({
      ...baseState(),
      selectedTools: [{ githubNodeId: 'node-cuda', fullName: 'owner/cuda-tool', stageId: 'modeling', role: 'MODELING', selectionRole: 'PRIMARY', status: 'ACTIVE', acquisitionMode: 'CLONE_UPSTREAM' }],
    });
    const result = validateResearchState(state, {
      'node-cuda': { language: 'Python', gpuRequired: true },
    });
    expect(result.status).toBe('CONFLICTED');
    expect(result.issues.some((issue) => issue.code === 'CONSTRAINT_GPU_CONFLICT')).toBe(true);
    expect(result.issues.find((issue) => issue.code === 'CONSTRAINT_GPU_CONFLICT')?.options).toHaveLength(4);
  });

  it('detects orphaned workflow stages referencing deleted tools', () => {
    const state = baseState();
    const withWorkflow = researchStateSchema.parse({
      ...state,
      workflow: {
        stages: [{ id: 'wf-1', name: '建模', researchStageId: 'modeling', toolIds: ['ghost-tool'] }],
        connections: [],
      },
    });
    const result = validateResearchState(withWorkflow);
    expect(result.status).toBe('NEEDS_WORKFLOW_UPDATE');
    expect(result.issues.some((issue) => issue.code === 'WORKFLOW_TOOL_REMOVED')).toBe(true);
  });

  it('does not invent constraints when facts are missing', () => {
    const state = baseState();
    const result = validateResearchState(state, {});
    expect(result.status).toBe('NEEDS_PARTIAL_SEARCH');
  });
});

describe('GitHub query generator', () => {
  it('generates 3-8 queries per stage with qualifiers and topics', () => {
    const state = baseState();
    const strategy = buildSearchStrategy(state);
    expect(strategy.plans.length).toBeGreaterThanOrEqual(2);
    for (const plan of strategy.plans) {
      expect(plan.queries.length).toBeGreaterThanOrEqual(3);
      expect(plan.queries.length).toBeLessThanOrEqual(8);
      expect(plan.deduplicationGroup).toBe(`${plan.stageId}-v1`);
    }
  });

  it('bakes language constraint into queries and de-duplicates identical queries', () => {
    const state = baseState();
    const plan = buildStageQueries(state.stages[0], state);
    expect(plan.queries.some((query) => query.query.includes('language:Python'))).toBe(true);
    const queries = plan.queries.map((query) => query.query);
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('Candidate dedup and filters', () => {
  function repo(id: string, fullName: string, overrides: Partial<GithubSearchRepo> = {}): GithubSearchRepo {
    return {
      nodeId: id,
      owner: fullName.split('/')[0],
      name: fullName.split('/')[1],
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      description: 'A tool',
      defaultBranch: 'main',
      primaryLanguage: 'Python',
      topics: [],
      licenseSpdx: 'MIT',
      stars: 10,
      forks: 2,
      openIssues: 1,
      archived: false,
      disabled: false,
      isFork: false,
      parentFullName: null,
      pushedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('folds duplicates by node_id and by fork parent', () => {
    const raw = [
      { repo: repo('n1', 'owner/a'), stageId: 'data-processing', sourceQuery: 'q1' },
      { repo: repo('n1', 'owner/a'), stageId: 'modeling', sourceQuery: 'q2' },
      { repo: repo('n2', 'other/b', { isFork: true, parentFullName: 'owner/a', stars: 5 }), stageId: 'data-processing', sourceQuery: 'q3' },
    ];
    const deduped = deduplicateCandidates(raw);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].stageIds.sort()).toEqual(['data-processing', 'modeling']);
  });

  it('excludes archived and empty repos but never by stars alone', () => {
    const state = baseState();
    const { kept, excluded } = applyRuleFilters([
      { repo: repo('n1', 'owner/archived', { archived: true }), stageIds: [], sourceQueries: [] },
      { repo: repo('n2', 'owner/empty', { description: null, topics: [], stars: 0 }), stageIds: [], sourceQueries: [] },
      { repo: repo('n3', 'owner/zero-star'), stageIds: [], sourceQueries: [] },
    ], state);
    expect(kept).toHaveLength(1);
    expect(excluded.map((item) => item.fullName)).toContain('owner/archived');
    expect(kept[0].repo.fullName).toBe('owner/zero-star');
  });
});

describe('Initial requirement parser (rules fallback)', () => {
  it('parses a long Chinese requirement into stages and constraints', () => {
    const result = parseRequirementByRules('我想研究使用深度学习识别运动想象脑电信号。希望使用公开数据集，主要使用 Python。需要数据下载、滤波、时频分析、特征处理、CNN 或 Transformer 建模、实验追踪和可视化工具。最好支持 Windows 本地运行，不希望使用付费 API。');
    expect(result.stages.length).toBeGreaterThanOrEqual(2);
    expect(result.requirements.languages).toContain('Python');
    expect(result.requirements.platforms).toContain('Windows');
    expect(result.requirements.gpuAllowed).toBe(true);
    expect(result.requirements.paidApiAllowed).toBe(false);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it('detects no-GPU intent', () => {
    const result = parseRequirementByRules('不需要 GPU，只需要 CPU 就能运行的量化回测工具。');
    expect(result.requirements.gpuAllowed).toBe(false);
  });

  it('preserves the original input in the topic (createTopic keeps requirement)', () => {
    expect(parseRequirementByRules('一句话需求。').title.length).toBeGreaterThan(0);
  });
});

describe('Impact analyzer', () => {
  it('classifies a full re-search when the core subject changes', () => {
    const state = baseState();
    const impact = analyzeImpact(state, [{ type: 'UPDATE_OBJECTIVE', objective: '改为研究量化投资' }]);
    expect(impact.fullSearchRequired).toBe(true);
    expect(impact.workflowRegenerationRequired).toBe(true);
    expect(impact.forkPlanAffected).toBe(true);
  });

  it('classifies adding a stage as partial search only for that stage', () => {
    const state = baseState();
    const impact = analyzeImpact(state, [{ type: 'ADD_STAGE', name: '模型解释', description: '' }]);
    expect(impact.fullSearchRequired).toBe(false);
    expect(impact.searchRequired.some((stage) => stage === '模型解释')).toBe(true);
    expect(impact.workflowRegenerationRequired).toBe(true);
  });
});

describe('Change interpreter rules', () => {
  it('maps 删除实验追踪 to a DELETE_STAGE operation', () => {
    const state = baseState();
    const result = interpretByRules(state, '删除实验追踪环节');
    expect(result.operations).toEqual([{ type: 'DELETE_STAGE', stageId: 'experiment-tracking' }]);
    expect(result.needsClarification).toBe(false);
  });

  it('maps 增加模型解释 to ADD_STAGE after evaluation', () => {
    const state = baseState();
    const result = interpretByRules(state, '在模型训练之后增加模型解释环节');
    expect(result.operations[0].type).toBe('ADD_STAGE');
    expect((result.operations[0] as { name: string }).name).toBe('模型解释');
  });

  it('returns needsClarification for unknown messages instead of guessing', () => {
    const state = baseState();
    const result = interpretByRules(state, '今天天气不错');
    expect(result.needsClarification).toBe(true);
    expect(result.operations).toEqual([]);
  });
});
