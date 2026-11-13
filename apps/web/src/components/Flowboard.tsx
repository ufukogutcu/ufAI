import { useShallow } from "zustand/react/shallow";
import { PermissionEditor } from "./Messaging";
import messagingStyles from "./Messaging.module.scss";
import { useCallback, useEffect, useRef, useMemo } from "react";
import {
  MarkerType,
  type Connection,
  type Edge,
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  useNodesState,
  type Viewport,
} from "@xyflow/react";
import { Minus, Plus, Scan, Workflow } from "lucide-react";
import {
  useAgents,
  useAgentStore,
  emptyNodes,
  emptyList,
  type WorkspaceFlowNode,
} from "../agent-store";
import { AgentPanel, AgentForm } from "./AgentPanel";
import { Dialog } from "./Dialog";
import { refreshOnFocus } from "../focus-refresh";
import { useNavigationGuard } from "../navigation-guard";
import { AgentNode, ClusterNode } from "./CanvasNodes";
import { ClusterPanel } from "./ClusterPanel";
import { dropCluster } from "../canvas-layout";
import { errorMessage } from "../api";
import { useSettings } from "../settings-store";
import { useDashboard } from "../store";
import { Tooltip } from "./Tooltip";
import styles from "./Flowboard.module.scss";
import { GlassMaterial } from "./GlassMaterial";
import { Appearance } from "./Appearance";

