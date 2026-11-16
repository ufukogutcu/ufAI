import type { CommunicationAnchors, CommunicationLink } from "../../server/src/contracts";
import { circlePoint, CONNECTION_RADIUS, normalizeAngle, type Point } from "./connection-geometry";

type AnchorEdit = { linkId: string; endpoint: keyof CommunicationAnchors; angle: number };
export function effectiveAnchorAngle(link: CommunicationLink, endpoint: keyof CommunicationAnchors,
  draft?: Partial<CommunicationAnchors>, edit?: AnchorEdit) {
  return edit?.linkId === link.id && edit.endpoint === endpoint ? edit.angle : draft?.[endpoint] ?? link[endpoint];
}

export const CONNECTION_ARC_SPAN = 24;
type Range = [number, number];
export function connectionArcRanges(angles: number[]): Range[] {
  const ranges: Range[] = angles.flatMap(angle => {
    const start = normalizeAngle(angle - CONNECTION_ARC_SPAN / 2), end = start + CONNECTION_ARC_SPAN;
    return end > 360 ? [[start, 360], [0, end - 360]] : [[start, end]];
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function connectionRingPaths(angles: number[], center: Point) {
  const arcs = connectionArcRanges(angles), remainder: Range[] = [];
  let cursor = 0;
  for (const [start, end] of arcs) {
    if (start > cursor) remainder.push([cursor, start]);
    cursor = end;
  }
  if (cursor < 360) remainder.push([cursor, 360]);
  function path(ranges: Range[]) {
    return ranges.map(([start, end]) => {
      const from = circlePoint(center, start), to = circlePoint(center, end);
      // Two arcs are necessary for a complete circle with coincident endpoints.
      const middle = circlePoint(center, (start + end) / 2);
      const arc = (point: Point) => `A${CONNECTION_RADIUS},${CONNECTION_RADIUS} 0 0 1 ${point.x},${point.y}`;
      return `M${from.x},${from.y} ${arc(middle)} ${arc(to)}`;
    }).join(" ");
  }
  return { arcs: path(arcs), remainder: path(remainder) };
}
