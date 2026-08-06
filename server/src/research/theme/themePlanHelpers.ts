import type { ResearchState, SelectedTool } from '../state/researchStateSchema.js';

export function activeSelectedTools(state: Pick<ResearchState, 'selectedTools'>): SelectedTool[] {
  return state.selectedTools.filter(
    (tool) => tool.status !== 'REMOVED_BY_USER' && tool.selectionRole !== 'EXCLUDED',
  );
}
