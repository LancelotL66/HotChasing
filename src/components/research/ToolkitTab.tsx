import React from 'react';
import { Star, Trash2, AlertTriangle, Info } from 'lucide-react';
import type { ToolkitView } from '../../services/researchApi';

interface Props {
  toolkit: ToolkitView | null;
  onRemove: (githubNodeId: string) => void;
  onSetPrimary: (githubNodeId: string, stageId: string) => void;
}

const COVERAGE_STYLES: Record<string, string> = {
  '已覆盖': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  '待确认': 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  '缺失': 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

export const ToolkitTab: React.FC<Props> = ({ toolkit, onRemove, onSetPrimary }) => {
  if (!toolkit) return <p className="py-8 text-center text-sm text-gray-400 dark:text-text-tertiary">加载工具链中…</p>;

  return (
    <div className="space-y-4">
      {toolkit.reminders.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {toolkit.reminders.map((reminder, index) => (
            <div key={index} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{reminder}</div>
          ))}
        </div>
      )}

      {toolkit.unassigned.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          <div className="mb-1 flex items-center gap-1.5 font-medium"><Info className="h-3.5 w-3.5" />待重新归类</div>
          {toolkit.unassigned.map((tool) => <div key={tool.githubNodeId}>{tool.fullName}（{tool.status}）</div>)}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-black/[0.06] text-xs text-gray-500 dark:border-white/[0.06] dark:text-text-tertiary">
              <th className="py-2 pr-3 font-medium">研究环节</th>
              <th className="py-2 pr-3 font-medium">主工具</th>
              <th className="py-2 pr-3 font-medium">备选工具</th>
              <th className="py-2 pr-3 font-medium">覆盖状态</th>
              <th className="py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {toolkit.rows.map((row) => (
              <tr key={row.stageId} className="border-b border-black/[0.04] dark:border-white/[0.04]">
                <td className="py-2.5 pr-3">
                  <div className="font-medium text-gray-800 dark:text-text-primary">{row.stageName}</div>
                  <div className="text-xs text-gray-400 dark:text-text-tertiary">{row.required ? '必选' : '可选'}</div>
                </td>
                <td className="py-2.5 pr-3">
                  {row.primary ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <Star className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-gray-800 dark:text-text-primary">{row.primary.fullName}</span>
                      </div>
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-gray-500 dark:bg-white/5 dark:text-text-tertiary">{row.primary.role}</span>
                        <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-gray-500 dark:bg-white/5 dark:text-text-tertiary">{row.primary.acquisitionMode}</span>
                      </div>
                      {row.compatibilityNotes.map((note, index) => (
                        <div key={index} className="text-xs text-amber-700 dark:text-amber-300">⚠ {note}</div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-gray-400 dark:text-text-tertiary">未选择</span>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  <div className="flex flex-col gap-1">
                    {row.alternatives.map((tool) => (
                      <button key={tool.githubNodeId} onClick={() => onSetPrimary(tool.githubNodeId, row.stageId)} className="group flex items-center gap-1.5 text-left text-xs text-gray-600 hover:text-blue-600 dark:text-text-secondary dark:hover:text-blue-300">
                        <Star className="h-3 w-3 text-gray-300 group-hover:text-blue-400" />
                        <span className="truncate">{tool.fullName}</span>
                        <span className="text-gray-400 group-hover:text-blue-400">设为主工具</span>
                      </button>
                    ))}
                    {row.alternatives.length === 0 && <span className="text-xs text-gray-400 dark:text-text-tertiary">—</span>}
                  </div>
                </td>
                <td className="py-2.5 pr-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COVERAGE_STYLES[row.coverage]}`}>{row.coverage}</span>
                </td>
                <td className="py-2.5">
                  {row.primary ? (
                    <button onClick={() => onRemove(row.primary.githubNodeId)} className="flex items-center gap-1 rounded p-1 text-xs text-gray-400 hover:text-red-500" aria-label="移除主工具">
                      <Trash2 className="h-3.5 w-3.5" />移除
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
