"use client";

// Shared clipboard helpers. The async Clipboard API (navigator.clipboard)
// is only available in secure contexts (https / localhost) and requires a
// user gesture. When it's unavailable or rejects, fall back to the legacy
// `document.execCommand('copy')` path, which works everywhere but needs a
// focused textarea with the text selected.

export async function copyText(text: string): Promise<void> {
  if (!text) return;

  // 1) Modern async clipboard API.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the execCommand fallback
    }
  }

  // 2) Legacy execCommand fallback. Create a hidden textarea, select its
  //    contents, run copy, then remove it. Must be synchronous-ish (no
  //    await between focus and execCommand) or the browser may treat the
  //    gesture as expired.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand('copy') returned false");
  } finally {
    document.body.removeChild(ta);
  }
}
