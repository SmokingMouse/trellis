---
id: 52e491eece1d
commit: 04250ddf16b6e63bfd04981ee509f564fe52c0d7
branch: perf/markdown-render-cache
timestamp: 2026-08-18T02:33:49+08:00
commit_message: "perf: markdown HAST 缓存 + 视口懒渲染，治大会话 Tab 切换延迟（S98）"
files_modified: ["components/ChatNode.tsx", "components/LinearThreadView.tsx", "components/TurnCard.tsx", "hooks/useNearViewport.ts", "lib/markdown-cache.ts", "progress/archive.md", "progress/sessions.md"]
agent_percentage: 0.0
---

## Prompt

This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request and Intent:
   - **Original request (in progress)**: "排查一个问题，就我发现好像当这个数大了以后，或者说内容多了以后，想要在Tab间切换，会存在特别大的延时。" — investigate and fix large latency when switching between session Tabs in Trellis when sessions have many nodes/much content.
   - **User-chosen fix scope** (via AskUserQuestion): **"P0 + P1：连首次切换也治"** — P0: markdown render cache keyed by node identity so repeat tab switches are instant; P1: IntersectionObserver lazy markdown rendering in the linear thread view (plain-text placeholder until ~800px from viewport, then upgrade to full markdown) so even the FIRST switch to a big session is fast. User acknowledged: "首次打开也快，但要处理滚动高度跳动、阅读位置恢复、IO 已读标记的配合，回归风险中等。"
   - Earlier completed request: branch cleanup (deleted merged branch, aligned local main to origin/main).
   - Communication default: Chinese (per global CLAUDE.md).

2. Key Technical Concepts:
   - Trellis: Next.js app (**modified Next.js — AGENTS.md mandates reading `node_modules/next/dist/docs/` before writing Next.js code**; this change was client components/libs only, so not triggered), bun, bun:sqlite, zustand, React Flow (@xyflow/react v12), react-markdown v10.1.0
   - react-markdown v10 exact render path: `processor.runSync(processor.parse(file), file)` → `post(tree, options)` → `toJsxRuntime(tree, {Fragment, components, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true, passNode: true})`; post's `transform` visitor converts leftover `raw` nodes to text and applies `urlTransform` to each property in `urlAttributes` (from `html-url-attributes` package, type `Record<string, Array<string> | null>`, null = all elements)
   - react-markdown root exports: `MarkdownAsync, MarkdownHooks, Markdown as default, defaultUrlTransform` — the app's `import ReactMarkdown from "react-markdown"` IS the sync component
   - HAST-level caching: cache the hast tree per nodeId+content identity; repeat mounts only re-run toJsxRuntime (cheap) vs the full unified pipeline (parse+remark+rehype-highlight+katex). Static-HTML caching ruled out (MD_COMPONENTS are interactive); element caching ruled out (components re-execute on mount)
   - IntersectionObserver lazy rendering with rootMargin 800px; placeholder height captured at IO fire time; useLayoutEffect scroll compensation (`container.scrollTop += delta` when card top < container top) so upgrading cards above the viewport don't shift visible content; effects run in document order so compensation reduces to "was this card originally above the fold"
   - `useMarkdownBodyMarks` hook's `suspended` param gates both mark injection and pendingScrollAnchor flash; deps include `suspended` so flipping it re-runs effects
   - Progress protocol (mandatory after code changes): update `progress/sessions.md` (new entry + rotate oldest of >5 into archive.md in same edit), README Current Focus one sentence ≤200 chars

