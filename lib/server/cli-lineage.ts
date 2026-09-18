import fs from "node:fs";
import path from "node:path";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";
import { canonicalPath } from "./canonical-path";
import { CliTranscriptNoTurnsError } from "./cli-attach";
import { makeSlicer } from "./cooperative";

export type CliLineageMember = {
  sid: string;
  path: string;
  isRoot: boolean;
  forkPointUuid: string | null;
};

export type DiscoveredLineage = {
  rootSid: string;
  members: CliLineageMember[];
};

type ParsedFile = {
  full: string;
  parsed: ParsedCliSession;
  turnIds: Set<string>;
};

function fileOrder(full: string): number {
  try {
    const stat = fs.statSync(full);
    return stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || 0;
  } catch {
    return 0;
  }
}

function forkPointFor(
  member: ParsedCliSession,
  otherTurnIds: Set<string>,
): string | null {
  const turns = [...member.turns].sort((a, b) => a.createdAt - b.createdAt);
  const firstUnique = turns.find((turn) => !otherTurnIds.has(turn.id));
  if (firstUnique) return firstUnique.parentId;
  const lastShared = [...turns].reverse().find((turn) => otherTurnIds.has(turn.id));
  return lastShared?.id ?? null;
}

function toParsedFile(full: string, parsed: ParsedCliSession): ParsedFile {
  return {
    full,
    parsed,
    turnIds: new Set(parsed.turns.map((turn) => turn.id)),
  };
}

/**
 * 「选中文件自己就没有 turn」是个**结局已定**的失败：再怎么扫兄弟文件也变不出
 * 一个 selectedFile 来。所以这一支必须在枚举之前就抛掉 —— 根因 D 的第三条：
 * devbox 上一个坏会话每轮重试都要先付一次全树扫描（197MB 那个实测 2.4s），
 * ×N 个坏会话叠成 7–16s 的接口延迟。
 *
 * 抛的是确定性错误类型、不是裸 Error：调用链尽头是 herdr-fleet 的重试闸，裸
 * Error 会被当成「可重试」无限重排（根因 C 的放大器）。同样的字节重跑一万次还是
 * 同样的结果，指纹变了才值得再试 —— 正是 isDeterministicAttachFailure 的语义。
 * 异步化之后这条依然成立：Promise 只是换了传递方式，reject 的还是同一个类型。
 */
function requireSelectedTurns(
  selected: string,
  parsed: ParsedCliSession | null,
): ParsedCliSession {
  if (!parsed || parsed.turns.length === 0) {
    throw new CliTranscriptNoTurnsError(selected);
  }
  return parsed;
}

/** 兄弟候选。枚举失败（目录读不了）退化成「只有自己」，与老行为一致。 */
function siblingCandidates(
  selected: string,
  files: string[] | undefined,
): string[] {
  if (files) return files;
  try {
    const dir = path.dirname(selected);
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(dir, file));
  } catch {
    return [selected];
  }
}

/** Group sibling transcript files that share stable turn IDs into one tree. */
export function discoverLineageWithParser(
  transcriptPath: string,
  parse: (path: string) => ParsedCliSession | null,
  siblingFiles?: (selectedPath: string) => string[],
): DiscoveredLineage {
  // selected 与下面每个 full 都走 canonicalPath：这里是靠**精确串比较**认选中
  // 文件的（`file.full === selected`），一边物理路径一边 $HOME 符号路径就永远
  // 对不上，结果是把「明明有 turn 的文件」判成没有 —— 根因 C。
  const selected = canonicalPath(transcriptPath);
  // selected 先解析、先判死。枚举只在「还有可能成组」时才发生。
  const parsedFiles: ParsedFile[] = [
    toParsedFile(selected, requireSelectedTurns(selected, parse(selected))),
  ];
  let files: string[] | undefined;
  try {
    files = siblingFiles?.(selected);
  } catch {
    files = [selected];
  }
  for (const file of siblingCandidates(selected, files)) {
    const full = canonicalPath(file);
    if (full === selected) continue; // 上面已经解析过，别再付一次
    const parsed = parse(full);
    if (!parsed || parsed.turns.length === 0) continue;
    parsedFiles.push(toParsedFile(full, parsed));
  }
  return assembleLineage(selected, parsedFiles);
}

