import { createHash } from 'node:crypto';

export type RequirementKind = 'behavior' | 'constraint' | 'technology' | 'tooling' | 'milestone' | 'acceptance';

export type RequirementItem = {
  id: string;
  text: string;
  source: string;
  kind: RequirementKind;
  required: boolean;
  owningPhase: string;
};

export type LockedCorrection = {
  id: string;
  text: string;
  source: string;
};

export type RequirementsBaseline = {
  version: 2;
  scope: string;
  requirements: RequirementItem[];
  lockedCorrections: LockedCorrection[];
  approvedTechnologies: string[];
  packageManager: string;
  requiredMilestones: string[];
  deferred: string[];
};

export type PlanCoverage = {
  baselineDigest: string;
  coveredRequirementIds: string[];
  approvedTechnologies: string[];
  packageManager: string;
  requiredMilestones: string[];
};

export type PreservationReport = {
  passed: boolean;
  failures: string[];
  warnings: string[];
  coverage?: PlanCoverage;
};

const baselineSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string' },
    requirements: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: 500 },
          source: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: ['behavior', 'constraint', 'technology', 'tooling', 'milestone', 'acceptance'] },
          required: { type: 'boolean' },
          owningPhase: { type: 'string', maxLength: 100 }
        },
        required: ['text', 'source', 'kind', 'required', 'owningPhase']
      }
    },
    approvedTechnologies: { type: 'array', maxItems: 20, items: { type: 'string' } },
    packageManager: { type: 'string' },
    requiredMilestones: { type: 'array', maxItems: 40, items: { type: 'string' } },
    deferred: { type: 'array', maxItems: 40, items: { type: 'string' } }
  },
  required: ['scope', 'requirements', 'approvedTechnologies', 'packageManager', 'requiredMilestones', 'deferred']
} as const;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).map(item => item.trim()).filter(Boolean))] : [];
}

