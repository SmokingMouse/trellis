import fs from "node:fs";
import path from "node:path";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";

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

/** Group sibling transcript files that share stable turn IDs into one tree. */
export function discoverLineageWithParser(
  transcriptPath: string,
  parse: (path: string) => ParsedCliSession | null,
  siblingFiles?: (selectedPath: string) => string[],
): DiscoveredLineage {
  const selected = path.resolve(transcriptPath);
  let files: string[];
  try {
    files = siblingFiles
      ? siblingFiles(selected)
      : fs
          .readdirSync(path.dirname(selected))
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => path.join(path.dirname(selected), file));
  } catch {
    files = [selected];
  }

  const parsedFiles: ParsedFile[] = [];
  for (const file of files) {
    const full = path.resolve(file);
    const parsed = parse(full);
    if (!parsed || parsed.turns.length === 0) continue;
    parsedFiles.push({
      full,
      parsed,
      turnIds: new Set(parsed.turns.map((turn) => turn.id)),
    });
  }

  const selectedFile = parsedFiles.find((file) => file.full === selected);
  if (!selectedFile) throw new Error("selected CLI jsonl has no parseable turns");

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
