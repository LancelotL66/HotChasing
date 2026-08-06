import type { ChangeOperation } from './researchOperations.js';
import {
  researchStageSchema,
  researchStateSchema,
  selectedToolSchema,
  themeWorkflowSchema,
  type ResearchStage,
  type ResearchState,
  type ValueSource,
} from './researchStateSchema.js';

/**
 * Research State Reducer：唯一允许写入 Research State 的地方。
 *
 * 规则：
 * - 被锁定的字段不得被 AI 覆盖（USER_MANUAL_EDIT / USER_CONFIRMED 也需要先解锁，避免静默覆盖）。
 * - 删除研究环节后，环节上的工具不能被静默删除，只能变为 UNASSIGNED。
 * - 结构变化后重新编号 position，并把受影响环节的 searchStatus 退回 NOT_STARTED。
 */

export interface ReducerResult {
  state: ResearchState;
  warnings: string[];
  rejectedOperations: Array<{ type: string; reason: string }>;
  changedStageIds: string[];
  workflowNeedsRegeneration: boolean;
}

export function stageIdFromName(name: string, existing: string[]): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = /^[a-z0-9-]+$/.test(ascii) && ascii.length > 0 ? ascii : `stage-${existing.length + 1}`;
  if (!existing.includes(base)) return base;
  let index = 2;
  while (existing.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renumber(stages: ResearchStage[]): ResearchStage[] {
  return stages.map((stage, index) => ({ ...stage, position: index }));
}

function isLocked(state: ResearchState, path: string): boolean {
  return state.locks[path] === true;
}

function markSource(state: ResearchState, path: string, source: ValueSource): void {
  state.fieldSources[path] = source;
}

function newStage(input: {
  id: string;
  name: string;
  description?: string;
  required?: boolean;
  inputs?: string[];
  outputs?: string[];
  keywords?: string[];
  source: ResearchStage['source'];
  position: number;
}): ResearchStage {
  return researchStageSchema.parse({
    id: input.id,
    name: input.name,
    description: input.description ?? '',
    position: input.position,
    required: input.required ?? true,
    locked: false,
    source: input.source,
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    toolRequirements: { keywords: input.keywords ?? [] },
    searchStatus: 'NOT_STARTED',
    candidateCount: 0,
    selectedToolIds: [],
    version: 1,
  });
}

function syncStageToolIds(state: ResearchState): void {
  const byStage = new Map<string, string[]>();
  for (const tool of state.selectedTools) {
    if (tool.status === 'REMOVED_BY_USER' || tool.selectionRole === 'EXCLUDED') continue;
    if (!tool.stageId) continue;
    const list = byStage.get(tool.stageId) ?? [];
    list.push(tool.githubNodeId);
    byStage.set(tool.stageId, list);
  }
  state.stages = state.stages.map((stage) => ({ ...stage, selectedToolIds: byStage.get(stage.id) ?? [] }));
}

/**
 * 应用一组结构化操作。actor 决定写入的 valueSource，并参与锁定判定。
 */
export function applyOperations(
  input: ResearchState,
  operations: ChangeOperation[],
  actor: Extract<ValueSource, 'USER_CONFIRMED' | 'USER_MANUAL_EDIT' | 'AI_PROPOSED'> = 'USER_CONFIRMED',
): ReducerResult {
  const state = clone(input);
  const warnings: string[] = [];
  const rejectedOperations: Array<{ type: string; reason: string }> = [];
  const changedStageIds = new Set<string>();
  let workflowNeedsRegeneration = false;

  const reject = (type: string, reason: string) => {
    rejectedOperations.push({ type, reason });
    warnings.push(reason);
  };

  const findStage = (stageId: string) => state.stages.find((stage) => stage.id === stageId);
  const stageLocked = (stageId: string) => {
    const stage = findStage(stageId);
    return Boolean(stage?.locked) || isLocked(state, `stage:${stageId}`);
  };

  for (const operation of operations) {
    switch (operation.type) {
      case 'UPDATE_OBJECTIVE': {
        if (isLocked(state, 'objective')) { reject(operation.type, '研究目标已锁定，需先解锁才能修改。'); break; }
        state.objective = operation.objective;
        markSource(state, 'objective', actor);
        if (operation.title && !isLocked(state, 'title')) {
          state.title = operation.title;
          markSource(state, 'title', actor);
        }
        break;
      }
      case 'UPDATE_REQUIREMENT': {
        for (const [key, value] of Object.entries(operation.patch)) {
          if (value === undefined) continue;
          const path = `requirements.${key}`;
          if (isLocked(state, path)) { reject(operation.type, `约束 ${key} 已锁定，未修改。`); continue; }
          (state.requirements as unknown as Record<string, unknown>)[key] = value;
          markSource(state, path, actor);
        }
        workflowNeedsRegeneration = true;
        break;
      }
      case 'ADD_STAGE': {
        const id = operation.temporaryId && !state.stages.some((stage) => stage.id === operation.temporaryId)
          ? operation.temporaryId
          : stageIdFromName(operation.name, state.stages.map((stage) => stage.id));
        const stage = newStage({
          id,
          name: operation.name,
          description: operation.description,
          required: operation.required,
          inputs: operation.inputs,
          outputs: operation.outputs,
          keywords: operation.keywords,
          source: actor === 'AI_PROPOSED' ? 'AI_GENERATED' : 'USER_CREATED',
          position: state.stages.length,
        });
        let insertAt = state.stages.length;
        if (operation.positionAfter) {
          const index = state.stages.findIndex((item) => item.id === operation.positionAfter);
          if (index >= 0) insertAt = index + 1;
        } else if (operation.positionBefore) {
          const index = state.stages.findIndex((item) => item.id === operation.positionBefore);
          if (index >= 0) insertAt = index;
        }
        state.stages.splice(insertAt, 0, stage);
        state.stages = renumber(state.stages);
        changedStageIds.add(id);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'UPDATE_STAGE': {
        const stage = findStage(operation.stageId);
        if (!stage) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        if (stageLocked(operation.stageId)) { reject(operation.type, `研究环节 ${stage.name} 已锁定，未修改。`); break; }
        if (operation.name !== undefined) stage.name = operation.name;
        if (operation.description !== undefined) stage.description = operation.description;
        if (operation.inputs !== undefined) stage.inputs = operation.inputs;
        if (operation.outputs !== undefined) stage.outputs = operation.outputs;
        stage.version += 1;
        stage.source = actor === 'AI_PROPOSED' ? 'AI_REVISED' : 'USER_REVISED';
        markSource(state, `stage:${stage.id}`, actor);
        changedStageIds.add(stage.id);
        break;
      }
      case 'DELETE_STAGE': {
        const stage = findStage(operation.stageId);
        if (!stage) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        if (stageLocked(operation.stageId)) { reject(operation.type, `研究环节 ${stage.name} 已锁定，未删除。`); break; }
        state.stages = renumber(state.stages.filter((item) => item.id !== operation.stageId));
        // 工具不静默删除：转为未分配，等待用户重新归类或移除。
        state.selectedTools = state.selectedTools.map((tool) =>
          tool.stageId === operation.stageId ? { ...tool, stageId: '', status: 'UNASSIGNED' as const } : tool);
        changedStageIds.add(operation.stageId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'REORDER_STAGE': {
        const known = new Map(state.stages.map((stage) => [stage.id, stage]));
        const ordered: ResearchStage[] = [];
        for (const id of operation.stageOrder) {
          const stage = known.get(id);
          if (stage) { ordered.push(stage); known.delete(id); }
        }
        for (const stage of known.values()) ordered.push(stage);
        state.stages = renumber(ordered);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'SPLIT_STAGE': {
        const index = state.stages.findIndex((stage) => stage.id === operation.stageId);
        if (index < 0) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        if (stageLocked(operation.stageId)) { reject(operation.type, '目标研究环节已锁定，未拆分。'); break; }
        const origin = state.stages[index];
        const existingIds = state.stages.map((stage) => stage.id);
        const parts = operation.parts.map((part, offset) => {
          const id = stageIdFromName(part.name, existingIds);
          existingIds.push(id);
          return newStage({
            id,
            name: part.name,
            description: part.description,
            required: origin.required,
            keywords: part.keywords,
            source: actor === 'AI_PROPOSED' ? 'AI_GENERATED' : 'USER_CREATED',
            position: index + offset,
          });
        });
        state.stages.splice(index, 1, ...parts);
        state.stages = renumber(state.stages);
        state.selectedTools = state.selectedTools.map((tool) =>
          tool.stageId === operation.stageId
            ? { ...tool, stageId: parts[0].id, status: 'NEEDS_RECLASSIFICATION' as const }
            : tool);
        parts.forEach((part) => changedStageIds.add(part.id));
        workflowNeedsRegeneration = true;
        break;
      }
      case 'MERGE_STAGES': {
        const targets = state.stages.filter((stage) => operation.stageIds.includes(stage.id));
        if (targets.length < 2) { reject(operation.type, '需要至少两个存在的研究环节才能合并。'); break; }
        if (targets.some((stage) => stage.locked || isLocked(state, `stage:${stage.id}`))) {
          reject(operation.type, '待合并的研究环节中存在锁定项，未合并。');
          break;
        }
        const first = targets[0];
        const mergedId = stageIdFromName(operation.name ?? first.name, state.stages.filter((s) => !operation.stageIds.includes(s.id)).map((s) => s.id));
        const merged = newStage({
          id: mergedId,
          name: operation.name ?? first.name,
          description: targets.map((stage) => stage.description).filter(Boolean).join('；').slice(0, 400),
          required: targets.some((stage) => stage.required),
          inputs: [...new Set(targets.flatMap((stage) => stage.inputs))].slice(0, 12),
          outputs: [...new Set(targets.flatMap((stage) => stage.outputs))].slice(0, 12),
          keywords: [...new Set(targets.flatMap((stage) => stage.toolRequirements.keywords))].slice(0, 20),
          source: actor === 'AI_PROPOSED' ? 'AI_GENERATED' : 'USER_CREATED',
          position: first.position,
        });
        const firstIndex = state.stages.findIndex((stage) => stage.id === first.id);
        state.stages = state.stages.filter((stage) => !operation.stageIds.includes(stage.id));
        state.stages.splice(Math.max(0, firstIndex), 0, merged);
        state.stages = renumber(state.stages);
        state.selectedTools = state.selectedTools.map((tool) =>
          operation.stageIds.includes(tool.stageId)
            ? { ...tool, stageId: mergedId, status: 'NEEDS_RECLASSIFICATION' as const }
            : tool);
        changedStageIds.add(mergedId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'LOCK_FIELD': {
        state.locks[operation.path] = true;
        const stageId = operation.path.startsWith('stage:') ? operation.path.slice(6).split('.')[0] : '';
        if (stageId) {
          state.stages = state.stages.map((stage) => (stage.id === stageId ? { ...stage, locked: true } : stage));
        }
        if (operation.path.startsWith('tool:')) {
          const nodeId = operation.path.slice(5);
          state.selectedTools = state.selectedTools.map((tool) => (tool.githubNodeId === nodeId ? { ...tool, locked: true } : tool));
        }
        if (operation.path.startsWith('workflow.stage:') && state.workflow) {
          const id = operation.path.slice('workflow.stage:'.length);
          state.workflow.stages = state.workflow.stages.map((stage) => (stage.id === id ? { ...stage, locked: true } : stage));
        }
        break;
      }
      case 'UNLOCK_FIELD': {
        delete state.locks[operation.path];
        const stageId = operation.path.startsWith('stage:') ? operation.path.slice(6).split('.')[0] : '';
        if (stageId) {
          state.stages = state.stages.map((stage) => (stage.id === stageId ? { ...stage, locked: false } : stage));
        }
        if (operation.path.startsWith('tool:')) {
          const nodeId = operation.path.slice(5);
          state.selectedTools = state.selectedTools.map((tool) => (tool.githubNodeId === nodeId ? { ...tool, locked: false } : tool));
        }
        if (operation.path.startsWith('workflow.stage:') && state.workflow) {
          const id = operation.path.slice('workflow.stage:'.length);
          state.workflow.stages = state.workflow.stages.map((stage) => (stage.id === id ? { ...stage, locked: false } : stage));
        }
        break;
      }
      case 'MARK_STAGE_REQUIRED':
      case 'MARK_STAGE_OPTIONAL': {
        const stage = findStage(operation.stageId);
        if (!stage) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        if (stageLocked(operation.stageId)) { reject(operation.type, `研究环节 ${stage.name} 已锁定，未修改。`); break; }
        stage.required = operation.type === 'MARK_STAGE_REQUIRED';
        changedStageIds.add(stage.id);
        break;
      }
      case 'ADD_TOOL_CONSTRAINT': {
        const stage = findStage(operation.stageId);
        if (!stage) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        stage.toolRequirements = { ...stage.toolRequirements, ...Object.fromEntries(Object.entries(operation.constraint).filter(([, v]) => v !== undefined)) };
        stage.searchStatus = 'NOT_STARTED';
        changedStageIds.add(stage.id);
        break;
      }
      case 'REMOVE_TOOL_CONSTRAINT': {
        const stage = findStage(operation.stageId);
        if (!stage) { reject(operation.type, `研究环节 ${operation.stageId} 不存在。`); break; }
        const defaults = researchStageSchema.parse({ id: stage.id, name: stage.name, position: stage.position }).toolRequirements;
        const next = { ...stage.toolRequirements } as unknown as Record<string, unknown>;
        for (const field of operation.fields) {
          if (field in defaults) next[field] = (defaults as unknown as Record<string, unknown>)[field];
        }
        stage.toolRequirements = next as ResearchStage['toolRequirements'];
        changedStageIds.add(stage.id);
        break;
      }
      case 'SELECT_TOOL': {
        if (!findStage(operation.stageId)) { reject(operation.type, `研究环节 ${operation.stageId} 不存在，无法归类工具。`); break; }
        const existing = state.selectedTools.find((tool) => tool.githubNodeId === operation.githubNodeId);
        const tool = selectedToolSchema.parse({
          githubNodeId: operation.githubNodeId,
          fullName: operation.fullName,
          stageId: operation.stageId,
          role: operation.role ?? existing?.role ?? 'SUPPORTING_INFRASTRUCTURE',
          selectionRole: operation.selectionRole,
          status: 'ACTIVE',
          acquisitionMode: operation.acquisitionMode ?? existing?.acquisitionMode ?? 'CLONE_UPSTREAM',
          notes: operation.notes,
          locked: existing?.locked ?? false,
        });
        if (existing?.locked) { reject(operation.type, `工具 ${existing.fullName} 已锁定，未修改。`); break; }
        if (tool.selectionRole === 'PRIMARY') {
          state.selectedTools = state.selectedTools.map((item) =>
            item.stageId === tool.stageId && item.selectionRole === 'PRIMARY' && item.githubNodeId !== tool.githubNodeId && !item.locked
              ? { ...item, selectionRole: 'ALTERNATIVE' as const }
              : item);
        }
        state.selectedTools = existing
          ? state.selectedTools.map((item) => (item.githubNodeId === tool.githubNodeId ? tool : item))
          : [...state.selectedTools, tool];
        changedStageIds.add(tool.stageId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'ADD_ALTERNATIVE_TOOL': {
        if (!findStage(operation.stageId)) { reject(operation.type, `研究环节 ${operation.stageId} 不存在，无法添加备选工具。`); break; }
        const existing = state.selectedTools.find((tool) => tool.githubNodeId === operation.githubNodeId);
        const tool = selectedToolSchema.parse({
          githubNodeId: operation.githubNodeId,
          fullName: operation.fullName,
          stageId: operation.stageId,
          role: operation.role ?? existing?.role ?? 'SUPPORTING_INFRASTRUCTURE',
          selectionRole: 'ALTERNATIVE',
          status: 'ACTIVE',
          acquisitionMode: operation.acquisitionMode ?? existing?.acquisitionMode ?? 'CLONE_UPSTREAM',
          locked: existing?.locked ?? false,
        });
        state.selectedTools = existing
          ? state.selectedTools.map((item) => (item.githubNodeId === tool.githubNodeId ? tool : item))
          : [...state.selectedTools, tool];
        changedStageIds.add(tool.stageId);
        break;
      }
      case 'REMOVE_TOOL': {
        const existing = state.selectedTools.find((tool) => tool.githubNodeId === operation.githubNodeId);
        if (!existing) { reject(operation.type, '目标工具不在当前工具链中。'); break; }
        if (existing.locked) { reject(operation.type, `工具 ${existing.fullName} 已锁定，未移除。`); break; }
        state.selectedTools = state.selectedTools.map((tool) =>
          tool.githubNodeId === operation.githubNodeId
            ? { ...tool, status: 'REMOVED_BY_USER' as const, selectionRole: 'EXCLUDED' as const, notes: operation.reason || tool.notes }
            : tool);
        changedStageIds.add(existing.stageId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'CHANGE_PRIMARY_TOOL': {
        const target = state.selectedTools.find((tool) => tool.githubNodeId === operation.githubNodeId);
        if (!target) { reject(operation.type, '目标工具不在当前工具链中。'); break; }
        state.selectedTools = state.selectedTools.map((tool) => {
          if (tool.githubNodeId === operation.githubNodeId) {
            return { ...tool, stageId: operation.stageId, selectionRole: 'PRIMARY' as const, status: 'ACTIVE' as const };
          }
          if (tool.stageId === operation.stageId && tool.selectionRole === 'PRIMARY' && !tool.locked) {
            return { ...tool, selectionRole: 'ALTERNATIVE' as const };
          }
          return tool;
        });
        changedStageIds.add(operation.stageId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'REPLACE_TOOL': {
        const existing = state.selectedTools.find((tool) => tool.githubNodeId === operation.githubNodeId);
        if (!existing) { reject(operation.type, '被替换的工具不在当前工具链中。'); break; }
        if (existing.locked) { reject(operation.type, `工具 ${existing.fullName} 已锁定，未替换。`); break; }
        const replacement = selectedToolSchema.parse({
          githubNodeId: operation.replacementGithubNodeId,
          fullName: operation.replacementFullName,
          stageId: operation.stageId ?? existing.stageId,
          role: operation.role ?? existing.role,
          selectionRole: existing.selectionRole,
          status: 'ACTIVE',
          acquisitionMode: operation.acquisitionMode ?? existing.acquisitionMode,
        });
        state.selectedTools = [
          ...state.selectedTools.map((tool) =>
            tool.githubNodeId === operation.githubNodeId
              ? { ...tool, status: 'REMOVED_BY_USER' as const, selectionRole: 'EXCLUDED' as const, notes: `已被 ${replacement.fullName} 替换` }
              : tool),
          replacement,
        ];
        changedStageIds.add(replacement.stageId);
        workflowNeedsRegeneration = true;
        break;
      }
      case 'UPDATE_WORKFLOW': {
        if (isLocked(state, 'workflow')) { reject(operation.type, '主题主线已锁定，需先解锁。'); break; }
        const base = state.workflow ?? themeWorkflowSchema.parse({});
        const patch = operation.patch;
        const next = clone(base);
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.description !== undefined) next.description = patch.description;
        if (patch.testGoal !== undefined) next.testGoal = patch.testGoal;
        if (patch.themeInputs !== undefined) next.themeInputs = patch.themeInputs;
        if (patch.finalOutputs !== undefined) next.finalOutputs = patch.finalOutputs;
        if (patch.successCriteria !== undefined) next.successCriteria = patch.successCriteria;
        if (patch.connections !== undefined) next.connections = patch.connections;
        if (patch.stagePatches) {
          for (const stagePatch of patch.stagePatches) {
            const stage = next.stages.find((item) => item.id === stagePatch.id);
            if (!stage) { warnings.push(`主线阶段 ${stagePatch.id} 不存在，已忽略。`); continue; }
            if (stage.locked || isLocked(state, `workflow.stage:${stage.id}`)) { reject(operation.type, `主线阶段 ${stage.name} 已锁定，未修改。`); continue; }
            if (stagePatch.name !== undefined) stage.name = stagePatch.name;
            if (stagePatch.toolIds !== undefined) stage.toolIds = stagePatch.toolIds;
            if (stagePatch.inputs !== undefined) stage.inputs = stagePatch.inputs;
            if (stagePatch.outputs !== undefined) stage.outputs = stagePatch.outputs;
            if (stagePatch.manualStep !== undefined) stage.manualStep = stagePatch.manualStep;
            if (stagePatch.locked !== undefined) stage.locked = stagePatch.locked;
            if (stagePatch.notes !== undefined) stage.notes = stagePatch.notes;
          }
        }
        if (patch.removeStageIds?.length) {
          const blocked = next.stages.filter((stage) => patch.removeStageIds?.includes(stage.id) && (stage.locked || isLocked(state, `workflow.stage:${stage.id}`)));
          if (blocked.length) reject(operation.type, `主线阶段 ${blocked.map((stage) => stage.name).join('、')} 已锁定，未删除。`);
          const removable = new Set(patch.removeStageIds.filter((id) => !blocked.some((stage) => stage.id === id)));
          next.stages = next.stages.filter((stage) => !removable.has(stage.id));
          next.connections = next.connections.filter((connection) => !removable.has(connection.from) && !removable.has(connection.to));
        }
        if (patch.stageOrder?.length) {
          const known = new Map(next.stages.map((stage) => [stage.id, stage]));
          const ordered: typeof next.stages = [];
          for (const id of patch.stageOrder) {
            const stage = known.get(id);
            if (stage) { ordered.push(stage); known.delete(id); }
          }
          for (const stage of known.values()) ordered.push(stage);
          next.stages = ordered;
        }
        next.source = actor === 'AI_PROPOSED' ? 'AI_GENERATED' : 'USER_REVISED';
        next.version = base.version + 1;
        state.workflow = themeWorkflowSchema.parse(next);
        markSource(state, 'workflow', actor);
        break;
      }
      case 'UPDATE_TEST_SCOPE': {
        if (!state.workflow) { reject(operation.type, '尚未生成主题主线，无法设置测试范围。'); break; }
        if (isLocked(state, 'workflow')) { reject(operation.type, '主题主线已锁定，需先解锁。'); break; }
        if (operation.testGoal !== undefined) state.workflow.testGoal = operation.testGoal;
        if (operation.successCriteria !== undefined) state.workflow.successCriteria = operation.successCriteria;
        state.workflow.version += 1;
        break;
      }
      default: {
        reject((operation as { type: string }).type, '未知的变更操作类型。');
      }
    }
  }

  for (const stageId of changedStageIds) {
    const stage = state.stages.find((item) => item.id === stageId);
    if (stage && stage.searchStatus === 'COMPLETED' && stage.candidateCount === 0) stage.searchStatus = 'NOT_STARTED';
  }

  syncStageToolIds(state);
  state.updatedAt = new Date().toISOString();

  return {
    state: researchStateSchema.parse(state),
    warnings,
    rejectedOperations,
    changedStageIds: [...changedStageIds],
    workflowNeedsRegeneration,
  };
}