3. Files and Code Sections:
   - **`lib/markdown-cache.ts`** (NEW, ~110 lines) — P0 hast cache. Full content written:
     - Frozen module-level processor: `unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS).use(remarkRehype, { allowDangerousHtml: true }).use(MARKDOWN_REHYPE_PLUGINS).freeze()`
     - `const cache = new Map<string, CacheEntry>(); const CAP = 200;` with LRU touch (delete+set on hit)
     - `getHast(cacheKey, content)`: on miss `const file = new VFile({ value: content }); const hast = processor.runSync(processor.parse(file), file) as HastRoot; applyPostTransform(hast);` then cache with eviction
     - `applyPostTransform(tree)`: faithful react-markdown transform copy — `visit(tree, (node: any, index: number | null | undefined, parent: any) => {...})` (index type must be `number | null | undefined` for tsc), raw→text replacement, urlAttributes loop with `MD_URL_TRANSFORM(String(value || ""), key, node)`
     - `renderCachedMarkdown(cacheKey, content)`: `toJsxRuntime(getHast(...), {Fragment, components: MD_COMPONENTS, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true, passNode: true})`
     - `MarkdownBody({cacheKey, content})` thin component
   - **`hooks/useNearViewport.ts`** (NEW) — P1 lazy primitive:
     - `useNearViewport(ref, {margin = 800, force = false})` returns `near || force`
     - IO effect: on intersect, `placeholderH.current = el.offsetHeight; setNear(true); io.disconnect()`
     - useLayoutEffect: `delta = el.offsetHeight - placeholderH.current`; finds `el.closest("[data-thread-scroll]")`; if `el.getBoundingClientRect().top >= container.getBoundingClientRect().top` skip; else `container.scrollTop += delta`
   - **`components/LinearThreadView.tsx`** — one edit: added `data-thread-scroll` attribute to scroll container (line ~482): `<div ref={scrollRef} onScroll={onScroll} data-thread-scroll className="flex-1 overflow-y-auto">`
   - **`components/TurnCard.tsx`** — 3 edits:
     - Imports: removed `MARKDOWN_REHYPE_PLUGINS`, added `import { MarkdownBody } from "@/lib/markdown-cache";` and `import { useNearViewport } from "@/hooks/useNearViewport";`
     - ResponseBody: added `isAnchorTarget = useSessionStore((s) => s.pendingScrollAnchor?.nodeId === node.id)`, `const near = useNearViewport(bodyRef, { force: isAnchorTarget });`, changed marks hook to `suspended: isStreaming || !near`; done branch now `near ? (<><MarkdownBody cacheKey={node.id} content={node.response} />...buttons...<GeneratedFilesBar/></>) : (<div className="whitespace-pre-wrap break-words" aria-hidden>{node.response}</div>)`
     - ReferenceFullBody: same pattern, `cacheKey={`ref:${node.id}`}`, hooks placed before the `if (!ref)` early return
   - **`components/ChatNode.tsx`** — imports swapped (removed ReactMarkdown, MD_COMPONENTS, MD_URL_TRANSFORM, MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS; added MarkdownBody); done branch now `<MarkdownBody cacheKey={n.id} content={n.response} />`. No laziness on canvas (canvas sessions ≤20 nodes).
   - **`node_modules/react-markdown/lib/index.js`** (read) — source of truth for pipeline replication: `post()` at line 313, sync `Markdown` at line 175
   - **`hooks/useMarkdownBodyMarks.ts`** (read) — confirmed suspended semantics
   - **`components/LinearThreadView.tsx`** (read) — restore effect lines 144-164, read-marking IO 286-353, scroll container line 482, `<section key={node.id}>` at line 505
   - **`lib/md-components.ts`** (read) — `MD_URL_TRANSFORM: UrlTransform = (url) => /^file:\/\//i.test(url) ? url : defaultUrlTransform(url)`, `MD_COMPONENTS: Components`
   - **`lib/markdown-plugins.ts`** (read) — `MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkSingleLineDisplayMath]`, `MARKDOWN_REHYPE_PLUGINS = [rehypeRaw, rehypeKatex, rehypeHighlight]`; custom plugin reads `file.value` (hence VFile requirement)

