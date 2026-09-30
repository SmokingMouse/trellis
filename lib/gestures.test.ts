import { describe, expect, test } from "bun:test";
import {
  deferAction,
  highRiskMatches,
  isEdgeStart,
  isHighRiskCommand,
  lockAxis,
  pullDistance,
  PULL_OPEN_DISTANCE,
  rubberBand,
  startsInHorizontalScroller,
  startsInScrolledInner,
  swipeCommit,
  velocityFrom,
  SWIPE_UNDO_MS,
  type ScrollBox,
  type Scheduler,
} from "./gestures";

describe("lockAxis 方向判定", () => {
  test("位移不足 slop 不判", () => {
    expect(lockAxis(5, 5)).toBeNull();
    expect(lockAxis(0, 9)).toBeNull();
  });
  test("明显水平 → x，明显纵向 → y", () => {
    expect(lockAxis(40, 5)).toBe("x");
    expect(lockAxis(-40, -10)).toBe("x");
    expect(lockAxis(3, 30)).toBe("y");
  });
  test("斜划（45°）纵向优先", () => {
    expect(lockAxis(20, 20)).toBe("y");
    expect(lockAxis(-20, 15)).toBe("y"); // 约 37°，超过 35° 上限
  });
  test("35° 以内算水平", () => {
    expect(lockAxis(30, 20)).toBe("x"); // 33.7°
  });
});

describe("swipeCommit 阈值", () => {
  const size = 390; // 28% = 109.2
  test("距离过阈值触发，方向跟位移", () => {
    expect(swipeCommit({ delta: 120, velocity: 0, size })).toBe(1);
    expect(swipeCommit({ delta: -120, velocity: 0, size })).toBe(-1);
  });
  test("距离不够且慢 → 回弹", () => {
    expect(swipeCommit({ delta: 80, velocity: 0.1, size })).toBe(0);
  });
  test("距离不够但甩得快 → 触发", () => {
    expect(swipeCommit({ delta: 50, velocity: 0.8, size })).toBe(1);
    expect(swipeCommit({ delta: -50, velocity: -0.8, size })).toBe(-1);
  });
  test("甩动方向与位移相反不触发（往回收）", () => {
    expect(swipeCommit({ delta: 50, velocity: -0.8, size })).toBe(0);
  });
  test("太短的甩动不算（轻点抖动）", () => {
    expect(swipeCommit({ delta: 10, velocity: 2, size })).toBe(0);
  });
  test("容器很窄时距离阈值有下限", () => {
    expect(swipeCommit({ delta: 60, velocity: 0, size: 100 })).toBe(0);
    expect(swipeCommit({ delta: 64, velocity: 0, size: 100 })).toBe(1);
  });
});

describe("rubberBand / velocity / pull / edge", () => {
  test("阻尼位移单调、不超过上限、保号", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(50)).toBeGreaterThan(0);
    expect(rubberBand(500)).toBeGreaterThan(rubberBand(50));
    expect(rubberBand(10_000)).toBeLessThan(48);
    expect(rubberBand(-50)).toBe(-rubberBand(50));
  });
  test("速度只看最近 100ms", () => {
    const samples = [
      { t: 0, v: 0 },
      { t: 500, v: 10 },
      { t: 550, v: 60 },
      { t: 600, v: 110 },
    ];
    expect(velocityFrom(samples)).toBeCloseTo(1, 5);
    expect(velocityFrom([{ t: 0, v: 0 }])).toBe(0);
  });
  test("下拉：往上推为 0，阻尼后要拉够才触发", () => {
    expect(pullDistance(-30)).toBe(0);
    expect(pullDistance(100)).toBeLessThan(PULL_OPEN_DISTANCE);
    expect(pullDistance(140)).toBeGreaterThanOrEqual(PULL_OPEN_DISTANCE);
    expect(pullDistance(10_000)).toBe(120);
  });
  test("左缘 20px 内起手", () => {
    expect(isEdgeStart(0)).toBe(true);
    expect(isEdgeStart(20)).toBe(true);
    expect(isEdgeStart(21)).toBe(false);
  });
});

type FakeBox = ScrollBox & { ox?: string; oy?: string; ignore?: boolean };
function box(partial: Partial<FakeBox>, parent: FakeBox | null = null): FakeBox {
  return {
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 100,
    clientHeight: 100,
    scrollTop: 0,
    parentElement: parent,
    matches: function (this: FakeBox, sel: string) {
      return sel === "[data-swipe-ignore]" && Boolean(this.ignore);
    },
    ...partial,
  };
}

