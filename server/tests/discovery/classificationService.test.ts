import { describe, expect, it } from 'vitest';
import { classifyProjectByRules, PRIMARY_CATEGORIES } from '../../src/discovery/classificationService.js';

describe('rule project classification', () => {
  it('assigns exactly one allowed primary category for an AI agent', () => {
    const result = classifyProjectByRules({ name: 'agent', description: 'An LLM agent with RAG and vector search.', topics: '["ai","agent","rag"]', language: 'TypeScript' });
    expect(result.primaryCategory).toBe('AI 与 Agent');
    expect(PRIMARY_CATEGORIES).toContain(result.primaryCategory);
    expect(result.functionTags).toEqual(expect.arrayContaining(['AI Agent', 'RAG', '向量检索']));
    expect(result.functionTags.length).toBeLessThanOrEqual(8);
  });

  it('does not classify Docker deployment as infrastructure when the core value is AI', () => {
    const result = classifyProjectByRules({ name: 'knowledge', description: 'An AI RAG application deployed with Docker.', topics: '["ai","docker","rag"]' });
    expect(result.primaryCategory).toBe('AI 与 Agent');
    expect(result.platformTags).toContain('Docker');
  });

  it('uses the fallback category for insufficient public information', () => {
    expect(classifyProjectByRules({ name: 'example' }).primaryCategory).toBe('其他 / 待分类');
  });

  it('classifies build-from-scratch programming resources as developer tools', () => {
    const result = classifyProjectByRules({ name: 'build-your-own-x', description: 'Master programming by recreating your favorite technologies from scratch.' });
    expect(result.primaryCategory).toBe('开发者工具');
    expect(result.functionTags).toContain('编程实践');
  });

  it('classifies resource indexes and interview curricula as learning and research', () => {
    expect(classifyProjectByRules({ name: 'awesome', description: 'Awesome lists about all kinds of interesting topics.' }).primaryCategory).toBe('学习与研究');
    expect(classifyProjectByRules({ name: 'coding-interview-university', description: 'A complete computer science study plan to become a software engineer.' }).primaryCategory).toBe('学习与研究');
  });

  it('uses reviewed category boundaries as shared fallback rules for both digest and Top100 callers', () => {
    expect(classifyProjectByRules({ description: 'A frontend framework.' }).primaryCategory).toBe('基础设施与 DevOps');
    expect(classifyProjectByRules({ description: 'Vue frontend framework.' }).primaryCategory).toBe('数据与数据库');
    expect(classifyProjectByRules({ description: 'Algorithms implemented in Python.' }).primaryCategory).toBe('开发者工具');
    expect(classifyProjectByRules({ description: 'A computer science curriculum.' }).primaryCategory).toBe('学习与研究');
  });
});
