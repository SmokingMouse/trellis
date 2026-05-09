// Imperative <mark> injection on a rendered markdown body. Replaces the
// old "regex on source markdown string" approach which broke on code
// fences, tables, links, bold/italic, list prefixes, and cross-paragraph
// selections — anywhere markdown syntax characters in the source diverge
// from selection.toString() (DOM textContent). See progress/anchor-dom-inject.md.
//
// Algorithm: walk root's textNodes to build a flat textContent index +
// a whitespace-normalized mirror with an offset map. For each anchor,
// indexOf the normalized needle, map back to original offsets, splitText
// at boundaries, then per-textNode-wrap with a fresh <mark>. Index is
// rebuilt per anchor since each wrap mutates the DOM.

type Anchor = { text: string; id: string };
type DataKey = "childId" | "noteId";
export type MarkSpec = { dataKey: DataKey; anchors: Anchor[] };

export function clearMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(
    "mark[data-child-id], mark[data-note-id]",
  );
  marks.forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  // Adjacent textNodes left split by removed marks merge back so the next
  // index pass doesn't see fragmented runs.
  root.normalize();
}

export function injectMarks(root: HTMLElement, specs: MarkSpec[]): void {
  for (const spec of specs) {
    for (const anchor of spec.anchors) {
      if (!anchor.text) continue;
      const needle = normalizeWs(anchor.text);
      if (!needle) continue;
      // Rebuild after each wrap — splitText invalidates node offsets.
      const idx = buildIndex(root);
      if (!idx) continue;
      const at = idx.normText.indexOf(needle);
      if (at < 0) continue;
      const origStart = idx.mapBack[at];
      const origEnd = idx.mapBack[at + needle.length - 1] + 1;
      wrapRange(root, idx, origStart, origEnd, spec.dataKey, anchor.id);
    }
  }
}

type NodeEntry = { node: Text; start: number; end: number };
type Idx = {
  nodes: NodeEntry[];
  normText: string;
  mapBack: number[];
};

function buildIndex(root: HTMLElement): Idx | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: NodeEntry[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push({
      node: t,
      start: text.length,
      end: text.length + t.data.length,
    });
    text += t.data;
  }
  if (!text) return null;
  // Collapse whitespace runs to a single space, while keeping a back-map
  // from each char of normText to its index in the original text. This
  // lets us match selections captured across line wraps (where DOM
  // serialization may differ from the source text by whitespace) while
  // still wrapping precise original ranges.
  let normText = "";
  const mapBack: number[] = [];
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isWs = c === 32 || c === 9 || c === 10 || c === 13;
    if (isWs) {
      if (!inWs) {
        normText += " ";
        mapBack.push(i);
        inWs = true;
      }
    } else {
      normText += text[i];
      mapBack.push(i);
      inWs = false;
    }
  }
  return { nodes, normText, mapBack };
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function wrapRange(
  root: HTMLElement,
  idx: Idx,
  origStart: number,
  origEnd: number,
  dataKey: DataKey,
  id: string,
): void {
  const startLoc = locate(idx.nodes, origStart, false);
  const endLoc = locate(idx.nodes, origEnd, true);
  if (!startLoc || !endLoc) return;

  // Split start: take the right half so the range begins at a textNode boundary.
  let startNode: Text = startLoc.node;
  let endNode: Text = endLoc.node;
  let endOffset = endLoc.offset;
  if (startLoc.offset > 0) {
    const right = startNode.splitText(startLoc.offset);
    if (endNode === startNode) {
      // Same originating textNode — after splitText, the tail we care
      // about lives in `right`, with its own (shifted) end offset.
      endNode = right;
      endOffset = endLoc.offset - startLoc.offset;
    }
    startNode = right;
  }
  // Split end: keep the left half so the range ends at a textNode boundary.
  if (endOffset > 0 && endOffset < endNode.data.length) {
    endNode.splitText(endOffset);
  }

  // Walk every textNode from startNode to endNode (inclusive) in document
  // order, then per-node wrap with a fresh <mark>. Per-node wrap (instead
  // of Range.surroundContents) handles cross-element ranges and avoids
  // the iOS Safari InvalidStateError surroundContents throws on those.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let started = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === startNode) started = true;
    if (started) targets.push(n as Text);
    if (n === endNode) break;
  }
  for (const t of targets) {
    if (!t.parentNode) continue;
    const m = document.createElement("mark");
    m.dataset[dataKey] = id;
    t.parentNode.insertBefore(m, t);
    m.appendChild(t);
  }
}

function locate(
  nodes: NodeEntry[],
  offset: number,
  atEnd: boolean,
): { node: Text; offset: number } | null {
  // Half-open intervals: [start, end). End offsets land on `end` (one past
  // the last char), which falls in the previous textNode at offset == its length.
  for (const e of nodes) {
    if (atEnd) {
      if (offset > e.start && offset <= e.end) {
        return { node: e.node, offset: offset - e.start };
      }
    } else {
      if (offset >= e.start && offset < e.end) {
        return { node: e.node, offset: offset - e.start };
      }
    }
  }
  return null;
}
