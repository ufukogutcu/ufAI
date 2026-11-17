/** Public metadata only. Secret values never belong in these read contracts. */
export interface VaultSecret {
  id: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface UserInputRequest {
  id: string;
  kind: "secret";
  workspaceId: string;
  agentId: string;
  taskId: string;
  name: string;
  purpose: string;
  secretId: string | null;
  expectedRevision: number | null;
  state: "pending" | "fulfilled" | "declined" | "cancelled";
  createdAt: string;
  updatedAt: string;
}
