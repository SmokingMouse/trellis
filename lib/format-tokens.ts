// Compact token-count formatter used across all token displays so the
// header / cards / fullscreen meta line read consistently.
//
// Tiers chosen for the trellis use case where cli-multi cache hits are
// often 30-50k:
//   - <1000   → exact integer ("820")
//   - 1k-10k  → one decimal ("1.2k")
//   - 10k+    → integer + k ("32k")
//
// Negative inputs return "0"; non-finite returns "—".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) {
    const v = (n / 1000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "k" : v + "k";
  }
  return Math.round(n / 1000) + "k";
}
