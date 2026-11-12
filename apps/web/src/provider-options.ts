import type { ConnectionProvider, IntegrationKind } from "./api";
export const providerOptions: {
  id: ConnectionProvider;
  label: string;
  kind: IntegrationKind;
}[] = [
  { id: "openai", label: "OpenAI", kind: "provider" },
  { id: "anthropic", label: "Anthropic", kind: "provider" },
  { id: "google", label: "Google Gemini", kind: "provider" },
  { id: "openrouter", label: "OpenRouter", kind: "provider" },
  { id: "xai", label: "xAI", kind: "provider" },
  { id: "deepseek", label: "DeepSeek", kind: "provider" },
  { id: "mistral", label: "Mistral", kind: "provider" },
  { id: "groq", label: "Groq", kind: "provider" },
  { id: "together", label: "Together", kind: "provider" },
  {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    kind: "provider",
  },
  { id: "ollama", label: "Ollama", kind: "provider" },
  { id: "codex", label: "Codex", kind: "runtime" },
];
