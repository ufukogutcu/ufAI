import { useCallback } from "react";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Viewport,
} from "@xyflow/react";
import { Minus, Plus, Scan, Workflow } from "lucide-react";
import { useDashboard } from "../store";
import styles from "./Flowboard.module.scss";

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1 };

function ViewControls() {
  const { zoomIn, zoomOut, setViewport } = useReactFlow();
  const { zoom } = useViewport();
  function handleZoomIn() {
    void zoomIn();
  }
  function handleZoomOut() {
    void zoomOut();
  }
  function handleReset() {
    void setViewport(defaultViewport);
  }
  return (
    <Panel position="bottom-left" className={styles.controls}>
      <button
        className="iconButton"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={zoom <= 0.25}
        onClick={handleZoomOut}
      >
        <Minus size={16} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        className="iconButton"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={zoom >= 2}
        onClick={handleZoomIn}
      >
        <Plus size={16} />
      </button>
      <div className={styles.divider} />
      <button
        className="iconButton"
        aria-label="Reset view"
        title="Reset view"
        onClick={handleReset}
      >
        <Scan size={16} />
      </button>
    </Panel>
  );
}

function Board({ workspaceId }: { workspaceId: string }) {
  const viewport = useDashboard((state) => state.viewports[workspaceId]);
  const saveViewport = useDashboard((state) => state.saveViewport);
  const handleMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, next: Viewport) => {
      saveViewport(workspaceId, next);
    },
    [saveViewport, workspaceId],
  );
  return (
    <div className={styles.board}>
      <ReactFlow
        defaultViewport={viewport ?? defaultViewport}
        onMoveEnd={handleMoveEnd}
        minZoom={0.25}
        maxZoom={2}
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        aria-label="Workspace flowboard"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#353944"
        />
        <ViewControls />
        <Panel position="top-left" className={styles.label}>
          <span className={styles.statusDot} /> FLOWBOARD{" "}
          <span className={styles.badge}>0 agents</span>
        </Panel>
        <Panel position="bottom-right" className={styles.hint}>
          Drag to pan <span>·</span> Scroll to zoom
        </Panel>
      </ReactFlow>
      <div className={styles.empty}>
        <div className={styles.illustration}>
          <Workflow size={34} strokeWidth={1.25} />
        </div>
        <span className="eyebrow">ROOM FOR YOUR NEXT IDEA</span>
        <h2>Your workspace starts here</h2>
        <p>
          A canvas for your agents and the ways they work together.
          <br />
          Agent editing and connections are coming next.
        </p>
        <span className={styles.emptyTag}>An open canvas. A fresh start.</span>
      </div>
    </div>
  );
}

export function Flowboard({ workspaceId }: { workspaceId: string }) {
  return (
    <ReactFlowProvider key={workspaceId}>
      <Board workspaceId={workspaceId} />
    </ReactFlowProvider>
  );
}
