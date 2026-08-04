import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForkLabView } from './ForkLabView';
import { forkLabApi, type ForkLabProject } from '../services/forkLabApi';

vi.mock('../services/backendAdapter', () => ({
  backend: { backendUrl: 'http://test/api' },
}));

vi.mock('../services/forkLabApi', () => ({
  forkLabApi: {
    listProjects: vi.fn(),
    getProject: vi.fn(),
    generateAssessment: vi.fn(),
    generatePlan: vi.fn(),
    updatePlan: vi.fn(),
    lockPlan: vi.fn(),
    unlockPlan: vi.fn(),
    removeProject: vi.fn(),
    forkProject: vi.fn(),
    createTask: vi.fn(),
  },
}));

vi.mock('../services/deploymentApi', () => ({
  deploymentApi: {
    createBatch: vi.fn(),
    listBatches: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    markManual: vi.fn(),
    listDeployments: vi.fn(),
    listRunners: vi.fn(),
  },
}));

const mockForkLabApi = vi.mocked(forkLabApi);
const { deploymentApi } = await import('../services/deploymentApi');
const mockDeploymentApi = vi.mocked(deploymentApi);

function createProject(overrides: Partial<ForkLabProject> = {}): ForkLabProject {
  return {
    id: 'proj-1',
    repo_id: 1,
    source: 'digest',
    upstream_full_name: 'owner/demo-app',
    fork_full_name: null,
    fork_status: 'NOT_REQUESTED',
    upstream_commit_sha: null,
    test_branch: null,
    project_status: 'SELECTED',
    selected_at: '2026-08-01T00:00:00.000Z',
    forked_at: null,
    archived_at: null,
    repo: {
      id: 1,
      full_name: 'owner/demo-app',
      language: 'TypeScript',
      stargazers_count: 1200,
      topics: '["ai","agent"]',
      hot_summary_zh: '一个用于开发者的 AI 智能体。',
    },
    assessment: null,
    plan: null,
    ...overrides,
  };
}

