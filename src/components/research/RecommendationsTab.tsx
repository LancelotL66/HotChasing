import React from 'react';
import { Search, Loader2, Star, Plus, RefreshCw, ExternalLink } from 'lucide-react';
import type { CandidateView, ResearchState } from '../../services/researchApi';

interface Props {
  state: ResearchState | null;
  candidates: CandidateView[];
  busy: string | null;
  tierFilter: string;
  setTierFilter: (value: string) => void;
  onSearch: (stageId?: string) => void;
  onRefresh: () => void;
  onSelect: (candidate: CandidateView) => void;
}

const TIER_LABELS: Record<string, string> = { FEATURED: '精选', MORE: '更多候选', POOL: '全部候选' };

function TierBadge({ tier }: { tier: string | null }) {
  const styles: Record<string, string> = {
    FEATURED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    MORE: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
    POOL: 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-text-secondary',
  };
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[tier ?? 'POOL'] ?? styles.POOL}`}>{TIER_LABELS[tier ?? 'POOL'] ?? tier}</span>;
}

function CandidateCard({ candidate, busy, onSelect }: { candidate: CandidateView; busy: string | null; onSelect: (candidate: CandidateView) => void }) {
  const analysis = candidate.analysis;
  const blocked = candidate.match_level === '不符合当前限制';
  return (
    <div className={`rounded-lg border p-3 text-left transition-colors ${blocked ? 'border-red-200 bg-red-50/50 dark:border-red-500/30 dark:bg-red-500/5' : 'border-black/[0.06] bg-white dark:border-white/[0.06] dark:bg-panel-dark'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-gray-900 dark:text-text-primary">{candidate.repo?.fullName ?? candidate.full_name}</h4>
            <TierBadge tier={candidate.tier} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-text-tertiary">
            <span>{candidate.repo?.primaryLanguage ?? '未知语言'}</span>
            <span className="flex items-center gap-0.5"><Star className="h-3 w-3" />{candidate.repo?.stars ?? 0}</span>
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 dark:bg-white/5">{candidate.match_level ?? '待评估'}</span>
          </div>
        </div>
        <a
          href={candidate.repo?.htmlUrl ?? `https://github.com/${candidate.full_name}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded p-1 text-gray-400 hover:text-blue-500"
          aria-label="查看 GitHub"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {analysis ? (
        <div className="mt-2 space-y-1 text-xs text-gray-600 dark:text-text-secondary">
          <p className="line-clamp-2">{analysis.summary}</p>
          <p className="line-clamp-2 text-gray-500 dark:text-text-tertiary">{analysis.roleInTheme}</p>
          <div className="flex flex-wrap gap-1 pt-0.5">
            {analysis.stageIds.slice(0, 3).map((stageId) => <span key={stageId} className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">{stageId}</span>)}
            {analysis.roles.slice(0, 3).map((role) => <span key={role} className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">{role}</span>)}
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">{(analysis.productForm ?? []).join('/') || 'LIBRARY'}</span>
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">本地={analysis.deployment.localSupported ? '✓' : '✗'}</span>
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">Docker={analysis.deployment.dockerAvailable ? '✓' : '✗'}</span>
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">GPU={analysis.deployment.gpuRequired ? '需' : '否'}</span>
            <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">{analysis.maintenance.status}</span>
          </div>
          {analysis.limitations.length > 0 && (
            <p className="text-amber-700 dark:text-amber-300">⚠ {analysis.limitations[0]}</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400 dark:text-text-tertiary">尚未深度分析。点击「加入工具链」会先按元数据分析。</p>
      )}
      <button
        onClick={() => onSelect(candidate)}
        disabled={busy === 'select'}
        className="mt-2 flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy === 'select' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        加入工具链
      </button>
    </div>
  );
}

export const RecommendationsTab: React.FC<Props> = ({ state, candidates, busy, tierFilter, setTierFilter, onSearch, onRefresh, onSelect }) => {
  const hasSearched = (state?.stages ?? []).some((stage) => stage.searchStatus === 'COMPLETED' || stage.searchStatus === 'PARTIAL' || stage.candidateCount > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => onSearch()}
            disabled={busy === 'search'}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'search' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            搜索整个 GitHub
          </button>
          {state?.stages.map((stage) => (
            <button key={stage.id} onClick={() => onSearch(stage.id)} disabled={busy === 'search'} className="rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-light-surface disabled:opacity-50 dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">
              局部搜索：{stage.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select value={tierFilter} onChange={(event) => setTierFilter(event.target.value)} className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-gray-700 dark:border-white/10 dark:bg-surface-2 dark:text-text-secondary">
            <option value="">全部层级</option>
            <option value="FEATURED">精选</option>
            <option value="MORE">更多候选</option>
            <option value="POOL">全部候选</option>
          </select>
          <button onClick={onRefresh} className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-light-surface dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">
            <RefreshCw className="h-3.5 w-3.5" />刷新
          </button>
        </div>
      </div>

      {busy === 'search' ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500 dark:text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />正在按研究环节搜索 GitHub，去重与过滤中…
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-black/10 py-10 text-center text-sm text-gray-400 dark:border-white/10 dark:text-text-tertiary">
          {hasSearched ? '当前筛选下没有候选。调整筛选或点击「搜索整个 GitHub」重新召回。' : '尚未搜索。点击「搜索整个 GitHub」开始动态召回开源工具。'}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.github_node_id} candidate={candidate} busy={busy} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
};
