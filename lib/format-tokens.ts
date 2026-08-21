// Compact token-count formatter used across all token displays so the
// header / cards / fullscreen meta line read consistently with high precision.
//
// Tiers:
//   - <1000      → exact integer ("820")
//   - 1k - 1M    → one decimal ("1.2k", "12.4k", "120.5k"; whole thousands strip ".0")
//   - 1M+        → up to two decimals ("1.25M", "1.2M", "1M")
//
// Negative inputs return "0"; non-finite returns "—".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "k" : v + "k";
  }
  const m = (n / 1_000_000).toFixed(2);
  return m.endsWith(".00")
    ? m.slice(0, -3) + "M"
    : m.endsWith("0")
      ? m.slice(0, -1) + "M"
      : m + "M";
}
