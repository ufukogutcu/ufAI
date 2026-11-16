// Only application-owned built-ins may supply capabilities/defaults.
export const browserSkillId = "builtin-browser";
export const defaultSkillEnabled = (id: string) => id === browserSkillId;
export const effectiveSkillEnabledSql = (skillId: string, override: string) =>
  `coalesce(${override}, CASE WHEN ${skillId}='${browserSkillId}' THEN 1 ELSE 0 END)`;
