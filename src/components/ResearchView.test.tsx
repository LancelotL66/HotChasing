import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const testState = {
  schemaVersion: 1,
  topicId: 'topic-1',
  version: 2,
  title: 'EEG 分类工具研究',
  objective: '建立 EEG 分类研究工具链',
  originalRequirement: '研究脑电分类工具',
  requirements: { domains: ['EEG'], languages: ['Python'], platforms: ['Windows'], preferredExecution: ['LOCAL'], localDeploymentPreferred: true, gpuAllowed: false, paidApiAllowed: false, externalNetworkAllowed: true, licenseRequired: false, excludedProductForms: [], extraConstraints: [] },
  stages: [
    { id: 'data-processing', name: '数据处理', description: '', position: 0, required: true, locked: false, source: 'AI_GENERATED', inputs: [], outputs: [], toolRequirements: { languages: ['Python'], minimumCandidates: 10, localDeploymentPreferred: true, gpuAllowed: false, allowedProductForms: [], keywords: ['eeg'] }, searchStatus: 'COMPLETED', candidateCount: 26, selectedToolIds: [], version: 1 },
    { id: 'modeling', name: '模型训练', description: '', position: 1, required: true, locked: false, source: 'AI_GENERATED', inputs: [], outputs: [], toolRequirements: { languages: ['Python'], minimumCandidates: 10, localDeploymentPreferred: true, gpuAllowed: false, allowedProductForms: [], keywords: [] }, searchStatus: 'COMPLETED', candidateCount: 14, selectedToolIds: [], version: 1 },
  ],
  selectedTools: [],
  workflow: null,
  locks: {},
  fieldSources: {},
  assumptions: [],
  unresolvedIssues: [],
  consistencyStatus: 'CONSISTENT',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

vi.mock('../services/researchApi', () => ({
  researchApi: {
    listTopics: vi.fn(async () => ({
      topics: [
        {
          id: 'topic-1',
          title: 'EEG 分类工具研究',
          original_requirement: '研究脑电分类工具',
          status: 'READY',
          current_state_version: 2,
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
          state: testState,
          consistency: { status: 'CONSISTENT', issues: [] },
          stageCount: 2,
          selectedToolCount: 0,
          hasWorkflow: false,
        },
      ],
    })),
    getState: vi.fn(async () => ({ state: testState, consistency: { status: 'CONSISTENT', issues: [] } })),
    getToolkit: vi.fn(async () => ({ toolkit: { rows: [], unassigned: [], excluded: [], reminders: [], gaps: [], duplicates: [] } })),
    getThemePlan: vi.fn(async () => ({ workflow: null })),
    createTopic: vi.fn(),
    parseTopic: vi.fn(),
    deleteTopic: vi.fn(),
    createProposal: vi.fn(),
    applyProposal: vi.fn(),
    rejectProposal: vi.fn(),
    runSearch: vi.fn(),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    analyzeCandidate: vi.fn(),
    selectTool: vi.fn(),
    updateTool: vi.fn(),
    removeTool: vi.fn(),
    findAlternatives: vi.fn(),
    checkCompatibility: vi.fn(),
    generateThemePlan: vi.fn(),
    saveToForkLab: vi.fn(),
  },
}));

import { researchApi } from '../services/researchApi';
import { ResearchView } from './ResearchView';

describe('ResearchView', () => {
  beforeEach(() => {
    vi.mocked(researchApi.listTopics).mockClear();
  });

  it('renders topics from the backend and shows the create box', async () => {
    render(<ResearchView />);
    await waitFor(() => expect(screen.getByText('EEG 分类工具研究')).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/描述研究需求/)).toBeInTheDocument();
    expect(screen.getByText('创建研究主题')).toBeInTheDocument();
  });

  it('selects a topic and exposes the four research tabs', async () => {
    render(<ResearchView />);
    await waitFor(() => expect(screen.getByText('EEG 分类工具研究')).toBeInTheDocument());
    fireEvent.click(screen.getByText('EEG 分类工具研究'));
    await waitFor(() => expect(screen.getByText('需求与对话')).toBeInTheDocument());
    expect(screen.getByText('工具推荐')).toBeInTheDocument();
    expect(screen.getByText('我的工具链')).toBeInTheDocument();
    expect(screen.getByText('主题主线')).toBeInTheDocument();
    expect(screen.getByText('数据处理')).toBeInTheDocument();
  });
});
