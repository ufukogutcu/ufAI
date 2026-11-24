import { memo, useEffect, useRef } from "react";
import { BaseEdge, useInternalNode, type EdgeProps } from "@xyflow/react";
import { useStore } from "zustand";
import { useAgents } from "../agent-store";
import type { CommunicationLink } from "../../../server/src/contracts";
import { circlePoint, radialPath, ringCenter } from "../connection-geometry";
import { effectiveAnchorAngle } from "../connection-appearance";
import { ConnectionGrip, useConnectionRings } from "./ConnectionRings";
import { MessageEnvelope } from "./MessageEnvelope";
import { useMessageTransits, type VisualTransit } from "../message-transit-store";
import styles from "./CommunicationEdge.module.scss";

function Envelopes({ path, source, transits }: { path: string; source: string; transits: VisualTransit[] }) {
  const route = useRef<SVGPathElement>(null);
  const envelopes = useRef<SVGGElement>(null);
  useEffect(() => {
    const line = route.current!, group = envelopes.current!;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const length = line.getTotalLength();
    let frame = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    function draw() {
      cancelAnimationFrame(frame);
      clearTimeout(expiry);
      if (document.visibilityState === "hidden") {
        group.style.visibility = "hidden";
        return;
      }
      group.style.visibility = "visible";
      const now = performance.now();
      let active = false;
      let nextExpiry = Infinity;
      for (let i = 0; i < transits.length; i++) {
        const transit = transits[i]!, icon = group.children[i] as SVGGElement;
        const progress = Math.min(1, Math.max(0, (now - transit.localStartedAt) / (transit.localArrivesAt - transit.localStartedAt)));
        icon.style.visibility = progress >= 1 ? "hidden" : "visible";
        if (progress >= 1) continue;
        active = true;
        nextExpiry = Math.min(nextExpiry, transit.localArrivesAt);
        const fraction = motion.matches ? 0.5 : transit.senderAgentId === source ? progress : 1 - progress;
        const point = line.getPointAtLength(length * fraction);
        icon.setAttribute("transform", `translate(${point.x} ${point.y})`);
      }
      if (active && !motion.matches) frame = requestAnimationFrame(draw);
      else if (active) expiry = setTimeout(draw, Math.max(1, nextExpiry - now));
    }
    draw();
    document.addEventListener("visibilitychange", draw);
    motion.addEventListener("change", draw);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(expiry);
      document.removeEventListener("visibilitychange", draw);
      motion.removeEventListener("change", draw);
    };
  }, [path, source, transits]);
  return <g className={styles.transits} aria-hidden="true">
    <path ref={route} d={path} fill="none" stroke="none" />
    <g ref={envelopes}>{transits.map(transit => (
      <MessageEnvelope key={transit.messageId} className={styles.envelope} />
    ))}</g>
  </g>;
}

export const CommunicationEdge = memo(function CommunicationEdge(props: EdgeProps) {
  const link = props.data?.link as CommunicationLink;
  const source = useInternalNode(props.source), target = useInternalNode(props.target);
  const savedDraft = useAgents(s => s.anchorDrafts[props.id]);
  const { store } = useConnectionRings();
  const dragAngle = useStore(store, s => s.drag?.kind === "edit" && s.drag.linkId === props.id ? s.drag.angle : undefined);
  const dragEndpoint = useStore(store, s => s.drag?.kind === "edit" && s.drag.linkId === props.id ? s.drag.endpoint : undefined);
  const hovered = useStore(store, s => s.hoveredLink === props.id);
  const sourceName = useAgents(s => s.agents[props.source]?.name ?? "agent");
  const targetName = useAgents(s => s.agents[props.target]?.name ?? "agent");
  const transits = useMessageTransits(props.id);
  if (!source || !target) return null;
  const edit = dragAngle !== undefined && dragEndpoint ? { linkId: props.id, endpoint: dragEndpoint, angle: dragAngle } : undefined;
  const sourceAngle = effectiveAnchorAngle(link, "sourceAnchorAngle", savedDraft, edit);
  const targetAngle = effectiveAnchorAngle(link, "targetAnchorAngle", savedDraft, edit);
  const from = circlePoint(ringCenter(source.internals.positionAbsolute), sourceAngle);
  const to = circlePoint(ringCenter(target.internals.positionAbsolute), targetAngle);
  const path = radialPath(from, sourceAngle, to, targetAngle);
  return <g onMouseEnter={() => store.getState().hover(props.id)} onMouseLeave={() => store.getState().hover(null)}
    onFocus={() => store.getState().hover(props.id)} onBlur={() => store.getState().hover(null)}>
    <BaseEdge id={props.id} path={path} style={props.style} interactionWidth={props.interactionWidth} />
    {transits.length > 0 && <Envelopes path={path} source={props.source} transits={transits} />}
    {link.state === "active" && <>
      <ConnectionGrip linkId={props.id} endpoint="sourceAnchorAngle" agentName={sourceName} peerName={targetName} {...from} angle={sourceAngle} visible={hovered || dragAngle !== undefined} />
      <ConnectionGrip linkId={props.id} endpoint="targetAnchorAngle" agentName={targetName} peerName={sourceName} {...to} angle={targetAngle} visible={hovered || dragAngle !== undefined} />
    </>}
  </g>;
});
