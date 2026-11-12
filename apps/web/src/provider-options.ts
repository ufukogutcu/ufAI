import type { ConnectionProvider, IntegrationKind } from "./api";
export const providerCategories = [
  { id: "api", label: "API" },
  { id: "subscription", label: "Subscription" },
  { id: "local", label: "Local" },
] as const;
export type ProviderCategory = (typeof providerCategories)[number]["id"];

export const providerOptions: {
  id: ConnectionProvider;
  label: string;
  kind: IntegrationKind;
  category: ProviderCategory;
}[] = [
  { id: "openai", label: "OpenAI", kind: "provider", category: "api" },
  { id: "anthropic", label: "Anthropic", kind: "provider", category: "api" },
  { id: "google", label: "Google Gemini", kind: "provider", category: "api" },
  { id: "openrouter", label: "OpenRouter", kind: "provider", category: "api" },
  { id: "xai", label: "xAI", kind: "provider", category: "api" },
  { id: "deepseek", label: "DeepSeek", kind: "provider", category: "api" },
  { id: "mistral", label: "Mistral", kind: "provider", category: "api" },
  { id: "groq", label: "Groq", kind: "provider", category: "api" },
  { id: "together", label: "Together", kind: "provider", category: "api" },
  {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    kind: "provider",
    category: "api",
  },
  { id: "ollama", label: "Ollama", kind: "provider", category: "local" },
  { id: "codex", label: "Codex", kind: "runtime", category: "subscription" },
];
