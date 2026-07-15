// Theme (palette) registry. A palette = a `[data-theme=X]` + `[data-theme=X].dark`
// variable-override pair in app/globals.css; this file is the single source the
// ThemeMenu swatches and the /theme command resolve against. `default` has no
// data-theme attribute (`:root`/`.dark` are the default palette).
//
// Adding a palette = one CSS override block in globals.css + one entry here.
// Components never reference palettes directly — they only consume token
// utilities (bg-surface / text-ink / bg-accent …).

export type ThemeMode = "light" | "dark" | "system";

export type PaletteDef = {
  id: string;
  label: string;
  /** swatch preview colors: [canvas, surface, accent] (light-mode values) */
  preview: [string, string, string];
};

export const DEFAULT_PALETTE = "default";

export const PALETTES: PaletteDef[] = [
  {
    id: "default",
    label: "默认",
    preview: ["#fafaf9", "#ffffff", "#4f46e5"],
  },
];

export function isPaletteId(id: string): boolean {
  return PALETTES.some((p) => p.id === id);
}
