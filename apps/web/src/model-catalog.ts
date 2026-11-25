import type { ProviderModel } from "./api";

export function catalogSearch(query: string, maker: string | undefined) {
  const params = new URLSearchParams({ q: query });
  if (maker !== undefined) params.set("maker", maker);
  return params.toString();
}

export function makerLabel(maker?: string | null) {
  return maker || "Other models";
}

export function groupModels(models: ProviderModel[]) {
  const groups = new Map<string, { maker?: string; models: ProviderModel[] }>();
  for (const model of models) {
    // Match SQLite NOCASE, which folds ASCII letters.
    const key = model.maker?.replace(/[A-Z]/g, letter => letter.toLowerCase()) ?? "";
    const group = groups.get(key);
    if (group) group.models.push(model);
    else groups.set(key, { maker: model.maker, models: [model] });
  }
  return [...groups.values()];
}