export function normalizeBaseline(value: unknown): RequirementsBaseline {
  if (!value || typeof value !== 'object') throw new Error('Ollama did not return a requirements object.');
  const raw = value as Record<string, unknown>;
  const extractedRequirements = Array.isArray(raw.requirements) ? raw.requirements.flatMap((value, index): RequirementItem[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const text = String(item.text ?? '').trim();
    const source = String(item.source ?? '').trim();
    const kind = String(item.kind ?? 'constraint') as RequirementKind;
    if (!text || !source || !['behavior', 'constraint', 'technology', 'tooling', 'milestone', 'acceptance'].includes(kind)) return [];
    return [{ id: `REQ-${String(index + 1).padStart(3, '0')}`, text, source, kind, required: item.required !== false, owningPhase: String(item.owningPhase ?? '').trim() }];
  }) : [];
  if (!extractedRequirements.length) throw new Error('Ollama did not extract any usable requirements.');
  const seenRequirements = new Set<string>();
  const requirements = extractedRequirements.filter(item => {
    const key = `${item.text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}|${item.source.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seenRequirements.has(key)) return false;
    seenRequirements.add(key);
    return true;
  });
  const duplicateCount = extractedRequirements.length - requirements.length;
  if (extractedRequirements.length >= 10 && duplicateCount / extractedRequirements.length >= 0.15) {
    throw new Error(`Ollama padded the baseline with ${duplicateCount} duplicate requirement rows. Regenerate a concise candidate without repeated provider behaviors.`);
  }
  const lockedCorrections = Array.isArray(raw.lockedCorrections) ? raw.lockedCorrections.flatMap((value, index): LockedCorrection[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const text = String(item.text ?? '').trim();
    if (!text) return [];
    return [{
      id: String(item.id ?? `LOCK-${String(index + 1).padStart(3, '0')}`).trim(),
      text,
      source: String(item.source ?? 'Human correction').trim() || 'Human correction'
    }];
  }) : [];
  if (requirements.length > 80) {
    throw new Error(`Ollama returned ${requirements.length} unique requirements, exceeding the 80-item safety limit. Narrow the current phase or correct the baseline instead of silently dropping requirements.`);
  }
  return {
    version: 2,
    scope: String(raw.scope ?? '').trim() || 'Approved requirements for the current planning scope.',
    requirements,
    lockedCorrections,
    approvedTechnologies: strings(raw.approvedTechnologies),
    packageManager: String(raw.packageManager ?? '').trim(),
    requiredMilestones: strings(raw.requiredMilestones),
    deferred: strings(raw.deferred)
  };
}

const comparisonStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is',
  'it', 'its', 'must', 'of', 'on', 'or', 'remain', 'required', 'that', 'the', 'their', 'this', 'to',
  'use', 'used', 'using', 'when', 'where', 'with'
]);

function requirementPolarity(value: string): string {
  const normalized = value.toLocaleLowerCase();
  const negative = /\b(?:(?:do|does|did|must|may|shall|should|will|can|is|are|was|were)\s+not|cannot|can't|never|no|without|exclude|prohibit|forbid)\b/.test(normalized);
  const exclusive = /\b(?:only|solely|exclusively)\b/.test(normalized);
  return `${negative ? 'negative' : 'positive'}:${exclusive ? 'exclusive' : 'nonexclusive'}`;
}

function requirementClauses(value: string): Array<{ negative: boolean; tokens: Set<string> }> {
  return value.toLocaleLowerCase().split(/(?:[.;]|\b(?:and|or|but|while|whereas)\s+(?=(?:must|shall|should|may|will|can|do|does|is|are)\b))/)
    .map(clause => clause.trim())
    .filter(Boolean)
    .map(clause => ({
      negative: /\b(?:(?:do|does|did|must|may|shall|should|will|can|is|are|was|were)\s+not|cannot|can't|never|no|without|exclude|prohibit|forbid)\b/.test(clause),
      tokens: new Set(clause.replace(/\b(?:do|does|did|must|may|shall|should|will|can|is|are|was|were|not|cannot|can't|never|no|without|only|solely|exclusively)\b/g, ' ')
        .replace(/[^a-z0-9@._/-]+/g, ' ')
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token.length > 2 && !comparisonStopWords.has(token)))
    }));
}

function hasOpposingClause(left: string, right: string): boolean {
  for (const a of requirementClauses(left)) {
    for (const b of requirementClauses(right)) {
      if (a.negative === b.negative || !a.tokens.size || !b.tokens.size) continue;
      const overlap = [...a.tokens].filter(token => b.tokens.has(token)).length / Math.min(a.tokens.size, b.tokens.size);
      if (overlap >= 0.6) return true;
    }
  }
  return false;
}

function comparisonTokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !comparisonStopWords.has(token)));
}

function requirementSimilarity(left: string, right: string): number {
  if (requirementPolarity(left) !== requirementPolarity(right) || hasOpposingClause(left, right)) return 0;
  const a = comparisonTokens(left);
  const b = comparisonTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return Math.max(intersection / a.size, intersection / b.size);
}

function mergeSimilarStrings(current: string[], previous: string[]): string[] {
  const merged = [...current];
  for (const item of previous) {
    if (!merged.some(candidate => requirementSimilarity(item, candidate) >= 0.72)) merged.push(item);
  }
  return [...new Set(merged.map(item => item.trim()).filter(Boolean))];
}

function technologyKey(value: string): string {
  return value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9.+-]*/)?.[0] ?? value.toLocaleLowerCase();
}

export function reconcileRequirementsBaseline(
  previous: RequirementsBaseline | undefined,
  candidate: RequirementsBaseline,
  corrections: Array<{ createdAt?: string; text: string }>
): { baseline: RequirementsBaseline; preservedRequirements: number } {
  const correctionTexts = [...new Set(corrections.map(item => item.text.trim()).filter(Boolean))];
  const lockedCorrections: LockedCorrection[] = correctionTexts.map((text, index) => ({
    id: `LOCK-${String(index + 1).padStart(3, '0')}`,
    text,
    source: corrections.find(item => item.text.trim() === text)?.createdAt
      ? `Human correction recorded ${corrections.find(item => item.text.trim() === text)!.createdAt}`
      : 'Human correction'
  }));

  const negatedAlternatives = [...cumulativeNegatedAlternatives(correctionTexts)];
  const contradictsLockedCorrection = (text: string) => negatedAlternatives.some(term => {
    if (!new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text)) return false;
    return !new RegExp(`(?:do not|must not|no|never|exclude|without)[^.!?\\n]{0,60}\\b${escapeRegExp(term)}\\b`, 'i').test(text);
  });

  const requirements = candidate.requirements.filter(item => !contradictsLockedCorrection(item.text));
  let preservedRequirements = 0;
  for (const prior of previous?.requirements ?? []) {
    if (contradictsLockedCorrection(prior.text)) continue;
    const covered = requirements.some(item => requirementSimilarity(prior.text, item.text) >= 0.50);
    if (!covered) {
      requirements.push({ ...prior, source: `${prior.source} (preserved from prior baseline)` });
      preservedRequirements += 1;
    }
  }

  if (requirements.length > 80) {
    throw new Error(`Reconciliation produced ${requirements.length} requirements, exceeding the 80-item safety limit. The prior baseline was preserved; narrow or correct the candidate rather than silently dropping requirements.`);
  }
  const renumbered = requirements.map((item, index) => ({
    ...item,
    id: `REQ-${String(index + 1).padStart(3, '0')}`
  }));
  const technologies = new Map<string, string>();
  for (const item of previous?.approvedTechnologies ?? []) if (!contradictsLockedCorrection(item)) technologies.set(technologyKey(item), item);
  for (const item of candidate.approvedTechnologies) if (!contradictsLockedCorrection(item)) technologies.set(technologyKey(item), item);

  let packageManager = candidate.packageManager.trim() || previous?.packageManager.trim() || '';
  const cumulativeCorrections = correctionTexts.join('\n');
  const pinnedPackageManager = /\b(pnpm@[0-9]+(?:\.[0-9]+){1,2})\b/i.exec(cumulativeCorrections)?.[1];
  if (pinnedPackageManager) packageManager = pinnedPackageManager.toLocaleLowerCase();
  if (/\bmailpit\b/i.test(cumulativeCorrections)) technologies.set('mailpit', 'Mailpit');
  if (/\bvercel\b/i.test(cumulativeCorrections) && /provisional|later phase/i.test(cumulativeCorrections)) {
    technologies.set('vercel', 'Vercel (provisionally adopted for later phases; current phase remains local only)');
  }

  return {
    baseline: {
      version: 2,
      scope: candidate.scope || previous?.scope || 'Approved requirements for the current planning scope.',
      requirements: renumbered,
      lockedCorrections,
      approvedTechnologies: [...technologies.values()],
      packageManager,
      requiredMilestones: mergeSimilarStrings(
        candidate.requiredMilestones.filter(item => !contradictsLockedCorrection(item)),
        (previous?.requiredMilestones ?? []).filter(item => !contradictsLockedCorrection(item))
      ),
      deferred: mergeSimilarStrings(candidate.deferred, previous?.deferred ?? [])
    },
    preservedRequirements
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cumulativeNegatedAlternatives(corrections: string[]): Set<string> {
  const terms = new Set<string>();
  for (const correction of corrections) {
    for (const match of correction.matchAll(/(?:do not allow|must not use|never use|exclude)\s+([A-Za-z0-9@._/-]+)/gi)) {
      if (match[1]) terms.add(match[1]);
    }
  }
  return terms;
}

export function baselineDigest(baseline: RequirementsBaseline): string {
  return createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
}

export async function listOllamaModels(signal?: AbortSignal): Promise<string[]> {
  let response: Response;
  try { response = await fetch('http://127.0.0.1:11434/api/tags', { signal }); }
  catch { throw new Error('The Ollama endpoint at 127.0.0.1:11434 could not be reached from the VS Code extension host. Confirm the Ollama app and service are available, then refresh local models.'); }
  if (!response.ok) throw new Error(`Ollama model discovery failed with status ${response.status}.`);
  const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  return [...new Set((body.models ?? []).map(item => String(item.name ?? item.model ?? '').trim()).filter(Boolean))];
}

async function verifyOllamaReady(model: string, signal?: AbortSignal): Promise<void> {
  let models: string[];
  try { models = await listOllamaModels(signal); }
  catch (error) {
    throw new Error(`The VS Code extension could not reach Ollama at 127.0.0.1:11434. This checks extension-to-Ollama connectivity; it does not prove that the Ollama app is closed.${error instanceof Error && error.message ? ` Details: ${error.message}` : ''}`);
  }
  if (!models.includes(model.trim())) {
    throw new Error(`Ollama is reachable, but the selected model “${model.trim()}” is not installed. Refresh local models and choose one of: ${models.join(', ') || '(none installed)'}.`);
  }
}

export function parseGeneratedJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  try { return JSON.parse(trimmed); } catch { /* Try common local-model wrappers below. */ }
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try { return JSON.parse(match[1].trim()); } catch { /* Try the next fence or balanced object. */ }
  }
  const start = trimmed.indexOf('{');
  if (start < 0) return;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { return; }
      }
    }
  }
  return;
}

async function generateRequirementsJson(model: string, prompt: string, signal: AbortSignal | undefined, numPredict: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: model.trim(), prompt, stream: false, think: false, format: baselineSchema, options: { temperature: 0, num_predict: numPredict }, keep_alive: '5m' })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Ollama was reachable before generation started, but the model connection ended while it was running. This is a generation timeout, cancellation, or runner failure—not evidence that the Ollama app was closed. The saved baseline was not changed.${error instanceof Error && error.message ? ` Details: ${error.message}` : ''}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Ollama requirements extraction stopped with status ${response.status}${response.status === 500 ? ' after the local runner failed or reached its time limit' : ''}. The saved baseline was not changed.${detail ? ` Details: ${detail}` : ''}`);
  }
  const body = await response.json() as { response?: string };
  if (!body.response) throw new Error('Ollama returned no requirements output.');
  return body.response;
}

