// Minimal line-level diff for the Edit/MultiEdit tool views.
//
// Deliberately not a diff library: the inputs are one tool call's old_string /
// new_string, which are small and already scoped to the edited region. An
// LCS table is O(n·m) — fine at this size, and it produces a genuinely
// readable diff instead of "whole block red, whole block green".

export type DiffLine = {
  kind: "ctx" | "add" | "del";
  text: string;
  /** 1-based line number in the old text (null for additions). */
  oldNo: number | null;
  /** 1-based line number in the new text (null for deletions). */
  newNo: number | null;
};

// Above this the LCS table stops being worth it (and starts being a jank
// source), so we degrade to a plain replace-block. Edit payloads that big are
// effectively a rewrite anyway.
const MAX_LCS_LINES = 400;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text, i) => del(text, i + 1)),
      ...b.map((text, i) => add(text, i + 1)),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(del(a[i], i + 1));
      i++;
    } else {
      out.push(add(b[j], j + 1));
      j++;
    }
  }
  while (i < a.length) out.push(del(a[i], ++i));
  while (j < b.length) out.push(add(b[j], ++j));
  return out;
}

function add(text: string, newNo: number): DiffLine {
  return { kind: "add", text, oldNo: null, newNo };
}

function del(text: string, oldNo: number): DiffLine {
  return { kind: "del", text, oldNo, newNo: null };
}

/**
 * Drop runs of unchanged lines longer than `context * 2 + 1`, replacing each
 * with a single gap marker. Returns lines plus the positions where a gap was
 * elided, so the view can render a "⋯ N 行未变" separator.
 */
export function collapseContext(
  lines: DiffLine[],
  context = 3,
): Array<DiffLine | { kind: "gap"; hidden: number }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "ctx") continue;
    for (
      let k = Math.max(0, i - context);
      k <= Math.min(lines.length - 1, i + context);
      k++
    ) {
      keep[k] = true;
    }
  }
  const out: Array<DiffLine | { kind: "gap"; hidden: number }> = [];
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (run > 0) {
        out.push({ kind: "gap", hidden: run });
        run = 0;
      }
      out.push(lines[i]);
    } else {
      run++;
    }
  }
  if (run > 0) out.push({ kind: "gap", hidden: run });
  return out;
}
