import type { z } from 'zod';
import { getActiveAIConfigRow, requestJsonContent } from '../../discovery/aiGateway.js';
import { logger } from '../../services/logger.js';

/**
 * 主题研究复用现有 AI Gateway（同一 activeAIConfig、代理与超时策略）。
 * 所有 AI 输出必须通过 Zod 校验；失败时返回 null，由调用方使用规则兜底，
 * 绝不清空用户已有的 Research State。
 */

export interface ResearchAiResult<T> {
  data: T | null;
  source: 'ai' | 'rule';
  model: string | null;
  error?: string;
}

export function hasActiveAIConfig(): boolean {
  try {
    return Boolean(getActiveAIConfigRow());
  } catch {
    return false;
  }
}

export async function requestResearchJson<T>(
  scope: string,
  schema: z.ZodType<T>,
  prompt: string,
  maxTokens = 1600,
  temperature = 0.1,
): Promise<ResearchAiResult<T>> {
  let aiConfig: Record<string, unknown> | undefined;
  try {
    aiConfig = getActiveAIConfigRow();
  } catch {
    aiConfig = undefined;
  }
  if (!aiConfig) return { data: null, source: 'rule', model: null, error: 'NO_ACTIVE_AI_CONFIG' };
  try {
    const content = await requestJsonContent(aiConfig, prompt, maxTokens, temperature);
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      logger.warn(`research.${scope}`, 'AI 输出未通过 Schema 校验，使用规则兜底', { issues: parsed.error.issues.slice(0, 5) });
      return { data: null, source: 'rule', model: String(aiConfig.model ?? ''), error: 'SCHEMA_VALIDATION_FAILED' };
    }
    return { data: parsed.data, source: 'ai', model: String(aiConfig.model ?? '') };
  } catch (error) {
    logger.errorFromError(`research.${scope}`, 'AI 调用失败，使用规则兜底', error);
    return { data: null, source: 'rule', model: null, error: 'AI_REQUEST_FAILED' };
  }
}
