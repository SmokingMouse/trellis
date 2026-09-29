"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  CalendarClock,
  CircleArrowUp,
  Cpu,
  ExternalLink,
  KeyRound,
  MessagesSquare,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { IconButton, Icon, Skeleton, StatusDot, type StatusTone } from "@/components/ui";
import type { ButlerOverview, ButlerSection } from "@/lib/butler";

// 管家会话右栏：「当前配置」只读镜像 + 管家的规矩。数据走 /api/butler/overview
// （与 `trellisctl overview` 同源），管家每轮答完自动刷新一次 —— 它刚改的东西
// 在右栏立刻看得到，不用去设置页核对。
const PANEL_W = "20rem";
const WIDE_QUERY = "(min-width: 1280px)";
const DAY = 86_400_000;

type Row = { key: string; icon: LucideIcon; label: string; href: string; tone?: StatusTone; value: string; title?: string };

function fail(label: string, s: { ok: false; error: string }, icon: LucideIcon, href: string): Row {
  return { key: label, icon, label, href, tone: "danger", value: "读取失败", title: s.error };
}

function rows(o: ButlerOverview): Row[] {
  const out: Row[] = [];
  const add = <T,>(label: string, icon: LucideIcon, href: string, s: ButlerSection<T>, ok: (v: T) => Omit<Row, "key" | "icon" | "label" | "href">) => {
    out.push(s.ok ? { key: label, icon, label, href, ...ok(s as T) } : fail(label, s, icon, href));
  };
  add("Agent", Bot, "/settings/agents", o.agents, (a) => ({
    value: `${a.total} 个${a.disabled ? ` · ${a.disabled} 停用` : ""}`,
  }));
  add("定时任务", CalendarClock, "/settings/tasks", o.tasks, (t) => ({
    tone: t.failing.length ? "danger" : t.running ? "live" : undefined,
    value: t.failing.length
      ? `${t.failing.length} 个上次失败`
      : `${t.total} 个 · ${t.scheduled} 个定时${t.running ? ` · ${t.running} 在跑` : ""}`,
    title: t.failing.map((f) => `${f.name}：${f.error ?? f.status}`).join("\n") || undefined,
  }));
  add("模型", Cpu, "/settings/models", o.models, (m) => ({
    tone: m.missingKey.length ? "warn" : undefined,
    value: m.missingKey.length ? `${m.missingKey.length} 个缺 key` : (m.defaultModel ?? "未设默认"),
    title: m.missingKey.length ? `缺 key：${m.missingKey.join("、")}` : undefined,
  }));
  add("CLI 登录", KeyRound, "/settings/models", o.auth, (a) => {
    const bad = a.clis.filter((c) => c.installed && (c.loggedIn === false || c.errors.length));
    // claude 是主力，挂了标红；codex 常年走第三方端点不登录，只提示不报警。
    const critical = bad.some((c) => c.name === "claude");
    const soon = a.clis.filter((c) => c.refreshExpiresAt && c.refreshExpiresAt - Date.now() < 3 * DAY);
    return {
      tone: critical ? "danger" : bad.length ? "warn" : soon.length || a.clis.some((c) => c.warnings.length) ? "warn" : undefined,
      value: bad.length
        ? `${bad.map((c) => c.name).join(" / ")} 未登录`
        : soon.length
          ? `${soon[0].name} 凭证 ${Math.max(0, Math.ceil((soon[0].refreshExpiresAt! - Date.now()) / DAY))} 天后过期`
          : "正常",
      title: a.clis.flatMap((c) => [...c.errors, ...c.warnings].map((w) => `${c.name}：${w}`)).join("\n") || undefined,
    };
  });
  add("飞书机器人", MessagesSquare, "/settings/bots", o.bots, (b) => ({
    tone: b.errored.length ? "danger" : undefined,
    value: b.total ? (b.errored.length ? `${b.errored.length} 个出错` : `${b.enabled} 个启用`) : "未配置",
    title: b.errored.map((e) => `${e.name}：${e.error}`).join("\n") || undefined,
  }));
  add("版本", CircleArrowUp, "/settings/update", o.version, (v) => ({
    tone: v.deployPhase === "failed" || v.deployPhase === "broken" ? "danger" : v.behind ? "unread" : undefined,
    value: v.behind ? `落后 ${v.behind} 个提交` : v.sha ? v.sha.slice(0, 7) : "开发模式",
  }));
  return out;
}

