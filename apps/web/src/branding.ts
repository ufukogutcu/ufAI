import type { ThemeColors } from "../../server/src/contracts";

export const relayPath = "M22 74h18c13 0 19-7 19-20V23h16M59 48h16";
export const relayNodes = [
  { cx: 75, cy: 23, secondary: false },
  { cx: 75, cy: 48, secondary: false },
  { cx: 22, cy: 74, secondary: true },
] as const;

// Favicons are separate SVG documents, so resolve their colors explicitly.
export function relayFavicon(
  colors: Pick<ThemeColors, "logo-text" | "logo-secondary">,
): string {
  const primary = colors["logo-text"];
  const nodes = relayNodes
    .map(
      ({ cx, cy, secondary }) =>
        `<circle cx="${cx}" cy="${cy}" r="9" fill="${secondary ? colors["logo-secondary"] : primary}"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path d="${relayPath}" fill="none" stroke="${primary}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>${nodes}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
