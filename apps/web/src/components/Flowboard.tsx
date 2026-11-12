import { useCallback, useEffect, useRef } from "react";
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
import { useSettings } from "../settings-store";
import { useDashboard } from "../store";
import { Tooltip } from "./Tooltip";
import styles from "./Flowboard.module.scss";
import { GlassMaterial } from "./GlassMaterial";

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
    <Panel position="bottom-left" className={`${styles.controls} glassSurface`}>
      <GlassMaterial />
      <Tooltip content="Zoom out">
        <button
          className="iconButton"
          aria-label="Zoom out"
          disabled={zoom <= 0.25}
          onClick={handleZoomOut}
        >
          <Minus size={16} />
        </button>
      </Tooltip>
      <span>{Math.round(zoom * 100)}%</span>
      <Tooltip content="Zoom in">
        <button
          className="iconButton"
          aria-label="Zoom in"
          disabled={zoom >= 2}
          onClick={handleZoomIn}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <div className={styles.divider} />
      <Tooltip content="Reset view">
        <button
          className="iconButton"
          aria-label="Reset view"
          onClick={handleReset}
        >
          <Scan size={16} />
        </button>
      </Tooltip>
    </Panel>
  );
}

function Board({ workspaceId }: { workspaceId: string }) {
  const mode = useSettings((state) => state.snapshot.activeTheme.mode);
  const viewport = useDashboard((state) => state.viewports[workspaceId]);
  const saveViewport = useDashboard((state) => state.saveViewport);
  const beginInteraction = useDashboard(
    (state) => state.beginViewportInteraction,
  );
  const endInteraction = useDashboard((state) => state.endViewportInteraction);
  useEffect(
    () => () => endInteraction(workspaceId),
    [endInteraction, workspaceId],
  );
  const { setViewport, getViewport } = useReactFlow();
  const applying = useRef(false);
  useEffect(() => {
    if (!viewport) return;
    const current = getViewport();
    if (
      current.x === viewport.x &&
      current.y === viewport.y &&
      current.zoom === viewport.zoom
    )
      return;
    applying.current = true;
    void setViewport(viewport).finally(() => {
      applying.current = false;
    });
  }, [viewport, setViewport, getViewport]);
  const handleMoveStart = useCallback(() => {
    if (!applying.current) beginInteraction(workspaceId);
  }, [beginInteraction, workspaceId]);
  const handleMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, next: Viewport) => {
      if (!applying.current) void saveViewport(workspaceId, next);
    },
    [saveViewport, workspaceId],
  );
  return (
    <div className={styles.board}>
      <ReactFlow
        defaultViewport={viewport ?? defaultViewport}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        minZoom={0.25}
        maxZoom={2}
        colorMode={mode}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        aria-label="Workspace flowboard"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={0.8}
          color="var(--canvas-dots)"
        />
        <ViewControls />
        <Panel position="bottom-right" className={styles.hint}>
          Drag to pan <span>·</span> Scroll to zoom
        </Panel>
      </ReactFlow>
      <div className={styles.empty}>
        <div className={styles.illustration} aria-hidden="true">
          <Workflow size={34} strokeWidth={1.25} />
        </div>
        <h2>Your workspace starts here</h2>
        <p>
          A canvas for your agents and the ways they work together.
        </p>
        <p className={styles.comingSoon}>
          Agent editing and connections are coming next.
        </p>
      </div>
    </div>
  );
}

export function Flowboard({ workspaceId }: { workspaceId: string }) {
  const viewport = useDashboard((state) => state.viewports[workspaceId]);
  const error = useDashboard((state) => state.viewportErrors[workspaceId]);
  const load = useDashboard((state) => state.loadViewport);
  const retry = useDashboard((state) => state.retryViewport);
  useEffect(() => {
    void load(workspaceId);
  }, [load, workspaceId]);
  function handleRetry() {
    void retry(workspaceId);
  }
  return (
    <>
      {error && (
        <div className="errorBanner" role="alert">
          {error}{" "}
          <button className="textButton" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {viewport ? (
        <ReactFlowProvider key={workspaceId}>
          <Board workspaceId={workspaceId} />
        </ReactFlowProvider>
      ) : (
        <div className="centerState" role="status">
          {error ? "Canvas could not load." : "Loading canvas…"}
        </div>
      )}
    </>
  );
}