export async function extractRequirements(model: string, source: string, signal?: AbortSignal): Promise<RequirementsBaseline> {
  if (!model.trim()) throw new Error('Choose an installed Ollama model for requirements extraction.');
  await verifyOllamaReady(model, signal);
  const prompt = `Extract a conservative requirements baseline for the CURRENT planning scope from the approved source below.

Rules:
- Preserve explicit requirements, accepted technologies, tooling decisions, milestones, acceptance conditions, and deferrals.
- Include only requirements that apply to the current scope. Record later-phase items under deferred instead of importing them.
- Treat explicit human decisions and the workflow's locked-decision ledger as authoritative. When an option has been selected, record the selected choice rather than the former alternatives.
- Split independently verifiable acceptance outcomes into separate requirement items. Do not bundle unrelated commands, security boundaries, UI behavior, and worktree checks into one catch-all requirement.
- Do not repeat deferred work as optional requirements. Put it only in deferred.
- When the source names an exact package manager or selected boundary, preserve that exact decision.
- Replace uncertain alternatives such as “A or B unverified” with the source's confirmed choice. If no choice exists, record the required observable decision or acceptance test without guessing.
- Do not invent improvements, architecture, evidence systems, or approval criteria.
- Source must identify the source heading, requirement label, or a short distinctive phrase.
- owningPhase is blank when the source does not assign one.
- packageManager is blank when none is approved.
- This is extraction only. Do not judge readiness or approve a plan.
- Use only as many concise requirement items as the approved scope requires, up to 80. Never pad the list, repeat a provider behavior, or invent opposite outcomes to reach a count. Return only the JSON object required by the supplied schema, with no Markdown fence or commentary.

APPROVED SOURCE:
${source.slice(0, 180_000)}`;
  const firstOutput = await generateRequirementsJson(model, prompt, signal, 10_000);
  let parsed = parseGeneratedJson(firstOutput);
  let firstFailure = parsed === undefined ? 'The candidate was not parseable JSON.' : '';
  if (parsed !== undefined) {
    try { return normalizeBaseline(parsed); }
    catch (error) { firstFailure = error instanceof Error ? error.message : String(error); }
  }
  const repairPrompt = `The prior local extraction failed deterministic validation: ${firstFailure}\n\nConvert the candidate below into one valid JSON object matching the supplied schema. Preserve every supported current-scope requirement, milestone, entry decision, exit decision, acceptance item, and deferral. Use only as many rows as needed, up to 80. Remove duplicates and contradictions; never pad the list. Return JSON only with no commentary or Markdown fences.\n\nCANDIDATE OUTPUT:\n${firstOutput.slice(0, 100_000)}`;
  const repairedOutput = await generateRequirementsJson(model, repairPrompt, signal, 12_000);
  parsed = parseGeneratedJson(repairedOutput);
  if (parsed === undefined) throw new Error('Ollama returned requirements that were not valid JSON after one automatic local repair attempt. The saved baseline was not changed.');
  try { return normalizeBaseline(parsed); }
  catch (error) { throw new Error(`Ollama returned a baseline that still failed deterministic quality checks after one automatic local repair attempt. The saved baseline was not changed. ${error instanceof Error ? error.message : String(error)}`); }
}

