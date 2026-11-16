// Only application-owned built-ins may supply capabilities/defaults.
export const browserSkillId = "builtin-browser";
export const duckDuckGoSkillId = "builtin-duckduckgo-instant-answer";
const defaultEnabledSkillIds = [browserSkillId, duckDuckGoSkillId];
export const defaultSkillEnabled = (id: string) => defaultEnabledSkillIds.includes(id);
export const effectiveSkillEnabledSql = (skillId: string, override: string) =>
  `coalesce(${override}, CASE WHEN ${skillId} IN (${defaultEnabledSkillIds.map(id => `'${id}'`).join(",")}) THEN 1 ELSE 0 END)`;
