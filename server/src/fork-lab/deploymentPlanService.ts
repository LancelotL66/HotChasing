import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { fetchRepositoryEnrichment } from '../discovery/classificationService.js';
import { generateDeploymentPlan } from '../discovery/aiGateway.js';
import { requireProject, setProjectStatus } from './forkLabService.js';

export interface PlanResult {
  plan: Record<string, unknown>;
  cached: boolean;
  source: 'ai' | 'rule';
}

export function getPlan(projectId: string): Record<string, unknown> | null {
  return getDb().prepare('SELECT id,workspace_project_id,plan_json,plan_source,plan_version,locked,generated_at,updated_at FROM deployment_plans WHERE workspace_project_id=?').get(projectId) as Record<string, unknown> | null;
}

export async function generatePlan(projectId: string, force = false): Promise<PlanResult> {
  const project = requireProject(projectId);
  const db = getDb();
  const existing = getPlan(project.id);
  if (existing && existing.locked) {
    const error = new Error('Deployment plan is locked');
    (error as Error & { code?: string }).code = 'PLAN_LOCKED';
    throw error;
  }
  if (existing && !force) {
    return { plan: existing, cached: true, source: 'cached' as unknown as 'ai' };
  }
  const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  if (!repo) {
    const error = new Error('Repository not found');
    (error as Error & { code?: string }).code = 'REPOSITORY_NOT_FOUND';
    throw error;
  }
  const assessment = db.prepare('SELECT * FROM deployment_assessments WHERE repo_id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  if (!assessment) {
    const error = new Error('Deployment assessment required before generating plan');
    (error as Error & { code?: string }).code = 'ASSESSMENT_REQUIRED';
    throw error;
  }
  let parsedAssessment: Record<string, unknown>;
  try { parsedAssessment = JSON.parse(String(assessment.assessment_json)) as Record<string, unknown>; } catch { parsedAssessment = {}; }
  const { readme, architecture } = await fetchRepositoryEnrichment(repo);
  setProjectStatus(project.id, 'PLAN_GENERATING');
  try {
    const result = await generateDeploymentPlan(repo, parsedAssessment, readme, architecture);
    const now = new Date().toISOString();
    const planSource = result.source === 'ai' ? 'ai' : 'official';
    if (existing) {
      db.prepare('UPDATE deployment_plans SET plan_json=?,plan_source=?,plan_version=plan_version+1,generated_at=?,updated_at=? WHERE workspace_project_id=?')
        .run(JSON.stringify(result.planJson), planSource, now, now, project.id);
    } else {
      db.prepare('INSERT INTO deployment_plans (id,workspace_project_id,plan_json,plan_source,plan_version,locked,generated_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
        .run(randomUUID(), project.id, JSON.stringify(result.planJson), planSource, 1, now, now);
    }
    setProjectStatus(project.id, 'PLAN_READY');
    return { plan: getPlan(project.id) as Record<string, unknown>, cached: false, source: result.source };
  } catch (error) {
    setProjectStatus(project.id, 'FAILED');
    throw error;
  }
}

export function updatePlan(projectId: string, planJson: Record<string, unknown>): Record<string, unknown> {
  const project = requireProject(projectId);
  const existing = getPlan(project.id);
  if (!existing) {
    const error = new Error('Deployment plan not found');
    (error as Error & { code?: string }).code = 'PLAN_NOT_FOUND';
    throw error;
  }
  if (existing.locked) {
    const error = new Error('Deployment plan is locked');
    (error as Error & { code?: string }).code = 'PLAN_LOCKED';
    throw error;
  }
  const now = new Date().toISOString();
  getDb().prepare('UPDATE deployment_plans SET plan_json=?,plan_source=?,plan_version=plan_version+1,updated_at=? WHERE workspace_project_id=?')
    .run(JSON.stringify(planJson), 'manual', now, project.id);
  setProjectStatus(project.id, 'PLAN_READY');
  return getPlan(project.id) as Record<string, unknown>;
}

export function lockPlan(projectId: string): Record<string, unknown> {
  const project = requireProject(projectId);
  const existing = getPlan(project.id);
  if (!existing) {
    const error = new Error('Deployment plan not found');
    (error as Error & { code?: string }).code = 'PLAN_NOT_FOUND';
    throw error;
  }
  getDb().prepare('UPDATE deployment_plans SET locked=1,updated_at=? WHERE workspace_project_id=?').run(new Date().toISOString(), project.id);
  setProjectStatus(project.id, 'PLAN_READY');
  return getPlan(project.id) as Record<string, unknown>;
}

export function unlockPlan(projectId: string): Record<string, unknown> {
  const project = requireProject(projectId);
  const existing = getPlan(project.id);
  if (!existing) {
    const error = new Error('Deployment plan not found');
    (error as Error & { code?: string }).code = 'PLAN_NOT_FOUND';
    throw error;
  }
  getDb().prepare('UPDATE deployment_plans SET locked=0,updated_at=? WHERE workspace_project_id=?').run(new Date().toISOString(), project.id);
  return getPlan(project.id) as Record<string, unknown>;
}
