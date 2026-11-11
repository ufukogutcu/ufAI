import catalog from "@ufai/theme-catalog";
import type {
  Theme,
  ThemeColors,
  ThemeInput,
  ThemeMode,
  ThemeColorKey,
} from "../../server/src/contracts";
import type { CSSProperties } from "react";
export { catalog };
export type { Theme, ThemeColors, ThemeInput, ThemeMode, ThemeColorKey };
export const colorKeys = Object.keys(catalog.tokens) as ThemeColorKey[];
export const hexColor = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
export function normalizeColor(value: string): string {
  const digits = value.slice(1).toLowerCase();
  return `#${digits.length < 5 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}
export function resolveColors(
  mode: ThemeMode,
  colors: Partial<ThemeColors>,
): ThemeColors {
  return Object.fromEntries(
    colorKeys.map((key) => [
      key,
      normalizeColor(colors[key] ?? catalog.tokens[key][mode]),
    ]),
  ) as ThemeColors;
}
export const defaultThemes: Theme[] = catalog.themes.map((theme) => ({
  ...theme,
  mode: theme.mode as ThemeMode,
  colors: resolveColors(theme.mode as ThemeMode, {}),
  builtIn: true,
  createdAt: null,
  updatedAt: null,
}));
export function themeStyle(
  theme: Pick<Theme, "mode" | "colors">,
): CSSProperties {
  return Object.fromEntries([
    ["colorScheme", theme.mode],
    ...colorKeys.map((key) => [
      catalog.tokens[key].cssVariable,
      theme.colors[key],
    ]),
  ]) as CSSProperties;
}
export function applyTheme(
  theme: Theme,
  element: HTMLElement = document.documentElement,
) {
  for (const key of colorKeys)
    element.style.setProperty(
      catalog.tokens[key].cssVariable,
      theme.colors[key],
    );
  element.style.colorScheme = theme.mode;
  element.dataset.themeMode = theme.mode;
}

// Composite translucent colors before calculating readable text contrast.
function rgb(color: string): number[] {
  const full = normalizeColor(color).slice(1);
  return [0, 2, 4]
    .map((offset) => parseInt(full.slice(offset, offset + 2), 16))
    .concat(full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1);
}
function over(front: number[], back: number[]): number[] {
  return front
    .slice(0, 3)
    .map((channel, i) => channel * front[3]! + back[i]! * (1 - front[3]!))
    .concat(1);
}
function luminance(color: number[]): number {
  return color.slice(0, 3).reduce((sum, channel, i) => {
    const s = channel / 255;
    return (
      sum +
      (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][i]!
    );
  }, 0);
}
export function contrastWarnings(input: ThemeInput): string[] {
  const base = rgb(catalog.tokens.background[input.mode]);
  const page = over(rgb(input.colors.background), base);
  const pairs: [ThemeColorKey, ThemeColorKey, string][] = [
    ["text", "background", "Main text"],
    ["muted", "background", "Secondary text"],
    ["primary-text", "primary-background", "Primary button"],
    ["text", "input-background", "Input text"],
    ["danger-text", "danger-background", "Destructive button"],
    ["error-text", "error-background", "Error banner"],
  ];
  return pairs.flatMap(([foreground, background, label]) => {
    const bg = over(rgb(input.colors[background]), page);
    const fg = over(rgb(input.colors[foreground]), bg);
    const values = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
    const ratio = (values[0]! + 0.05) / (values[1]! + 0.05);
    return ratio < 4.5
      ? [`${label}: ${ratio.toFixed(1)}:1 contrast (4.5:1 recommended).`]
      : [];
  });
}
