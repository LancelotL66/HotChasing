import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../../helpers/fakeDb.js';

let fakeDb: FakeDb;

vi.mock('../../../src/db/connection.js', () => ({
  getDb: () => fakeDb,
}));

vi.mock('../../../src/research/ai/researchAi.js', () => ({
  requestResearchJson: vi.fn(async () => ({ data: null, source: 'rule', model: null })),
  hasActiveAIConfig: vi.fn(() => false),
}));

vi.mock('../../../src/research/github/githubResearchClient.js', () => ({
  searchRepositories: vi.fn(async () => ({
    repos: [{ nodeId: 'n1', owner: 'mne-tools', name: 'mne-python', fullName: 'mne-tools/mne-python', htmlUrl: 'https://github.com/mne-tools/mne-python', description: 'MNE software for processing MEG and EEG data', defaultBranch: 'main', primaryLanguage: 'Python', topics: ['eeg', 'neuroscience'], licenseSpdx: 'BSD-3-Clause', stars: 2600, forks: 900, openIssues: 120, archived: false, disabled: false, isFork: false, parentFullName: null, pushedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }],
    totalCount: 1,
    status: 'OK' as const,
  })),
  upsertRepositoryCache: vi.fn(),
  getCachedRepository: vi.fn(() => ({
    github_node_id: 'n1',
    owner: 'mne-tools',
    name: 'mne-python',
    full_name: 'mne-tools/mne-python',
    html_url: 'https://github.com/mne-tools/mne-python',
    description: 'MNE software for processing MEG and EEG data',
    default_branch: 'main',
    primary_language: 'Python',
    topics_json: '["eeg","neuroscience"]',
    license_spdx: 'BSD-3-Clause',
    stars: 2600,
    forks: 900,
    open_issues: 120,
    archived: 0,
    disabled: 0,
    is_fork: 0,
    parent_full_name: null,
    pushed_at: '2026-07-01T00:00:00.000Z',
    github_updated_at: '2026-07-01T00:00:00.000Z',
    metadata_fetched_at: '2026-07-01T00:00:00.000Z',
  })),
  rateLimitResetAt: vi.fn(() => null),
  isRateLimited: vi.fn(() => false),
}));

vi.mock('../../../src/research/github/githubRepositoryEnricher.js', () => ({
  enrichRepository: vi.fn(async () => ({
    readmeText: '# MNE-Python\n读 EEG 数据并滤波。',
    readmeHash: 'abc',
    rootFiles: ['file:README.md', 'file:pyproject.toml'],
    deploymentFiles: ['pyproject.toml'],
    fromCache: false,
    partial: false,
  })),
  getAnalysisCache: vi.fn(() => undefined),
  saveStructuredAnalysis: vi.fn(),
}));

vi.mock('../../../src/research/analysis/researchToolAnalyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/research/analysis/researchToolAnalyzer.js')>();
  return {
    ...actual,
    analyzeTool: vi.fn(async (repo: { nodeId: string; fullName: string }, _enrichment, _state, fallbackStageIds: string[]) => ({
      analysis: {
        schemaVersion: 1,
        githubNodeId: repo.nodeId,
        repository: repo.fullName,
        name: 'MNE-Python',
        stageIds: fallbackStageIds,
        roles: ['DATA_PROCESSING'],
        summary: '处理脑电数据的 Python 工具',
        roleInTheme: '负责读取、滤波与切分 EEG 数据',
        howUserWouldUseIt: [],
        inputs: ['EEG 文件'],
        outputs: ['Epochs'],
        productForm: ['LIBRARY'],
        deployment: { localSupported: true, dockerAvailable: false, gpuRequired: false, credentialsRequired: false, paidApiRequired: false, preferredAcquisitionMode: 'PACKAGE' },
        advantages: [],
        limitations: [],
        maintenance: { status: 'ACTIVE', evidence: '最近推送' },
        replicationSuitability: 'HIGH',
        evidenceLevel: 'README_ONLY',
        recommendationReason: '测试',
      },
      source: 'rule' as const,
      model: null,
    })),
  };
});

