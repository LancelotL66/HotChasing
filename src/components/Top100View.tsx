import { useEffect, useState } from "react";
import {
  ExternalLink,
  GitFork,
  Github,
  Search,
  Sparkles,
  Star,
  Trophy,
} from "lucide-react";
import { backend } from "../services/backendAdapter";
import { ReadmeModal } from "./ReadmeModal";
import { createGitHubApiService } from "../services/githubApiFactory";
import { useAppStore } from "../store/useAppStore";
import { AIService } from "../services/aiService";
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
const jsonList = (value: string | null) => {
  try {
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
};
interface TopItem {
  repo_id: number;
  rank: number;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  created_at: string;
  updated_at: string;
  hot_summary_zh: string | null;
  primary_category: string;
  function_tags: string | null;
  product_forms: string | null;
  platform_tags: string | null;
  classification_reason: string | null;
}
function toRepository(item: TopItem): Repository {
  return {
    id: item.repo_id,
    name: item.full_name.split("/")[1],
    full_name: item.full_name,
    html_url: item.html_url,
    description: item.description,
    stargazers_count: item.stargazers_count,
    forks_count: item.forks_count,
    forks: item.forks_count,
    language: item.language,
    created_at: item.created_at,
    updated_at: item.updated_at,
    pushed_at: item.updated_at,
    owner: { login: item.full_name.split("/")[0], avatar_url: "" },
    topics: [],
    hot_summary_zh: item.hot_summary_zh,
  };
}

export function Top100View() {
  const [items, setItems] = useState<TopItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updatePhase, setUpdatePhase] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [readmeRepository, setReadmeRepository] = useState<Repository | null>(
    null,
  );
  const [starringId, setStarringId] = useState<number | null>(null);
  const githubToken = useAppStore((state) => state.githubToken);
  const repositories = useAppStore((state) => state.repositories);
  const addRepository = useAppStore((state) => state.addRepository);
  const aiConfigs = useAppStore((state) => state.aiConfigs);
  const activeAIConfig = useAppStore((state) => state.activeAIConfig);
  const language = useAppStore((state) => state.language);
  const load = async () => {
    if (!backend.backendUrl) return;
    const response = await fetch(
      `${backend.backendUrl}/classic-ranking/top100`,
    );
    const data = (await response.json()) as { items: TopItem[]; generatedAt: string | null };
    setItems(data.items);
    setLastUpdated(data.generatedAt);
  };
  useEffect(() => {
    load().catch(() => setMessage("Top100 加载失败"));
  }, []);
  const generate = async () => {
    setLoading(true);
    setMessage("");
    setUpdateProgress(8);
    setUpdatePhase("正在采集双候选池");
    const timer = window.setInterval(() => {
      setUpdateProgress((current) => current === null ? current : Math.min(90, current + 3));
    }, 2500);
    try {
      window.setTimeout(() => setUpdatePhase("正在按热度评分、AI 分类与生成摘要"), 800);
      const response = await fetch(
        `${backend.backendUrl}/classic-ranking/generate-top100`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) throw new Error(`请求失败：${response.status}`);
      setUpdateProgress(95);
      setUpdatePhase("正在保存榜单并刷新页面");
      await load();
      setUpdateProgress(100);
      setUpdatePhase("更新完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败");
    } finally {
      window.clearInterval(timer);
      setLoading(false);
      window.setTimeout(() => setUpdateProgress(null), 1200);
    }
  };
  const search = async () => {
    if (!query.trim()) return load();
    setLoading(true);
    try {
      const config = aiConfigs.find((item) => item.id === activeAIConfig);
      const asRepos = items.map(toRepository);
      const result = config
        ? await new AIService(config, language).searchRepositoriesWithReranking(
            asRepos,
            query,
          )
        : asRepos.filter((item) =>
            `${item.full_name} ${item.description ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          );
      const order = new Map(result.map((item, index) => [item.id, index]));
      setItems((current) =>
        current
          .filter((item) => order.has(item.repo_id))
          .sort((a, b) => order.get(a.repo_id)! - order.get(b.repo_id)!),
      );
      setMessage(
        config ? "已使用 AI 语义理解排序结果。" : "未配置 AI，已使用文本匹配。",
      );
    } finally {
      setLoading(false);
    }
  };
  const star = async (item: TopItem) => {
    if (!githubToken) return setMessage("请先登录 GitHub 后再加星。");
    setStarringId(item.repo_id);
    try {
      const repository = toRepository(item);
      const [owner, name] = repository.full_name.split("/");
      await createGitHubApiService(githubToken).starRepository(owner, name);
      if (!repositories.some((repo) => repo.id === repository.id))
        addRepository({ ...repository, starred_at: new Date().toISOString() });
    } catch {
      setMessage("加星失败，请检查 GitHub Token 权限与网络。");
    } finally {
      setStarringId(null);
    }
  };
  const visible = items.filter(
    (item) =>
      selectedCategory === "全部" || item.primary_category === selectedCategory,
  );
  const grouped =
    selectedCategory === "全部"
      ? [{ category: "", items: visible }]
      : [{ category: selectedCategory, items: visible }];
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Top100 热门项目</h2>
          <p className="text-sm text-gray-500">
            综合长期采用度与当下热度，新项目和经典项目均可入选。
          </p>
        </div>
        <button
          onClick={generate}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-white disabled:opacity-50"
        >
          <Trophy className="h-4 w-4" />
          更新 Top100
        </button>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-gray-500">
          上次更新：{lastUpdated ? new Date(lastUpdated).toLocaleString("zh-CN") : "尚未生成"}
        </p>
        {updateProgress !== null && (
          <div aria-live="polite">
            <div className="mb-1 flex justify-between text-xs text-amber-700 dark:text-amber-300">
              <span>{updatePhase}</span><span>{updateProgress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950/40">
              <div className="h-full rounded-full bg-amber-600 transition-[width] duration-500" style={{ width: `${updateProgress}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") search();
          }}
          placeholder="用自然语言搜索 Top100"
          className="min-w-64 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm"
        />
        <button
          onClick={search}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm"
        >
          <Search className="h-4 w-4" />
          AI 语义搜索（不更新榜单）
        </button>
      </div>
      {message && (
        <p className="rounded-lg bg-blue-50 p-3 text-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            onClick={() => setSelectedCategory(category)}
            className={`rounded-full border px-3 py-1 text-sm ${selectedCategory === category ? "border-amber-600 bg-amber-600 text-white" : ""}`}
          >
            {category}
          </button>
        ))}
      </div>
      <div className="space-y-8">
        {grouped.map(({ category, items: groupItems }) => (
          <section key={category} className="space-y-3">
            {category && (
              <h3 className="border-l-4 border-amber-600 pl-3 text-lg font-semibold">
                {category}
              </h3>
            )}
            {groupItems.map((item) => (
              <article
                key={item.repo_id}
                onClick={() => setReadmeRepository(toRepository(item))}
                className="cursor-pointer rounded-xl border border-black/10 bg-white p-5 shadow-sm transition-colors hover:border-amber-400 dark:bg-white/5"
              >
                <div className="mb-3 min-h-12 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                  <Sparkles className="mr-2 inline h-4 w-4" />
                  {item.hot_summary_zh ?? "中文总结尚未生成。"}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="font-semibold">
                      #{item.rank} {item.full_name}
                    </span>
                    <p className="mt-1 text-xs text-gray-500">
                      {item.language || "未知语言"} ·{" "}
                      <Star className="inline h-3 w-3" />{" "}
                      {item.stargazers_count.toLocaleString()} ·{" "}
                      <GitFork className="inline h-3 w-3" />{" "}
                      {item.forks_count.toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      创建：
                      {new Date(item.created_at).toLocaleDateString("zh-CN")} ·
                      最近更新：
                      {new Date(item.updated_at).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <a
                      onClick={(event) => event.stopPropagation()}
                      href={`https://zread.ai/${item.full_name}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md p-2 hover:bg-gray-100"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <a
                      onClick={(event) => event.stopPropagation()}
                      href={item.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md p-2 hover:bg-gray-100"
                    >
                      <Github className="h-4 w-4" />
                    </a>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        star(item);
                      }}
                      disabled={starringId === item.repo_id}
                      className="rounded-md p-2 hover:bg-yellow-100 disabled:opacity-50"
                    >
                      <Star className="h-4 w-4" />
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
                  <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                    Top100
                  </span>
                </div>
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                  {item.description}
                </p>
                <p className="mt-3 text-xs text-gray-500">
                  分类依据：
                  {item.classification_reason ?? "基于公开仓库信息分类。"}
                </p>
              </article>
            ))}
          </section>
        ))}
      </div>
      {!visible.length && !loading && (
        <p className="text-gray-500">当前分类或搜索条件没有匹配项目。</p>
      )}
      <ReadmeModal
        isOpen={!!readmeRepository}
        onClose={() => setReadmeRepository(null)}
        repository={readmeRepository}
      />
    </section>
  );
}
