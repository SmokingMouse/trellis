// 相对时间的唯一真源。此前 ReferenceCard / RelatedHints 各手写一份同样的
// 「刚刚 / N 分钟前 / N 小时前 / N 天前」，S133 收拢到这里。
//
// 两种形态：
//   formatRelativeTime      —— 带「前」的完整写法，给卡片 / 提示行用。
//   formatRelativeTimeShort —— 侧栏窄行用的紧凑写法（去「前」、超 30 天落
//                              到「月/日」）：210px 的行里「12 小时前」和
//                              标签抢地方，而「12小时」已足够让人定位。
//
// `now` 可注入是为了测试与 SSR 一致性，不是给调用方玩时区的。

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

export function formatRelativeTimeShort(
  ts: number,
  now: number = Date.now(),
): string {
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