export async function createLocalWorkStarter(
  model: string,
  mode: 'planning' | 'implementation',
  source: string,
  signal?: AbortSignal
): Promise<string> {
  if (!model.trim()) throw new Error('Choose an installed Ollama model before enabling a local work starter.');
  await verifyOllamaReady(model, signal);
  const planningRules = `Create an advisory first planning draft or bounded revision packet. Map every proposed section to the supplied requirements and current phase. Preserve locked decisions and deferrals. Identify files and verification commands only when supported by the source. Do not approve readiness, invent requirements, expand later-phase work, or include review history. If a prior plan exists, describe exact canonical replacements instead of rewriting unrelated sections.`;
  const implementationRules = `Create an advisory implementation work packet for the approved plan. Identify the likely files, ordered edits, tests, and risky boundaries. Separate mechanical work from security, authentication, authorization, migration, concurrency, durability, or destructive work that must remain with the primary implementer. Do not claim that code was changed or tests ran. Do not invent requirements, commands, files, or acceptance evidence.`;
  const prompt = `You are the local first-pass assistant in a guarded software workflow.

${mode === 'planning' ? planningRules : implementationRules}

Return concise Markdown that another coding agent can use as a starting point. This output is advisory and cannot approve or complete the workflow.

SOURCE:
${source.slice(0, 150_000)}`;
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: model.trim(), prompt, stream: false, think: false, options: { temperature: 0, num_predict: 5_000 }, keep_alive: '5m' })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Ollama was reachable before the local ${mode} starter began, but the generation connection ended. The optional starter will be skipped and Claude can continue.${error instanceof Error && error.message ? ` Details: ${error.message}` : ''}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Ollama local ${mode} starter stopped with status ${response.status}.${detail ? ` Details: ${detail}` : ''}`);
  }
  const body = await response.json() as { response?: string };
  const text = String(body.response ?? '').trim();
  if (!text) throw new Error(`Ollama returned no local ${mode} starter.`);
  return text;
}

export function baselineMarkdown(baseline: RequirementsBaseline, digest = baselineDigest(baseline)): string {
  const rows = baseline.requirements.map(item => `| ${item.id} | ${item.kind} | ${item.required ? 'Required' : 'Optional'} | ${item.owningPhase || 'Current scope'} | ${item.text.replace(/\|/g, '\\|')} | ${item.source.replace(/\|/g, '\\|')} |`).join('\n');
  const locked = baseline.lockedCorrections.length
    ? baseline.lockedCorrections.map(item => `### ${item.id}\n\n${item.text}\n\n_Source: ${item.source}_`).join('\n\n')
    : 'None recorded.';
  return `# Requirements baseline\n\nStatus: Awaiting human approval\nDigest: \`${digest}\`\n\n${baseline.scope}\n\n## Locked human corrections\n\nThese instructions are cumulative and authoritative. If generated wording conflicts with a locked correction, the locked correction wins.\n\n${locked}\n\n## Extracted requirements\n\n| ID | Kind | Status | Owner | Requirement | Source |\n|---|---|---|---|---|---|\n${rows}\n\n## Approved technologies\n\n${baseline.approvedTechnologies.length ? baseline.approvedTechnologies.map(item => `- ${item}`).join('\n') : '- None explicitly selected'}\n\n## Package manager\n\n${baseline.packageManager || 'Not specified'}\n\n## Required milestones\n\n${baseline.requiredMilestones.length ? baseline.requiredMilestones.map(item => `- ${item}`).join('\n') : '- None explicitly named'}\n\n## Deferred\n\n${baseline.deferred.length ? baseline.deferred.map(item => `- ${item}`).join('\n') : '- None recorded'}\n`;
}