export function ButlerPanel({ refreshKey }: { refreshKey: string }) {
  const [wide, setWide] = useState(false);
  const [data, setData] = useState<ButlerOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 与 --trellis-sb / --trellis-term-h 同一套：面板占多宽由它自己发布，
  // LinearThreadView 的 right 消费。窄屏不出面板、不占位。
  useEffect(() => {
    const root = document.documentElement;
    if (wide) root.style.setProperty("--trellis-rp", PANEL_W);
    else root.style.removeProperty("--trellis-rp");
    return () => {
      root.style.removeProperty("--trellis-rp");
    };
  }, [wide]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/butler/overview", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ButlerOverview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!wide) return;
    let alive = true;
    void fetch("/api/butler/overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as ButlerOverview;
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [wide, refreshKey]);

  const refresh = () => {
    setLoading(true);
    void load();
  };

  if (!wide) return null;

  return (
    <aside
      data-butler-panel
      aria-label="管家：当前配置"
      className="fixed right-0 z-20 overflow-y-auto border-l border-line bg-surface-canvas px-4 pt-4 pb-10"
      style={{
        width: PANEL_W,
        top: "calc(5.25rem + var(--trellis-pending-h, 0px))",
        bottom: "var(--trellis-term-h, 0px)",
      }}
    >
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <h2 className="text-label font-medium text-ink-faint">当前配置</h2>
        <IconButton label="刷新" size="sm" className="ml-auto" onClick={refresh}>
          <Icon icon={RefreshCw} size="sm" className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
        </IconButton>
      </div>
      <div className="rounded-card border border-line bg-surface">
        {!data && !error &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex h-[38px] items-center px-3 [&+&]:border-t [&+&]:border-line-faint">
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        {error && !data && <div className="px-3 py-3 text-label text-danger-ink">读取失败：{error}</div>}
        {data &&
          rows(data).map((r) => (
            <a
              key={r.key}
              href={r.href}
              title={r.title}
              className="group flex h-[38px] items-center gap-2.5 px-3 text-ui text-ink hover:bg-surface-hover [&+&]:border-t [&+&]:border-line-faint"
            >
              <Icon icon={r.icon} size="sm" className="text-ink-faint" />
              {r.label}
              <span className="ml-auto flex min-w-0 items-center gap-1.5 text-label text-ink-muted">
                {r.tone && <StatusDot tone={r.tone} />}
                <span className="truncate">{r.value}</span>
                <Icon icon={ExternalLink} size="sm" className="shrink-0 text-ink-faint opacity-0 group-hover:opacity-100" />
              </span>
            </a>
          ))}
      </div>

      <h2 className="mt-6 mb-2 px-0.5 text-label font-medium text-ink-faint">管家的规矩</h2>
      <div className="space-y-1 rounded-card border border-line bg-surface px-3 py-2.5 text-label leading-relaxed text-ink-muted">
        <Rule tag="读">随便查，不打扰你</Rule>
        <Rule tag="改">先用人话讲清要改什么，你说确认才写</Rule>
        <Rule tag="建任务">先手动跑一次看结果，满意了再挂定时</Rule>
        <Rule tag="不碰" tone="danger">密钥、升级回滚、删机器人、Trellis 自身代码</Rule>
      </div>
      {data && (
        <div className="mt-3 px-0.5 text-nano text-ink-faint">
          {new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新
        </div>
      )}
    </aside>
  );
}

function Rule({ tag, tone, children }: { tag: string; tone?: "danger"; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={tone === "danger" ? "w-12 shrink-0 text-danger-ink" : "w-12 shrink-0 text-ink-faint"}>{tag}</span>
      <span>{children}</span>
    </div>
  );
}