const { default: researchRouter } = await import('../../../src/routes/research.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(researchRouter);
  return app;
}

describe('Research routes (M1-M6, rule fallback)', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
  });

  it('creates a topic with the raw requirement preserved and v1 state', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/research/topics')
      .send({ requirement: '我想研究使用深度学习识别运动想象脑电信号，主要使用 Python。' })
      .expect(201);
    expect(response.body.topic.original_requirement).toContain('运动想象脑电信号');
    expect(response.body.topic.state.version).toBe(1);
    expect(response.body.topic.state.stages).toHaveLength(0);
  });

  it('rejects empty requirements', async () => {
    const app = createTestApp();
    await request(app).post('/api/research/topics').send({ requirement: '   ' }).expect(400);
  });

  it('parses a long requirement into stages via rules when AI is unavailable', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: '需要数据下载、滤波、时频分析、特征处理、CNN 或 Transformer 建模、实验追踪和可视化工具。最好支持 Windows 本地运行，不希望使用付费 API。' }).expect(201);
    const parsed = await request(app).post(`/api/research/topics/${created.body.topic.id}/parse`).expect(200);
    expect(parsed.body.source).toBe('rule');
    expect(parsed.body.topic.state.stages.length).toBeGreaterThanOrEqual(2);
    expect(parsed.body.topic.state.requirements.paidApiAllowed).toBe(false);
    expect(parsed.body.topic.status).toBe('READY');
  });

  it('creates a change proposal from natural language and applies it after confirmation', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: '需要数据下载、滤波、特征处理、模型训练、实验追踪和可视化工具。' }).expect(201);
    const topicId = created.body.topic.id;
    await request(app).post(`/api/research/topics/${topicId}/parse`).expect(200);

    const proposal = await request(app)
      .post(`/api/research/topics/${topicId}/change-proposals`)
      .send({ userMessage: '删除实验追踪环节' })
      .expect(201);
    expect(proposal.body.proposal.operations).toEqual([{ type: 'DELETE_STAGE', stageId: 'experiment-tracking' }]);
    expect(proposal.body.status).toBe('READY_FOR_CONFIRMATION');
    expect(proposal.body.proposal.impact.forkPlanAffected).toBe(true);

    const applied = await request(app).post(`/api/research/topics/${topicId}/change-proposals/${proposal.body.id}/apply`).send({}).expect(200);
    expect(applied.body.state.stages.some((stage: { id: string }) => stage.id === 'experiment-tracking')).toBe(false);
    expect(applied.body.state.version).toBeGreaterThanOrEqual(3);
  });

  it('does not guess when the message is ambiguous', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: '研究需求' }).expect(201);
    const topicId = created.body.topic.id;
    const proposal = await request(app)
      .post(`/api/research/topics/${topicId}/change-proposals`)
      .send({ userMessage: '随便聊聊' })
      .expect(201);
    expect(proposal.body.status).toBe('NEEDS_CLARIFICATION');
    expect(proposal.body.proposal.operations).toEqual([]);
  });

  it('applies manual structured operations (drag-sort equivalent)', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: '研究脑电工具' }).expect(201);
    const topicId = created.body.topic.id;
    await request(app).post(`/api/research/topics/${topicId}/parse`).expect(200);
    const state = await request(app).get(`/api/research/topics/${topicId}/state`).expect(200);
    const order = state.body.state.stages.map((stage: { id: string }) => stage.id).reverse();
    const manual = await request(app)
      .post(`/api/research/topics/${topicId}/manual-operations`)
      .send({ operations: [{ type: 'REORDER_STAGE', stageOrder: order }], summary: '测试拖拽排序' })
      .expect(200);
    expect(manual.body.state.stages.map((stage: { id: string }) => stage.id)).toEqual(order);
  });

  it('runs a GitHub search end-to-end with mocked clients and stores candidates', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: 'EEG data processing' }).expect(201);
    const topicId = created.body.topic.id;
    await request(app).post(`/api/research/topics/${topicId}/parse`).expect(200);

    const search = await request(app).post(`/api/research/topics/${topicId}/search`).send({}).expect(200);
    expect(search.body.outcome.status).toBe('COMPLETED');
    expect(search.body.outcome.uniqueCount).toBeGreaterThan(0);

    const candidates = await request(app).get(`/api/research/topics/${topicId}/candidates`).expect(200);
    expect(candidates.body.candidates.length).toBeGreaterThan(0);
    expect(candidates.body.candidates[0].repo.fullName).toBe('mne-tools/mne-python');
  });

  it('selects a tool, shows toolkit, generates theme plan and saves to fork lab', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: 'EEG classification tools' }).expect(201);
    const topicId = created.body.topic.id;
    await request(app).post(`/api/research/topics/${topicId}/parse`).expect(200);
    await request(app).post(`/api/research/topics/${topicId}/search`).send({}).expect(200);

    const candidates = await request(app).get(`/api/research/topics/${topicId}/candidates`).expect(200);
    const candidate = candidates.body.candidates[0];
    const stageId = candidate.stage_id ?? candidate.analysis.stageIds[0];

    const selected = await request(app)
      .post(`/api/research/topics/${topicId}/tools`)
      .send({ githubNodeId: candidate.github_node_id, stageId, selectionRole: 'PRIMARY' })
      .expect(200);
    expect(selected.body.state.selectedTools).toHaveLength(1);
    expect(selected.body.state.selectedTools[0].selectionRole).toBe('PRIMARY');

    const toolkit = await request(app).get(`/api/research/topics/${topicId}/toolkit`).expect(200);
    expect(toolkit.body.toolkit.rows.length).toBeGreaterThan(0);
    expect(toolkit.body.toolkit.rows[0].coverage).toBe('已覆盖');

    const plan = await request(app).post(`/api/research/topics/${topicId}/generate-theme-plan`).send({}).expect(200);
    expect(plan.body.workflow.stages.length).toBeGreaterThan(0);
    expect(plan.body.source).toBe('rule');

    const saved = await request(app)
      .post(`/api/research/topics/${topicId}/save-to-fork-lab`)
      .send({ name: 'EEG 研究方案', description: '测试', testGoal: '验证 EEG 分类链路' })
      .expect(200);
    expect(saved.body.theme.researchTopicId).toBe(topicId);
    expect(saved.body.version.version).toBe(1);
    expect(saved.body.version.tools).toHaveLength(1);
    expect(saved.body.version.planJson.source).toBe('RESEARCH_GITHUB_SEARCH');
    expect(saved.body.version.planJson).not.toHaveProperty('dailyDigestSource');
    expect(saved.body.version.planJson).not.toHaveProperty('top100Rank');

    const themes = await request(app).get('/api/research/themes').expect(200);
    expect(themes.body.themes).toHaveLength(1);
  });

  it('returns 409 when saving a theme plan without a workflow', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: 'EEG classification tools' }).expect(201);
    const response = await request(app)
      .post(`/api/research/topics/${created.body.topic.id}/save-to-fork-lab`)
      .send({ name: '无主线方案' })
      .expect(409);
    expect(response.body.code).toBe('NO_THEME_WORKFLOW');
  });

  it('lists versions and produces a diff after a change', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/research/topics').send({ requirement: '研究脑电工具' }).expect(201);
    const topicId = created.body.topic.id;
    await request(app).post(`/api/research/topics/${topicId}/parse`).expect(200);
    const versions = await request(app).get(`/api/research/topics/${topicId}/versions`).expect(200);
    expect(versions.body.versions.length).toBe(2);

    const diff = await request(app).get(`/api/research/topics/${topicId}/versions/1/diff`).expect(200);
    expect(diff.body.diff.some((item: { field: string }) => item.field.startsWith('stage:'))).toBe(true);
  });
});