describe('ForkLabView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForkLabApi.listProjects.mockResolvedValue({ projects: [createProject()] });
    mockForkLabApi.getProject.mockImplementation(async (id: string) => ({ project: createProject({ id }) }));
    mockDeploymentApi.listTasks.mockResolvedValue({ tasks: [] });
    mockDeploymentApi.listDeployments.mockResolvedValue({ deployments: [] });
    mockDeploymentApi.listRunners.mockResolvedValue({ runners: [] });
  });

  it('renders the direct-test workflow tabs', async () => {
    render(<ForkLabView />);
    expect(await screen.findByText('项目库')).toBeTruthy();
    expect(screen.getByText('测试中')).toBeTruthy();
    expect(screen.getAllByText('已部署').length).toBeGreaterThan(0);
    expect(screen.getByText('失败与受限')).toBeTruthy();
  });

  it('loads and renders library projects', async () => {
    render(<ForkLabView />);
    expect(await screen.findByText('owner/demo-app')).toBeTruthy();
    expect(screen.getByText(/来源：日报/)).toBeTruthy();
    expect(screen.getByText('一个用于开发者的 AI 智能体。')).toBeTruthy();
  });

  it('filters library projects by status', async () => {
    mockForkLabApi.listProjects.mockResolvedValue({
      projects: [
        createProject({ id: 'p1', repo_id: 1, assessment: null, plan: null }),
        createProject({
          id: 'p2',
          repo_id: 2,
          upstream_full_name: 'owner/assessed-app',
          assessment: { repo_id: 2, value_score: 84, difficulty_score: 42, testability_score: 78, risk_score: 21, recommended_level: 'AGENT_ASSISTED_TEST', recommended_strategy: 'OFFICIAL_DOCKERFILE', assessment_json: '{"deploymentValueScore":84}', source_hash: 'h', ai_config_id: null, confidence: 0.8, assessed_at: '2026-08-01T00:00:00.000Z' },
          plan: null,
        }),
      ],
    });
    render(<ForkLabView />);
    expect(await screen.findByText('owner/demo-app')).toBeTruthy();
    expect(screen.getByText('owner/assessed-app')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '待分析' }));
    expect(screen.queryByText('owner/assessed-app')).toBeNull();
    expect(screen.getByText('owner/demo-app')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '分析完成' }));
    expect(screen.queryByText('owner/demo-app')).toBeNull();
    expect(screen.getByText('owner/assessed-app')).toBeTruthy();
  });

  it('shows the batch action bar after selecting a project', async () => {
    render(<ForkLabView />);
    await screen.findByText('owner/demo-app');
    const checkbox = screen.getByLabelText('选择 owner/demo-app') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(await screen.findByText(/已选 1 项/)).toBeTruthy();
    expect(screen.getByText('批量生成部署分析')).toBeTruthy();
    expect(screen.getByText('批量生成建议流程')).toBeTruthy();
  });

  it('runs batch assessment for selected projects', async () => {
    mockForkLabApi.generateAssessment.mockResolvedValue({ assessment: { repo_id: 1 } as never, cached: false, source: 'ai' });
    render(<ForkLabView />);
    await screen.findByText('owner/demo-app');
    fireEvent.click(screen.getByLabelText('选择 owner/demo-app'));
    fireEvent.click(await screen.findByText('批量生成部署分析'));
    await waitFor(() => expect(mockForkLabApi.generateAssessment).toHaveBeenCalledWith('proj-1'));
    await waitFor(() => expect(screen.getByText(/批量操作完成/)).toBeTruthy());
  });

  it('generates a plan and opens the editor, then saves edits', async () => {
    mockForkLabApi.generatePlan.mockResolvedValue({
      plan: {
        id: 'plan-1',
        workspace_project_id: 'proj-1',
        plan_json: JSON.stringify({ schemaVersion: 1, strategy: 'OFFICIAL_DOCKERFILE', summary: '使用 Dockerfile 构建', testLevel: 'L2', steps: [{ id: 'build', type: 'docker_build' }] }),
        plan_source: 'ai',
        plan_version: 1,
        locked: 0,
        generated_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      cached: false,
      source: 'ai',
    });
    mockForkLabApi.updatePlan.mockImplementation(async (_id: string, _plan: Record<string, unknown>) => ({
      plan: {
        id: 'plan-1',
        workspace_project_id: 'proj-1',
        plan_json: JSON.stringify({ ..._plan, summary: '手动修改后的摘要' }),
        plan_source: 'manual',
        plan_version: 2,
        locked: 0,
        generated_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
    }));
    mockForkLabApi.getProject.mockImplementation(async (id: string) => ({
      project: createProject({
        id,
        assessment: {
          repo_id: 1, value_score: 84, difficulty_score: 42, testability_score: 78, risk_score: 21,
          recommended_level: 'AGENT_ASSISTED_TEST', recommended_strategy: 'OFFICIAL_DOCKERFILE',
          assessment_json: '{"deploymentValueScore":84}', source_hash: 'h', ai_config_id: null, confidence: 0.8,
          assessed_at: '2026-08-01T00:00:00.000Z',
        },
        plan: {
          id: 'plan-1', workspace_project_id: id, plan_json: JSON.stringify({ schemaVersion: 1, strategy: 'OFFICIAL_DOCKERFILE', summary: '使用 Dockerfile 构建', testLevel: 'L2', steps: [{ id: 'build', type: 'docker_build' }] }), plan_source: 'ai', plan_version: 1, locked: 0, generated_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
        },
      }),
    }));

    render(<ForkLabView />);
    await screen.findByText('owner/demo-app');
    fireEvent.click(screen.getByText('生成建议流程'));

    await waitFor(() => expect(mockForkLabApi.generatePlan).toHaveBeenCalledWith('proj-1'));
    expect(await screen.findByText('编辑部署计划')).toBeTruthy();

    const summaryInput = screen.getByDisplayValue('使用 Dockerfile 构建');
    fireEvent.change(summaryInput, { target: { value: '手动修改后的摘要' } });
    fireEvent.click(screen.getByText('保存修改'));
    await waitFor(() => expect(mockForkLabApi.updatePlan).toHaveBeenCalled());
  });

  it('removes a project from the library', async () => {
    mockForkLabApi.removeProject.mockResolvedValue({ deleted: true });
    render(<ForkLabView />);
    await screen.findByText('owner/demo-app');
    fireEvent.click(screen.getByText('从实验室移除'));
    await waitFor(() => expect(mockForkLabApi.removeProject).toHaveBeenCalledWith('proj-1'));
  });

  it('shows deployed projects in the deployed tab', async () => {
    mockDeploymentApi.listDeployments.mockResolvedValue({
      deployments: [{
        id: 'dep-1',
        workspace_project_id: 'proj-1',
        task_id: 'task-1',
        runner_id: 'runner-1',
        workspace_path: 'D:/workspace/task-1',
        container_names_json: '[]',
        ports_json: '[3000]',
        status: 'RUNNING',
        started_at: '2026-08-01T00:00:00.000Z',
        stopped_at: null,
        project: { upstream_full_name: 'owner/demo-app', source: 'top100' },
      }],
    });
    render(<ForkLabView />);
    await screen.findByText('项目库');
    fireEvent.click(screen.getAllByRole('button', { name: '已部署' })[0]);
    expect(await screen.findByText('owner/demo-app')).toBeTruthy();
    expect(screen.getByText(/端口：3000/)).toBeTruthy();
  });
});
