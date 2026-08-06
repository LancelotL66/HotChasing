import React, { useState } from 'react';
import { GitBranch, Loader2, Save, AlertTriangle, Check } from 'lucide-react';
import { researchApi, type ResearchState, type ThemeWorkflow } from '../../services/researchApi';

interface Props {
  state: ResearchState | null;
  workflow: ThemeWorkflow | null;
  busy: string | null;
  onGenerate: () => void;
}

const MODE_LABELS: Record<string, string> = {
  LIBRARY_CALL: '库调用', CLI_CALL: 'CLI', FILE_EXCHANGE: '文件交换', HTTP_API: 'HTTP API',
  RPC: 'RPC', MCP: 'MCP', DATABASE: '数据库', MESSAGE_QUEUE: '消息队列', MANUAL_HANDOFF: '人工衔接',
};

export const WorkflowTab: React.FC<Props> = ({ state, workflow, busy, onGenerate }) => {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [testGoal, setTestGoal] = useState('');
  const [allowMod, setAllowMod] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const handleSave = async () => {
    if (!state || !name.trim()) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const result = await researchApi.saveToForkLab(state.topicId, { name, testGoal, allowAgentModification: allowMod });
      setSavedMsg(`已保存到 Fork 实验室：${result.theme.name} v${result.version.version}`);
      setSaveOpen(false);
      setName('');
      setTestGoal('');
    } catch (err) {
      setSavedMsg(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const toolName = (toolId: string) => state?.selectedTools.find((tool) => tool.githubNodeId === toolId)?.fullName ?? toolId;

  if (!workflow) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-500 dark:text-text-tertiary">
          选择多个工具后生成一条建议研究主线。主线会把各工具串成可端到端测试的完整链路。
        </p>
        <button
          onClick={onGenerate}
          disabled={busy === 'plan' || (state?.selectedTools ?? []).length === 0}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
          生成建议主线
        </button>
        {(state?.selectedTools ?? []).length === 0 && (
          <p className="text-xs text-gray-400 dark:text-text-tertiary">先在「工具推荐」或「我的工具链」中至少选择一个工具。</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-text-primary">{workflow.name}</h3>
          <p className="text-xs text-gray-500 dark:text-text-tertiary">
            来源：{workflow.source === 'AI_GENERATED' ? 'AI 生成' : '规则生成'} · v{workflow.version} · {workflow.stages.length} 个阶段
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onGenerate} disabled={busy === 'plan'} className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-light-surface disabled:opacity-50 dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">
            <Loader2 className={`h-3.5 w-3.5 ${busy === 'plan' ? 'animate-spin' : ''}`} />重新生成
          </button>
          <button onClick={() => setSaveOpen((open) => !open)} className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
            <Save className="h-3.5 w-3.5" />保存到 Fork 实验室
          </button>
        </div>
      </div>

      {savedMsg && <p className={`text-xs ${savedMsg.startsWith('保存失败') ? 'text-red-600 dark:text-red-300' : 'text-emerald-600 dark:text-emerald-300'}`}>{savedMsg}</p>}

      {saveOpen && (
        <div className="rounded-lg border border-black/[0.06] bg-light-surface p-3 text-sm dark:border-white/[0.06] dark:bg-surface-2">
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-text-tertiary">方案名称</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：运动想象 EEG 深度学习实验环境"
            className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/10 dark:bg-surface-2 dark:text-text-primary"
          />
          <label className="mb-1 mt-2 block text-xs font-medium text-gray-500 dark:text-text-tertiary">测试目标</label>
          <input
            value={testGoal}
            onChange={(event) => setTestGoal(event.target.value)}
            placeholder="例如：完成 EEG 数据处理、训练和结果展示"
            className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/10 dark:bg-surface-2 dark:text-text-primary"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 dark:text-text-secondary">
            <input type="checkbox" checked={allowMod} onChange={(event) => setAllowMod(event.target.checked)} />
            允许 Agent 修改工具源码（仅工作区内）
          </label>
          <div className="mt-3 flex gap-2">
            <button onClick={handleSave} disabled={saving || !name.trim()} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}确认保存
            </button>
            <button onClick={() => setSaveOpen(false)} className="rounded-lg border border-black/10 px-3 py-1.5 text-xs text-gray-700 hover:bg-light-surface dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">取消</button>
          </div>
        </div>
      )}

      {workflow.missingStages.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>缺少工具的环节：{workflow.missingStages.join('、')}。建议在「工具推荐」中补齐。</span>
        </div>
      )}
      {workflow.duplicateTools.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>功能重叠提示：{workflow.duplicateTools.join('；')}</span>
        </div>
      )}

      <div className="space-y-0">
        {workflow.stages.map((stage, index) => {
          const connection = workflow.connections.find((item) => item.from === stage.id);
          return (
            <div key={stage.id}>
              {index > 0 && connection && (
                <div className="flex items-center gap-2 py-1 pl-4 text-xs text-gray-400 dark:text-text-tertiary">
                  <span className="h-px w-8 bg-black/10 dark:bg-white/10" />
                  {MODE_LABELS[connection.mode] ?? connection.mode}
                </div>
              )}
              <div className="rounded-lg border border-black/[0.06] bg-white p-3 dark:border-white/[0.06] dark:bg-panel-dark">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">{index + 1}</span>
                  <span className="font-medium text-gray-900 dark:text-text-primary">{stage.name}</span>
                  {stage.manualStep && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">人工步骤</span>}
                  {stage.locked && <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">锁定</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {stage.toolIds.map((toolId) => (
                    <span key={toolId} className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">{toolName(toolId)}</span>
                  ))}
                  {stage.toolIds.length === 0 && <span className="text-xs text-gray-400 dark:text-text-tertiary">无工具</span>}
                </div>
                {stage.inputs.length > 0 && (
                  <div className="mt-1 text-xs text-gray-500 dark:text-text-tertiary">输入：{stage.inputs.join('、')}</div>
                )}
                {stage.outputs.length > 0 && (
                  <div className="text-xs text-gray-500 dark:text-text-tertiary">输出：{stage.outputs.join('、')}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {workflow.successCriteria.length > 0 && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          <div className="mb-1 font-medium">端到端成功标准</div>
          {workflow.successCriteria.map((criterion, index) => <div key={index}>· {criterion}</div>)}
        </div>
      )}
    </div>
  );
};
