import { useEffect, useState } from "react";
import {
  CalendarDays,
  ExternalLink,
  GitFork,
  Github,
  Radar,
  Search,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import {
  digestApi,
  type DailyDigest,
  type DailyDigestItem,
} from "../services/digestApi";
import { backend } from "../services/backendAdapter";
import { ReadmeModal } from "./ReadmeModal";
import { createGitHubApiService } from "../services/githubApiFactory";
import { useAppStore } from "../store/useAppStore";
import { AIService } from "../services/aiService";
import { DiscoveryView } from "./DiscoveryView";
import type { Repository } from "../types";

const CATEGORIES = [
  "全部",
  "AI 与 Agent",
  "开发者工具",
  "数据与数据库",
  "基础设施与 DevOps",
  "效率与自动化",
  "设计与内容创作",
  "安全与隐私",
  "桌面与移动应用",
  "学习与研究",
  "其他 / 待分类",
];
function jsonList(value: string | null): string[] {
  try {
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
}
function toRepository(item: DailyDigestItem): Repository {
  return {
    id: item.repo_id,
    name: item.name,
    full_name: item.full_name,
    html_url: item.html_url,
    description: item.description,
    stargazers_count: item.stargazers_count,
    forks_count: item.forks_count ?? 0,
    forks: item.forks_count ?? 0,
    language: item.language,
    created_at: item.created_at,
    updated_at: item.updated_at,
    pushed_at: item.pushed_at,
    owner: { login: item.owner_login, avatar_url: item.owner_avatar_url },
    topics: jsonList(item.topics),
    hot_summary_zh: item.hot_summary_zh,
    hot_summary_zh_status:
      item.hot_summary_zh_status as Repository["hot_summary_zh_status"],
    hot_summary_zh_source:
      item.hot_summary_zh_source as Repository["hot_summary_zh_source"],
  };
}

export function DailyDigestView() {
  const [hotView, setHotView] = useState<"digest" | "trending">("digest");
  const [digests, setDigests] = useState<
    Array<Pick<DailyDigest, "digest_date" | "title">>
  >([]);
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("全部");
  const [readmeRepository, setReadmeRepository] = useState<Repository | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [archiveNotice, setArchiveNotice] = useState("");
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updatePhase, setUpdatePhase] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [starringId, setStarringId] = useState<number | null>(null);
  const [timeMode, setTimeMode] = useState<"today" | "date" | "range">("today");
  const [selectedDate, setSelectedDate] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [query, setQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<DailyDigestItem[] | null>(null);
  const githubToken = useAppStore((state) => state.githubToken);
  const repositories = useAppStore((state) => state.repositories);
  const addRepository = useAppStore((state) => state.addRepository);
  const aiConfigs = useAppStore((state) => state.aiConfigs);
  const activeAIConfig = useAppStore((state) => state.activeAIConfig);
  const language = useAppStore((state) => state.language);
  const load = async (date?: string) => {
    setLoading(true);
    setMessage("");
    try {
      const list = await digestApi.list();
      setDigests(list);
      const requestedDate = date ?? list[0]?.digest_date ?? new Date().toISOString().slice(0, 10);
      setDigest(await digestApi.get(requestedDate));
      if (list.length) setLastUpdated(list[0].generated_at);
      setSemanticResults(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let timer: number | undefined;
    let attempts = 0;
    const loadWhenBackendReady = () => {
      if (!backend.backendUrl) {
        if (attempts++ < 20) timer = window.setTimeout(loadWhenBackendReady, 250);
        return;
      }
      void load(new Date().toISOString().slice(0, 10));
    };
    loadWhenBackendReady();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!archiveNotice) return;
    const timer = window.setTimeout(() => setArchiveNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [archiveNotice]);
  const showToday = () => {
    setTimeMode("today");
    setSelectedDate("");
    setRangeStart("");
    setRangeEnd("");
    setSemanticResults(null);
    load(new Date().toISOString().slice(0, 10));
  };
  const selectArchiveDate = (date: string) => {
    setTimeMode("date");
    setSelectedDate(date);
    setRangeStart("");
    setRangeEnd("");
    setSemanticResults(null);
    if (date) load(date);
  };
  const enableRangeFilter = () => {
    setTimeMode("range");
    setSelectedDate("");
    setSemanticResults(null);
  };
  const loadRange = async (start: string, end: string) => {
    if (!start || !end || start > end) return;
    setLoading(true);
    setMessage("");
    try {
      const dates = digests
        .map((digest) => digest.digest_date)
        .filter((date) => date >= start && date <= end);
      const results = await Promise.all(dates.map((date) => digestApi.get(date)));
      const items = results.flatMap((digest) =>
        digest.items.map((item) => ({ ...item, reason: `${digest.digest_date} · ${item.reason}` })),
      );
      setDigest({
        id: `range-${start}-${end}`,
        digest_date: end,
        title: `范围筛选：${start} - ${end}`,
        summary: `展示 ${dates.length} 天日报中的 ${items.length} 个项目。`,
        generated_at: results[0]?.generated_at ?? `${end}T00:00:00.000Z`,
        status: "range",
        items,
      });
      setSemanticResults(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "日报范围加载失败");
    } finally {
      setLoading(false);
    }
  };
  const selectRangeStart = (date: string) => {
    setRangeStart(date);
    setSemanticResults(null);
    if (date && rangeEnd && date <= rangeEnd) void loadRange(date, rangeEnd);
  };
  const selectRangeEnd = (date: string) => {
    setRangeEnd(date);
    setSemanticResults(null);
    if (rangeStart && date && rangeStart <= date) void loadRange(rangeStart, date);
  };
  const showAllDigests = () => {
    const latest = digests[0]?.digest_date;
    const earliest = digests.at(-1)?.digest_date;
    if (!earliest || !latest) return;
    setTimeMode("range");
    setSelectedDate("");
    setRangeStart(earliest);
    setRangeEnd(latest);
    void loadRange(earliest, latest);
  };
  const collectAndGenerate = async () => {
    setLoading(true);
    setMessage("");
    setUpdateProgress(8);
    setUpdatePhase("正在采集热点候选");
    let progressTimer: number | undefined;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const currentDigests = await digestApi.list();
      const existing = currentDigests.find((item) => item.digest_date === today);
      if (existing) {
        await load(today);
        setArchiveNotice("今日日报已归档，已直接读取，不重复采集或调用 AI。");
        return;
      }
      const collected = await digestApi.collectHotProjects();
      setUpdateProgress(45);
      setUpdatePhase("正在评分、AI 分类与生成摘要");
      progressTimer = window.setInterval(() => {
        setUpdateProgress((current) => current === null ? current : Math.min(90, current + 3));
      }, 1800);
      const generated = await digestApi.generate();
      window.clearInterval(progressTimer);
      progressTimer = undefined;
      setUpdateProgress(95);
      setUpdatePhase("正在保存日报并刷新页面");
      await load(generated.digestDate);
      setUpdateProgress(100);
      setUpdatePhase("更新完成");
      setMessage(
        `已从 ${collected.channels.length} 个分类采集 ${collected.itemsSaved} 个热点候选项目并生成日报。`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "热点采集或日报生成失败");
    } finally {
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      setLoading(false);
      window.setTimeout(() => setUpdateProgress(null), 1200);
    }
  };
  const rebuildAllDigests = async () => {
    if (!window.confirm("将使用当前规则重建所有已归档日报，并重新调用必要的 AI。确认继续？")) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await digestApi.rebuildAll();
      await load(new Date().toISOString().slice(0, 10));
      setMessage(result.failed.length ? `已重建 ${result.rebuilt} 份日报；${result.failed.length} 份失败：${result.failed.map((item) => item.date).join("、")}。` : `已按当前规则重建 ${result.rebuilt} 份归档日报。`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "重建日报失败");
    } finally {
      setLoading(false);
    }
  };
  const star = async (item: DailyDigestItem) => {
    if (!githubToken) return setMessage("请先登录 GitHub 后再加星。");
    setStarringId(item.repo_id);
    try {
      const repository = toRepository(item);
      const [owner, name] = repository.full_name.split("/");
      await createGitHubApiService(githubToken).starRepository(owner, name);
      addRepository({ ...repository, starred_at: new Date().toISOString() });
      setMessage(`${item.full_name} 已加入 GitHub 星标仓库。`);
    } catch {
      setMessage("加星失败，请检查 GitHub Token 权限与网络。");
    } finally {
      setStarringId(null);
    }
  };
  const filteredItems =
    digest?.items.filter(
      (item) =>
        selectedCategory === "全部" || item.primary_category === selectedCategory,
    ) ?? [];
  const visibleItems = semanticResults ?? filteredItems;
  const isStarred = (repoId: number) =>
    repositories.some((repository) => repository.id === repoId && Boolean(repository.starred_at));
  const search = async () => {
    if (!query.trim()) {
      setSemanticResults(null);
      setMessage("已恢复日报默认排序。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const config = aiConfigs.find((item) => item.id === activeAIConfig);
      const repositories = filteredItems.map(toRepository);
      const results = config
        ? await new AIService(config, language).searchRepositoriesWithReranking(
            repositories,
            query,
          )
        : repositories.filter((item) =>
            `${item.full_name} ${item.description ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          );
      const order = new Map(results.map((item, index) => [item.id, index]));
      setSemanticResults(
        filteredItems
          .filter((item) => order.has(item.repo_id))
          .sort((a, b) => order.get(a.repo_id)! - order.get(b.repo_id)!),
      );
      setMessage(
        config ? "已使用 AI 语义理解排序当前日报结果。" : "未配置 AI，已使用文本匹配。",
      );
    } finally {
      setLoading(false);
    }
  };
  const grouped =
    selectedCategory === "全部"
      ? [{ category: "", items: visibleItems }]
      : [{ category: selectedCategory, items: visibleItems }];
  if (hotView === "trending") {
    return (
      <section className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold">热点</h2>
          <p className="text-sm text-gray-500">
            今日精选提供可回溯的系统日报；实时趋势展示 GitHub 当前升温的项目。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setHotView("digest")}
            className="rounded-lg border px-4 py-2 text-sm font-medium"
          >
            今日精选
          </button>
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
            实时趋势
          </button>
        </div>
        <DiscoveryView trendingOnly />
      </section>
    );
  }
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">热点</h2>
          <p className="text-sm text-gray-500">
            新近项目按 README 和工程结构驱动的 AI 分类组织，不使用个人星标仓库。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={collectAndGenerate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            <Radar className="h-4 w-4" />
            采集今日日报
          </button>
          <button
            onClick={rebuildAllDigests}
            disabled={loading || !digests.length}
            className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 disabled:opacity-50 dark:border-blue-500/60 dark:text-blue-200"
          >
            测试：重新采集全部日报
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-gray-500">
          上次更新：{lastUpdated ? new Date(lastUpdated).toLocaleString("zh-CN") : "尚未生成"}
        </p>
        {updateProgress !== null && (
          <div aria-live="polite">
            <div className="mb-1 flex justify-between text-xs text-blue-700 dark:text-blue-300">
              <span>{updatePhase}</span><span>{updateProgress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950/40">
              <div className="h-full rounded-full bg-blue-600 transition-[width] duration-500" style={{ width: `${updateProgress}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
          今日精选
        </button>
        <button
          onClick={() => setHotView("trending")}
          className="rounded-lg border px-4 py-2 text-sm font-medium"
        >
          实时趋势
        </button>
      </div>
      <details className="rounded-lg border border-black/10 bg-white px-4 py-3 text-sm text-gray-600 dark:bg-white/5 dark:text-gray-300">
        <summary className="cursor-pointer font-medium text-gray-900 dark:text-white">
          日报如何筛选热点？
        </summary>
        <div className="mt-3 space-y-4 leading-6">
          <div>
            <p className="font-medium text-gray-900 dark:text-white">1. 候选范围</p>
            <p>
              仅从系统通过 GitHub Search 采集到的项目中选择，不包含你的个人 Star 仓库。项目需在近 120 天内创建，并且采集快照位于所选日报日期的 UTC 当天。
            </p>
            <p>
              采集覆盖 AI、开发者工具、数据工程、DevOps、安全、效率、设计、桌面应用、教育和新项目等频道；多数频道要求至少 20 Stars，“新项目与值得关注”频道要求至少 50 Stars。
            </p>
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">2. 热度评分</p>
            <p>
              同一项目至少有 2 次快照后才计算 final score；快照不足时分数为 0，并使用频道排名和最近更新时间作为排序依据。
            </p>
            <p>
              有足够快照时，分数由以下信号相加：24 小时 Star 增长的对数得分（系数 30）、7 日平均 Star 增长的对数得分（系数 20）、频道排名提升（每提升 1 位加 10 分）、14 天内更新（加 10 分）、30 天内发布新版本（加 10 分）。Star 总量本身不直接加分。
            </p>
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">3. 排序与入选</p>
            <p>
              候选先按 final score 从高到低排序；同分时频道排名靠前者优先，再按最近更新时间排序。系统会先读取最多 48 个候选，再生成默认最多 30 项的日报。
            </p>
            <p>
              为避免单一领域占满日报，系统会优先从每个主分类选取排序最高的 1 项，再按整体排序补齐剩余名额。分类只影响覆盖性，不直接增加热度分数。
            </p>
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">4. 分类与说明</p>
            <p>
              入选项目会读取 Description、Topics、README 与仓库根目录结构，由 AI 使用日报和 Top100 共用的分类规则生成分类、标签和中文摘要；AI 不可用或输出不合规时才使用规则兜底。
            </p>
          </div>
        </div>
      </details>
      {message && (
        <p className="rounded-lg bg-blue-50 p-3 text-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
          {message}
        </p>
      )}
      {archiveNotice && (
        <div className="fixed right-4 top-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-blue-200 bg-white p-4 text-sm text-blue-900 shadow-lg dark:border-blue-500/40 dark:bg-slate-900 dark:text-blue-100" role="status">
          <p className="flex-1">{archiveNotice}</p>
          <button onClick={() => setArchiveNotice("")} aria-label="关闭提示" className="rounded p-1 hover:bg-blue-100 dark:hover:bg-blue-950/50"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") search();
          }}
          placeholder="用自然语言搜索当前日报"
          className="min-w-64 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm"
        />
        <button
          onClick={search}
          disabled={loading || !digest}
          className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
        >
          <Search className="h-4 w-4" />
          AI 语义搜索
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={showToday}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${timeMode === "today" ? "border-blue-400 bg-blue-500/15 text-blue-700 dark:text-blue-200" : "border-black/10 text-gray-600 hover:border-blue-300 hover:text-blue-700 dark:border-white/10 dark:text-gray-300 dark:hover:border-blue-400/60 dark:hover:text-blue-200"}`}
        >
          今日日报
        </button>
        <button
          onClick={enableRangeFilter}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${timeMode === "range" ? "border-blue-400 bg-blue-500/15 text-blue-700 dark:text-blue-200" : "border-black/10 text-gray-600 hover:border-blue-300 hover:text-blue-700 dark:border-white/10 dark:text-gray-300 dark:hover:border-blue-400/60 dark:hover:text-blue-200"}`}
        >
          范围筛选
        </button>
        <button
          onClick={showAllDigests}
          disabled={!digests.length || loading}
          className="rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:border-blue-400/60 dark:hover:text-blue-200"
        >
          显示全部日报
        </button>
      </div>
      {timeMode !== "range" && (
      <label
        htmlFor="digest-date"
        className="group flex cursor-pointer items-center justify-between gap-4 overflow-hidden rounded-xl border border-blue-200/80 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-4 py-3 shadow-sm transition-all hover:border-blue-400 hover:shadow-blue-500/10 dark:border-blue-400/20 dark:from-blue-950/40 dark:via-slate-950/70 dark:to-cyan-950/30 dark:hover:border-blue-400/50 dark:hover:shadow-blue-500/10"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-lg shadow-blue-600/25 transition-transform group-hover:scale-105">
            <CalendarDays className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900 dark:text-white">浏览指定日期</span>
            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">已生成日报 {digests.length} 天；其他日期显示当日采集项目</span>
          </span>
        </span>
        <input
          id="digest-date"
          type="date"
          value={selectedDate}
          min={digests.at(-1)?.digest_date}
          max={digests[0]?.digest_date}
          onChange={(event) => selectArchiveDate(event.target.value)}
          className="[color-scheme:light] w-[10.5rem] cursor-pointer rounded-lg border border-blue-200 bg-white/80 px-3 py-2 text-sm font-medium text-blue-950 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:[color-scheme:dark] dark:border-white/10 dark:bg-white/[0.07] dark:text-blue-100"
        />
      </label>
      )}
      {timeMode === "range" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200/80 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-4 py-3 text-sm dark:border-blue-400/20 dark:from-blue-950/40 dark:via-slate-950/70 dark:to-cyan-950/30">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-lg shadow-blue-600/25">
            <CalendarDays className="h-4 w-4 text-white" />
          </span>
          <label className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
            起始日报
            <input
              type="date"
              value={rangeStart}
              min={digests.at(-1)?.digest_date}
              max={rangeEnd || digests[0]?.digest_date}
              onChange={(event) => selectRangeStart(event.target.value)}
              className="[color-scheme:light] cursor-pointer rounded-lg border border-blue-200 bg-white/80 px-3 py-2 text-sm font-medium text-blue-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:[color-scheme:dark] dark:border-white/10 dark:bg-white/[0.07] dark:text-blue-100"
            />
          </label>
          <span className="text-blue-400">-</span>
          <label className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
            结束日报
            <input
              type="date"
              value={rangeEnd}
              min={rangeStart || digests.at(-1)?.digest_date}
              max={digests[0]?.digest_date}
              onChange={(event) => selectRangeEnd(event.target.value)}
              className="[color-scheme:light] cursor-pointer rounded-lg border border-blue-200 bg-white/80 px-3 py-2 text-sm font-medium text-blue-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:[color-scheme:dark] dark:border-white/10 dark:bg-white/[0.07] dark:text-blue-100"
            />
          </label>
          {(rangeStart || rangeEnd) && (
            <button
              onClick={() => {
                setRangeStart("");
                setRangeEnd("");
                setSemanticResults(null);
              }}
              className="ml-auto text-blue-600 hover:text-blue-500 dark:text-blue-300"
            >
              清除筛选
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            onClick={() => {
              setSelectedCategory(category);
              setSemanticResults(null);
            }}
            className={`rounded-full border px-3 py-1 text-sm ${selectedCategory === category ? "border-blue-600 bg-blue-600 text-white" : ""}`}
          >
            {category}
          </button>
        ))}
      </div>
      {digest && (
        <div className="space-y-8">
          <div>
            <h3 className="text-xl font-medium">{digest.title}</h3>
            <p className="text-gray-500">{digest.summary}</p>
            <p className="mt-1 text-xs text-gray-500">
              抓取并归档时间：
              {new Date(digest.generated_at).toLocaleString("zh-CN")}
            </p>
          </div>
          {grouped.map(({ category, items }) => (
            <section key={category} className="space-y-3">
              {category && (
                <h4 className="border-l-4 border-blue-600 pl-3 text-lg font-semibold">
                  {category}
                </h4>
              )}
              {items.map((item) => (
                <article
                  key={`${category}-${item.repo_id}-${item.reason}`}
                  onClick={() => setReadmeRepository(toRepository(item))}
                  className={`cursor-pointer rounded-xl border bg-white p-5 shadow-sm transition-colors hover:border-blue-400 dark:bg-white/5 ${item.reason.startsWith("今日值得关注") ? "border-blue-500 ring-1 ring-blue-300 dark:ring-blue-700" : "border-black/10"}`}
                >
                  {item.reason.startsWith("今日值得关注") && (
                    <div className="mb-3 inline-flex rounded-full bg-blue-600 px-2.5 py-1 text-xs font-medium text-white">
                      今日值得关注
                    </div>
                  )}
                  <div className="mb-3 min-h-12 rounded-lg bg-blue-50 p-3 text-sm leading-6 text-blue-950 dark:bg-blue-950/30 dark:text-blue-100">
                    <Sparkles className="mr-2 inline h-4 w-4" />
                    {item.hot_summary_zh ?? "中文总结正在生成，请稍后刷新。"}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-semibold">{item.full_name}</span>
                      <p className="mt-1 text-xs text-gray-500">
                        {item.language || "未知语言"} ·{" "}
                        <Star className="inline h-3 w-3" />{" "}
                        {item.stargazers_count.toLocaleString()} ·{" "}
                        <GitFork className="inline h-3 w-3" />{" "}
                        {(item.forks_count ?? 0).toLocaleString()}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        创建：
                        {new Date(item.created_at).toLocaleDateString(
                          "zh-CN",
                        )}{" "}
                        · 最近更新：
                        {new Date(item.updated_at).toLocaleDateString("zh-CN")}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <a
                        onClick={(event) => event.stopPropagation()}
                        href={`https://zread.ai/${item.full_name}`}
                        target="_blank"
                        rel="noreferrer"
                        title="在 Z-Read 中打开"
                        className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-white/10"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <a
                        onClick={(event) => event.stopPropagation()}
                        href={item.html_url}
                        target="_blank"
                        rel="noreferrer"
                        title="在 GitHub 中打开"
                        className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-white/10"
                      >
                        <Github className="h-4 w-4" />
                      </a>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          star(item);
                        }}
                        disabled={starringId === item.repo_id || isStarred(item.repo_id)}
                        title={isStarred(item.repo_id) ? "已添加 GitHub Star" : "添加 GitHub Star"}
                        className="rounded-md p-2 hover:bg-yellow-100 disabled:opacity-50 dark:hover:bg-yellow-500/20"
                      >
                        <Star className={`h-4 w-4 ${isStarred(item.repo_id) ? "fill-yellow-400 text-yellow-500" : ""}`} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      item.primary_category,
                      ...jsonList(item.function_tags).slice(0, 5),
                      ...jsonList(item.product_forms).slice(0, 2),
                      ...jsonList(item.platform_tags).slice(0, 2),
                    ]
                      .filter(Boolean)
                      .map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 dark:bg-white/10 dark:text-gray-200"
                        >
                          #{tag}
                        </span>
                      ))}
                    {item.is_top100 === 1 && (
                      <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                        Top100
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                    {item.description}
                  </p>
                  <p className="mt-3 text-xs text-gray-500">
                    分类依据：{item.classification_reason ?? item.reason}
                  </p>
                  <button
                    onClick={async (event) => {
                      event.stopPropagation();
                      await digestApi.regenerateSummary(item.repo_id);
                      await load(digest.digest_date);
                    }}
                    className="mt-3 text-sm text-blue-600"
                  >
                    重新生成中文总结
                  </button>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
      <ReadmeModal
        isOpen={!!readmeRepository}
        onClose={() => setReadmeRepository(null)}
        repository={readmeRepository}
      />
    </section>
  );
}
