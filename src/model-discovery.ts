export type AccountModel = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
};

export type ClaudeModel = {
  id: string;
  name: string;
  shortName: string;
  family: string;
  section: string;
  defaultEffort?: string;
  supportedEfforts: string[];
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, unknown>;
    return text(record.reasoningEffort) || text(record.effort);
  }).filter(Boolean);
}

export function parseModelServicePage(data: unknown): AccountModel[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): AccountModel[] => {
    if (!item || typeof item !== 'object') return [];
    const model = item as Record<string, unknown>;
    const id = text(model.model) || text(model.id);
    if (!id) return [];
    return [{
      id,
      displayName: text(model.displayName) || id,
      isDefault: model.isDefault === true,
      defaultReasoningEffort: text(model.defaultReasoningEffort) || undefined,
      supportedReasoningEfforts: reasoningEfforts(model.supportedReasoningEfforts)
    }];
  });
}

export function parseClaudeModelCatalog(raw: string): ClaudeModel[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const catalog = (parsed as Record<string, unknown>).catalog;
  if (!catalog || typeof catalog !== 'object') return [];
  const config = (catalog as Record<string, unknown>).config;
  if (!config || typeof config !== 'object') return [];
  const models = (config as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item): ClaudeModel[] => {
    if (!item || typeof item !== 'object') return [];
    const model = item as Record<string, unknown>;
    const runtime = model.runtime && typeof model.runtime === 'object'
      ? model.runtime as Record<string, unknown>
      : {};
    const id = text(model.id);
    if (!id) return [];
    return [{
      id,
      name: text(model.name) || id,
      shortName: text(model.short_name) || text(model.name) || id,
      family: text(runtime.family),
      section: text(model.section),
      defaultEffort: text(runtime.default_effort) || undefined,
      supportedEfforts: reasoningEfforts(runtime.effort_levels)
    }];
  });
}
