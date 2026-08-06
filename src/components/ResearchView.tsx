import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Loader2, RefreshCw, X, MessageSquare, Search, Wrench, GitBranch } from 'lucide-react';
import { researchApi, type CandidateView, type ChangeProposal, type ResearchState, type ResearchTopic, type ThemeWorkflow, type ToolkitView } from '../services/researchApi';
import { DialogueTab } from './research/DialogueTab';
import { RecommendationsTab } from './research/RecommendationsTab';
import { ToolkitTab } from './research/ToolkitTab';
import { WorkflowTab } from './research/WorkflowTab';

type TabId = 'dialogue' | 'recommendations' | 'toolkit' | 'workflow';

const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dialogue', label: '需求与对话', icon: MessageSquare },
  { id: 'recommendations', label: '工具推荐', icon: Search },
  { id: 'toolkit', label: '我的工具链', icon: Wrench },
  { id: 'workflow', label: '主题主线', icon: GitBranch },
];

export const ResearchView: React.FC = () => {
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('dialogue');
  const [newRequirement, setNewRequirement] = useState('');
  const [creating, setCreating] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<ResearchState | null>(null);
  const [proposal, setProposal] = useState<ChangeProposal | null>(null);
  const [message, setMessage] = useState('');
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [toolkit, setToolkit] = useState<ToolkitView | null>(null);
  const [workflow, setWorkflow] = useState<ThemeWorkflow | null>(null);
  const [tierFilter, setTierFilter] = useState<string>('');

  const selectedTopic = useMemo(() => topics.find((topic) => topic.id === selectedTopicId) ?? null, [topics, selectedTopicId]);

  const refreshTopics = useCallback(async () => {
    try {
      const result = await researchApi.listTopics();
      setTopics(result.topics);
      return result.topics;
    } catch (err) {
      setError((err as Error).message);
      return [] as ResearchTopic[];
    }
  }, []);

  const refreshCandidates = useCallback(async (id: string, tier?: string) => {
    try {
      const result = await researchApi.listCandidates(id, tier ? { tier } : undefined);
      setCandidates(result.candidates);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshTopicDetail = useCallback(async (topicId: string) => {
    const [stateResult, toolkitResult, workflowResult] = await Promise.all([
      researchApi.getState(topicId).catch(() => null),
      researchApi.getToolkit(topicId).catch(() => null),
      researchApi.getThemePlan(topicId).catch(() => null),
    ]);
    if (stateResult) setState(stateResult.state);
    if (toolkitResult) setToolkit(toolkitResult.toolkit);
    if (workflowResult) setWorkflow(workflowResult.workflow);
    await refreshTopics();
  }, [refreshTopics]);

  useEffect(() => {
    void refreshTopics();
  }, [refreshTopics]);

  useEffect(() => {
    if (selectedTopicId) void refreshTopicDetail(selectedTopicId);
  }, [selectedTopicId, refreshTopicDetail]);

  const handleCreate = async () => {
    if (!newRequirement.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await researchApi.createTopic(newRequirement);
      setNewRequirement('');
      setProposal(null);
      setSelectedTopicId(result.topic.id);
      setTab('dialogue');
      await refreshTopics();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleParse = async (topicId: string) => {
    setParsing(true);
    setError(null);
    try {
      await researchApi.parseTopic(topicId);
      await refreshTopicDetail(topicId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const handleDeleteTopic = async (topicId: string) => {
    if (!window.confirm('删除该研究主题及其所有状态版本？')) return;
    setError(null);
    try {
      await researchApi.deleteTopic(topicId);
      if (selectedTopicId === topicId) {
        setSelectedTopicId(null);
        setState(null);
        setCandidates([]);
        setToolkit(null);
        setWorkflow(null);
        setProposal(null);
      }
      await refreshTopics();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedTopicId || !message.trim()) return;
    setError(null);
    try {
      const result = await researchApi.createProposal(selectedTopicId, { userMessage: message });
      setProposal(result);
      setMessage('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleApplyProposal = async () => {
    if (!selectedTopicId || !proposal) return;
    setBusy('apply');
    setError(null);
    try {
      await researchApi.applyProposal(selectedTopicId, proposal.id, true);
      setProposal(null);
      await refreshTopicDetail(selectedTopicId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleRejectProposal = async () => {
    if (!selectedTopicId || !proposal) return;
    try {
      await researchApi.rejectProposal(selectedTopicId, proposal.id);
      setProposal(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSearch = async (stageId?: string) => {
    if (!selectedTopicId) return;
    setBusy('search');
    setError(null);
    try {
      await researchApi.runSearch(selectedTopicId, stageId);
      await refreshTopicDetail(selectedTopicId);
      await refreshCandidates(selectedTopicId, tierFilter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleSelectTool = async (candidate: CandidateView) => {
    if (!selectedTopicId) return;
    setBusy('select');
    setError(null);
    try {
      await researchApi.selectTool(selectedTopicId, {
        githubNodeId: candidate.github_node_id,
        stageId: candidate.stage_id ?? candidate.analysis?.stageIds[0] ?? undefined,
        selectionRole: 'PRIMARY',
        acquisitionMode: candidate.analysis?.deployment.preferredAcquisitionMode,
      });
      await refreshTopicDetail(selectedTopicId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveTool = async (githubNodeId: string) => {
    if (!selectedTopicId) return;
    setError(null);
    try {
      await researchApi.removeTool(selectedTopicId, githubNodeId);
      await refreshTopicDetail(selectedTopicId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSetPrimary = async (githubNodeId: string, stageId: string) => {
    if (!selectedTopicId) return;
    setError(null);
    try {
      await researchApi.updateTool(selectedTopicId, githubNodeId, { selectionRole: 'PRIMARY', stageId });
      await refreshTopicDetail(selectedTopicId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleGeneratePlan = async () => {
    if (!selectedTopicId) return;
    setBusy('plan');
    setError(null);
    try {
      const result = await researchApi.generateThemePlan(selectedTopicId);
      setWorkflow(result.workflow);
      await refreshTopicDetail(selectedTopicId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="w-full shrink-0 lg:w-72">
          <div className="rounded-xl border border-black/[0.06] bg-white p-3 shadow-sm dark:border-white/[0.06] dark:bg-panel-dark">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-text-primary">研究主题</h2>
              <span className="text-xs text-gray-500 dark:text-text-tertiary">{topics.length} 个</span>
            </div>
            <div className="space-y-2">
              <textarea
                value={newRequirement}
                onChange={(event) => setNewRequirement(event.target.value)}
                placeholder="用一句话或大段文字描述研究需求…"
                rows={3}
                className="w-full resize-none rounded-lg border border-black/10 bg-light-surface px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-400 dark:border-white/10 dark:bg-surface-2 dark:text-text-primary"
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newRequirement.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                创建研究主题
              </button>
            </div>
            <div className="mt-3 max-h-[52vh] space-y-1 overflow-y-auto">
              {topics.map((topic) => (
                <div
                  key={topic.id}
                  className={`group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${selectedTopicId === topic.id ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-700 hover:bg-light-surface dark:text-text-secondary dark:hover:bg-white/5'}`}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => { setSelectedTopicId(topic.id); setProposal(null); setTab('dialogue'); }}
                  >
                    <div className="truncate font-medium">{topic.title}</div>
                    <div className="truncate text-xs opacity-70">
                      v{topic.current_state_version} · {topic.status} · {topic.stageCount} 环节
                    </div>
                  </button>
                  <button
                    onClick={() => handleDeleteTopic(topic.id)}
                    className="ml-2 rounded p-1 text-gray-400 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    aria-label="删除主题"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {topics.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-gray-400 dark:text-text-tertiary">还没有研究主题，先创建第一个吧。</p>
              )}
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          {selectedTopic ? (
            <div className="rounded-xl border border-black/[0.06] bg-white shadow-sm dark:border-white/[0.06] dark:bg-panel-dark">
              <div className="border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.06]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold text-gray-900 dark:text-text-primary">{state?.title ?? selectedTopic.title}</h1>
                    <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-text-tertiary">{state?.objective || '尚未解析研究目标'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {state && (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.consistencyStatus === 'CONSISTENT' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                        {state.consistencyStatus}
                      </span>
                    )}
                    <button
                      onClick={() => handleParse(selectedTopic.id)}
                      disabled={parsing}
                      className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-light-surface disabled:opacity-50 dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5"
                    >
                      {parsing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {state?.stages.length ? '重新解析' : '解析需求'}
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {TABS.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setTab(item.id)}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors ${tab === item.id ? 'bg-blue-600 text-white' : 'bg-light-surface text-gray-700 hover:bg-black/5 dark:bg-white/5 dark:text-text-secondary dark:hover:bg-white/10'}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="p-4">
                {tab === 'dialogue' && (
                  <DialogueTab
                    state={state}
                    proposal={proposal}
                    message={message}
                    setMessage={setMessage}
                    busy={busy}
                    onSend={handleSendMessage}
                    onApply={handleApplyProposal}
                    onReject={handleRejectProposal}
                  />
                )}
                {tab === 'recommendations' && (
                  <RecommendationsTab
                    state={state}
                    candidates={candidates}
                    busy={busy}
                    tierFilter={tierFilter}
                    setTierFilter={setTierFilter}
                    onSearch={handleSearch}
                    onRefresh={() => selectedTopicId && refreshCandidates(selectedTopicId, tierFilter)}
                    onSelect={handleSelectTool}
                  />
                )}
                {tab === 'toolkit' && (
                  <ToolkitTab toolkit={toolkit} onRemove={handleRemoveTool} onSetPrimary={handleSetPrimary} />
                )}
                {tab === 'workflow' && (
                  <WorkflowTab
                    state={state}
                    workflow={workflow}
                    busy={busy}
                    onGenerate={handleGeneratePlan}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-black/10 text-sm text-gray-400 dark:border-white/10 dark:text-text-tertiary">
              在左侧创建一个研究主题，开始主题研究
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
