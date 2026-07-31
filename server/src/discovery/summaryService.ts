import { createHash } from 'node:crypto';

export function hotSummarySourceHash(repo: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([
    repo.name, repo.description, repo.topics, repo.language, repo.stargazers_count, repo.updated_at,
  ])).digest('hex');
}

export function ruleHotSummary(repo: Record<string, unknown>): string {
  const name = typeof repo.name === 'string' ? repo.name : '该项目';
  const language = typeof repo.language === 'string' && repo.language ? repo.language : '开源技术';
  const description = typeof repo.description === 'string' ? repo.description.trim() : '';
  if (!description) return `这是一个近期热度上升的开源项目 ${name}。当前可确认的信息有限，建议查看 README、Release 和后续调研结果。`;
  return `${name} 是一个以 ${language} 为主的开源项目，主要解决：${description.slice(0, 100)}。近期进入热门候选池，建议结合 README、Release 与后续调研结果判断是否适用。`;
}
