import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { fetchRepositoryEnrichment } from '../discovery/classificationService.js';
import { generateDeploymentAssessment } from '../discovery/aiGateway.js';
import { requireProject, setProjectStatus, type ProjectView } from './forkLabService.js';
import { refreshRepositoryFromGitHub } from '../discovery/projectRefreshService.js';

export function deploymentAssessmentSourceHash(repo: Record<string, unknown>, readme = '', architecture = ''): string {
  return createHash('sha256').update(JSON.stringify(['deployment-assessment-v1', repo.full_name, repo.description, repo.topics, repo.language, repo.license, repo.updated_at, readme, architecture])).digest('hex');
}

export interface AssessmentResult {
  assessment: Record<string, unknown>;
  cached: boolean;
  source: 'ai' | 'rule';
}

export async function ensureAssessment(projectId: string, force = false): Promise<AssessmentResult> {
  const project = requireProject(projectId);
  const db = getDb();
  const repo = await refreshRepositoryFromGitHub(project.repo_id) ?? db.prepare('SELECT * FROM repositories WHERE id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  if (!repo) {
    const error = new Error('Repository not found');
    (error as Error & { code?: string }).code = 'REPOSITORY_NOT_FOUND';
    throw error;
  }
  const { readme, architecture } = await fetchRepositoryEnrichment(repo);
  const sourceHash = deploymentAssessmentSourceHash(repo, readme, architecture);
  const existing = db.prepare('SELECT * FROM deployment_assessments WHERE repo_id=?').get(project.repo_id) as Record<string, unknown> | undefined;
  if (existing && !force && existing.source_hash === sourceHash) {
    return { assessment: existing, cached: true, source: 'cached' as unknown as 'ai' };
  }

  setProjectStatus(project.id, 'ASSESSING');
  try {
    const result = await generateDeploymentAssessment(repo, readme, architecture);
    db.prepare(`INSERT INTO deployment_assessments (repo_id,value_score,difficulty_score,testability_score,risk_score,recommended_level,recommended_strategy,assessment_json,source_hash,ai_config_id,confidence,assessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo_id) DO UPDATE SET
        value_score=excluded.value_score,
        difficulty_score=excluded.difficulty_score,
        testability_score=excluded.testability_score,
        risk_score=excluded.risk_score,
        recommended_level=excluded.recommended_level,
        recommended_strategy=excluded.recommended_strategy,
        assessment_json=excluded.assessment_json,
        source_hash=excluded.source_hash,
        ai_config_id=excluded.ai_config_id,
        confidence=excluded.confidence,
        assessed_at=excluded.assessed_at`)
      .run(
        project.repo_id,
        result.valueScore,
        result.difficultyScore,
        result.testabilityScore,
        result.riskScore,
        result.recommendedLevel,
        result.recommendedMethod,
        JSON.stringify(result.assessmentJson),
        sourceHash,
        result.aiConfigId,
        result.confidence,
        new Date().toISOString(),
      );
    setProjectStatus(project.id, 'ASSESSMENT_READY');
    const saved = db.prepare('SELECT * FROM deployment_assessments WHERE repo_id=?').get(project.repo_id) as Record<string, unknown>;
    return { assessment: saved, cached: false, source: result.source };
  } catch (error) {
    setProjectStatus(project.id, 'FAILED');
    throw error;
  }
}

export function getAssessment(projectId: string): Record<string, unknown> | null {
  const project = requireProject(projectId);
  return getDb().prepare('SELECT * FROM deployment_assessments WHERE repo_id=?').get(project.repo_id) as Record<string, unknown> | null;
}

export type { ProjectView };
