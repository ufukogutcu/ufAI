import type { Compaction, ConnectionProvider } from "./contracts.js";

export interface TextMessage {
  role: "user" | "assistant";
  content: string;
}
export interface TextRequest {
  modelId: string;
  instructions: string;
  messages: TextMessage[];
  outputTokens: number;
  contextWindow: number;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
}
export interface TextResult {
  text: string;
  finishReason: string;
  usage: Record<string, number> | null;
}
export interface ExecutionSnapshot {
  presetId: string;
  connectionId: string;
  provider: ConnectionProvider;
  modelId: string;
  contextWindow: number;
  compaction: Compaction | null;
  instructions: string;
  agentRevision: number;
}
export interface ModelProviderAdapter {
  generate(request: TextRequest): Promise<TextResult>;
  countTokens?(request: TextRequest): Promise<number>;
}
export interface AgentRuntimeAdapter {
  executeText?(id: string, request: TextRequest): Promise<TextResult>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}
export interface ToolRound {
  text: string;
  calls: ToolCall[];
  continuation: unknown;
  usage: Record<string, number> | null;
}
export interface TaskRequest extends TextRequest {
  tools: ToolSpec[];
  maxRounds?: number;
  continuation?: unknown[];
  onTool: (call: ToolCall) => Promise<ToolResult>;
  onCommentary?: (text: string) => void;
}
