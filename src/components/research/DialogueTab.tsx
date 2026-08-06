import React from 'react';
import { Send, Check, X, AlertTriangle, Loader2 } from 'lucide-react';
import type { ChangeProposal, ResearchState } from '../../services/researchApi';

interface Props {
  state: ResearchState | null;
  proposal: ChangeProposal | null;
  message: string;
  setMessage: (value: string) => void;
  busy: string | null;
  onSend: () => void;
  onApply: () => void;
  onReject: () => void;
}

const QUICK_COMMANDS = ['精简研究环节', '只保留 Python', '排除 GPU 工具', '检查链路缺口', '寻找替代工具'];

function ConstraintChips({ state }: { state: ResearchState | null }) {
  if (!state || state.stages.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-text-tertiary">尚未解析研究需求。点击右上角「解析需求」生成研究环节。</p>;
  }
  return (
    <div className="space-y-2">
      <div className="text-sm text-gray-800 dark:text-text-primary">{state.objective || '未填写研究目标'}</div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {state.requirements.languages.map((l) => <span key={l} className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">{l}</span>)}
        {state.requirements.platforms.map((p) => <span key={p} className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{p}</span>)}
        {!state.requirements.gpuAllowed && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">无 GPU</span>}
        {!state.requirements.paidApiAllowed && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">无付费 API</span>}
        {state.requirements.localDeploymentPreferred && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">本地优先</span>}
      </div>
      <div className="space-y-1">
        {[...state.stages].sort((a, b) => a.position - b.position).map((stage, index) => (
          <div key={stage.id} className="flex items-center gap-2 rounded border border-black/[0.06] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.06] dark:bg-panel-dark">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-gray-800 dark:text-text-primary">{stage.name}</span>
            <span className="shrink-0 text-gray-400 dark:text-text-tertiary">{stage.required ? '必选' : '可选'}</span>
            {stage.locked && <LockBadge />}
            <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">{stage.candidateCount} 候选</span>
          </div>
        ))}
      </div>
      {state.assumptions.length > 0 && (
        <div className="text-xs text-gray-500 dark:text-text-tertiary">
          <div className="font-medium">系统假设</div>
          {state.assumptions.map((assumption, index) => <div key={index}>· {assumption}</div>)}
        </div>
      )}
    </div>
  );
}

function LockBadge() {
  return <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/5 dark:text-text-tertiary">锁定</span>;
}

function ProposalPreview({ proposal, busy, onApply, onReject }: { proposal: ChangeProposal; busy: string | null; onApply: () => void; onReject: () => void }) {
  const p = proposal.proposal;
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-500/30 dark:bg-blue-500/10">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-blue-700 dark:text-blue-300">AI 对你的理解</h3>
        <span className="text-[10px] text-blue-400">{proposal.status}</span>
      </div>
      <p className="mt-1 text-sm text-gray-800 dark:text-text-primary">{p.interpretation.summary}</p>
      <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-text-secondary">
        {p.interpretation.bullets.map((bullet, index) => <li key={index}>· {bullet}</li>)}
      </ul>
      <div className="mt-3 space-y-1 border-t border-blue-200/70 pt-2 dark:border-blue-500/20">
        {p.impact.summaryRows.map((row, index) => (
          <div key={index} className="flex justify-between gap-3 text-xs">
            <span className="text-gray-500 dark:text-text-tertiary">{row.item}</span>
            <span className="text-right text-gray-800 dark:text-text-primary">{row.impact}</span>
          </div>
        ))}
      </div>
      {p.conflicts.length > 0 && (
        <div className="mt-2 space-y-1 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {p.conflicts.map((conflict, index) => (
            <div key={index} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{conflict.message}</div>
          ))}
        </div>
      )}
      {p.warnings.length > 0 && (
        <div className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
          {p.warnings.map((warning, index) => <div key={index}>⚠ {warning}</div>)}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button onClick={onApply} disabled={busy === 'apply'} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}确认调整
        </button>
        <button onClick={onReject} className="flex items-center gap-1 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-light-surface dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">
          <X className="h-3.5 w-3.5" />取消
        </button>
      </div>
    </div>
  );
}

export const DialogueTab: React.FC<Props> = ({ state, proposal, message, setMessage, busy, onSend, onApply, onReject }) => {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="rounded-lg border border-black/[0.06] bg-light-surface p-3 dark:border-white/[0.06] dark:bg-surface-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-text-tertiary">系统当前理解</h3>
          <ConstraintChips state={state} />
        </div>
        {proposal && (
          <ProposalPreview proposal={proposal} busy={busy} onApply={onApply} onReject={onReject} />
        )}
      </div>

      <div className="flex flex-col rounded-lg border border-black/[0.06] p-3 dark:border-white/[0.06]">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-text-tertiary">AI 对话调整</h3>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_COMMANDS.map((command) => (
            <button key={command} onClick={() => setMessage(command)} className="rounded-full border border-black/10 px-2.5 py-1 text-xs text-gray-600 hover:bg-light-surface dark:border-white/10 dark:text-text-secondary dark:hover:bg-white/5">
              {command}
            </button>
          ))}
        </div>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="例如：删除实验追踪环节 / 只保留 Python 工具 / 增加模型解释环节…"
          rows={4}
          className="min-h-24 w-full flex-1 resize-none rounded-lg border border-black/10 bg-light-surface px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-400 dark:border-white/10 dark:bg-surface-2 dark:text-text-primary"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-gray-400 dark:text-text-tertiary">AI 只生成变更提案，确认后才会应用。</p>
          <button onClick={onSend} disabled={!message.trim() || busy !== null} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            生成提案
          </button>
        </div>
      </div>
    </div>
  );
};
