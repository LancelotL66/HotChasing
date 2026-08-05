import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FlaskConical,
  Github,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  Trash2,
  AlertTriangle,
  Archive,
  FileText,
  FolderOpen,
  Play,
  X,
} from "lucide-react";
import { backend } from "../services/backendAdapter";
import { isElectron } from "../services/electronProxy";
import { getLocalAgentConfig } from "../services/localAgentConfig";
import { ReadmeModal } from "./ReadmeModal";
import MarkdownRenderer from "./MarkdownRenderer";
import type { Repository } from "../types";
import { useForkLabStore } from "../store/useForkLabStore";
import {
  forkLabApi,
  type ForkLabProject,
} from "../services/forkLabApi";
import {
  deploymentApi,
  type DeploymentTask,
  type LocalDeployment,
  type ProjectTestReport,
} from "../services/deploymentApi";

type TabId = "library" | "running" | "deployed" | "failed";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "library", label: "项目库" },
  { id: "running", label: "测试中" },
  { id: "deployed", label: "已部署" },
  { id: "failed", label: "失败与受限" },
];

const STATUS_FILTERS = [
  "全部",
  "待分析",
  "分析完成",
  "计划未生成",
  "计划已生成",
  "测试中",
  "已部署",
  "需要人工处理",
];

function jsonList(value: string | null): string[] {
  try {
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
}

function parseAssessmentJson(project: ForkLabProject): Record<string, unknown> | null {
  try {
    return project.assessment?.assessment_json ? (JSON.parse(project.assessment.assessment_json) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parsePlanJson(project: ForkLabProject): Record<string, unknown> | null {
  try {
    return project.plan?.plan_json ? (JSON.parse(project.plan.plan_json) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toReadmeRepository(project: ForkLabProject): Repository {
  const repo = project.repo ?? {};
  const fullName = String(repo.full_name ?? project.upstream_full_name);
  const [owner = "", name = fullName] = fullName.split("/");
  return {
    id: Number(repo.id ?? project.repo_id),
    name: String(repo.name ?? name),
    full_name: fullName,
    description: typeof repo.description === "string" ? repo.description : null,
    html_url: String(repo.html_url ?? `https://github.com/${fullName}`),
    stargazers_count: Number(repo.stargazers_count ?? 0),
    forks_count: Number(repo.forks_count ?? 0),
    forks: Number(repo.forks ?? repo.forks_count ?? 0),
    language: typeof repo.language === "string" ? repo.language : null,
    created_at: String(repo.created_at ?? project.selected_at),
    updated_at: String(repo.updated_at ?? project.selected_at),
    pushed_at: String(repo.pushed_at ?? repo.updated_at ?? project.selected_at),
    owner: { login: String(repo.owner_login ?? owner), avatar_url: String(repo.owner_avatar_url ?? "") },
    topics: jsonList(typeof repo.topics === "string" ? repo.topics : ""),
    hot_summary_zh: typeof repo.hot_summary_zh === "string" ? repo.hot_summary_zh : null,
  };
}

function projectStatus(project: ForkLabProject): string[] {
  const statuses: string[] = [];
  if (!project.assessment) statuses.push("待分析");
  if (project.assessment) statuses.push("分析完成");
  if (!project.plan) statuses.push("计划未生成");
  if (project.plan) statuses.push("计划已生成");
  if (["QUEUED", "TESTING"].includes(project.project_status)) statuses.push("测试中");
  if (project.project_status === "DEPLOYED") statuses.push("已部署");
  if (project.project_status === "FAILED") statuses.push("需要人工处理");
  return statuses;
}

function statusBadge(label: string) {
  const colorMap: Record<string, string> = {
    待分析: "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-200",
    分析完成: "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300",
    计划未生成: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
    计划已生成: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300",
    测试中: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300",
    已部署: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
    需要人工处理: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
  };
  return colorMap[label] ?? "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-200";
}

type HumanDecisionRequest = {
  requestId?: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
};

function pendingDecision(events: DeploymentTask['events']): HumanDecisionRequest | null {
  if (!events) return null;
  const requestIndex = [...events].map((event) => event.stage === 'WAITING_FOR_INPUT' && event.event_type === 'stage').lastIndexOf(true);
  if (requestIndex < 0 || events.slice(requestIndex + 1).some((event) => event.event_type === 'decision_response')) return null;
  try {
    const parsed = JSON.parse(events[requestIndex].message) as Partial<HumanDecisionRequest>;
    if (typeof parsed.question !== 'string') return null;
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((option): option is { id: string; label: string; description?: string } => typeof option?.id === 'string' && typeof option?.label === 'string')
      : [];
    return { requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined, question: parsed.question, options };
  } catch {
    return null;
  }
}

function PlanEditorDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ForkLabProject;
  onClose: () => void;
  onSaved: (project: ForkLabProject) => void;
}) {
  const [summary, setSummary] = useState("");
  const [jsonText, setJsonText] = useState("{}");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const current = parsePlanJson(project);
  useEffect(() => {
    setSummary(String(current?.summary ?? ""));
    setJsonText(JSON.stringify(current ?? {}, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.plan?.id, project.plan?.plan_version, project.plan?.updated_at]);

  const save = async () => {
    setError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      setError("部署计划 JSON 格式有误，无法保存。");
      return;
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      setError("部署计划至少需要一个 steps 步骤。");
      return;
    }
    parsed.summary = summary;
    setSaving(true);
    try {
      const result = await forkLabApi.updatePlan(project.id, parsed);
      onSaved({ ...project, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const lock = async () => {
    setError("");
    try {
      const result = await forkLabApi.lockPlan(project.id);
      onSaved({ ...project, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : "锁定失败");
    }
  };

  const unlock = async () => {
    setError("");
    try {
      const result = await forkLabApi.unlockPlan(project.id);
      onSaved({ ...project, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : "解锁失败");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-black/10 bg-white p-6 shadow-dialog dark:bg-panel-dark dark:border-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">编辑部署计划</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-gray-100 dark:hover:bg-white/10" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-300">计划摘要（自然语言流程说明）</p>
        <textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          disabled={project.plan?.locked === 1}
          rows={2}
          className="w-full rounded-lg border border-black/10 bg-white p-2 text-sm dark:bg-black/20 dark:border-white/10"
        />
        <p className="mb-2 mt-4 text-sm text-gray-600 dark:text-gray-300">结构化 deployment-plan.json</p>
        <textarea
          value={jsonText}
          onChange={(event) => setJsonText(event.target.value)}
          disabled={project.plan?.locked === 1}
          rows={14}
          className="w-full rounded-lg border border-black/10 bg-white p-2 font-mono text-xs dark:bg-black/20 dark:border-white/10"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          {project.plan?.locked !== 1 && (
            <>
              <button onClick={lock} className="rounded-lg px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10">
                锁定流程
              </button>
              <button onClick={save} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
                {saving ? "保存中…" : "保存修改"}
              </button>
            </>
          )}
          {project.plan?.locked === 1 && (
            <button onClick={unlock} className="inline-flex items-center gap-1 rounded-lg border border-amber-600 px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10">
              <Lock className="h-4 w-4" /> 解锁流程
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AssessmentPanel({ project }: { project: ForkLabProject }) {
  const assessment = parseAssessmentJson(project);
  if (!assessment) return null;
  const scoreRow = (label: string, value: unknown, accent: string) => {
    const n = Number(value);
    return (
      <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        <p className={`mt-1 text-lg font-semibold ${accent}`}>{Number.isFinite(n) ? n : "—"}</p>
      </div>
    );
  };
  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-800/40 dark:bg-blue-950/20">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {scoreRow("部署价值", assessment.deploymentValueScore, "text-blue-700 dark:text-blue-300")}
        {scoreRow("部署难度", assessment.deploymentDifficultyScore, "text-orange-600 dark:text-orange-300")}
        {scoreRow("可测试性", assessment.testabilityScore, "text-green-600 dark:text-green-300")}
        {scoreRow("风险", assessment.riskScore, "text-red-600 dark:text-red-300")}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-white px-2 py-1 text-gray-700 dark:bg-black/20 dark:text-gray-200">
          建议级别：{String(assessment.recommendedLevel ?? "—")}
        </span>
        <span className="rounded bg-white px-2 py-1 text-gray-700 dark:bg-black/20 dark:text-gray-200">
          部署方式：{String(assessment.recommendedMethod ?? "—")}
        </span>
        <span className="rounded bg-white px-2 py-1 text-gray-700 dark:bg-black/20 dark:text-gray-200">
          置信度：{Number(assessment.confidence ?? 0).toFixed(2)}
        </span>
        {project.assessment && (
          <span className="rounded bg-white px-2 py-1 text-gray-500 dark:bg-black/20 dark:text-gray-400">
            来源：{project.assessment.ai_config_id ? "AI" : "规则"}
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">
        {Array.isArray(assessment.difficultyReasons) && assessment.difficultyReasons.length > 0
          ? `难度说明：${(assessment.difficultyReasons as string[]).join("；")}`
          : "未提供难度说明。"}
      </p>
    </div>
  );
}

function ReportDialog({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const [reports, setReports] = useState<ProjectTestReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"report" | "logs">("report");
  const [workspaceBusy, setWorkspaceBusy] = useState<"open" | "archive" | "delete" | null>(null);

  useEffect(() => {
    void deploymentApi.listProjectReports(projectId)
      .then((result) => setReports(result.reports))
      .catch((err) => setError(err instanceof Error ? err.message : "加载报告失败"))
      .finally(() => setLoading(false));
  }, [projectId]);

  const report = reports[0];
  const workspaceAction = async (action: "open" | "archive" | "delete") => {
    if (!report?.workspace_path || !window.electronAPI?.runner) return;
    if (action === "delete" && !window.confirm("删除此任务的全部本地测试文件？已保存的项目报告和日志不会删除。")) return;
    setWorkspaceBusy(action);
    setError("");
    try {
      const result = action === "open"
        ? await window.electronAPI.runner.openWorkspace(report.workspace_path)
        : action === "archive"
          ? await window.electronAPI.runner.archiveWorkspace(report.workspace_path)
          : await window.electronAPI.runner.deleteWorkspace(report.workspace_path);
      if (!result.success) throw new Error(result.error ?? "工作区操作失败");
      if (action === "archive") setError("测试文件已迁移到所选目录，项目报告和日志已保留。");
      if (action === "delete") setError("本地测试文件已删除，项目报告和日志已保留。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "工作区操作失败");
    } finally {
      setWorkspaceBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border border-black/10 bg-white shadow-dialog dark:border-white/10 dark:bg-panel-dark" onClick={(event) => event.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div><h3 className="text-base font-semibold">{projectName} 的测试报告</h3><p className="mt-1 text-xs text-gray-500">报告随项目保存；清理本地工作区不会删除报告与日志。</p></div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-gray-100 dark:hover:bg-white/10" aria-label="关闭"><X className="h-5 w-5" /></button>
        </div>
        {loading ? <div className="p-8 text-center text-sm text-gray-500">加载报告中…</div> : !report ? <div className="p-8 text-center text-sm text-gray-500">该项目尚无已保存的测试报告。</div> : <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <div className="flex gap-1"><button onClick={() => setView("report")} className={`rounded-md px-3 py-1.5 text-sm ${view === "report" ? "bg-blue-600 text-white" : "hover:bg-gray-100 dark:hover:bg-white/10"}`}>中文报告</button><button onClick={() => setView("logs")} className={`rounded-md px-3 py-1.5 text-sm ${view === "logs" ? "bg-blue-600 text-white" : "hover:bg-gray-100 dark:hover:bg-white/10"}`}>测试日志</button></div>
            {isElectron() && report.workspace_path && <div className="flex flex-wrap gap-1"><button title="在文件管理器中打开测试工作区" onClick={() => void workspaceAction("open")} disabled={workspaceBusy !== null} className="rounded-md p-2 text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/10"><FolderOpen className="h-4 w-4" /></button><button onClick={() => void workspaceAction("archive")} disabled={workspaceBusy !== null} className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-500/10"><Archive className="h-4 w-4" />转移位置</button><button onClick={() => void workspaceAction("delete")} disabled={workspaceBusy !== null} className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" />删除本地文件</button></div>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">{view === "report" ? <MarkdownRenderer content={report.report_markdown} className="rounded-md bg-black/5 p-4 dark:bg-black/30" /> : <pre className="whitespace-pre-wrap break-words rounded-md bg-black/5 p-4 text-xs leading-6 text-gray-800 dark:bg-black/30 dark:text-gray-200">{report.logs_text || "未保存可用的 Agent 测试日志。"}</pre>}</div>
          <div className="border-t border-black/10 px-5 py-3 text-xs text-gray-500 dark:border-white/10">测试完成：{new Date(report.created_at).toLocaleString("zh-CN")} · 状态：{report.status}{report.workspace_path ? ` · 工作区：${report.workspace_path}` : ""}</div>
        </>}
        {error && <p className="mx-5 mb-4 rounded-md bg-blue-50 p-2 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-100">{error}</p>}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  selected,
  onToggleSelect,
  onRefresh,
}: {
  project: ForkLabProject;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<null | "assessment" | "plan" | "regenerate-plan" | "remove">(null);
  const [error, setError] = useState("");
  const [showPlanEditor, setShowPlanEditor] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showReadme, setShowReadme] = useState(false);
  const repo = project.repo ?? {};
  const topics = jsonList(String(repo.topics ?? ""));
  const plan = parsePlanJson(project);
  const statuses = projectStatus(project);

  const run = async (action: "assessment" | "plan") => {
    setBusy(action);
    setError("");
    try {
      if (action === "assessment") {
        const result = await forkLabApi.generateAssessment(project.id);
        onRefresh(project.id);
        if (!result.cached) setExpanded(true);
      } else {
        await forkLabApi.generatePlan(project.id);
        onRefresh(project.id);
        setShowPlanEditor(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(null);
    }
  };

  const regeneratePlan = async () => {
    setBusy("regenerate-plan");
    setError("");
    try {
      await forkLabApi.generatePlan(project.id, true);
      onRefresh(project.id);
      setShowPlanEditor(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新生成流程失败");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError("");
    try {
      await forkLabApi.removeProject(project.id);
      useForkLabStore.getState().markRemoved(project.repo_id);
      onRefresh(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{project.upstream_full_name}</span>
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-500/20 dark:text-blue-300">
              来源：{project.source === "digest" ? "日报" : project.source === "top100" ? "Top100" : "手动"}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {String(repo.language ?? "未知语言")} · Stars {Number(repo.stargazers_count ?? 0).toLocaleString()}
            {typeof repo.hot_summary_zh === "string" && repo.hot_summary_zh && (
              <span className="ml-2 text-blue-600 dark:text-blue-300">AI 摘要已生成</span>
            )}
          </p>
        </div>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(project.id)}
          aria-label={`选择 ${project.upstream_full_name}`}
          className="h-4 w-4"
        />
      </div>

      {typeof repo.hot_summary_zh === "string" && repo.hot_summary_zh && (
        <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm leading-6 text-blue-950 dark:bg-blue-950/30 dark:text-blue-100">
          {repo.hot_summary_zh}
        </div>
      )}

      {statuses.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {statuses.map((status) => (
            <span key={status} className={`rounded px-2 py-1 text-xs ${statusBadge(status)}`}>
              {status}
            </span>
          ))}
        </div>
      )}

      {topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {topics.slice(0, 6).map((tag) => (
            <span key={tag} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-white/10 dark:text-gray-300">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => run("assessment")}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-lg border border-blue-600 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-500/10"
        >
          {busy === "assessment" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {project.assessment ? "重新分析" : "生成部署分析"}
        </button>
        <button onClick={() => setShowReport(true)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10">
          <FileText className="h-4 w-4" /> 查看测试报告
        </button>
        <button onClick={() => setShowReadme(true)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/10">
          <FileText className="h-4 w-4" /> README
        </button>
        <button
          onClick={() => (project.plan ? setShowPlanEditor(true) : run("plan"))}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-lg border border-amber-600 px-3 py-1.5 text-sm text-amber-600 hover:bg-amber-50 disabled:opacity-50 dark:hover:bg-amber-500/10"
        >
          {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
          {project.plan ? "查看/编辑流程" : "生成建议流程"}
        </button>
        {project.plan && (
          <button
            onClick={() => void regeneratePlan()}
            disabled={busy !== null || project.plan.locked === 1}
            title={project.plan.locked === 1 ? "请先在流程编辑器中解锁" : "按当前仓库信息重新生成本地测试流程"}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
          >
            {busy === "regenerate-plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            重新生成测试流程
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
        >
          <Rocket className="h-4 w-4" /> {expanded ? "收起分析" : "查看部署分析"}
        </button>
        <a
          href={`https://github.com/${project.upstream_full_name}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
        >
          <Github className="h-4 w-4" /> 上游
        </a>
        <button
          onClick={remove}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-500/10"
        >
          {busy === "remove" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} 从实验室移除
        </button>
      </div>

      {expanded && <AssessmentPanel project={project} />}
      {plan && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-gray-600 dark:text-gray-300">
            建议流程：{String(plan.summary ?? "")}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/5 p-3 text-xs dark:bg-black/30">
            {JSON.stringify(plan, null, 2)}
          </pre>
        </details>
      )}

      {showPlanEditor && (
        <PlanEditorDialog
          project={project}
          onClose={() => setShowPlanEditor(false)}
          onSaved={(updated) => {
            setShowPlanEditor(false);
            onRefresh(updated.id);
          }}
        />
      )}
      {showReport && <ReportDialog projectId={project.id} projectName={project.upstream_full_name} onClose={() => setShowReport(false)} />}
      <ReadmeModal isOpen={showReadme} onClose={() => setShowReadme(false)} repository={showReadme ? toReadmeRepository(project) : null} />
    </article>
  );
}

function EmptyTab({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-black/10 bg-white/50 p-10 text-center dark:border-white/10 dark:bg-white/5">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400 dark:bg-white/10">
        {icon}
      </div>
      <h3 className="mt-4 text-base font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">{description}</p>
    </div>
  );
}

function DecisionDialog({ task, request, onClose, onSubmit }: { task: DeploymentTask; request: HumanDecisionRequest; onClose: () => void; onSubmit: (choice: string, note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const options = request.options.length > 0 ? request.options : [
    { id: 'allow_once', label: '允许一次', description: '按 Agent 建议继续当前操作。' },
    { id: 'skip', label: '跳过', description: '跳过当前操作并在报告中记录。' },
    { id: 'stop', label: '终止', description: '停止当前测试并记录原因。' },
  ];
  const submit = async (choice: string) => {
    setSubmitting(true);
    try {
      await onSubmit(choice, note);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-lg border border-black/10 bg-white p-5 shadow-dialog dark:border-white/10 dark:bg-panel-dark" onClick={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">需要人工确认</h3>
        <p className="mt-1 text-xs text-gray-500">{task.project?.upstream_full_name ?? task.workspace_project_id}</p>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-6">{request.question}</p>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="可选说明" className="mt-4 w-full rounded-md border border-black/10 bg-white p-2 text-sm dark:border-white/10 dark:bg-black/20" />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/10">稍后处理</button>
          {options.map((option) => <button key={option.id} title={option.description} onClick={() => void submit(option.id)} disabled={submitting} className="rounded-md border border-blue-600 px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-500/10">{submitting ? "提交中…" : option.label}</button>)}
        </div>
      </div>
    </div>
  );
}

export function ForkLabView() {
  const [activeTab, setActiveTab] = useState<TabId>("library");
  const [projects, setProjects] = useState<ForkLabProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const [runningTasks, setRunningTasks] = useState<DeploymentTask[]>([]);
  const [failedTasks, setFailedTasks] = useState<DeploymentTask[]>([]);
  const [deployments, setDeployments] = useState<LocalDeployment[]>([]);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [decisionTask, setDecisionTask] = useState<{ task: DeploymentTask; request: HumanDecisionRequest } | null>(null);
  const [reportProject, setReportProject] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await forkLabApi.listProjects();
      setProjects(result.projects);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let attempts = 0;
    const loadWhenBackendReady = () => {
      if (!backend.backendUrl) {
        if (attempts++ < 20) timer = window.setTimeout(loadWhenBackendReady, 250);
        return;
      }
      void load();
    };
    loadWhenBackendReady();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  const refreshProject = useCallback(async (id: string) => {
    try {
      const result = await forkLabApi.getProject(id);
      setProjects((prev) => prev.map((p) => (p.id === id ? result.project : p)));
    } catch {
      void load();
    }
  }, [load]);

  const loadTabData = useCallback(async () => {
    setTabsLoading(true);
    setMessage("");
    try {
      const [running, failed, deploymentsResult] = await Promise.all([
        deploymentApi.listTasks("running"),
        deploymentApi.listTasks("failed"),
        deploymentApi.listDeployments(),
      ]);
      const runningWithEvents = await Promise.all(running.tasks.map(async (task) => {
        try {
          const detail = await deploymentApi.getTask(task.id);
          return { ...task, events: detail.events };
        } catch {
          return task;
        }
      }));
      setRunningTasks(runningWithEvents);
      setFailedTasks(failed.tasks);
      setDeployments(deploymentsResult.deployments);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载部署任务失败");
    } finally {
      setTabsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTabData();
  }, [activeTab, loadTabData]);

  useEffect(() => {
    if (activeTab !== "running") return;
    const timer = window.setInterval(() => void loadTabData(), 4000);
    return () => window.clearInterval(timer);
  }, [activeTab, loadTabData]);

  const taskAction = async (action: () => Promise<unknown>) => {
    setTabsLoading(true);
    try {
      await action();
      await loadTabData();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "任务操作失败");
    } finally {
      setTabsLoading(false);
    }
  };

  const clearTask = async (task: DeploymentTask, stopFirst = false) => {
    if (!window.confirm(stopFirst ? `停止并清除 ${task.project?.upstream_full_name ?? '此任务'} 的所有测试记录？` : `清除 ${task.project?.upstream_full_name ?? '此任务'} 的所有测试记录？`)) return;
    await taskAction(async () => {
      if (stopFirst && !['CANCELLED', 'COMPLETED', 'FAILED', 'BLOCKED', 'MANUAL_REQUIRED'].includes(task.status)) await deploymentApi.cancelTask(task.id);
      await deploymentApi.deleteTask(task.id);
    });
  };

  const clearDeployment = async (deployment: LocalDeployment) => {
    if (!deployment.task_id) {
      setMessage("此部署记录没有关联测试任务，无法清除。");
      return;
    }
    if (!window.confirm(`删除 ${deployment.project?.upstream_full_name ?? "此项目"} 的部署记录？本地工作区和已保存的测试报告不会删除。`)) return;
    await taskAction(() => deploymentApi.deleteTask(deployment.task_id!));
  };

  const startSelectedTests = async () => {
    if (selectedIds.size === 0) return;
    if (!isElectron() || !window.electronAPI?.runner) {
      setMessage("直接开始测试需要使用 HotChasing 桌面版，以便安全启动本机 Runner。网页版不能直接启动电脑上的 Agent。\n");
      return;
    }
    setBatchBusy(true);
    setMessage("");
    let taskIds: string[] = [];
    try {
      const result = await deploymentApi.createBatch(Array.from(selectedIds));
      taskIds = result.tasks.map((task) => task.id);
      const agentConfig = getLocalAgentConfig();
      const started = await window.electronAPI.runner.start({
        backendUrl: backend.backendUrl!,
        agent: agentConfig.agent,
        taskIds,
        runnerName: agentConfig.runnerName,
        workspaceRoot: agentConfig.workspaceRoot,
        model: agentConfig.model,
        autoApprove: agentConfig.autoApprove,
        pureMode: agentConfig.pureMode,
      });
      if (!started.success) throw new Error(started.error ?? "启动本机测试失败");
      setMessage(`已开始测试 ${result.tasks.length} 个项目。本机 Agent 会只执行本次选择的项目，完成后自动退出。`);
      setSelectedIds(new Set());
      setActiveTab("running");
      await loadTabData();
      await load();
    } catch (err) {
      await Promise.all(taskIds.map((taskId) => deploymentApi.deleteTask(taskId).catch(() => undefined)));
      setMessage(err instanceof Error ? err.message : "开始测试失败");
    } finally {
      setBatchBusy(false);
    }
  };

  const filtered = useMemo(() => {
    if (statusFilter === "全部") return projects;
    return projects.filter((p) => projectStatus(p).includes(statusFilter));
  }, [projects, statusFilter]);
  const offlineRunnerTasks = failedTasks.filter((task) => task.current_stage === "RUNNER_OFFLINE");

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const batchRun = async (action: "assessment" | "plan" | "remove") => {
    if (selectedIds.size === 0) return;
    setBatchBusy(true);
    setMessage("");
    let ok = 0;
    let failed = 0;
    try {
      for (const id of selectedIds) {
        try {
          if (action === "assessment") await forkLabApi.generateAssessment(id);
          else if (action === "plan") await forkLabApi.generatePlan(id);
          else {
            await forkLabApi.removeProject(id);
            const project = projects.find((p) => p.id === id);
            if (project) useForkLabStore.getState().markRemoved(project.repo_id);
          }
          ok += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      setBatchBusy(false);
      setSelectedIds(new Set());
      await load();
      setMessage(`批量操作完成：成功 ${ok}，失败 ${failed}。`);
    }
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((p) => next.add(p.id));
      return next;
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <FlaskConical className="h-5 w-5" /> Fork 实验室
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            从日报与 Top100 选择项目，查看 README、生成部署分析，并直接开始本地测试。
          </p>
        </div>
        <button onClick={() => void load()} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">
          <RefreshCw className="h-4 w-4" /> 刷新
        </button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-black/10 pb-2 dark:border-white/10">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            aria-label={tab.label}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              activeTab === tab.id
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
            }`}
            >
            {tab.label}
            <span className="ml-1 text-xs opacity-80">({tab.id === "library" ? projects.length : tab.id === "running" ? runningTasks.length : tab.id === "deployed" ? deployments.length : failedTasks.length})</span>
          </button>
        ))}
      </div>

      {message && (
        <p className="rounded-lg bg-blue-50 p-3 text-blue-800 dark:bg-blue-950/30 dark:text-blue-100">{message}</p>
      )}

      {offlineRunnerTasks.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
          <span>{offlineRunnerTasks.length} 个测试任务因 Runner 离线已暂停。重新启动 Runner 后可重试。</span>
          <button onClick={() => setActiveTab("failed")} className="rounded-lg border border-amber-700 px-3 py-1.5 text-sm hover:bg-amber-100 dark:hover:bg-amber-900/30">查看任务</button>
        </div>
      )}

      {activeTab === "library" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter}
                onClick={() => setStatusFilter(filter)}
                className={`rounded-full border px-3 py-1 text-sm ${statusFilter === filter ? "border-blue-600 bg-blue-600 text-white" : ""}`}
              >
                {filter}
              </button>
            ))}
          </div>

          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 p-3 dark:border-blue-800/40 dark:bg-blue-950/20">
              <span className="text-sm text-blue-800 dark:text-blue-200">已选 {selectedIds.size} 项：</span>
              <button onClick={() => void batchRun("assessment")} disabled={batchBusy} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {batchBusy ? "处理中…" : "批量生成部署分析"}
              </button>
              <button onClick={() => void batchRun("plan")} disabled={batchBusy} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {batchBusy ? "处理中…" : "批量生成建议流程"}
              </button>
              <button onClick={selectAllVisible} className="rounded-lg border border-blue-600 px-3 py-1.5 text-sm text-blue-600">
                全选当前筛选
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="rounded-lg px-3 py-1.5 text-sm text-blue-600">
                清空
              </button>
               <button onClick={() => void startSelectedTests()} disabled={batchBusy} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                 {batchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {batchBusy ? "启动中…" : "开始测试所选项目"}
               </button>
              <button onClick={() => void batchRun("remove")} disabled={batchBusy} className="rounded-lg border border-red-600 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">
                {batchBusy ? "处理中…" : "批量移除"}
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
            </div>
          ) : filtered.length === 0 ? (
            <EmptyTab
              icon={<FlaskConical className="h-6 w-6" />}
              title="项目库为空"
              description="在热点日报或 Top100 的项目卡片上点击「加入 Fork 实验室」，把感兴趣的项目收集到这里统一管理。"
            />
          ) : (
            <div className="space-y-3">
              {filtered.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  selected={selectedIds.has(project.id)}
                  onToggleSelect={toggleSelect}
                  onRefresh={(id) => void refreshProject(id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "running" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            正在测试的项目（每 4 秒刷新，共 {runningTasks.length} 项）。
          </p>
          {tabsLoading ? (
            <div className="flex items-center justify-center py-10 text-gray-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
          ) : runningTasks.length === 0 ? (
            <EmptyTab icon={<Loader2 className="h-6 w-6" />} title="暂无测试中的项目" description="批量开始测试后，项目进度会实时显示在这里。" />
          ) : (
            <div className="space-y-2">
              {runningTasks.map((task) => (
                <div key={task.id} className="rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{task.project?.upstream_full_name ?? task.workspace_project_id}</p>
                      <p className="mt-1 text-xs text-gray-500">
                         状态：{task.status === "QUEUED" ? "正在启动本机 Agent" : "测试中"} · 阶段：{task.current_stage ?? task.status}
                      </p>
                    </div>
                    <button
                      onClick={() => void taskAction(() => deploymentApi.cancelTask(task.id))}
                      className="rounded-lg border border-red-600 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      取消
                    </button>
                    <button onClick={() => void clearTask(task, true)} className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">停止并清除</button>
                  </div>
                  {pendingDecision(task.events) && (
                    <button
                      onClick={() => setDecisionTask({ task, request: pendingDecision(task.events)! })}
                      className="mt-3 rounded-lg border border-amber-600 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
                    >
                      需要人工确认
                    </button>
                  )}
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-white/10">
                    <div className="h-full rounded-full bg-indigo-600" style={{ width: `${Math.max(2, Math.round(task.progress ?? 0))}%` }} />
                  </div>
                  {task.events && task.events.length > 0 && (
                    <div className="mt-3 max-h-28 overflow-auto rounded-md bg-black/5 p-2 font-mono text-xs text-gray-600 dark:bg-black/30 dark:text-gray-300">
                      {task.events.slice(-4).map((event, index) => (
                        <p key={`${event.created_at}-${index}`} className="break-words">[{event.stage ?? event.event_type}] {event.message}</p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "deployed" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            本地已构建/运行的项目（共 {deployments.length} 项）。启动/停止/重建等管理操作将在 M8 阶段实现。
          </p>
          {tabsLoading ? (
            <div className="flex items-center justify-center py-10 text-gray-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
          ) : deployments.length === 0 ? (
            <EmptyTab icon={<CheckCircle2 className="h-6 w-6" />} title="暂无已部署项目" description="任务校验通过后，已部署项目会出现在这里。" />
          ) : (
            <div className="space-y-2">
              {deployments.map((deployment) => (
                <div key={deployment.id} className="rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-white/5">
                  <p className="text-sm font-semibold">{deployment.project?.upstream_full_name ?? deployment.workspace_project_id}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    状态：{deployment.status} · 端口：{(() => { try { return JSON.parse(deployment.ports_json ?? "[]").join(", ") || "—"; } catch { return "—"; } })()}
                  </p>
                  {deployment.workspace_path && <p className="mt-1 text-xs text-gray-400">工作区：{deployment.workspace_path}</p>}
                  <div className="mt-3 flex justify-end">
                    <button onClick={() => setReportProject({ id: deployment.workspace_project_id, name: deployment.project?.upstream_full_name ?? deployment.workspace_project_id })} className="mr-2 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"><FileText className="h-4 w-4" />查看报告</button>
                    <button
                      onClick={() => void clearDeployment(deployment)}
                      title="删除部署记录和关联任务，保留项目库与测试报告"
                      className="inline-flex items-center gap-1 rounded-lg border border-red-600 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" /> 删除部署记录
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "failed" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            失败与受限任务（共 {failedTasks.length} 项）。可重试或转人工处理。
          </p>
          {tabsLoading ? (
            <div className="flex items-center justify-center py-10 text-gray-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
          ) : failedTasks.length === 0 ? (
            <EmptyTab icon={<AlertTriangle className="h-6 w-6" />} title="暂无失败任务" description="构建失败、需要 GPU/账号/凭据或存在风险的任务会汇总在这里。" />
          ) : (
            <div className="space-y-2">
              {failedTasks.map((task) => (
                <div key={task.id} className="rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-800/40 dark:bg-red-950/20">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{task.project?.upstream_full_name ?? task.workspace_project_id}</p>
                      <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                        {task.status} · {task.error_message ?? "未知错误"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void taskAction(() => deploymentApi.retryTask(task.id))}
                        className="rounded-lg border border-blue-600 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10"
                      >
                        重试
                      </button>
                      {task.status !== "MANUAL_REQUIRED" && (
                        <button
                          onClick={() => void taskAction(() => deploymentApi.markManual(task.id))}
                          className="rounded-lg border border-amber-600 px-3 py-1.5 text-sm text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                        >
                          转人工
                        </button>
                      )}
                      <button onClick={() => void clearTask(task)} className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">清除记录</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {decisionTask && (
        <DecisionDialog
          task={decisionTask.task}
          request={decisionTask.request}
          onClose={() => setDecisionTask(null)}
          onSubmit={async (choice, note) => {
            await deploymentApi.submitDecision(decisionTask.task.id, decisionTask.request.requestId, choice, note || undefined);
            await loadTabData();
          }}
        />
      )}
      {reportProject && <ReportDialog projectId={reportProject.id} projectName={reportProject.name} onClose={() => setReportProject(null)} />}

    </section>
  );
}
