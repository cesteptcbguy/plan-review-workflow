export function hasUnresolvedAcceptanceTemplate(results: string): boolean {
  return /<(?:short hash|timestamp|port|value|result|details?|paths?|output|file count|test count|seconds|lower|upper|n|exact steps|clean\/output|none or)[^>]*>/i.test(results)
    || /\b(?:PASS\s*\/\s*FAIL|YES\s*\/\s*NO|shown\s*\/\s*hidden|enabled\s*\/\s*disabled|unchanged\s*\/\s*changed|may resume\s*\/\s*remains paused)\b/i.test(results);
}

export function acceptanceOutcome(results: string): 'pass' | 'fail' | 'unknown' {
  const text = results.trim().replace(/[*_`~]/g, '');
  if (hasUnresolvedAcceptanceTemplate(text)) return 'unknown';
  if (/(?:overall|acceptance|session|review|result|disposition)[^\n:]{0,60}:\s*(?:FAIL|FAILED)\b/im.test(text)) return 'fail';
  if (/\bFAIL(?:ED)?\s*:\s*[1-9][0-9]*\b/i.test(text)) return 'fail';
  if (/^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:(?:check|test|scenario|case)\s+)?[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,80}:\s*(?:FAIL|FAILED)\b/im.test(text)) return 'fail';
  if (/^\s*(?:[-*]\s*)?(?:FAIL|FAILED)\b(?:\s*[:—-]|\s*$)/im.test(text)) return 'fail';
  if (/^\s*\d+[.)]\s+(?:FAIL|FAILED)\b/im.test(text)) return 'fail';
  if (/^\s*(?:[-*]\s*)?(?:IDs?\s+failing|failed\s+checks?|failures?)\s*:\s*(?!0\b|none\b)[^\n]+/im.test(text)) return 'fail';
  if (/\|\s*(?:FAIL|FAILED)\s*\|/i.test(text)) return 'fail';
  if (/(?:overall|acceptance|session|review|result|disposition)[^\n:]{0,60}:\s*PASS(?:ED)?\b/im.test(text)) return 'pass';
  if (/\ball\s+(?:required\s+)?(?:acceptance\s+)?checks?\s+pass(?:ed)?\b/i.test(text)) return 'pass';
  return 'unknown';
}

export function completedAcceptanceNeedsReopen(results: string): boolean {
  return hasUnresolvedAcceptanceTemplate(results) || acceptanceOutcome(results) !== 'pass';
}

export function requiresExplicitImplementationApproval(record: { implementationRequiresHumanApproval?: boolean; remediationOfRunId?: string }): boolean {
  return record.implementationRequiresHumanApproval === true || Boolean(record.remediationOfRunId);
}

function recordOutcome(identifier: string, evidence: string): 'pass' | 'fail' | 'other' | 'missing' {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifierPattern = new RegExp(`(?:^|[^A-Z0-9.-])(${escaped})(?:$|[^A-Z0-9.-])`, 'i');
  const anyIdentifierPattern = /\b[A-Z]{1,6}[.-]?\d+[A-Z0-9.-]*\b/gi;
  const outcomes = evidence.split(/\r?\n/).flatMap(line => {
    const normalized = line.replace(/[*_`~]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = identifierPattern.exec(normalized);
    if (!target || target.index === undefined) return [];
    const targetStart = target.index + target[0].indexOf(target[1]);
    const identifiers = [...normalized.matchAll(anyIdentifierPattern)];
    const next = identifiers.find(match => (match.index ?? -1) > targetStart);
    const segment = normalized.slice(targetStart, next?.index ?? normalized.length);
    const outcome = /\b(NOT\s+RUN|SKIP(?:PED)?|PENDING|UNKNOWN|FAIL(?:ED)?|PASS(?:ED)?)\b/i.exec(segment)?.[1].toLocaleLowerCase();
    if (!outcome) return [];
    if (outcome.startsWith('pass')) return ['pass' as const];
    if (outcome.startsWith('fail')) return ['fail' as const];
    return ['other' as const];
  });
  if (!outcomes.length) return 'missing';
  if (outcomes.includes('fail')) return 'fail';
  if (outcomes.some(outcome => outcome !== 'pass')) return 'other';
  return 'pass';
}

export function siblingEvidenceSatisfiesProcedure(procedure: string, evidence: string, currentRevision = ''): boolean {
  if (!procedure || !evidence || acceptanceOutcome(evidence) === 'fail') return false;
  const identifiers = [...new Set(procedure.match(/\b[A-Z]{1,6}[.-]?\d+[A-Z0-9.-]*\b/g) ?? [])];
  const revision = currentRevision.trim();
  if (!/^[a-f0-9]{7,64}$/i.test(revision)) return false;
  const evidenceBlocks = evidence.split(/\n\s*---\s*\n/);
  const blockHasRevision = (block: string) => block.includes(revision) || block.includes(revision.slice(0, 12)) || block.includes(revision.slice(0, 7));
  return identifiers.length > 0 && identifiers.every(identifier => evidenceBlocks.some(block => blockHasRevision(block) && recordOutcome(identifier, block) === 'pass'));
}
