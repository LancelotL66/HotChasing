import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../helpers/fakeDb.js';

let fakeDb: FakeDb;
vi.mock('../../src/db/connection.js', () => ({ getDb: () => fakeDb }));

const { default: deploymentRouter } = await import('../../src/routes/deployment.js');
const { default: runnersRouter } = await import('../../src/routes/runners.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(deploymentRouter);
  app.use(runnersRouter);
  return app;
}

function seedProject(projectId: string, repoId: number, withPlan = true) {
  const now = '2026-08-01T00:00:00.000Z';
  fakeDb.seed('fork_workspace_projects', [{
    id: projectId,
    repo_id: repoId,
    source: 'top100',
    upstream_full_name: 'owner/demo',
    fork_full_name: 'user/demo',
    fork_status: 'READY',
    upstream_commit_sha: 'abc123',
    test_branch: 'hotchasing/test/proj-1',
    project_status: 'PLAN_READY',
    selected_at: now,
    forked_at: now,
    archived_at: null,
  }]);
  fakeDb.seed('repositories', [{
    id: repoId,
    name: 'demo',
    full_name: 'owner/demo',
    html_url: 'https://github.com/owner/demo',
    description: 'A demo.',
    stargazers_count: 1000,
    language: 'TypeScript',
    created_at: now,
    updated_at: now,
    pushed_at: now,
    owner_login: 'owner',
    owner_avatar_url: '',
    topics: '[]',
  }]);
  fakeDb.seed('deployment_assessments', [{
    repo_id: repoId,
    value_score: 80,
    difficulty_score: 40,
    testability_score: 70,
    risk_score: 20,
    recommended_level: 'AGENT_ASSISTED_TEST',
    recommended_strategy: 'OFFICIAL_DOCKERFILE',
    assessment_json: '{"recommendedMethod":"OFFICIAL_DOCKERFILE","suspectedPorts":[3000]}',
    source_hash: 'hash',
    ai_config_id: null,
    confidence: 0.8,
    assessed_at: now,
  }]);
  if (withPlan) {
    fakeDb.seed('deployment_plans', [{
      id: `plan-${projectId}`,
      workspace_project_id: projectId,
      plan_json: JSON.stringify({ schemaVersion: 1, strategy: 'OFFICIAL_DOCKERFILE', summary: 'Docker 部署', testLevel: 'L2', steps: [{ id: 'build', type: 'docker_build' }] }),
      plan_source: 'ai',
      plan_version: 1,
      locked: 0,
      generated_at: now,
      updated_at: now,
    }]);
  }
}

