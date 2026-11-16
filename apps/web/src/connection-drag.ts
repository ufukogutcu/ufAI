import { createStore } from "zustand";
import type { CommunicationAnchors, CommunicationLink } from "../../server/src/contracts";
import { angleAt, nearestRingTarget, ringCenter, type Point, type RingNode } from "./connection-geometry";

export type AnchorKey = keyof CommunicationAnchors;
export type ConnectionDrag =
  | { kind: "create"; sourceId: string; sourceAngle: number; point: Point; targetId?: string; targetAngle?: number }
  | { kind: "edit"; linkId: string; agentId: string; endpoint: AnchorKey; angle: number; originalAngle: number };
interface DragState {
  drag: ConnectionDrag | null;
  hoveredLink: string | null;
  hover: (linkId: string | null) => void;
  beginCreate: (sourceId: string, point: Point) => void;
  beginEdit: (linkId: string, endpoint: AnchorKey, angle: number) => void;
  move: (point: Point) => void;
  finish: () => Promise<void>;
  cancel: () => void;
  validate: () => void;
}
export function createConnectionDragStore(options: {
  nodes: () => RingNode[];
  link: (id: string) => CommunicationLink | undefined;
  create: (source: string, target: string, anchors: CommunicationAnchors) => Promise<void>;
  save: (id: string, anchors: Partial<CommunicationAnchors>) => Promise<void>;
}) {
  return createStore<DragState>((set, get) => ({
    drag: null,
    hoveredLink: null,
    hover: hoveredLink => set({ hoveredLink }),
    beginCreate(sourceId, point) {
      const node = options.nodes().find(node => node.id === sourceId);
      if (node) set({ drag: { kind: "create", sourceId, sourceAngle: angleAt(ringCenter(node.position), point), point } });
    },
    beginEdit(linkId, endpoint, angle) {
      const link = options.link(linkId);
      if (link?.state !== "active") return;
      set({ drag: { kind: "edit", linkId, endpoint, angle, originalAngle: angle,
        agentId: endpoint === "sourceAnchorAngle" ? link.sourceAgentId : link.targetAgentId } });
    },
    move(point) {
      get().validate();
      const drag = get().drag;
      if (!drag) return;
      const nodes = options.nodes();
      if (drag.kind === "edit") {
        const node = nodes.find(node => node.id === drag.agentId);
        if (node) set({ drag: { ...drag, angle: angleAt(ringCenter(node.position), point, drag.angle) } });
      } else {
        const target = nearestRingTarget(nodes, drag.sourceId, point);
        const source = nodes.find(node => node.id === drag.sourceId)!;
        const fallback = target ? angleAt(ringCenter(target.position), ringCenter(source.position), (drag.sourceAngle + 180) % 360) : 0;
        set({ drag: { ...drag, point, targetId: target?.id,
          targetAngle: target ? angleAt(ringCenter(target.position), point, fallback) : undefined } });
      }
    },
    async finish() {
      get().validate();
      const drag = get().drag;
      set({ drag: null });
      if (drag?.kind === "create" && drag.targetId && drag.targetAngle !== undefined)
        await options.create(drag.sourceId, drag.targetId, { sourceAnchorAngle: drag.sourceAngle, targetAnchorAngle: drag.targetAngle });
      else if (drag?.kind === "edit" && drag.angle !== drag.originalAngle)
        await options.save(drag.linkId, { [drag.endpoint]: drag.angle });
    },
    cancel: () => set({ drag: null }),
    validate() {
      const drag = get().drag;
      if (!drag) return;
      const nodes = options.nodes();
      const id = drag.kind === "create" ? drag.sourceId : drag.agentId;
      if (!nodes.some(node => node.id === id) || (drag.kind === "edit" && options.link(drag.linkId)?.state !== "active"))
        set({ drag: null });
    },
  }));
}
export type ConnectionDragStore = ReturnType<typeof createConnectionDragStore>;
