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
  kind: "secret" | "text" | "single_choice" | "multi_select" | "form";
  definition?: InputDefinition;
  answer?: InputAnswer | null;
  taskTitle?: string;
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

export interface InputOption { id: string; label: string; description?: string }
export type InputValue = string | number | boolean | { selected: string[]; other?: string };
export type InputAnswer = InputValue | Record<string, InputValue>;
export interface InputDefinition {
  fields?: InputField[];
  options?: InputOption[];
  allowOther?: boolean;
  default?: InputValue;
  minLength?: number;
  maxLength?: number;
  minSelections?: number;
  maxSelections?: number;
}
export interface InputField extends Omit<InputDefinition, "fields"> {
  id: string;
  label: string;
  description?: string;
  type: "text" | "single_choice" | "multi_select" | "boolean" | "number" | "integer" | "email" | "url" | "date" | "date_time";
  required?: boolean;
  minimum?: number;
  maximum?: number;
}
