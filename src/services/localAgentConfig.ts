export type LocalAgentType = 'opencode' | 'claude-code' | 'codex' | 'manual';

export interface LocalAgentConfig {
  agent: LocalAgentType;
  runnerName: string;
  workspaceRoot: string;
  model: string;
  autoApprove: boolean;
  pureMode: boolean;
}

const KEY = 'hotchasing:local-agent-config';
const fallback: LocalAgentConfig = { agent: 'opencode', runnerName: '', workspaceRoot: '', model: '', autoApprove: false, pureMode: false };

export function getLocalAgentConfig(): LocalAgentConfig {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LocalAgentConfig>;
    return {
      agent: ['opencode', 'claude-code', 'codex', 'manual'].includes(value.agent ?? '') ? value.agent as LocalAgentType : fallback.agent,
      runnerName: typeof value.runnerName === 'string' ? value.runnerName : '',
      workspaceRoot: typeof value.workspaceRoot === 'string' ? value.workspaceRoot : '',
      model: typeof value.model === 'string' ? value.model : '',
      autoApprove: value.autoApprove === true,
      pureMode: value.pureMode === true,
    };
  } catch {
    return fallback;
  }
}

export function saveLocalAgentConfig(config: LocalAgentConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}
