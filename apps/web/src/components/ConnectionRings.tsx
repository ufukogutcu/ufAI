import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Handle, Position, ViewportPortal, useInternalNode, useReactFlow, useStore as useFlowStore, useStoreApi } from "@xyflow/react";
import { useStore } from "zustand";
import { useAgentStore } from "../agent-store";
import { errorMessage } from "../api";
import { createConnectionDragStore, type AnchorKey, type ConnectionDragStore } from "../connection-drag";
import { angleAt, circlePoint, CONNECTION_RADIUS, radialPath, ringCenter } from "../connection-geometry";
import styles from "./ConnectionRings.module.scss";

type PointerEvent = ReactPointerEvent<HTMLElement | SVGElement>;
const RingContext = createContext<{
  store: ConnectionDragStore;
  start: (event: PointerEvent, begin: () => void) => void;
  move: (event: PointerEvent) => void;
  finish: (event: PointerEvent) => void;
  cancel: (event: PointerEvent) => void;
} | null>(null);
export function useConnectionRings() {
  const context = useContext(RingContext);
  if (!context) throw new Error("Connection rings require their workspace provider.");
  return context;
}

export function ConnectionRingsProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const agents = useAgentStore();
  const flow = useReactFlow();
  const flowStore = useStoreApi();
  const capture = useRef<{ element: HTMLElement | SVGElement; pointerId: number } | null>(null);
  const [store] = useState(() => createConnectionDragStore({
    nodes: () => flow.getNodes().flatMap((node, order) => {
      const internal = flow.getInternalNode(node.id);
      return node.type === "agent" && internal && agents.getState().agents[node.id]
        ? [{ id: node.id, position: internal.internals.positionAbsolute, zIndex: internal.internals.z, order }] : [];
    }),
    link: id => agents.getState().communication[workspaceId]?.links.find(link => link.id === id),
    create: (source, target, anchors) => agents.getState().createCommunicationLink(workspaceId, source, target, anchors),
    save: (id, anchors) => agents.getState().saveCommunicationAnchors(workspaceId, id, anchors),
  }));
  const release = useCallback(() => {
    const current = capture.current;
    capture.current = null;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && store.getState().drag) {
        event.preventDefault();
        event.stopPropagation();
        store.getState().cancel();
      }
    }
    const unsubscribe = store.subscribe(state => { if (!state.drag) release(); });
    const unagents = agents.subscribe(() => store.getState().validate());
    const unflow = flowStore.subscribe(() => store.getState().validate());
    document.addEventListener("keydown", keydown, true);
    const blur = () => store.getState().cancel();
    window.addEventListener("blur", blur);
    return () => {
      unsubscribe(); unagents(); unflow();
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", blur);
      store.getState().cancel(); release();
    };
  }, [agents, flowStore, store, release]);
  const start = useCallback((event: PointerEvent, begin: () => void) => {
    if (event.button !== 0 || !event.isPrimary || capture.current) return;
    event.preventDefault(); event.stopPropagation();
    begin();
    if (!store.getState().drag) return;
    capture.current = { element: event.currentTarget, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [store]);
  const move = useCallback((event: PointerEvent) => {
    if (capture.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    store.getState().move(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [flow, store]);
  const finish = useCallback((event: PointerEvent) => {
    if (capture.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    move(event);
    void store.getState().finish().catch(error => agents.setState({ positionError: errorMessage(error) }));
  }, [agents, move, store]);
  const cancel = useCallback((event: PointerEvent) => {
    if (capture.current?.pointerId === event.pointerId) store.getState().cancel();
  }, [store]);
  const value = useMemo(() => ({ store, start, move, finish, cancel }), [store, start, move, finish, cancel]);
  return <RingContext.Provider value={value}>{children}</RingContext.Provider>;
}

export function AgentConnectionRing({ id, name }: { id: string; name: string }) {
  const { store, start, move, finish, cancel } = useConnectionRings();
  const { screenToFlowPosition } = useReactFlow();
  const target = useStore(store, s => s.drag?.kind === "create" && s.drag.targetId === id);
  function pointerDown(event: PointerEvent) {
    start(event, () => store.getState().beginCreate(id, screenToFlowPosition({ x: event.clientX, y: event.clientY })));
  }
  return <>
    {/* A structural handle keeps React Flow's edge registry valid. The ring owns gestures. */}
    <Handle id="ring" type="source" position={Position.Left} isConnectable={false} className={styles.structuralHandle} aria-hidden="true" />
    <svg className={`${styles.ring} nodrag nopan`} data-target={target || undefined} aria-label={`Connection ring for ${name}`}>
      <circle className={styles.outline} cx={CONNECTION_RADIUS + 22} cy={CONNECTION_RADIUS + 22} r={CONNECTION_RADIUS} />
      <circle className={styles.hitArea} cx={CONNECTION_RADIUS + 22} cy={CONNECTION_RADIUS + 22} r={CONNECTION_RADIUS}
        onPointerDown={pointerDown} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onClick={event => event.stopPropagation()} />
    </svg>
  </>;
}

export function ConnectionPreview() {
  const { store } = useConnectionRings();
  const drag = useStore(store, state => state.drag);
  const source = useInternalNode(drag?.kind === "create" ? drag.sourceId : "");
  const target = useInternalNode(drag?.kind === "create" ? drag.targetId ?? "" : "");
  if (drag?.kind !== "create" || !source) return null;
  const from = circlePoint(ringCenter(source.internals.positionAbsolute), drag.sourceAngle);
  const to = target && drag.targetAngle !== undefined ? circlePoint(ringCenter(target.internals.positionAbsolute), drag.targetAngle) : drag.point;
  const toAngle = drag.targetAngle ?? angleAt(to, from);
  return <ViewportPortal><svg className={styles.preview} aria-hidden="true"><path d={radialPath(from, drag.sourceAngle, to, toAngle)} /></svg></ViewportPortal>;
}

export function ConnectionGrip({ linkId, endpoint, agentName, peerName, x, y, angle, visible }: {
  linkId: string; endpoint: AnchorKey; agentName: string; peerName: string; x: number; y: number; angle: number; visible: boolean;
}) {
  const { store, start, move, finish, cancel } = useConnectionRings();
  const agents = useAgentStore();
  const zoom = useFlowStore(state => state.transform[2]);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const open = () => {
    const link = Object.values(agents.getState().communication).flatMap(workspace => workspace.links).find(link => link.id === linkId);
    if (link) agents.setState({ communicationEditor: { workspaceId: link.workspaceId, linkId } });
  };
  return <ViewportPortal><button type="button" className={`${styles.grip} nodrag nopan`} data-visible={visible || undefined}
    style={{ left: x, top: y, "--connection-grip-scale": 1 / zoom } as CSSProperties} aria-label={`Adjust connection point on ${agentName} with ${peerName}`} onClick={event => {
      event.stopPropagation();
      if (!suppressClick.current || event.detail === 0) open();
      suppressClick.current = false;
    }}
    onPointerDown={event => {
      pointerStart.current = { x: event.clientX, y: event.clientY };
      suppressClick.current = false;
      start(event, () => store.getState().beginEdit(linkId, endpoint, angle));
    }}
    onPointerMove={event => {
      const initial = pointerStart.current;
      if (initial && Math.hypot(event.clientX - initial.x, event.clientY - initial.y) > 3) suppressClick.current = true;
      move(event);
    }} onPointerUp={event => { pointerStart.current = null; finish(event); }}
    onPointerCancel={event => { pointerStart.current = null; suppressClick.current = true; cancel(event); }}
    onLostPointerCapture={event => {
      if (pointerStart.current) { pointerStart.current = null; suppressClick.current = true; }
      cancel(event);
    }}
    onPointerEnter={() => store.getState().hover(linkId)} onPointerLeave={() => store.getState().hover(null)}
    onFocus={() => store.getState().hover(linkId)} onBlur={() => store.getState().hover(null)}
  ><span /></button></ViewportPortal>;
}