export function planContractInstructions(baseline: RequirementsBaseline, digest = baselineDigest(baseline)): string {
  const requiredIds = [...baseline.requirements.filter(item => item.required).map(item => item.id), ...baseline.lockedCorrections.map(item => item.id)];
  return `The human-approved requirements baseline below is immutable for this run. Preserve every required item and do not import deferred work. Locked human corrections are authoritative and override conflicting generated summaries. End the plan with exactly one fenced \`workflow-requirements\` JSON block using this shape:\n\n\`\`\`workflow-requirements\n{"baselineDigest":"${digest}","coveredRequirementIds":[${requiredIds.map(id => JSON.stringify(id)).join(',')}],"approvedTechnologies":${JSON.stringify(baseline.approvedTechnologies)},"packageManager":${JSON.stringify(baseline.packageManager)},"requiredMilestones":${JSON.stringify(baseline.requiredMilestones)}}\n\`\`\`\n\nThe block records preservation; it does not replace the plan's ordinary explanations and acceptance checks.\n\nApproved baseline:\n${JSON.stringify(baseline, null, 2)}`;
}

export function parsePlanCoverage(plan: string): PlanCoverage | undefined {
  const match = /```workflow-requirements\s*([\s\S]*?)```/i.exec(plan);
  if (!match) return;
  try {
    const raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
    return {
      baselineDigest: String(raw.baselineDigest ?? '').trim(),
      coveredRequirementIds: strings(raw.coveredRequirementIds),
      approvedTechnologies: strings(raw.approvedTechnologies),
      packageManager: String(raw.packageManager ?? '').trim(),
      requiredMilestones: strings(raw.requiredMilestones)
    };
  } catch { return; }
}

