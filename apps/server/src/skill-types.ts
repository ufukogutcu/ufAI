/** Public skill contracts; browser consumers import these as types only. */
export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  "allowed-tools"?: string;
}
export interface SkillInput extends SkillMetadata {
  instructions: string;
}
export interface SkillSummary extends SkillMetadata {
  id: string;
  builtIn: boolean;
  revision: number;
  source: {
    kind: "builtin" | "editor" | "upload" | "url" | "local";
    location?: string;
  };
  enabled: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SkillDetail extends SkillSummary {
  instructions: string;
  path: string;
  files: { path: string; size: number }[];
  enabledAgents: { id: string; name: string; workspaceId: string }[];
}
export interface SkillInstallation {
  id: string;
  expiresAt: string;
  candidates: {
    key: string;
    name: string;
    description: string;
    existingId: string | null;
    identical: boolean;
    warnings: string[];
  }[];
}
export interface SkillPage {
  items: SkillSummary[];
  total: number;
  path: string;
}

export interface SkillActivation {
  skillId: string;
  revision: number;
  name: string;
  instructions: string;
  path: string;
}