/**
 * discoverLineageWithParser 的非阻塞版：解析与枚举都可以是异步的，兄弟循环里
 * 按时间片让出事件循环。结果与同步版逐字相同（分组是 union-find，与文件顺序
 * 无关；root 选举与 members 排序都是确定性比较）。
 */
export async function discoverLineageWithParserAsync(
  transcriptPath: string,
  parse: (path: string) => Promise<ParsedCliSession | null>,
  siblingFiles?: (selectedPath: string) => string[] | Promise<string[]>,
): Promise<DiscoveredLineage> {
  const selected = canonicalPath(transcriptPath);
  const parsedFiles: ParsedFile[] = [
    toParsedFile(selected, requireSelectedTurns(selected, await parse(selected))),
  ];
  let files: string[] | undefined;
  try {
    files = await siblingFiles?.(selected);
  } catch {
    files = [selected];
  }
  const yieldSlice = makeSlicer();
  for (const file of siblingCandidates(selected, files)) {
    const full = canonicalPath(file);
    if (full === selected) continue;
    const parsed = await parse(full);
    // 缓存命中的 parse 是已 resolve 的 promise —— 光靠 await 不会让出宏任务，
    // 几百个兄弟照样能占住事件循环，所以这里显式过一次时间片闸。
    await yieldSlice();
    if (!parsed || parsed.turns.length === 0) continue;
    parsedFiles.push(toParsedFile(full, parsed));
  }
  return assembleLineage(selected, parsedFiles);
}

function assembleLineage(
  selected: string,
  parsedFiles: ParsedFile[],
): DiscoveredLineage {
  const selectedFile = parsedFiles.find((file) => file.full === selected);
  // requireSelectedTurns 已经保证它在里面；留着这道闸是因为「selected 必须在
  // 候选集合里」是本文件的核心不变量，将来谁改枚举都不该悄悄破掉它。
  if (!selectedFile) throw new CliTranscriptNoTurnsError(selected);

  const parent = new Map<string, string>();
  const find = (value: string): string => {
    const p = parent.get(value) ?? value;
    if (p === value) {
      parent.set(value, value);
      return value;
    }
    const root = find(p);
    parent.set(value, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const firstOwnerByTurn = new Map<string, string>();
  for (const file of parsedFiles) {
    find(file.full);
    for (const id of file.turnIds) {
      const first = firstOwnerByTurn.get(id);
      if (first) union(first, file.full);
      else firstOwnerByTurn.set(id, file.full);
    }
  }

  const selectedRoot = find(selectedFile.full);
  const group = parsedFiles.filter((file) => find(file.full) === selectedRoot);
  const allTurns = group.flatMap((file) => file.parsed.turns);
  const rootTurn =
    allTurns
      .filter((turn) => turn.parentId === null)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] ??
    allTurns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];

  const rootCandidates = group
    .filter((file) => file.turnIds.has(rootTurn.id))
    .sort(
      (a, b) =>
        fileOrder(a.full) - fileOrder(b.full) ||
        a.parsed.updatedAt - b.parsed.updatedAt ||
        a.full.localeCompare(b.full),
    );
  const rootFile = rootCandidates[0] ?? selectedFile;
  const groupTurnIds = new Set(
    group.flatMap((file) => file.parsed.turns.map((turn: ParsedTurn) => turn.id)),
  );
  const members = group.map((file) => {
    const others = new Set(groupTurnIds);
    for (const id of file.turnIds) {
      if (!group.some((other) => other.full !== file.full && other.turnIds.has(id))) {
        others.delete(id);
      }
    }
    const isRoot = file.full === rootFile.full;
    return {
      sid: file.parsed.sessionId,
      path: file.full,
      isRoot,
      forkPointUuid: isRoot ? null : forkPointFor(file.parsed, others),
    };
  });
  members.sort(
    (a, b) => Number(b.isRoot) - Number(a.isRoot) || a.path.localeCompare(b.path),
  );
  return { rootSid: rootFile.parsed.sessionId, members };
}
