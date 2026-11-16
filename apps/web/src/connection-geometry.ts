import { AGENT_WIDTH, AGENT_HEIGHT } from "./canvas-layout";

export type Point = { x: number; y: number };
export const CONNECTION_RADIUS = 95;
export const CONNECTION_CENTER = { x: AGENT_WIDTH / 2, y: AGENT_HEIGHT / 2 };
export function ringCenter(position: Point): Point {
  return { x: position.x + CONNECTION_CENTER.x, y: position.y + CONNECTION_CENTER.y };
}
export function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}
export function angleAt(center: Point, point: Point, fallback = 0) {
  return point.x === center.x && point.y === center.y ? fallback
    : normalizeAngle(Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI);
}
export function circlePoint(center: Point, angle: number, radius = CONNECTION_RADIUS): Point {
  const radians = angle * Math.PI / 180;
  return { x: center.x + Math.cos(radians) * radius, y: center.y + Math.sin(radians) * radius };
}
export function radialPath(source: Point, sourceAngle: number, target: Point, targetAngle: number) {
  const length = Math.max(40, Math.min(160, Math.hypot(target.x - source.x, target.y - source.y) * 0.35));
  const a = circlePoint(source, sourceAngle, length), b = circlePoint(target, targetAngle, length);
  return `M${source.x},${source.y} C${a.x},${a.y} ${b.x},${b.y} ${target.x},${target.y}`;
}
export type RingNode = { id: string; position: Point; zIndex: number; order: number };
export function nearestRingTarget(nodes: RingNode[], sourceId: string, point: Point) {
  return nodes.filter(node => node.id !== sourceId)
    .map(node => ({ node, distance: Math.hypot(point.x - ringCenter(node.position).x, point.y - ringCenter(node.position).y) }))
    .filter(item => item.distance <= CONNECTION_RADIUS)
    .sort((a, b) => b.distance - a.distance || b.node.zIndex - a.node.zIndex || b.node.order - a.node.order)[0]?.node;
}