const nodeTypes = { agent: AgentNode, cluster: ClusterNode };
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
  const agentStore = useAgentStore();
  const savedNodes = useAgents((s) => s.nodes[workspaceId] ?? emptyNodes);
  const links=useAgents(s=>s.communication[workspaceId]?.links ?? emptyList);
  const editor=useAgents(s=>s.communicationEditor);
  const edgeNames=useAgents(useShallow(s=>Object.fromEntries(links.map(link=>[link.id,`Allow ${s.agents[link.sourceAgentId]?.name ?? "agent"} to contact ${s.agents[link.targetAgentId]?.name ?? "agent"}`]))));
  const edges=useMemo<Edge[]>(()=>links.map(link=>({id:link.id,source:link.sourceAgentId,target:link.targetAgentId,sourceHandle:"out",targetHandle:"in",className:editor?.linkId===link.id?messagingStyles.selected:messagingStyles.edge,markerEnd:{type:MarkerType.ArrowClosed,color:"var(--communication-edge)"},ariaLabel:edgeNames[link.id]})),[links,editor?.linkId,edgeNames]);
  const connect=useCallback((connection:Connection)=>{
    if(connection.source && connection.target) void agentStore.getState().createCommunicationLink(workspaceId,connection.source,connection.target).catch(e=>agentStore.setState({positionError:errorMessage(e)}));
  },[agentStore,workspaceId]);
  const selectedId = useAgents((s) => s.selected[workspaceId]);
  const selected = useAgents((s) =>
    selectedId ? s.agents[selectedId] : undefined,
  );
  const createOpen = useAgents((s) => s.createIn === workspaceId);
  const [nodes, setNodes, onNodesChange] =
    useNodesState<WorkspaceFlowNode>(savedNodes);
  const dragging = useRef(0);
  const canvasInteracting = useAgents((s) => s.canvasInteracting);
  const guard = useNavigationGuard();
  const root = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  useEffect(
    () => () => {
      agentStore.setState((s) => ({
        canvasInteracting: false,
        dropTarget: null,
        canvasGeneration: s.canvasGeneration + 1,
      }));
    },
    [agentStore],
  );
  useEffect(() => {
    if (!dragging.current && !canvasInteracting) setNodes(savedNodes);
  }, [savedNodes, setNodes, canvasInteracting]);
  useEffect(() => {
    void agentStore.getState().loadWorkspace(workspaceId);
    let closed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      pending = false;
    const refresh = () => {
      if (closed || pending) return;
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        if (closed) return;
        void (async () => {
          await agentStore.getState().loadWorkspace(workspaceId);
          await agentStore.getState().loadCommunication(workspaceId);
          const id = agentStore.getState().selected[workspaceId];
          if (id) await agentStore.getState().refreshAgent(id);
          if (!closed)
            agentStore.setState((s) => ({ eventVersion: s.eventVersion + 1 }));
        })();
      }, 350);
    };
    const events = new EventSource(
      `/api/events?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    events.addEventListener("change", refresh);
    events.addEventListener("resync", refresh);
    events.onopen = () => {
      agentStore.setState({ connected: true });
      refresh();
    };
    events.onerror = () => agentStore.setState({ connected: false });
    const unfocus = refreshOnFocus(async () => {
      refresh();
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      events.close();
      unfocus();
    };
  }, [agentStore, workspaceId]);
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: WorkspaceFlowNode) => {
      if (node.type === "agent")
        guard(() => agentStore.getState().select(workspaceId, node.id));
    },
    [agentStore, workspaceId, guard],
  );
  const absolutePosition = useCallback(
    (node: WorkspaceFlowNode) => {
      const parent = node.parentId
        ? agentStore.getState().clusters[node.parentId]
        : undefined;
      return {
        x: node.position.x + (parent?.x ?? 0),
        y: node.position.y + (parent?.y ?? 0),
      };
    },
    [agentStore],
  );
  const handleNodeDrag = useCallback(
    (_event: MouseEvent | TouchEvent, node: WorkspaceFlowNode) => {
      if (node.type !== "agent") return;
      const p = absolutePosition(node),
        groups = Object.values(agentStore.getState().clusters).filter(
          (c) => c.workspaceId === workspaceId,
        );
      const target = dropCluster(groups, p.x, p.y);
      if (agentStore.getState().dropTarget !== target)
        agentStore.setState({ dropTarget: target });
    },
    [absolutePosition, agentStore, workspaceId],
  );
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: WorkspaceFlowNode) => {
      const generation = dragging.current;
      const p = absolutePosition(node),
        state = agentStore.getState();
      const action =
        node.type === "cluster"
          ? state.updateCluster(node.id, {
              x: node.position.x,
              y: node.position.y,
            })
          : state.moveAgent(
              node.id,
              p.x,
              p.y,
              dropCluster(
                Object.values(state.clusters).filter(
                  (c) => c.workspaceId === workspaceId,
                ),
                p.x,
                p.y,
              ),
            );
      void action
        .catch((e) => agentStore.setState({ positionError: errorMessage(e) }))
        .finally(() => {
          if (dragging.current === generation) dragging.current = 0;
          if (agentStore.getState().canvasGeneration !== generation) return;
          agentStore.getState().endCanvasInteraction(generation);
          setNodes(agentStore.getState().nodes[workspaceId] ?? emptyNodes);
        });
    },
    [agentStore, absolutePosition, workspaceId, setNodes],
  );
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
  const clusterPosition = useMemo(
    () => ({
      x: (-viewport!.x + 240) / viewport!.zoom,
      y: (-viewport!.y + 240) / viewport!.zoom,
    }),
    [viewport],
  );
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
    <div className={styles.board} ref={root}>
      <ReactFlow
        defaultViewport={viewport ?? defaultViewport}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        minZoom={0.25}
        maxZoom={2}
        colorMode={mode}
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStart={() => {
          dragging.current = agentStore.getState().beginCanvasInteraction();
        }}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        nodesDraggable
        nodesFocusable={false}
        nodesConnectable
        edgesFocusable
        edges={edges}
        onConnect={connect}
        onEdgeClick={(_event,edge)=>agentStore.setState({communicationEditor:{workspaceId,linkId:edge.id}})}
        onEdgeDoubleClick={(_event,edge)=>agentStore.setState({communicationEditor:{workspaceId,linkId:edge.id}})}
        elementsSelectable
        deleteKeyCode={null}
        autoPanOnNodeFocus
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
      {!savedNodes.length && (
        <Appearance>
          <div className={styles.empty}>
            <div className={styles.illustration} aria-hidden="true">
              <Workflow size={34} strokeWidth={1.25} />
            </div>
            <h2>Your workspace starts here</h2>
            <p>A canvas for your agents and the ways they work together.</p>
            <p className={styles.comingSoon}>
              Use Add Agent beside the workspace title to start a conversation.
            </p>
          </div>
        </Appearance>
      )}
      {editor?.workspaceId===workspaceId&&<PermissionEditor key={`${editor.linkId??editor.sourceAgentId??"new"}`} workspaceId={workspaceId}/>}
      <ClusterPanel workspaceId={workspaceId} position={clusterPosition} />
      {selected && (
        <AgentPanel
          key={selected.id}
          agent={selected}
          onClose={() => agentStore.getState().select(workspaceId, null)}
        />
      )}
      {createOpen && (
        <Dialog
          title="New agent"
          onClose={() => guard(() => agentStore.setState({ createIn: null }))}
        >
          <AgentForm
            onSave={async (values) => {
              const bounds = root.current!.getBoundingClientRect();
              const position = screenToFlowPosition({
                x: bounds.left + bounds.width * 0.45,
                y: bounds.top + bounds.height * 0.5,
              });
              await agentStore
                .getState()
                .create(workspaceId, { ...values, ...position });
            }}
          />
        </Dialog>
      )}
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
        <Appearance kind="fade">
          <div className="errorBanner" role="alert">
            {error}{" "}
            <button className="textButton" onClick={handleRetry}>
              Retry
            </button>
          </div>
        </Appearance>
      )}
      {viewport ? (
        <ReactFlowProvider key={workspaceId}>
          <Board workspaceId={workspaceId} />
        </ReactFlowProvider>
      ) : (
        <Appearance>
          <div className="centerState" role="status">
            {error ? "Canvas could not load." : "Loading canvas…"}
          </div>
        </Appearance>
      )}
    </>
  );
}
