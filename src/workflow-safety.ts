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

export function humanPrerequisiteProcedure(plan: string, prerequisiteText: string): string {
  if (!/\b(?:human|operator|interactive|observations?|account)\b/i.test(prerequisiteText)) return '';
  const start = /^##\s+(?:\d+[.)]?\s*)?Operator checklist\s*$/im.exec(plan);
  if (!start || start.index === undefined) return '';
  const remainder = plan.slice(start.index);
  const end = /^##\s+(?:\d+[.)]?\s*)?Decision rules(?:\s+and[^\n]*)?\s*$/im.exec(remainder);
  return remainder.slice(0, end?.index ?? remainder.length).trim().slice(0, 30_000);
}

export function humanPrerequisiteResponseTemplate(procedure: string): string {
  const itemLines = procedure.split('\n').map(line => line.replace(/[*_`]/g, ''));
  const namedItem = /^\s*(?:(?:#{1,6}|[-+])\s+|\d+[.)]\s+)?(O-\d+[A-Z0-9.-]*)(?=\s*[:—–-]|\s*$)/i;
  const identifiers = [...new Set(itemLines.flatMap(line => {
    const match = namedItem.exec(line);
    return match ? [match[1].toUpperCase()] : [];
  }))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  // Markdown allows every source marker to be "1."; each row still needs evidence.
  const numberedSteps = itemLines.filter(line => /^\s*\d+[.)]\s+\S/.test(line))
    .flatMap((line, index) => namedItem.test(line) ? [] : [String(index + 1)]);
  if (!identifiers.length && !numberedSteps.length) return '';
  const resultLines = [...identifiers.flatMap(identifier => {
    const normalized = identifier.toUpperCase();
    if (normalized === 'O-1') return ['O-1: PASS/FAIL/UNVERIFIED — documented support: ; effective create permission: ; functional: UNTESTED'];
    if (normalized === 'O-2') return ['O-2: PASS/FAIL/UNVERIFIED — documented support: ; write-tool permission: ; functional: UNTESTED'];
    if (normalized === 'O-6') return [
      'O-6 overall: PASS/FAIL/UNVERIFIED',
      ...'abcdefg'.split('').map(part => `O-6(${part}): PASS/FAIL/UNVERIFIED — observation:`),
    ];
    if (normalized === 'O-7') return [
      'O-7 overall: PASS/FAIL/UNVERIFIED — documented minimum Read + Use:',
      ...'abcd'.split('').map(part => `O-7(${part}): PASS/FAIL/UNVERIFIED/N/A — observation:`),
    ];
    return [`${normalized}: PASS/FAIL/UNVERIFIED — observation:`];
  }), ...numberedSteps.map(number => `Step ${number}: PASS/FAIL/UNVERIFIED — observation:`)];
  return [
    'Human prerequisite session',
    'Date:',
    'Account labels (no names, emails, IDs, or secrets): A=; W=; O=',
    '',
    ...resultLines,
    '',
    'Secrets or identifying values recorded: NO',
    'Unavailable evidence / responsible administrator or support role / precise next action:',
  ].join('\n');
}

export function validatePrerequisiteResults(procedure: string, submission: string): boolean {
  const template = humanPrerequisiteResponseTemplate(procedure);
  if (!template || !submission.trim() || hasUnresolvedAcceptanceTemplate(submission)) return false;
  const rows = template.split('\n').filter(line => /^(?:O-\d|Step \d+:)/.test(line));
  return rows.every(row => {
    const label = row.slice(0, row.indexOf(':'));
    const actual = submission.split('\n').find(line => line.trim().startsWith(`${label}:`));
    if (!actual) return false;
    const value = actual.slice(actual.indexOf(':') + 1).trim();
    if (!/^(?:PASS|FAIL|UNVERIFIED|N\/A)\b/.test(value)) return false;
    const fields = row.split(/—|;/).slice(1).map(field => field.trim()).filter(field => field.includes(':'));
    if (!fields.length) return true;
    return fields.every(field => {
      const key = field.slice(0, field.indexOf(':') + 1);
      const index = value.indexOf(key);
      return index >= 0 && Boolean(value.slice(index + key.length).split(';')[0].trim());
    });
  });
}

export function recordOwnerImplementationConsent(record: { ownerImplementationDecision?: 'pending' | 'approved'; pendingAfterPrerequisite?: string[] }, reply: string): void {
  if (record.ownerImplementationDecision !== 'approved' && (record.pendingAfterPrerequisite ?? []).some(item => /approv|authoriz/i.test(item) && /implement/i.test(item))) record.ownerImplementationDecision = 'pending';
  // Consent is an owner decision, never an orchestrator's resolution claim.
  if (/^I (?:approve|authorize) (?:feature |the )?implementation[.!]?$/i.test(reply.trim())) {
    record.ownerImplementationDecision = 'approved';
    record.pendingAfterPrerequisite = (record.pendingAfterPrerequisite ?? []).filter(item => !isImplementationApprovalItem(item));
  }
}

export function isImplementationApprovalItem(item: string): boolean {
  // Only a standalone implementation decision can be consumed by this consent.
  return /^(?:give (?:explicit )?(?:owner |human )?(?:approval|authorization) (?:before|for) (?:feature |the )?implementation|(?:approve|authorize) (?:feature |the )?implementation)[.!]?$/i.test(item.trim());
}

export function hasPendingOwnerApproval(record: { ownerImplementationDecision?: 'pending' | 'approved'; pendingAfterPrerequisite?: string[] }): boolean {
  return record.ownerImplementationDecision === 'pending' || (record.pendingAfterPrerequisite ?? []).some(item => /approv|authoriz/i.test(item) && /implement/i.test(item));
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