4. Errors and fixes:
   - `bunx: command not found` → use `bun x tsc` / `bun x eslint`
   - tsc error TS2345: visitor `(node: any, index: number | null, parent: any)` not assignable to BuildVisitor (`number | undefined` vs `number | null`) → changed index type to `number | null | undefined`
   - Verification script `Cannot find package 'react' from '/tmp/verify-md-cache.ts'` → copied script into project root so node_modules resolves
   - `Export named 'Markdown' not found in module 'react-markdown'` → root index.js only re-exports Markdown as default; changed to `import Markdown from "react-markdown"` (also revealed the app's ReactMarkdown IS the sync component)
   - No user corrections on substance this session.

5. Problem Solving:
   - **Solved (implementation)**: P0 hast cache + P1 IO lazy rendering fully implemented and wired into TurnCard (ResponseBody + ReferenceFullBody), ChatNode, LinearThreadView.
   - **Solved (correctness verification)**: End-to-end HTML equivalence test — rendered the 40 largest done-node responses from `~/.trellis/data.db` through both react-markdown's sync component and `renderCachedMarkdown`, via `renderToStaticMarkup`: **40/40 identical HTML**. This validates pipeline, post-transform, and toJsxRuntime options together.
   - **Solved (performance verification)**: Benchmark (40 nodes, 399KB): baseline (full pipeline every switch) 1149ms → cached cold 828ms → **cached warm 193ms (6x faster)**. P1 laziness reduces first-switch cost further (only ~10-20 near cards render).
   - **Solved (lint hygiene)**: eslint before/after diff via git stash confirmed zero new errors in changed files (all reported errors pre-existing, line-shifted).
   - **Design decisions**: scroll compensation for height jumps (document-order invariant); `force` for anchor targets (flash effect needs markdown DOM); `aria-hidden` on placeholders (avoid SR reading raw markdown symbols); streaming nodes never cached/lazy; cache LRU cap 200.
   - **Open minor question**: whether to extend MarkdownBody to other full-pipeline consumers (CardImageButton, InteractionForm, FilePreview, ZoneEditor) — these are preview/editor surfaces, not the tab-switch hot path; likely not needed.

6. All user messages:
   - (From prior session, still governing) "现在什么阶段了？这分支还有存在的必要吗？"
   - "清理吧。"
   - "排查一个问题，就我发现好像当这个数大了以后，或者说内容多了以后，想要在Tab间切换，会存在特别大的延时。"
   - AskUserQuestion answer: **"P0 + P1：连首次切换也治"**
   - No new user messages this session (continuation work; one system notice: date changed to 2026-08-18, not to be mentioned).
   - Standing security/process constraints from CLAUDE.md (still in effect): 飞书/Lark write operations require reading `~/.claude/skills/lark-shared/references/write-gates.md` and literal user confirmation first (not relevant to this task); default Chinese communication; progress protocol mandatory after code changes.

7. Pending Tasks:
   - Update progress per protocol: write new entry in `progress/sessions.md` (with Next) and rotate oldest of >5 entries into `progress/archive.md` in the same edit; update `progress/README.md` Current Focus if Goal state affected (Goals are user-defined, don't add/remove).
   - Final report to user (in Chinese): what was implemented, verification results (40/40 equivalence, 1149ms→193ms), remaining minor considerations.
   - Optional (mention, don't necessarily do): other ReactMarkdown consumers not converted.

8. Current Work:
   Immediately before this summary, I had completed all code changes and verification:
   - Created `lib/markdown-cache.ts` and `hooks/useNearViewport.ts`
   - Edited `components/TurnCard.tsx`, `components/ChatNode.tsx`, `components/LinearThreadView.tsx`
   - `bun x tsc --noEmit` passes clean
   - eslint: no new errors (verified via git-stash before/after diff)
   - Equivalence test: `{"total":40,"same":40,"diff":0,"diffIds":[]}`
   - Benchmark: `baseline (react-markdown, full pipeline): 1149ms / cached cold (build hast + render): 828ms / cached warm (repeat switch): 193ms (40 nodes, 399KB total)`
   - Deleted temp scripts (verify-md-cache.ts, bench-md-cache.ts)
   - Last command: grepped remaining consumers — `MARKDOWN_REHYPE_PLUGINS` still in CardImageButton.tsx, InteractionForm.tsx, FilePreview.tsx, ZoneEditor.tsx; `ReactMarkdown` still in ZoneEditor, CardImageButton, ChatNode (streaming branch), InteractionForm, HoverPreview, FilePreview, TurnCard (streaming branch). These are intentional (streaming branches + non-hot-path surfaces).

9. Optional Next Step:
   Update progress files per the mandatory progress protocol ("代码变更后（硬性）：同一原子操作更新 progress——标完成 TODO、写 sessions.md(含 Next)+轮转"), then report to the user in Chinese: P0+P1 implemented and verified — repeat tab switches drop from ~1149ms to ~193ms (6x) on the 40 largest nodes, first switch is fast via IO lazy placeholders with scroll compensation, and output is byte-identical to react-markdown (40/40 HTML equivalence). The user's chosen scope "P0 + P1：连首次切换也治" is now fully implemented and verified; no further code work is pending unless the user wants the cache extended to the remaining preview/editor ReactMarkdown surfaces (CardImageButton/InteractionForm/FilePreview/ZoneEditor).

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /home/zhangpeng.pada/.claude/projects/-data00-home-zhangpeng-pada-trellis/ab12ddd8-fa11-4d9d-81d5-84b8b1e8dcc3.jsonl
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

## Summary

按仓库惯例走：特性分支 → `--no-ff` 合 main → progress 单独提交 → 推送。