describe('Deployment tasks and runners (M4/M5)', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
    seedProject('proj-1', 1);
    seedProject('proj-2', 2);
  });

  it('creates a batch and queued tasks from selected projects', async () => {
    const response = await request(createApp())
      .post('/api/deployment/batches')
      .send({ projectIds: ['proj-1', 'proj-2'], testLevel: 'L2', maxConcurrency: 2 })
      .expect(201);
    expect(response.body.tasks).toHaveLength(2);
    expect(response.body.tasks[0]).toMatchObject({ status: 'QUEUED', agent_id: 'manual', workspace_project_id: 'proj-1' });
    expect(response.body.tasks[0].project).toBeTruthy();
  });

  it('registers a runner and claims the next queued task with a bundle', async () => {
    const app = createApp();
    await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1'] }).expect(201);
    const reg = await request(app).post('/api/runners/register').send({ name: 'host-1', platform: 'windows' }).expect(201);
    const runnerId = reg.body.id;

    const claim = await request(app).post(`/api/runners/${runnerId}/claim-task`).expect(200);
    console.log('CLAIM_TASK', JSON.stringify(claim.body.task?.task));
    expect(claim.body.task).toBeTruthy();
    expect(claim.body.task.task).toMatchObject({ status: 'CLAIMED', runner_id: runnerId });
    expect(claim.body.task.plan).toMatchObject({ strategy: 'OFFICIAL_DOCKERFILE' });
    expect(claim.body.task.verification.checks).toHaveLength(2);
  });

  it('does not hand out the same task twice (mutual exclusion)', async () => {
    const app = createApp();
    await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1'] }).expect(201);
    const r1 = await request(app).post('/api/runners/register').send({ name: 'r1' }).expect(201);
    const r2 = await request(app).post('/api/runners/register').send({ name: 'r2' }).expect(201);

    const first = await request(app).post(`/api/runners/${r1.body.id}/claim-task`).expect(200);
    expect(first.body.task).toBeTruthy();
    const second = await request(app).post(`/api/runners/${r2.body.id}/claim-task`).expect(200);
    expect(second.body.task).toBeNull();
  });

  it('claims only a task explicitly selected by the user', async () => {
    const app = createApp();
    const created = await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1', 'proj-2'] }).expect(201);
    const selectedTask = created.body.tasks[1];
    const reg = await request(app).post('/api/runners/register').send({ name: 'desktop-runner' }).expect(201);

    const claim = await request(app).post(`/api/runners/${reg.body.id}/claim-task/${selectedTask.id}`).expect(200);
    expect(claim.body.task.task).toMatchObject({ id: selectedTask.id, status: 'CLAIMED', runner_id: reg.body.id });

    const otherTask = await request(app).get(`/api/deployment/tasks/${created.body.tasks[0].id}`).expect(200);
    expect(otherTask.body.task.status).toBe('QUEUED');
  });

  it('reports runner heartbeat', async () => {
    const app = createApp();
    const reg = await request(app).post('/api/runners/register').send({ name: 'host-1' }).expect(201);
    await request(app).post(`/api/runners/${reg.body.id}/heartbeat`).send({}).expect(200);
    const runner = fakeDb.tables.runner_agents.get(reg.body.id);
    expect(runner).toBeTruthy();
    expect(runner!.status).toBe('ONLINE');
    expect(runner!.last_heartbeat_at).toBeTruthy();
  });

  it('records events and logs, then completes a task into a local deployment', async () => {
    const app = createApp();
    await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1'] }).expect(201);
    const reg = await request(app).post('/api/runners/register').send({ name: 'host-1' }).expect(201);
    const claim = await request(app).post(`/api/runners/${reg.body.id}/claim-task`).expect(200);
    const taskId = claim.body.task.task.id;

    await request(app).post(`/api/runners/${reg.body.id}/tasks/${taskId}/events`)
      .send({ eventType: 'agent', stage: 'AGENT_PLANNING', message: 'agent started' }).expect(200);
    await request(app).post(`/api/runners/${reg.body.id}/tasks/${taskId}/events`)
      .send({ eventType: 'stage', stage: 'BUILDING', message: 'building' }).expect(200);
    const building = await request(app).get(`/api/deployment/tasks/${taskId}`).expect(200);
    expect(building.body.task).toMatchObject({ status: 'BUILDING', current_stage: 'BUILDING', progress: 55 });
    await request(app).post(`/api/runners/${reg.body.id}/tasks/${taskId}/logs`)
      .send({ lines: ['line1', 'line2'] }).expect(200);

    await request(app).post(`/api/runners/${reg.body.id}/tasks/${taskId}/complete`)
      .send({
        status: 'COMPLETED',
        stage: 'REPORTING',
        ports: [3000],
        workspacePath: 'D:/workspace/x',
        reportMarkdown: '# 项目本地部署测试报告\n\n## 1. 最终结论\n\n通过。',
        logsText: 'pytest: 302 passed',
      })
      .expect(200);

    const detail = await request(app).get(`/api/deployment/tasks/${taskId}`).expect(200);
    expect(detail.body.task.status).toBe('COMPLETED');
    expect(detail.body.events.length).toBeGreaterThanOrEqual(3);

    const deployments = await request(app).get('/api/local-deployments').expect(200);
    expect(deployments.body.deployments).toHaveLength(1);
    expect(deployments.body.deployments[0]).toMatchObject({ status: 'RUNNING', task_id: taskId });

    const reports = await request(app).get('/api/deployment/projects/proj-1/reports').expect(200);
    expect(reports.body.reports).toHaveLength(1);
    expect(reports.body.reports[0]).toMatchObject({ task_id: taskId, logs_text: 'pytest: 302 passed' });

    await request(app).delete(`/api/deployment/tasks/${taskId}`).expect(200);
    const reportsAfterTaskCleanup = await request(app).get('/api/deployment/projects/proj-1/reports').expect(200);
    expect(reportsAfterTaskCleanup.body.reports).toHaveLength(1);
  });

  it('cancels a queued task', async () => {
    const app = createApp();
    const created = await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1'] }).expect(201);
    const taskId = created.body.tasks[0].id;
    await request(app).post(`/api/deployment/tasks/${taskId}/cancel`).expect(200);
    const detail = await request(app).get(`/api/deployment/tasks/${taskId}`).expect(200);
    expect(detail.body.task.status).toBe('CANCELLED');
  });

  it('retries a failed task back to queued', async () => {
    const app = createApp();
    const created = await request(app).post('/api/deployment/batches').send({ projectIds: ['proj-1'] }).expect(201);
    const taskId = created.body.tasks[0].id;
    fakeDb.tables.deployment_tasks.get(taskId)!.status = 'FAILED';
    await request(app).post(`/api/deployment/tasks/${taskId}/retry`).expect(200);
    const detail = await request(app).get(`/api/deployment/tasks/${taskId}`).expect(200);
    expect(detail.body.task.status).toBe('QUEUED');
  });
});