export function checkPlanPreservation(baseline: RequirementsBaseline, plan: string): PreservationReport {
  const coverage = parsePlanCoverage(plan);
  if (!coverage) return { passed: false, failures: ['The plan is missing a valid workflow-requirements JSON block.'], warnings: [] };
  const failures: string[] = [];
  const warnings: string[] = [];
  const digest = baselineDigest(baseline);
  if (coverage.baselineDigest !== digest) failures.push(`The plan references baseline digest ${coverage.baselineDigest || '(blank)'} instead of ${digest}.`);
  const required = [...baseline.requirements.filter(item => item.required).map(item => item.id), ...baseline.lockedCorrections.map(item => item.id)];
  const missing = required.filter(id => !coverage.coveredRequirementIds.includes(id));
  const knownIds = new Set([...baseline.requirements.map(item => item.id), ...baseline.lockedCorrections.map(item => item.id)]);
  const unknown = coverage.coveredRequirementIds.filter(id => !knownIds.has(id));
  if (missing.length) failures.push(`Required baseline IDs are missing from coverage: ${missing.join(', ')}.`);
  if (unknown.length) failures.push(`Coverage contains IDs that are not in the approved baseline: ${unknown.join(', ')}.`);
  const missingTechnologies = baseline.approvedTechnologies.filter(item => !coverage.approvedTechnologies.includes(item));
  const addedTechnologies = coverage.approvedTechnologies.filter(item => !baseline.approvedTechnologies.includes(item));
  if (missingTechnologies.length) failures.push(`Approved technologies were removed: ${missingTechnologies.join(', ')}.`);
  if (addedTechnologies.length) failures.push(`Unapproved technologies were added to the plan contract: ${addedTechnologies.join(', ')}.`);
  if (coverage.packageManager !== baseline.packageManager) failures.push(`Package manager changed from “${baseline.packageManager || 'not specified'}” to “${coverage.packageManager || 'not specified'}”.`);
  const missingMilestones = baseline.requiredMilestones.filter(item => !coverage.requiredMilestones.includes(item));
  if (missingMilestones.length) failures.push(`Required milestones were removed: ${missingMilestones.join(', ')}.`);
  if (baseline.packageManager) {
    const normalizedPackageManager = baseline.packageManager.trim().toLowerCase();
    const packageManagerFamily = ['npm', 'pnpm', 'yarn', 'bun'].find(item =>
      normalizedPackageManager === item || normalizedPackageManager.startsWith(`${item}@`)
    ) ?? normalizedPackageManager;
    const alternatives = ['npm', 'pnpm', 'yarn', 'bun'].filter(item => item !== packageManagerFamily);
    const conflicting = alternatives.filter(item => new RegExp(`(?:^|[\\s\`])${item}\\s+(?:install|add|run|test|build|lint|exec)\\b`, 'im').test(plan));
    if (conflicting.length) failures.push(`Plan commands use a different package manager: ${conflicting.join(', ')}.`);
  }
  if (coverage.coveredRequirementIds.length !== new Set(coverage.coveredRequirementIds).size) warnings.push('The coverage block repeats one or more requirement IDs.');
  return { passed: failures.length === 0, failures, warnings, coverage };
}

export function preservationMarkdown(report: PreservationReport, round: number): string {
  return `# Requirements preservation check — planning round ${round}\n\nResult: **${report.passed ? 'PASS' : 'FAIL'}**\n\n## Failures\n\n${report.failures.length ? report.failures.map(item => `- ${item}`).join('\n') : '- None'}\n\n## Warnings\n\n${report.warnings.length ? report.warnings.map(item => `- ${item}`).join('\n') : '- None'}\n`;
}
