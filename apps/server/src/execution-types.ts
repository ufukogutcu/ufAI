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
