// 五字段 cron（分 时 日 月 周）的解析与匹配。纯函数、无 IO、无 server-only 导入。
// 放在 lib/ 而不是 lib/server/ 是刻意的：调度器（服务端）、触发器校验（API）、
// 任务页的「下次何时跑」回显（client）、单测脚本四处都要用同一份实现。
//
// **刻意不写「推算下一次触发时间」的算法**，只写「这一分钟匹不匹配」的匹配器。
// 调度器每分钟 tick 一次，逐个 due trigger 问「你匹配当前这分钟吗」；catch-up 也用
// 同一个匹配器逐分钟回扫。这样彻底绕开推算算法里最容易写错的边界（月末、跨年、
// dom/dow 的 OR 语义）。1440 次 Set 查表 = 微秒级，代价可忽略。
//
// 支持 `*` `*/n` `a,b,c` `a-b` 及其组合。**不做**秒级 / `L` / `W` / `#` / `?` /
// 月份与星期的英文缩写 —— 需求面窄，多一分语法多一分错。
//
// 时区：一律服务器本地（Date 的 getHours 等）。两台机器都在 Asia/Shanghai、无 DST。

export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  // dom 与 dow **都**受限时是 OR 语义（标准 cron 的历史怪癖：`0 0 1 * 1` =
  // 「每月 1 号 **或** 每周一」，不是「1 号且是周一」）。要判断得知道哪个受限。
  domRestricted: boolean;
  dowRestricted: boolean;
};

type Range = { min: number; max: number };
const RANGES: Record<keyof Omit<CronFields, "domRestricted" | "dowRestricted">, Range> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

function parseField(raw: string, r: Range): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const seg = part.trim();
    if (!seg) return null;
    const [body, stepRaw] = seg.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = r.min;
      hi = r.max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(body);
      hi = Number(body);
      // 裸数字带步长（`5/10`）非标准，按 `5-max/10` 解 —— 与 cron 实现的惯例一致。
      if (stepRaw !== undefined) hi = r.max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < r.min || hi > r.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], RANGES.minute);
  const hour = parseField(parts[1], RANGES.hour);
  const dom = parseField(parts[2], RANGES.dom);
  const month = parseField(parts[3], RANGES.month);
  // 7 = 周日的另一种写法，归一到 0。
  const dowRaw = parseField(parts[4].replace(/7/g, "0"), RANGES.dow);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow: dowRaw,
    domRestricted: parts[2].trim() !== "*",
    dowRestricted: parts[4].trim() !== "*",
  };
}

export function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  // 标准 cron 的 OR 怪癖，见 CronFields 注释。
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/** 下一次触发（毫秒时间戳）。逐分钟前扫，封顶 366 天 —— **只给 UI 回显用**，
 * 调度器走 cronMatches，不依赖这个。 */
export function nextFireAfter(f: CronFields, from: Date): number | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(f, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 人话回显。裸 cron 串的问题不是难写，是**写错了不知道** —— 这个函数存在的
 * 唯一理由就是让人一眼看出自己写的是不是想要的。认不出的形状老实回原串。 */
export function describeCron(expr: string): string {
  const f = parseCron(expr);
  if (!f) return "表达式无效";
  const parts = expr.trim().split(/\s+/);
  const [m, h, dom, mon, dow] = parts;

  const hhmm = () => `${pad(Number(h))}:${pad(Number(m))}`;
  const isNum = (s: string) => /^\d+$/.test(s);

  if (isNum(m) && isNum(h) && dom === "*" && mon === "*" && dow === "*") {
    return `每天 ${hhmm()}`;
  }
  if (isNum(m) && isNum(h) && dom === "*" && mon === "*" && dow === "1-5") {
    return `每个工作日 ${hhmm()}`;
  }
  if (isNum(m) && isNum(h) && dom === "*" && mon === "*" && isNum(dow)) {
    return `每${WEEK[Number(dow) % 7]} ${hhmm()}`;
  }
  if (isNum(m) && isNum(h) && isNum(dom) && mon === "*" && dow === "*") {
    return `每月 ${dom} 号 ${hhmm()}`;
  }
  if (isNum(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每小时的第 ${m} 分钟`;
  }
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `每 ${m.slice(2)} 分钟`;
  }
  return expr;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
