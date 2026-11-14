import { memo, useEffect, useRef } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { Mail } from "lucide-react";
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
        icon.setAttribute("transform", `translate(${point.x - 12} ${point.y - 10})`);
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
    <g ref={envelopes}>{transits.map(transit => <g key={transit.messageId} className={styles.envelope}>
      <rect x="0" y="0" width="24" height="20" rx="4" />
      <Mail x="3" y="1" width="18" height="18" strokeWidth={1.75} />
    </g>)}</g>
  </g>;
}

export const CommunicationEdge = memo(function CommunicationEdge(props: EdgeProps) {
  const transits = useMessageTransits(props.id);
  const [path] = getBezierPath(props);
  return <>
    <BaseEdge id={props.id} path={path} style={props.style} interactionWidth={props.interactionWidth} />
    {transits.length > 0 && <Envelopes path={path} source={props.source} transits={transits} />}
  </>;
});