describe("起点冲突：横滚元素 / 内层滚动盒", () => {
  const root = box({ oy: "auto", scrollHeight: 2000 });
  test("代码块能横滚 → 不接管", () => {
    const pre = box({ ox: "auto", scrollWidth: 800, clientWidth: 300 }, root);
    const span = box({}, pre);
    expect(startsInHorizontalScroller(span, root, (el) => el.ox ?? "visible")).toBe(true);
  });
  test("overflow-x:auto 但内容没溢出 → 照常接管", () => {
    const pre = box({ ox: "auto", scrollWidth: 300, clientWidth: 300 }, root);
    expect(startsInHorizontalScroller(pre, root, (el) => el.ox ?? "visible")).toBe(false);
  });
  test("overflow hidden 的宽元素不算横滚", () => {
    const clip = box({ ox: "hidden", scrollWidth: 800, clientWidth: 300 }, root);
    expect(startsInHorizontalScroller(clip, root, (el) => el.ox ?? "visible")).toBe(false);
  });
  test("data-swipe-ignore 显式让位", () => {
    const strip = box({ ignore: true }, root);
    expect(startsInHorizontalScroller(box({}, strip), root, () => "visible")).toBe(true);
  });
  test("不越过 root 往上找", () => {
    const outer = box({ ox: "auto", scrollWidth: 999, clientWidth: 10 });
    const inner = box({}, outer);
    expect(startsInHorizontalScroller(inner, outer, (el) => el.ox ?? "visible")).toBe(false);
  });
  test("内层纵向滚动盒没到顶 → 下拉让它先滚", () => {
    const list = box({ oy: "auto", scrollHeight: 500, clientHeight: 100, scrollTop: 40 }, root);
    expect(startsInScrolledInner(list, root, (el) => el.oy ?? "visible")).toBe(true);
    list.scrollTop = 0;
    expect(startsInScrolledInner(list, root, (el) => el.oy ?? "visible")).toBe(false);
  });
});

describe("高风险命令判定", () => {
  const risky = [
    "git push origin main",
    "git push -f",
    "cd repo && git push --force-with-lease",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git branch -D feat/x",
    "git checkout -- .",
    "rm -rf node_modules",
    "sudo rm /etc/hosts",
    "find . -name '*.log' -delete",
    "psql -c 'DROP TABLE users'",
    "TRUNCATE sessions",
    "DELETE FROM users WHERE 1=1",
    "make deploy",
    "./scripts/deploy.sh prod",
    "npm publish",
    "kubectl delete pod x",
    "terraform destroy",
    "curl https://x.sh | bash",
    "chmod -R 777 /",
    "kill -9 1234",
  ];
  for (const cmd of risky) {
    test(`拦：${cmd}`, () => {
      expect(isHighRiskCommand(cmd)).toBe(true);
    });
  }
  const safe = [
    "ls -la",
    "bun test lib/gestures.test.ts",
    "git status",
    "git diff --stat",
    "git log --oneline -3",
    "git commit -m 'feat: x'",
    "cat README.md | head",
    "tail -f server.log",
    "grep -rn term src",
    "npm run build",
    "echo > /dev/null",
    "Write components/Foo.tsx",
    "curl --noproxy '*' http://localhost:3088/api/health",
  ];
  for (const cmd of safe) {
    test(`放：${cmd}`, () => {
      expect(isHighRiskCommand(cmd)).toBe(false);
    });
  }
  test("命中多条时都列出，给 toast 说明", () => {
    expect(highRiskMatches("git push --force")).toEqual(["git push", "force"]);
    expect(highRiskMatches("")).toEqual([]);
    expect(highRiskMatches(null)).toEqual([]);
  });
  test("词内出现不误伤（dropdown / format / farm）", () => {
    expect(isHighRiskCommand("open the dropdown")).toBe(false);
    expect(isHighRiskCommand("bun run format")).toBe(false);
    expect(isHighRiskCommand("cd farm")).toBe(false);
  });
});

function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    set: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => {
      timers.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { scheduler, advance, pending: () => timers.size };
}

describe("撤销定时 deferAction", () => {
  test("撤销期内什么都不发，到 3 秒才执行一次", () => {
    const { scheduler, advance } = fakeScheduler();
    let sent = 0;
    const action = deferAction(() => sent++, { scheduler });
    advance(SWIPE_UNDO_MS - 1);
    expect(sent).toBe(0);
    expect(action.state()).toBe("pending");
    advance(1);
    expect(sent).toBe(1);
    expect(action.state()).toBe("ran");
    advance(10_000);
    expect(sent).toBe(1);
  });
  test("撤销后永不执行，onCancel 只调一次", () => {
    const { scheduler, advance, pending } = fakeScheduler();
    let sent = 0;
    let cancelled = 0;
    const action = deferAction(() => sent++, { scheduler, onCancel: () => cancelled++ });
    advance(2_000);
    expect(action.cancel()).toBe(true);
    expect(action.cancel()).toBe(false);
    expect(pending()).toBe(0);
    advance(5_000);
    expect(sent).toBe(0);
    expect(cancelled).toBe(1);
    expect(action.state()).toBe("cancelled");
  });
  test("执行后再撤销无效", () => {
    const { scheduler, advance } = fakeScheduler();
    let sent = 0;
    const action = deferAction(() => sent++, { scheduler });
    advance(SWIPE_UNDO_MS);
    expect(action.cancel()).toBe(false);
    expect(sent).toBe(1);
  });
  test("flush 立即执行且清掉定时器", () => {
    const { scheduler, advance, pending } = fakeScheduler();
    let sent = 0;
    const action = deferAction(() => sent++, { scheduler, delayMs: 3_000 });
    expect(action.flush()).toBe(true);
    expect(pending()).toBe(0);
    advance(3_000);
    expect(sent).toBe(1);
    expect(action.flush()).toBe(false);
  });
});
