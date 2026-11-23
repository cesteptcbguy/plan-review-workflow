import * as vscode from 'vscode';
import { canAutoApplyFinalCanonicalCorrection, isCompletedPrerequisiteState, normalizePrerequisitePlanningDecision, planningCheckpointInteractionType } from './prerequisite-state';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import { homedir } from 'node:os';
import { MobileBridge, type MobileInfo, type MobileSettings, type MobileSnapshot } from './mobile';
import { baselineDigest, baselineMarkdown, checkPlanPreservation, createLocalWorkStarter, extractRequirements, listOllamaModels, normalizeBaseline, planContractInstructions, preservationMarkdown, reconcileRequirementsBaseline, type RequirementsBaseline } from './requirements';
import { waitForChildExit } from './process-lifecycle';
import { acceptanceOutcome, completedAcceptanceNeedsReopen, hasUnresolvedAcceptanceTemplate, requiresExplicitImplementationApproval, siblingEvidenceSatisfiesProcedure } from './workflow-safety';

type Provider = 'claude' | 'codex';
type Role = { provider: Provider; model: string; effort: string };
type ClaudeSessionPolicy = 'checkpoint' | 'continuous' | 'fresh';
type Preset = { name: string; planner: Role; reviewer: Role; orchestrator: Role; implementer: Role; codeReviewer: Role; claudeExploreModel: string; claudeSessionPolicy: ClaudeSessionPolicy; requirementsGuard: boolean; ollamaModel: string; localPlanningStarter: boolean; localImplementationStarter: boolean; secondarySolApproval: boolean; secondaryApprovalModel: string; secondaryDecisionDelegation: boolean; maxRounds: number; maxCodeRounds: number };
type Decision = 'REVISE' | 'ROADMAP_READY' | 'READY_TO_CODE' | 'PHASE_COMPLETE' | 'SPLIT' | 'WAITING_FOR_PREREQUISITE' | 'PREREQUISITE_COMPLETE' | 'NEEDS_HUMAN' | 'NEEDS_MORE_PLANNING' | 'STOP';
type ResumeStage = 'planning' | 'reviewing' | 'deciding';
type CodeDecision = 'FIX' | 'CODE_READY' | 'NEEDS_HUMAN' | 'NEEDS_MORE_CODE' | 'STOP';
type CodeResumeStage = 'implementing' | 'code_reviewing' | 'code_deciding';
type SplitPhase = { title: string; objective: string; dependsOn: string[] };
type Prerequisite = { title: string; reason: string; resumeWhen: string };
type PlanningFinding = { id: string; summary: string; source: string; severity: 'High' | 'Medium' | 'Low'; affectedPhase: string; canonicalLocation: string; closureCondition: string; status: 'open' | 'resolved' | 'deferred' };
type PlanningLedger = { objective: string; inScope: string[]; lockedDecisions: string[]; unresolvedFindings: string[]; deferred: string[]; findings?: PlanningFinding[] };
type GuidanceEntry = { createdAt: string; beforeRound: number; text: string; artifactPath: string };
type RoadmapAcceptance = { status: 'provisional'; acceptedAt: string; notes: string; artifactPath: string };
type RequirementsCorrection = { createdAt: string; text: string };
type RequirementsGuardState = { model: string; status: 'draft' | 'approved' | 'declined'; baselinePath: string; baselineMarkdownPath: string; digest: string; approvedAt?: string; declinedAt?: string; declineReason?: string; sourcePaths: string[]; corrections?: RequirementsCorrection[]; correctionsPath?: string; candidateHistoryPaths?: string[]; autoPreservedRequirements?: number; preservationFailures: number; architecturalReviews: number; finalCanonicalCorrectionUsed?: boolean; humanDirectedPasses?: number };
type DecisionResult = { decision: Decision; detail: string; plannerPrompt: string; phases: SplitPhase[]; prerequisite?: Prerequisite; planningLedger?: PlanningLedger; workflowName?: string };
type PlanningAuditRecommendation = 'TARGETED_REVISION' | 'READY' | 'NEEDS_HUMAN' | 'RETURN_TO_PARENT' | 'STOP';
type PlanningCheckpointAudit = { recommendation: PlanningAuditRecommendation; summary: string; confirmedFindings: string[]; rejectedFindings: string[]; plannerPrompt: string };
type SecondaryApprovalReview = { decision: 'APPROVE' | 'REVISE' | 'NEEDS_HUMAN'; summary: string; findings: string[]; correctionPrompt: string };
type DelegatedDecision = { decision: 'RESOLVED' | 'HUMAN_REQUIRED'; answer: string; rationale: string; nextInstruction: string };
type CodeDecisionResult = {
  decision: CodeDecision;
  detail: string;
  implementerPrompt: string;
  question: string;
  humanInstructions: string;
  expectedEvidence: string[];
  responseTemplate: string;
  humanAcceptanceRequired: boolean;
};
type RunRecord = { id: string; task: string; originalTask?: string; workflowName?: string; phasePath?: number[]; taskFilePath?: string; humanInput?: string; implementationApprovalGuidance?: string; implementationRequiresHumanApproval?: boolean; guidanceEntries?: GuidanceEntry[]; roadmapAcceptance?: RoadmapAcceptance; sourcePlanPath?: string; requirementsSourcePath?: string; requirementsGuard?: RequirementsGuardState; claudeSessions?: { planner?: string; plannerStartedRound?: number; implementer?: string; implementerStartedRound?: number }; parentRunId?: string; returnToRunFile?: string; splitPhaseIndex?: number; splitPhaseTitle?: string; completedPhaseIndexes?: number[]; finalPlanIndexPath?: string; baselinePlanPath?: string; workingDraftPath?: string; approvedPlanPath?: string; splitPhases?: SplitPhase[]; prerequisite?: Prerequisite; orchestratorDirection?: string; planningLedger?: PlanningLedger; remediationOfRunId?: string; supersededByRemediationRunId?: string; preset: Preset; stage: string; resumeStage?: ResumeStage; round: number; decision?: Decision; detail?: string; codeRound?: number; codeStage?: string; codeResumeStage?: CodeResumeStage; codeDecision?: CodeDecision; codeDetail?: string; codeDirection?: string; secondaryCodeApprovalStatus?: 'pending' | 'approved'; secondaryCodeApprovalRound?: number; verificationRetryCount?: number; additionalDirectories?: string[]; acceptanceStatus?: 'pending' | 'failed' | 'complete'; acceptanceInstructions?: string; pendingHumanActions?: string[]; acceptanceResponseTemplate?: string; acceptanceResultsPath?: string; files: string[] };
type ResumeContext = { runDir: string; record: RunRecord; stage: ResumeStage; round: number; plan?: string; review?: string; orchestratorDirection?: string };
type SplitContext = { runDir: string; record: RunRecord; phases: SplitPhase[]; plan?: string };
type CodeContext = { runDir: string; record: RunRecord; stage: CodeResumeStage; round: number; plan: string; implementation?: string; review?: string; direction?: string };
type Interaction = { type: 'needsInput' | 'codeNeedsInput' | 'acceptancePending' | 'prerequisitePending' | 'prerequisiteComplete' | 'childLimit' | 'failed' | 'morePlanning' | 'moreCode' | 'verificationRequired' | 'readyToCode' | 'codeReady' | 'requirementsApproval'; text: string; details?: string; responseTemplate?: string; finalCorrection?: boolean; requirementsGuardAttached?: boolean; requirementsGuardLimit?: boolean; canReopen?: boolean } | { type: 'nextPhase'; text: string; phase: SplitPhase; canReopen?: boolean } | { type: 'split'; text: string; phases: SplitPhase[]; roadmapReady?: boolean; roadmapAccepted?: boolean; roadmapNotes?: string };
type AccountModel = { id: string; displayName: string; isDefault: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts: string[] };
const presetsKey = 'presets.v1';
const lastRunKey = 'lastRunFile.v1';
const mobileEnabledKey = 'mobile.enabled.v1';
const mobileServerKey = 'mobile.ntfyServer.v1';
const mobileTopicSecretKey = 'mobile.ntfyTopic.v1';
const maxSplitDepth = 2;
const maxChildPlanningRounds = 13;
const gitIndexPolicy = 'The Git index is human-owned state. Never stage or unstage files and never run or request git add, git restore --staged, git reset, or git rm --cached. Review both staged and unstaged diffs in place. An intentionally staged implementation is not a verification failure and must not block readiness.';
const blockedCommandPolicy = 'Use COMMAND_BLOCKED only when the provider permission layer prevented a command from executing at all. A command that ran and returned a nonzero exit status is CHECK_FAILED, not COMMAND_BLOCKED; report its exact failure evidence for review.';
const secondaryApprovalRole = (preset: Preset): Role => ({ provider: 'codex', model: preset.secondaryApprovalModel || 'gpt-6.1-sol', effort: 'high' });
const providerCommands = new Map<Provider, string>();

function blockedCommandHasExecutionEvidence(implementation: string, blockedLine: string): boolean {
  const command = blockedLine.trim().replace(/^COMMAND_BLOCKED:\s*/i, '').trim();
  if (!command) return false;
  return implementation.split('\n').some(line => !line.trim().startsWith('COMMAND_BLOCKED:')
    && line.includes(command)
    && /\b(?:PASS|FAIL)\b|\bexit(?:ed)?\s+(?:code\s+)?\d+\b/i.test(line));
}

function sanitizeAgentText(value: string): string {
  return value.replace(/\0/g, '\\0');
}

function isManualAcceptancePhase(task: string): boolean {
  return /\b(?:hands-on|interactive|operator|native-app|Electron)\b.{0,120}\b(?:session|check|acceptance|results?|record)|\b(?:run|perform|record|capture)\b.{0,100}\b(?:PASS|FAIL|observations?|hands-on checks?|interactive checks?)\b/is.test(task);
}

function canSplitPhase(task: string, phasePath: number[] | undefined): boolean {
  return (phasePath?.length ?? 0) < maxSplitDepth && !isManualAcceptancePhase(task);
}

function isArchitectureRoadmapTask(task: string, parentRunId?: string): boolean {
  if (parentRunId) return false;
  const planningOnly = /\bplanning only\b|\bdo not (?:proceed to|begin|start) implementation\b|\bimplementation requires a later\b/i.test(task);
  const roadmapDeliverable = /\barchitecture (?:proposal|plan|design)\b|\bphased (?:implementation )?(?:plan|proposal|roadmap)\b|\barchitecture\b[\s\S]{0,120}\broadmap\b/i.test(task);
  return planningOnly && roadmapDeliverable;
}

const defaultPreset: Preset = {
  name: 'Claude plans, Codex reviews',
  planner: { provider: 'claude', model: 'sonnet', effort: 'high' },
  reviewer: { provider: 'codex', model: '', effort: 'high' },
  orchestrator: { provider: 'codex', model: '', effort: 'medium' },
  implementer: { provider: 'claude', model: 'sonnet', effort: 'high' },
  codeReviewer: { provider: 'codex', model: '', effort: 'high' },
  claudeExploreModel: 'haiku',
  claudeSessionPolicy: 'checkpoint',
  requirementsGuard: false,
  ollamaModel: '',
  localPlanningStarter: true,
  localImplementationStarter: true,
  secondarySolApproval: false,
  secondaryApprovalModel: 'gpt-6.1-sol',
  secondaryDecisionDelegation: false,
  maxRounds: 3,
  maxCodeRounds: 3
};

function reusableClaudeSession(policy: ClaudeSessionPolicy, sessionId: string | undefined, startedRound: number | undefined, round: number): string {
  if (!sessionId || policy === 'fresh') return '';
  if (policy === 'continuous') return sessionId;
  if (!startedRound || round - startedRound >= 3) return '';
  return sessionId;
}

function roleArgs(role: Role, readOnly: boolean, additionalDirectories: string[] = [], claudeExploreModel = '', claudeSessionId = ''): string[] {
  if (role.provider === 'claude') {
    const args = ['-p', '--output-format', 'json', '--permission-mode', readOnly ? 'plan' : 'acceptEdits'];
    if (claudeSessionId.trim()) args.push('--resume', claudeSessionId.trim());
    if (!readOnly) args.push('--allowedTools',
      'Bash(npm *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(bun *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(corepack *)',
      'Bash(bash *)', 'Bash(sh *)', 'Bash(/bin/bash *)', 'Bash(/bin/sh *)',
      'Bash(mkdir *)', 'Bash(cp *)', 'Bash(echo *)', 'Bash(grep *)', 'Bash(cmp *)', 'Bash(diff *)', 'Bash(find *)', 'Bash(ls *)', 'Bash(stat *)', 'Bash(env *)',
      'Bash(sw_vers *)', 'Bash(uname *)', 'Bash(arch *)',
      'Bash(curl *)', 'Bash(lsof *)', 'Bash(/usr/libexec/PlistBuddy *)', 'Bash(/usr/bin/ditto *)',
      'Bash(docker *)', 'Bash(docker-compose *)',
      'Bash(supabase --version*)', 'Bash(supabase --help*)',
      'Bash(supabase init*)', 'Bash(supabase start*)', 'Bash(supabase stop*)', 'Bash(supabase status*)', 'Bash(supabase db reset*)', 'Bash(psql *)',
      'Bash(git status*)', 'Bash(git diff*)');
    for (const directory of additionalDirectories) args.push('--add-dir', directory);
    if (claudeExploreModel.trim()) args.push('--agents', JSON.stringify({
      Explore: {
        description: 'Fast read-only agent for file discovery, code search, and codebase exploration. Use when searching or understanding a codebase without making changes.',
        prompt: 'Search and analyze the codebase efficiently without changing files. Return concise findings with relevant file paths and line references.',
        tools: ['Read', 'Grep', 'Glob'],
        model: claudeExploreModel.trim()
      }
    }));
    if (role.model.trim()) args.push('--model', role.model.trim());
    if (role.effort.trim()) args.push('--effort', role.effort.trim());
    return args;
  }
  const args = ['exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
  if (readOnly) args.push('--skip-git-repo-check');
  if (role.model.trim()) args.push('--model', role.model.trim());
  if (role.effort.trim()) args.push('-c', `model_reasoning_effort="${role.effort.trim()}"`);
  return args;
}

async function resolveProviderCommand(provider: Provider): Promise<string> {
  const cached = providerCommands.get(provider);
  if (cached) return cached;
  const executable = provider === 'claude' ? 'claude' : 'codex';
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, executable));
  candidates.push(path.join(homedir(), '.local', 'bin', executable));
  if (provider === 'claude') {
    candidates.push(path.join(homedir(), '.claude', 'local', 'claude'));
    try {
      const versionsRoot = path.join(homedir(), '.nvm', 'versions', 'node');
      const versions = await fs.readdir(versionsRoot);
      versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      candidates.push(...versions.map(version => path.join(versionsRoot, version, 'bin', 'claude')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.access(candidate);
      providerCommands.set(provider, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
  }
  const label = provider === 'claude' ? 'Claude Code' : 'Codex';
  throw new Error(`${label} command “${executable}” was not found in the VS Code environment or its usual installation locations. Open a terminal, confirm “${executable}” runs, then use Developer: Reload Window.`);
}

async function discoverDevTunnel(): Promise<string | undefined> {
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'devtunnel'));
  candidates.push('/opt/homebrew/bin/devtunnel', '/usr/local/bin/devtunnel');
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* Try the next usual installation location. */ }
  }
  return undefined;
}

async function invoke(role: Role, prompt: string, cwd: string, readOnly: boolean, signal: AbortSignal, additionalDirectories: string[] = [], claudeExploreModel = '', claudeSessionId = '', onClaudeSession?: (sessionId: string) => void): Promise<string> {
  const command = await resolveProviderCommand(role.provider);
  const commandName = role.provider === 'claude' ? 'claude' : 'codex';
  const useStdin = role.provider === 'codex';
  const safePrompt = sanitizeAgentText(prompt);
  const args = [...roleArgs(role, readOnly, additionalDirectories, claudeExploreModel, claudeSessionId), useStdin ? '-' : safePrompt];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(command, args, { cwd, env, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
  child.stderr!.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
  if (useStdin) child.stdin?.end(safePrompt);
  let exit;
  try {
    exit = await waitForChildExit(child, signal, 5_000, {
      onTerminationFailure: error => {
        void vscode.window.showErrorMessage(`CodeFlow Conductor could not stop the provider process tree: ${error.message} The workflow remains locked until the provider exits or you end it manually.`);
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Could not launch ${commandName}. Command path: ${command}. Working directory: ${cwd}. One of these paths does not exist or cannot be opened. Original error: ${(error as Error).message}`);
    }
    throw error;
  }
  if (exit.abortError || signal.aborted) throw exit.abortError ?? new DOMException('The operation was aborted.', 'AbortError');
  const code = exit.code;
  const signalName = exit.signal;
  if (role.provider === 'claude') {
          let result: any;
          try { result = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { result = undefined; }
          const structuredErrors = Array.isArray(result?.errors) ? result.errors.map(String).join('\n') : '';
          const detail = String(result?.result ?? result?.error?.message ?? result?.error ?? result?.message ?? structuredErrors ?? '').trim()
            || stderr.trim()
            || stdout.trim()
            || 'Claude exited without returning error details. Resume the run to retry the interrupted stage; if it repeats, run “claude” in a terminal to check its sign-in and local configuration.';
          if (code !== 0 || result?.is_error || result?.subtype === 'error_during_execution') {
            throw new Error(`${commandName} exited ${code ?? signalName ?? 'unknown'}: ${detail.slice(-3000)}`);
          }
          if (!result) throw new Error('Claude returned output that was not valid JSON. Resume the run to retry the interrupted stage.');
          const returnedSessionId = String(result.session_id ?? result.sessionId ?? '').trim();
          if (returnedSessionId) onClaudeSession?.(returnedSessionId);
          const summary = sanitizeAgentText(String(result.result ?? ''));
          const fullPlan = await readClaudePlanReference(summary, cwd);
    return fullPlan ?? summary;
  }
  const lines = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failure = lines.find(event => event.type === 'turn.failed' || event.type === 'error');
  const failureDetail = failure?.error?.message ?? failure?.message ?? failure?.item?.text;
  if (failure || code !== 0) {
    const detail = failureDetail || (failure ? JSON.stringify(failure) : '') || stderr || stdout;
    throw new Error(`${commandName} exited ${code}: ${String(detail).slice(-3000)}`);
  }
  const messages = lines.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  return sanitizeAgentText(String(messages.at(-1)?.item?.text ?? ''));
}

async function readClaudePlanReference(summary: string, cwd: string): Promise<string | undefined> {
  const paths = [...summary.matchAll(/\bplan\b.{0,60}\b(?:written|saved)\b.{0,30}\b(?:at|to)\b\s*`([^`\n]+\.md)`/gi)]
    .map(match => match[1])
    .filter(path.isAbsolute);
  const roots = [path.resolve(cwd), path.resolve(homedir(), '.claude', 'plans')];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (!roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > 5_000_000) continue;
      const content = sanitizeAgentText(await fs.readFile(resolved, 'utf8'));
      if (content.trim()) return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (/\bplan\b.{0,60}\b(?:written|saved)\b.{0,30}\b(?:at|to)\b/i.test(summary) && paths.length) {
    throw new Error('Claude returned only a plan summary, and the referenced full plan file could not be read. The previous full plan was preserved; retry this stage after checking the referenced path.');
  }
  return undefined;
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('Not inside a trusted directory') || raw.includes('--skip-git-repo-check')) {
    return 'Codex would not run because this folder is not a Git repository. Version 0.3 handles trusted VS Code folders automatically; retry the workflow.';
  }
  if (raw.startsWith('Could not launch claude') || raw.startsWith('Could not launch codex')) return raw;
  if (raw.includes('ENOENT')) return `A required local file or folder was not found. The provider CLI itself may still be installed. Details: ${raw}`;
  if (/auth|login|unauthorized/i.test(raw)) return 'The selected provider is not signed in. Sign in with its CLI, then retry.';
  return raw;
}

function showTemporaryWorkflowNotification(message: string, durationMs = 8000): void {
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeFlow Conductor', cancellable: false },
    async progress => {
      progress.report({ message, increment: 100 });
      await new Promise<void>(resolve => setTimeout(resolve, durationMs));
    }
  );
}

async function inferApprovedHomeDirectories(text: string, workspace: string): Promise<string[]> {
  const home = path.resolve(homedir());
  const root = path.resolve(workspace);
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedMatches = [...text.matchAll(new RegExp(`(["'])(${escapedHome}/.*?)\\1`, 'g'))].map(match => match[2]);
  const unquotedMatches = text.match(new RegExp(`(?<!["'])${escapedHome}/[^\\s"';&|]+`, 'g')) ?? [];
  const matches = [...quotedMatches, ...unquotedMatches];
  const directories: string[] = [];
  for (const raw of matches) {
    const candidate = path.resolve(raw.replace(/[),.:]+$/, '').replace(/\/$/, ''));
    if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) continue;
    if (candidate !== home && !candidate.startsWith(`${home}${path.sep}`)) continue;
    let directory = candidate;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) directory = path.dirname(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (path.extname(candidate)) directory = path.dirname(candidate);
    }
    if (directory !== home && directory.startsWith(`${home}${path.sep}`)) directories.push(directory);
  }
  const unique = [...new Set(directories)];
  return unique.filter(directory => !unique.some(other => other !== directory && other.startsWith(`${directory}${path.sep}`)));
}

async function discoverCodexModels(): Promise<AccountModel[]> {
  const command = await resolveProviderCommand('codex');
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out while asking Codex for available models.')), 15000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error, models?: AccountModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error); else resolve(models ?? []);
    };
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (!settled) finish(new Error(`Codex model discovery exited ${code}: ${stderr.slice(-2000)}`));
    });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as any;
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message ?? JSON.stringify(message.error)));
          send({ method: 'initialized', params: {} });
          send({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } });
        }
        if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message ?? JSON.stringify(message.error)));
          const models = Array.isArray(message.result?.data) ? message.result.data.map((model: any) => ({
            id: String(model.model ?? model.id),
            displayName: String(model.displayName ?? model.model ?? model.id),
            isDefault: model.isDefault === true,
            defaultReasoningEffort: model.defaultReasoningEffort ? String(model.defaultReasoningEffort) : undefined,
            supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((effort: any) => String(effort.reasoningEffort))
              : []
          })) : [];
          finish(undefined, models);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'plan_review_workflow', title: 'CodeFlow Conductor', version: '0.47.5' } } });
  });
}

function parseJsonResponse(raw: string, errorMessage: string): unknown {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* A provider may wrap the complete response in a JSON fence. */ }
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch { /* Report the common parse error below. */ }
  }
  const wholeFence = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (wholeFence) {
    try { return JSON.parse(wholeFence[1].trim()); } catch { /* Report the common parse error below. */ }
  }
  throw new Error(errorMessage);
}

function parseDecision(raw: string): DecisionResult {
  const value = parseJsonResponse(raw, 'Orchestrator did not return valid JSON. Inspect its saved response.');
  if (!value || typeof value !== 'object') throw new Error('Orchestrator response is not an object.');
  const data = value as Record<string, unknown>;
  const allowed: Decision[] = ['REVISE', 'ROADMAP_READY', 'READY_TO_CODE', 'PHASE_COMPLETE', 'SPLIT', 'WAITING_FOR_PREREQUISITE', 'PREREQUISITE_COMPLETE', 'NEEDS_HUMAN', 'NEEDS_MORE_PLANNING', 'STOP'];
  if (!allowed.includes(data.decision as Decision) || typeof data.detail !== 'string') throw new Error('Orchestrator response needs a decision and detail.');
  const phases = Array.isArray(data.phases) ? data.phases.flatMap((item): SplitPhase[] => {
    if (!item || typeof item !== 'object') return [];
    const phase = item as Record<string, unknown>;
    const title = String(phase.title ?? '').trim();
    const objective = String(phase.objective ?? '').trim();
    if (!title || !objective) return [];
    return [{ title, objective, dependsOn: Array.isArray(phase.dependsOn) ? phase.dependsOn.map(String) : [] }];
  }) : [];
  if ((data.decision === 'SPLIT' || data.decision === 'ROADMAP_READY') && phases.length === 0) {
    phases.push(
      { title: 'Focused first phase', objective: data.detail, dependsOn: [] },
      { title: 'Remaining implementation', objective: 'Complete the remaining scope from the parent plan after the focused first phase is accepted.', dependsOn: ['Focused first phase'] }
    );
  }
  const plannerPrompt = typeof data.plannerPrompt === 'string' && data.plannerPrompt.trim()
    ? data.plannerPrompt.trim()
    : data.decision === 'REVISE' || data.decision === 'NEEDS_MORE_PLANNING' || data.decision === 'STOP' ? data.detail : '';
  let prerequisite: Prerequisite | undefined;
  if (data.prerequisite && typeof data.prerequisite === 'object') {
    const item = data.prerequisite as Record<string, unknown>;
    const title = String(item.title ?? '').trim();
    const reason = String(item.reason ?? data.detail).trim();
    const resumeWhen = String(item.resumeWhen ?? '').trim();
    if (title) prerequisite = { title, reason, resumeWhen };
  }
  if (data.decision === 'WAITING_FOR_PREREQUISITE' && !prerequisite) {
    prerequisite = { title: 'External prerequisite', reason: data.detail, resumeWhen: 'Resume this phase after the prerequisite is complete and its evidence is available.' };
  }
  let planningLedger: PlanningLedger | undefined;
  if (data.planningLedger && typeof data.planningLedger === 'object') {
    const ledger = data.planningLedger as Record<string, unknown>;
    const strings = (input: unknown) => Array.isArray(input) ? input.map(String).map(value => value.trim()).filter(Boolean) : [];
    const findings = Array.isArray(ledger.findings) ? ledger.findings.flatMap((input): PlanningFinding[] => {
      if (!input || typeof input !== 'object') return [];
      const item = input as Record<string, unknown>;
      const id = String(item.id ?? '').trim();
      const summary = String(item.summary ?? '').trim();
      const severity = String(item.severity ?? 'Medium');
      const status = String(item.status ?? 'open');
      if (!id || !summary || !['High', 'Medium', 'Low'].includes(severity) || !['open', 'resolved', 'deferred'].includes(status)) return [];
      return [{
        id,
        summary,
        source: String(item.source ?? '').trim(),
        severity: severity as PlanningFinding['severity'],
        affectedPhase: String(item.affectedPhase ?? '').trim(),
        canonicalLocation: String(item.canonicalLocation ?? '').trim(),
        closureCondition: String(item.closureCondition ?? '').trim(),
        status: status as PlanningFinding['status']
      }];
    }) : undefined;
    const objective = String(ledger.objective ?? '').trim();
    if (objective) planningLedger = {
      objective,
      inScope: strings(ledger.inScope),
      lockedDecisions: strings(ledger.lockedDecisions),
      unresolvedFindings: strings(ledger.unresolvedFindings),
      deferred: strings(ledger.deferred),
      findings
    };
  }
  const workflowName = typeof data.workflowName === 'string' ? data.workflowName.trim().slice(0, 100) : '';
  return { decision: data.decision as Decision, detail: data.detail, plannerPrompt, phases, prerequisite, planningLedger, workflowName: workflowName || undefined };
}

function parsePlanningCheckpointAudit(raw: string): PlanningCheckpointAudit {
  const value = parseJsonResponse(raw, 'Planning checkpoint auditor did not return valid JSON. Inspect its saved response.');
  if (!value || typeof value !== 'object') throw new Error('Planning checkpoint audit is not an object.');
  const data = value as Record<string, unknown>;
  const allowed: PlanningAuditRecommendation[] = ['TARGETED_REVISION', 'READY', 'NEEDS_HUMAN', 'RETURN_TO_PARENT', 'STOP'];
  const recommendation = String(data.recommendation ?? '') as PlanningAuditRecommendation;
  const summary = String(data.summary ?? '').trim();
  if (!allowed.includes(recommendation) || !summary) throw new Error('Planning checkpoint audit needs a recommendation and summary.');
  const strings = (input: unknown) => Array.isArray(input) ? input.map(String).map(item => item.trim()).filter(Boolean) : [];
  return {
    recommendation,
    summary,
    confirmedFindings: strings(data.confirmedFindings),
    rejectedFindings: strings(data.rejectedFindings),
    plannerPrompt: String(data.plannerPrompt ?? '').trim()
  };
}

function planningCheckpointMarkdown(audit: PlanningCheckpointAudit, round: number, repeatedIds: string[], newIds: string[], resolvedIds: string[]): string {
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- None';
  return `# Planning checkpoint audit\n\nRound: ${round}\nRecommendation: ${audit.recommendation}\n\n## Assessment\n\n${audit.summary}\n\n## Confirmed blockers\n\n${list(audit.confirmedFindings)}\n\n## Rejected or nonblocking findings\n\n${list(audit.rejectedFindings)}\n\n## Finding movement\n\n### Repeated open IDs\n\n${list(repeatedIds)}\n\n### New open IDs\n\n${list(newIds)}\n\n### Resolved IDs\n\n${list(resolvedIds)}\n\n## Bounded next-step instructions\n\n${audit.plannerPrompt || 'No further planning correction is recommended.'}\n`;
}

function parseSecondaryApprovalReview(raw: string): SecondaryApprovalReview {
  const value = parseJsonResponse(raw, 'Secondary approval reviewer did not return valid JSON. Inspect its saved response.');
  if (!value || typeof value !== 'object') throw new Error('Secondary approval review is not an object.');
  const data = value as Record<string, unknown>;
  const decision = String(data.decision ?? '') as SecondaryApprovalReview['decision'];
  const summary = String(data.summary ?? '').trim();
  if (!['APPROVE', 'REVISE', 'NEEDS_HUMAN'].includes(decision) || !summary) throw new Error('Secondary approval review needs a decision and summary.');
  const findings = Array.isArray(data.findings) ? data.findings.map(String).map(item => item.trim()).filter(Boolean) : [];
  return { decision, summary, findings, correctionPrompt: String(data.correctionPrompt ?? '').trim() };
}

function secondaryApprovalMarkdown(title: string, model: string, review: SecondaryApprovalReview): string {
  return `# ${title}\n\nDecision: ${review.decision}\nModel: ${model}\n\n## Summary\n\n${review.summary}\n\n## Findings\n\n${review.findings.length ? review.findings.map(item => `- ${item}`).join('\n') : '- None'}\n\n## Correction guidance\n\n${review.correctionPrompt || 'No correction requested.'}\n`;
}

function parseDelegatedDecision(raw: string): DelegatedDecision {
  const value = parseJsonResponse(raw, 'Secondary decision delegate did not return valid JSON. Inspect its saved response.');
  if (!value || typeof value !== 'object') throw new Error('Secondary delegated decision is not an object.');
  const data = value as Record<string, unknown>;
  const decision = String(data.decision ?? '') as DelegatedDecision['decision'];
  const answer = String(data.answer ?? '').trim();
  const rationale = String(data.rationale ?? '').trim();
  const nextInstruction = String(data.nextInstruction ?? '').trim();
  if (!['RESOLVED', 'HUMAN_REQUIRED'].includes(decision) || !rationale) throw new Error('Secondary delegated decision needs a decision and rationale.');
  if (decision === 'RESOLVED' && !answer) throw new Error('A resolved delegated decision needs an answer.');
  return { decision, answer, rationale, nextInstruction };
}

function delegatedDecisionMarkdown(title: string, model: string, result: DelegatedDecision): string {
  return `# ${title}\n\nDecision: ${result.decision}\nModel: ${model}\n\n## Answer\n\n${result.answer || 'No delegated answer; direct human input remains required.'}\n\n## Rationale\n\n${result.rationale}\n\n## Next instruction\n\n${result.nextInstruction || 'Pause for direct human input.'}\n`;
}

function delegatedDecisionPrompt(question: string, context: string): string {
  return `Act as the owner's delegated decision reviewer for this workflow checkpoint. Do not edit files. Reply with ONLY JSON: {"decision":"RESOLVED|HUMAN_REQUIRED","answer":"the decision supported by existing authority, or empty","rationale":"specific supporting evidence or why delegation is unsafe","nextInstruction":"bounded instruction for the planner or implementer, or empty"}. Choose RESOLVED only when the answer follows directly from the approved task, requirements, plan, prior owner guidance, or concrete repository evidence. Do not invent a product preference or new requirement. Choose HUMAN_REQUIRED when the checkpoint requires credentials, private information unavailable in the repository, destructive or irreversible authorization, legal or financial consent, an observation from a UI/device/native session, execution of a human-only acceptance procedure, or a product choice with no recorded owner preference. Never claim that a command, UI flow, or acceptance check passed unless recorded evidence proves it.\n\nQuestion or checkpoint:\n${question}\n\nWorkflow context:\n${context}`;
}

function requiresDirectHumanAction(text: string): boolean {
  return /COMMAND_BLOCKED|password|passcode|secret|credential|API key|sign[ -]?in|log[ -]?in|permission (?:denied|required)|approval required|destructive|irreversible|human-only|operator checklist|interactive (?:desktop|app|session)|native (?:macOS|Windows|Linux)|UI\/device|screenshot|camera|microphone|physical device|click (?:the|a)|open the app|run (?:the following|this exact|`)|record (?:the|your) observations?/i.test(text);
}

function explicitUnmetPrerequisite(plan: string): Prerequisite | undefined {
  const gated = /(?:session|phase|execution)\s+is\s+gated|status\s+today:\s*blocked\s+on|nothing\s+(?:runs|executes|starts)\s+until\s+every\s+(?:item|prerequisite)\s+holds/i.test(plan);
  const absentClause = /\bno\s+([^.\n]{0,300}?)\s+exists\s+yet\b/i.exec(plan)?.[1] ?? '';
  const chunkNumbers = [...absentClause.matchAll(/\bchunk\s+(\d+)\b/gi)].map(match => Number(match[1])).filter(Number.isFinite);
  if (!gated || !chunkNumbers.length) return undefined;
  const chunk = `Chunk ${Math.max(...chunkNumbers)}`;
  return {
    title: chunk,
    reason: `The approved plan explicitly says this phase is gated because ${chunk}'s required code or completion evidence does not exist yet.`,
    resumeWhen: `Resume after ${chunk}'s code work is complete and the completion record or commit evidence named by the plan is available.`
  };
}

function parseCodeDecision(raw: string): CodeDecisionResult {
  const value = parseJsonResponse(raw, 'Code orchestrator did not return valid JSON. Inspect its saved response.');
  if (!value || typeof value !== 'object') throw new Error('Code orchestrator response is not an object.');
  const data = value as Record<string, unknown>;
  const allowed: CodeDecision[] = ['FIX', 'CODE_READY', 'NEEDS_HUMAN', 'NEEDS_MORE_CODE', 'STOP'];
  if (!allowed.includes(data.decision as CodeDecision) || typeof data.detail !== 'string') throw new Error('Code orchestrator response needs a decision and detail.');
  const implementerPrompt = typeof data.implementerPrompt === 'string' && data.implementerPrompt.trim()
    ? data.implementerPrompt.trim()
    : data.decision === 'FIX' ? data.detail : '';
  const question = typeof data.question === 'string' && data.question.trim()
    ? data.question.trim()
    : data.decision === 'NEEDS_HUMAN' ? `${data.detail}\n\nWhat specific guidance or access should the workflow use to continue?` : '';
  const humanInstructions = typeof data.humanInstructions === 'string' ? data.humanInstructions.trim() : '';
  const expectedEvidence = Array.isArray(data.expectedEvidence)
    ? data.expectedEvidence.map(String).map(value => value.trim()).filter(Boolean)
    : [];
  const responseTemplate = typeof data.responseTemplate === 'string' ? data.responseTemplate.trim() : '';
  const humanAcceptanceRequired = data.humanAcceptanceRequired === true || String(data.humanAcceptanceRequired ?? '').toLocaleLowerCase() === 'true';
  return { decision: data.decision as CodeDecision, detail: data.detail, implementerPrompt, question, humanInstructions, expectedEvidence, responseTemplate, humanAcceptanceRequired };
}

function pendingAcceptanceActions(record: RunRecord): string[] {
  if (record.acceptanceStatus === 'complete') return [];
  if (record.acceptanceStatus === 'pending') return record.pendingHumanActions?.length ? record.pendingHumanActions : [record.codeDetail || 'Complete the required human acceptance checks.'];
  const detail = record.codeDetail ?? '';
  if (/(?:human-only|manual|operator)\s+(?:acceptance\s+)?checks?.{0,100}(?:remain|pending|required)|acceptance\s+(?:follow-up|checks?).{0,80}(?:remain|pending|required)|must be completed before (?:claiming|declaring)/is.test(detail)) return [detail];
  return [];
}

async function findHumanSupportFiles(runDir: string): Promise<string[]> {
  let supportFiles: string[] = [];
  try {
    supportFiles = (await fs.readdir(runDir))
      .filter(name => /(?:operator|instructions?|checks?|checklist|manual|results?|working-plan)/i.test(name) && /\.(?:md|txt)$/i.test(name))
      .map(name => path.join(runDir, name));
  } catch { /* The orchestrator handoff below remains available. */ }
  return supportFiles;
}

async function buildCodeHumanPrompt(runDir: string, result: CodeDecisionResult): Promise<string> {
  const supportFiles = await findHumanSupportFiles(runDir);
  const instructions = result.humanInstructions || result.implementerPrompt;
  return [
    result.question.trim(),
    result.detail.trim() ? `Why the workflow paused:\n${result.detail.trim()}` : '',
    instructions.trim() ? `What to do:\n${instructions.trim()}` : '',
    result.expectedEvidence.length ? `What to observe and record:\n${result.expectedEvidence.map(item => `• ${item}`).join('\n')}` : '',
    supportFiles.length ? `Source instructions and result files:\n${supportFiles.map(file => `• ${file}`).join('\n')}` : '',
    result.responseTemplate
      ? `Response template:\n${result.responseTemplate}`
      : 'How to respond:\nState which checks or actions passed or failed, include the observations requested above, and name any results file you updated.'
  ].filter(Boolean).join('\n\n');
}

async function saveHumanActionArtifact(runDir: string, record: RunRecord, round: number, prompt: string): Promise<string> {
  const file = path.join(runDir, `code-round-${round}-human-action.md`);
  const content = `# Human action required\n\n${prompt.trim()}\n`;
  await fs.writeFile(file, content, 'utf8');
  for (const supportFile of await findHumanSupportFiles(runDir)) {
    if (!record.files.includes(supportFile)) record.files.push(supportFile);
  }
  if (!record.files.includes(file)) record.files.push(file);
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
  return file;
}

async function completedSiblingEvidence(runsRoot: string, parentRunId: string | undefined, currentRecordId = ''): Promise<string> {
  if (!parentRunId) return '';
  const parentRunDir = path.join(runsRoot, parentRunId);
  let parent: RunRecord;
  try { parent = JSON.parse(await fs.readFile(path.join(parentRunDir, 'run.json'), 'utf8')) as RunRecord; }
  catch { return ''; }
  const completed = new Set(parent.completedPhaseIndexes ?? []);
  const sections: string[] = [];
  for (const entry of await fs.readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentRecordId) continue;
    try {
      const siblingDir = path.join(runsRoot, entry.name);
      const sibling = JSON.parse(await fs.readFile(path.join(siblingDir, 'run.json'), 'utf8')) as RunRecord;
      if (sibling.parentRunId !== parentRunId || !completed.has(sibling.splitPhaseIndex ?? -1)) continue;
      if (!['code_ready', 'split_complete'].includes(sibling.stage) || sibling.acceptanceStatus === 'pending') continue;
      let acceptanceResults = '';
      if (sibling.acceptanceResultsPath) {
        try { acceptanceResults = await fs.readFile(sibling.acceptanceResultsPath, 'utf8'); } catch { /* Human input below may still contain the evidence. */ }
      }
      const humanEvidence = String(acceptanceResults || sibling.humanInput || '').trim();
      const detail = String(sibling.codeDetail || sibling.detail || '').trim();
      if (!humanEvidence && !detail) continue;
      sections.push([
        `Completed sibling phase: ${sibling.splitPhaseTitle || sibling.task.split('\n')[0]}`,
        detail ? `Completion summary:\n${detail}` : '',
        humanEvidence ? `Recorded human evidence:\n${humanEvidence.slice(-8000)}` : ''
      ].filter(Boolean).join('\n\n'));
    } catch { /* Ignore incomplete or unrelated run directories. */ }
  }
  return sections.join('\n\n---\n\n').slice(-16000);
}

async function cleanRepositoryRevision(cwd: string): Promise<string> {
  const runGit = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
    child.stderr?.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git exited ${code}`)));
  });
  try {
    const [revision, status] = await Promise.all([
      runGit(['rev-parse', 'HEAD']),
      runGit(['status', '--porcelain', '--untracked-files=no'])
    ]);
    return status ? '' : revision;
  } catch {
    return '';
  }
}

function manualProcedureForBlockedCommand(plan: string, blockedCommands: string[]): string {
  const command = blockedCommands.map(line => line.replace(/^\s*COMMAND_BLOCKED:\s*/, '').trim()).find(value => plan.includes(value));
  if (!command) return '';
  const commandIndex = plan.indexOf(command);
  const headings = [...plan.matchAll(/^(#{2,6})\s+(.+)$/gm)].filter(match => (match.index ?? 0) <= commandIndex);
  const preferred = [...headings].reverse().find(match => /manual|acceptance|operator|interactive|\bP\d+\b/i.test(match[2])) ?? headings.at(-1);
  if (!preferred || preferred.index === undefined) return '';
  const level = preferred[1].length;
  const afterStart = preferred.index + preferred[0].length;
  const following = [...plan.slice(afterStart).matchAll(/^(#{2,6})\s+.+$/gm)]
    .find(match => match[1].length <= level);
  const end = following?.index === undefined ? plan.length : afterStart + following.index;
  return plan.slice(preferred.index, end).trim();
}

function requiresFullHumanProcedure(blockedCommands: string[], procedure: string): boolean {
  const text = blockedCommands.join('\n');
  const variables = [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map(match => match[1]).filter(name => !['PWD', 'HOME'].includes(name));
  return variables.length > 0
    || /npm\s+(?:start|run\s+(?:dev|start))|electron|osascript|native|interactive/i.test(text)
    || procedure.length > 500 && /(?:^|\n)(?:Setup|Procedure|Expected|Record):?/im.test(procedure);
}

function manualEvidenceItems(procedure: string): string[] {
  const explicitItems = procedure.split('\n')
    .map(line => line.trim())
    .filter(line => /^(?:Record|Expected|Confirm|Verify):/i.test(line))
    .map(line => line.replace(/^\*+|\*+$/g, '').trim());
  if (explicitItems.length) return [...new Set(explicitItems)].slice(0, 30);
  const numberedItems = procedure.split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+[.)]\s+/.test(line))
    .filter(line => /\b(?:confirm|verify|record|inspect|observe|shows?|contains?|appears?|present|opens?|unchanged|remains?)\b/i.test(line))
    .filter(line => !/^\d+[.)]\s+`?(?:npm test|grep\b|node --check)/i.test(line));
  return [...new Set(numberedItems)].slice(0, 30);
}

function implementationReportsStepPassed(step: string, implementation: string): boolean {
  const commands = [...step.matchAll(/`([^`\n]+)`/g)].map(match => match[1].trim())
    .filter(command => /^(?:npm|pnpm|yarn|bun|node|grep|git|bash|sh)\b/.test(command));
  const commandPassed = commands.some(command => {
    const index = implementation.indexOf(command);
    if (index < 0) return false;
    const context = implementation.slice(Math.max(0, index - 160), index + command.length + 300);
    return /\bPASS(?:ED)?\b/i.test(context);
  });
  const mutationPassed = /\b(?:negative|mutation)\s+check\b/i.test(step)
    && /\b(?:negative|mutation)\s+check\b.{0,600}\bPASS(?:ED)?\b/is.test(implementation);
  return commandPassed || mutationPassed;
}

function remainingHumanProcedure(procedure: string, blockedCommands: string[], implementation: string): string {
  if (!procedure) return '';
  const lines = procedure.split('\n');
  const intro: string[] = [];
  const steps: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^\d+[.)]\s+/.test(line.trim())) {
      current = [line];
      steps.push(current);
    } else if (current) current.push(line);
    else intro.push(line);
  }
  if (!steps.length) return procedure;
  const blocked = blockedCommands.map(line => line.replace(/^\s*COMMAND_BLOCKED:\s*/, '').trim());
  const remaining = steps.filter(stepLines => {
    const step = stepLines.join('\n');
    if (blocked.some(command => command && step.includes(command))) return true;
    return !implementationReportsStepPassed(step, implementation);
  });
  const cleaned = [...intro, ...remaining.flat()]
    .join('\n')
    .replace(/^#{2,6}\s+Verification\s*$/im, '## Human acceptance checks still required')
    .replace(/\s*\([^)]*`[^`]+`[^)]*\b(?:rebuilds?|handler|internal state|still false|still true)\b[^)]*\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

function blockedHumanHandoff(plan: string, blockedCommands: string[], implementation = ''): CodeDecisionResult | undefined {
  const completeProcedure = manualProcedureForBlockedCommand(plan, blockedCommands);
  if (!requiresFullHumanProcedure(blockedCommands, completeProcedure)) return undefined;
  const procedure = remainingHumanProcedure(completeProcedure, blockedCommands, implementation);
  const evidenceItems = manualEvidenceItems(procedure);
  const responseTemplate = [
    'Interactive acceptance result: PASS / FAIL',
    '',
    ...(evidenceItems.length
      ? evidenceItems.map(item => `${item.match(/^\d+[.)]/)?.[0] ? `Step ${item.match(/^\d+/)?.[0]}` : item.replace(/^(?:Record|Expected|Confirm|Verify):\s*/i, '')}: PASS / FAIL — observations: `)
      : ['Blocked procedure: PASS / FAIL — observations: ']),
    '',
    'Failure details: none / <what failed>',
    'Results file updated: none / <path>'
  ].join('\n');
  return {
    decision: 'NEEDS_HUMAN',
    detail: `The provider cannot operate the desktop application. Approving the launch command cannot complete the visual or interactive checks, so retrying it automatically will produce the same block.\n\n${blockedCommands.join('\n')}`,
    implementerPrompt: '',
    question: 'Run the complete interactive acceptance procedure below and record every requested observation.',
    humanInstructions: procedure || `Run the blocked command as part of its complete repository procedure, including setup, interaction, verification, and cleanup.\n\n${blockedCommands.join('\n')}`,
    expectedEvidence: evidenceItems,
    responseTemplate,
    humanAcceptanceRequired: false
  };
}

function mergePlanningLedger(task: string, previous?: PlanningLedger, next?: PlanningLedger): PlanningLedger {
  const unique = (...groups: string[][]) => [...new Set(groups.flat().map(value => value.trim()).filter(Boolean))];
  const findings = next?.findings === undefined
    ? previous?.findings
    : [...new Map([...(previous?.findings ?? []), ...next.findings].map(item => [item.id, item])).values()];
  return {
    objective: previous?.objective || next?.objective || task,
    inScope: unique(previous?.inScope ?? [task], next?.inScope ?? []),
    lockedDecisions: unique(previous?.lockedDecisions ?? [], next?.lockedDecisions ?? []),
    unresolvedFindings: next?.unresolvedFindings ?? previous?.unresolvedFindings ?? [],
    deferred: unique(previous?.deferred ?? [], next?.deferred ?? []),
    findings
  };
}

async function requirementsSourceForRun(cwd: string, runDir: string, record: RunRecord): Promise<{ text: string; paths: string[] }> {
  const sections: string[] = [`Current planning task and phase objective:\n${(record.originalTask ?? record.task).slice(0, 24_000)}`];
  const paths: string[] = [];
  if (record.humanInput) sections.push(`Recorded human decisions and guidance:\n${record.humanInput.slice(-40_000)}`);
  if (record.planningLedger) sections.push(`Current workflow scope ledger. Preserve its locked decisions and deferrals; do not treat resolved review history as a new requirement:\n${JSON.stringify({ objective: record.planningLedger.objective, inScope: record.planningLedger.inScope, lockedDecisions: record.planningLedger.lockedDecisions, deferred: record.planningLedger.deferred }, null, 2).slice(-50_000)}`);
  if (record.orchestratorDirection) sections.push(`Confirmed current correction handoff. Extract only the requirements or locked boundaries this correction preserves; do not extract optional suggestions:\n${record.orchestratorDirection.slice(-40_000)}`);
  if (record.requirementsSourcePath) {
    const file = path.resolve(record.requirementsSourcePath);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('The selected requirements source must be a file smaller than 2 MB.');
    sections.push(`Selected approved specification (${file}):\n${(await fs.readFile(file, 'utf8')).slice(0, 120_000)}`);
    paths.push(file);
  }
  if (record.parentRunId) {
    try {
      const parentDir = path.join(path.dirname(runDir), record.parentRunId);
      const parent = JSON.parse(await fs.readFile(path.join(parentDir, 'run.json'), 'utf8')) as RunRecord;
      const parentPlan = parent.approvedPlanPath || parent.workingDraftPath || parent.baselinePlanPath;
      if (parentPlan) {
        const parentText = await fs.readFile(parentPlan, 'utf8');
        const phaseLabel = record.splitPhaseTitle?.trim();
        if (phaseLabel) {
          const lines = parentText.split(/\r?\n/);
          const indexes = lines.flatMap((line, index) => line.toLocaleLowerCase().includes(phaseLabel.toLocaleLowerCase()) ? [index] : []);
          const focused = [...new Set(indexes.flatMap(index => lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 9))))].join('\n');
          if (focused.trim()) sections.push(`Focused excerpts for ${phaseLabel} from the approved parent artifact:\n${focused.slice(0, 40_000)}`);
        }
        sections.push(`Approved parent planning artifact (${parentPlan}):\n${parentText.slice(0, 100_000)}`);
        paths.push(parentPlan);
      }
      if (parent.roadmapAcceptance?.notes) sections.push(`Human-approved parent roadmap notes:\n${parent.roadmapAcceptance.notes}`);
    } catch { /* The current task remains a usable extraction source. */ }
  }
  sections.push('Extract only requirements that apply to the current task or phase. Keep requirements owned by later phases deferred.');
  return { text: sections.join('\n\n---\n\n').slice(0, 180_000), paths };
}

async function readRequirementsBaseline(record: RunRecord): Promise<RequirementsBaseline | undefined> {
  if (!record.requirementsGuard?.baselinePath) return;
  try { return normalizeBaseline(JSON.parse(await fs.readFile(record.requirementsGuard.baselinePath, 'utf8'))); }
  catch { return; }
}

async function detectRepositoryPackageManager(workspace: string): Promise<string | undefined> {
  if (!workspace) return;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8')) as { packageManager?: unknown };
    const declared = String(manifest.packageManager ?? '').trim();
    if (declared) return declared;
  } catch { /* Fall through to lockfile detection. */ }
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm']
  ] as const) {
    try {
      await fs.access(path.join(workspace, file));
      return manager;
    } catch { /* Try the next lockfile. */ }
  }
}

async function savePlanningGuidance(runDir: string, record: RunRecord, beforeRound: number, guidance: string): Promise<void> {
  const text = guidance.trim();
  if (!text) return;
  const createdAt = new Date().toISOString();
  const file = path.join(runDir, `human-guidance-before-round-${beforeRound}.md`);
  await fs.writeFile(file, `# Human guidance for planning round ${beforeRound}\n\nRecorded: ${createdAt}\n\n${text}\n`, 'utf8');
  record.guidanceEntries = [...(record.guidanceEntries ?? []), { createdAt, beforeRound, text, artifactPath: file }];
  record.humanInput = [record.humanInput, `Human guidance supplied before planning round ${beforeRound}:\n${text}`].filter(Boolean).join('\n\n');
  if (!record.files.includes(file)) record.files.push(file);
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
}

async function saveImplementationApprovalGuidance(runDir: string, record: RunRecord, guidance: string): Promise<void> {
  const text = guidance.trim();
  if (!text) return;
  const createdAt = new Date().toISOString();
  const file = path.join(runDir, 'implementation-approval-guidance.md');
  await fs.writeFile(file, `# Implementation approval guidance\n\nRecorded: ${createdAt}\n\n${text}\n`, 'utf8');
  record.implementationApprovalGuidance = text;
  record.humanInput = [record.humanInput, `Human guidance supplied when implementation was approved:\n${text}`].filter(Boolean).join('\n\n');
  if (!record.files.includes(file)) record.files.push(file);
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
}

function beginHumanDirectedRequirementsPass(record: RunRecord, guidance: string): void {
  const guard = record.requirementsGuard;
  if (guard?.status !== 'approved' || (guard.architecturalReviews < 2 && guard.preservationFailures < 2)) return;
  if (!guidance.trim()) throw new Error('Paste the focused revision guidance before starting another requirements-guarded planning pass.');
  if ((guard.humanDirectedPasses ?? 0) >= 2) throw new Error('This requirements-guarded run already used two human-directed restart passes. Start a smaller focused workflow instead of extending this plan again.');
  guard.humanDirectedPasses = (guard.humanDirectedPasses ?? 0) + 1;
  guard.finalCanonicalCorrectionUsed = false;
  guard.architecturalReviews = 0;
  guard.preservationFailures = 0;
}

function slugify(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'implementation-plan';
}

function formatPhasePath(phasePath: number[] | undefined): string {
  return (phasePath ?? []).map(value => String(value).padStart(2, '0')).join('-');
}

function publishedPlanningDirectory(cwd: string, record: RunRecord): string {
  const planningDir = path.join(cwd, 'docs', 'planning');
  return record.workflowName ? path.join(planningDir, slugify(record.workflowName)) : planningDir;
}

async function persistWorkingDraft(cwd: string, record: RunRecord, plan: string | undefined, status: string): Promise<string | undefined> {
  if (!plan?.trim()) return;
  const runDir = path.join(cwd, '.review-workflow', 'runs', record.id);
  await fs.mkdir(runDir, { recursive: true });
  const file = path.join(runDir, 'working-plan.md');
  const provenance = `<!-- Plan Review Workflow\nRun: ${record.id}${record.parentRunId ? `\nParent run: ${record.parentRunId}` : ''}\nStatus: ${status}\nUpdated: ${new Date().toISOString()}\n-->`;
  await fs.writeFile(file, `${provenance}\n\n${plan.trim()}\n`, 'utf8');
  record.workingDraftPath = file;
  if (!record.files.includes(file)) record.files.push(file);
  return file;
}

function isInsideDirectory(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function resolveApprovedPlanPath(cwd: string, record: RunRecord): Promise<string | undefined> {
  if (record.approvedPlanPath) {
    try {
      const stat = await fs.stat(record.approvedPlanPath);
      if (stat.isFile()) return record.approvedPlanPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const planningRoot = path.join(cwd, 'docs', 'planning');
  const candidates: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /-approved(?:-plan-index)?\.md$/i.test(entry.name)) {
        const header = (await fs.readFile(target, 'utf8')).slice(0, 2_000);
        if (new RegExp(`(?:^|\\n)Run:\\s*${record.id}(?:\\n|$)`).test(header)) candidates.push(target);
      }
    }
  };
  await visit(planningRoot);
  if (!candidates.length) return undefined;
  candidates.sort((left, right) => left.localeCompare(right));
  const recovered = candidates[0];
  record.approvedPlanPath = recovered;
  record.files = Array.isArray(record.files) ? record.files : [];
  if (!record.files.includes(recovered)) record.files.push(recovered);
  return recovered;
}

async function publishApprovedPlan(cwd: string, record: RunRecord, plan: string | undefined, approvalStatus = 'approved for implementation'): Promise<string | undefined> {
  if (!plan?.trim()) return;
  const planningDir = publishedPlanningDirectory(cwd, record);
  await fs.mkdir(planningDir, { recursive: true });
  const recordedPath = record.approvedPlanPath;
  const phasePrefix = formatPhasePath(record.phasePath);
  const descriptiveName = record.splitPhaseTitle || record.workflowName || record.task;
  const generatedName = phasePrefix
    ? `${phasePrefix}-${slugify(descriptiveName)}-approved.md`
    : `00-${slugify(descriptiveName)}-approved.md`;
  const file = recordedPath && isInsideDirectory(recordedPath, path.join(cwd, 'docs', 'planning'))
    ? recordedPath
    : path.join(planningDir, generatedName);
  const provenance = `<!-- Plan Review Workflow\nRun: ${record.id}${record.parentRunId ? `\nParent run: ${record.parentRunId}` : ''}\nStatus: ${approvalStatus}\nUpdated: ${new Date().toISOString()}\n-->`;
  await fs.writeFile(file, `${provenance}\n\n${plan.trim()}\n`, 'utf8');
  record.approvedPlanPath = file;
  if (!record.files.includes(file)) record.files.push(file);
  return file;
}

async function readRunRecords(runsRoot: string): Promise<Map<string, { record: RunRecord; runFile: string; runDir: string }>> {
  const records = new Map<string, { record: RunRecord; runFile: string; runDir: string }>();
  for (const entry of await fs.readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot, entry.name);
    const runFile = path.join(runDir, 'run.json');
    try {
      const record = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
      record.files = Array.isArray(record.files) ? record.files : [];
      records.set(record.id || entry.name, { record, runFile, runDir });
    } catch {
      // Ignore incomplete or unrelated folders.
    }
  }
  return records;
}

async function cleanupPublishedPlans(cwd: string, currentRunDir: string, currentRecord: RunRecord, includeFamily: boolean): Promise<void> {
  const planningDir = path.join(cwd, 'docs', 'planning');
  const runsRoot = path.dirname(currentRunDir);
  let allRecords: Map<string, { record: RunRecord; runFile: string; runDir: string }>;
  try { allRecords = await readRunRecords(runsRoot); } catch { return; }
  allRecords.set(currentRecord.id, { record: currentRecord, runFile: path.join(currentRunDir, 'run.json'), runDir: currentRunDir });

  let rootId = currentRecord.id;
  if (includeFamily) {
    const visited = new Set<string>();
    while (!visited.has(rootId)) {
      visited.add(rootId);
      const parentId = allRecords.get(rootId)?.record.parentRunId;
      if (!parentId || !allRecords.has(parentId)) break;
      rootId = parentId;
    }
  }
  const familyIds = new Set<string>([rootId]);
  if (includeFamily) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, value] of allRecords) {
        if (value.record.parentRunId && familyIds.has(value.record.parentRunId) && !familyIds.has(id)) {
          familyIds.add(id);
          changed = true;
        }
      }
    }
  }

  const family = [...familyIds].flatMap(id => allRecords.get(id) ? [allRecords.get(id)!] : []);
  const keep = new Set<string>();
  for (const { record } of family) {
    if ((record.stage === 'roadmap_ready' || record.decision === 'ROADMAP_READY' || record.stage === 'ready_to_code' || record.decision === 'READY_TO_CODE' || record.stage === 'code_ready' || record.codeDecision === 'CODE_READY') && record.approvedPlanPath) keep.add(path.resolve(record.approvedPlanPath));
    if (record.finalPlanIndexPath) keep.add(path.resolve(record.finalPlanIndexPath));
  }

  const candidates = new Set<string>();
  for (const item of family) {
    const { record, runDir } = item;
    const publicWorkingDraft = record.workingDraftPath && isInsideDirectory(path.resolve(record.workingDraftPath), path.resolve(planningDir))
      ? record.workingDraftPath
      : undefined;
    if (publicWorkingDraft) {
      try {
        const content = await fs.readFile(publicWorkingDraft, 'utf8');
        const internalDraft = path.join(runDir, 'working-plan.md');
        await fs.writeFile(internalDraft, content, 'utf8');
        record.workingDraftPath = internalDraft;
        if (!record.files.includes(internalDraft)) record.files.push(internalDraft);
      } catch {
        record.workingDraftPath = undefined;
      }
    }
    for (const file of [...record.files, publicWorkingDraft, record.approvedPlanPath, record.finalPlanIndexPath]) {
      if (file && isInsideDirectory(path.resolve(file), path.resolve(planningDir))) candidates.add(path.resolve(file));
    }
  }

  const removed = new Set<string>();
  for (const file of candidates) {
    if (keep.has(file)) continue;
    try {
      const content = await fs.readFile(file, 'utf8');
      if (!content.startsWith('<!-- Plan Review Workflow') && !content.startsWith('# Approved implementation plan index')) continue;
      await fs.unlink(file);
      removed.add(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      removed.add(file);
    }
  }

  for (const { record, runFile } of family) {
    record.files = record.files.filter(file => !removed.has(path.resolve(file)));
    if (record.approvedPlanPath && removed.has(path.resolve(record.approvedPlanPath))) record.approvedPlanPath = undefined;
    if (record.finalPlanIndexPath && removed.has(path.resolve(record.finalPlanIndexPath))) record.finalPlanIndexPath = undefined;
    await fs.writeFile(runFile, JSON.stringify(record, null, 2), 'utf8');
  }
}

async function persistOriginalTask(runDir: string, record: RunRecord): Promise<string | undefined> {
  const originalTask = String(record.originalTask ?? record.task ?? '').trim();
  if (!originalTask) return;
  const file = record.taskFilePath ?? path.join(runDir, 'original-task.md');
  await fs.writeFile(file, `# Original task\n\n${originalTask}\n`, 'utf8');
  record.originalTask = originalTask;
  record.task = record.task || originalTask;
  record.taskFilePath = file;
  if (!record.files.includes(file)) record.files.unshift(file);
  return file;
}

async function persistSplitPlanIndex(cwd: string, parentRunDir: string, parentRecord: RunRecord): Promise<string | undefined> {
  const phases = Array.isArray(parentRecord.splitPhases) ? parentRecord.splitPhases : [];
  if (!phases.length) return;
  const runsRoot = path.dirname(parentRunDir);
  const children = new Map<number, { record: RunRecord; modified: number }>();
  for (const entry of await fs.readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === parentRecord.id) continue;
    const runFile = path.join(runsRoot, entry.name, 'run.json');
    try {
      const child = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
      if (child.parentRunId !== parentRecord.id) continue;
      const index = Number.isInteger(child.splitPhaseIndex) ? child.splitPhaseIndex! : phases.findIndex(phase =>
        phase.title === child.splitPhaseTitle || child.task.includes(`Phase: ${phase.title}\n`));
      const childComplete = child.codeDecision === 'CODE_READY' || child.stage === 'code_ready' || child.stage === 'split_complete';
      if (index < 0 || !childComplete) continue;
      if (!child.approvedPlanPath && child.stage !== 'split_complete') {
        let approvedSource: string | undefined;
        for (const candidate of [child.workingDraftPath, path.join(path.dirname(runFile), `round-${child.round}-plan.md`)]) {
          if (!candidate) continue;
          try { approvedSource = await fs.readFile(candidate, 'utf8'); break; } catch { /* Try the next saved plan. */ }
        }
        if (approvedSource) {
          await publishApprovedPlan(cwd, child, approvedSource);
          await fs.writeFile(runFile, JSON.stringify(child, null, 2), 'utf8');
        }
      }
      const modified = (await fs.stat(runFile)).mtimeMs;
      if (!children.has(index) || children.get(index)!.modified < modified) children.set(index, { record: child, modified });
    } catch {
      // Ignore unrelated or incomplete run directories while building the index.
    }
  }
  const planningDir = publishedPlanningDirectory(cwd, parentRecord);
  await fs.mkdir(planningDir, { recursive: true });
  const phasePrefix = formatPhasePath(parentRecord.phasePath);
  const indexName = parentRecord.workflowName
    ? phasePrefix
      ? `${phasePrefix}-phase-overview-${slugify(parentRecord.splitPhaseTitle || parentRecord.task)}.md`
      : '00-workflow-overview.md'
    : `${slugify(parentRecord.task)}-${parentRecord.id.slice(0, 8)}-approved-plan-index.md`;
  const file = parentRecord.finalPlanIndexPath ?? path.join(planningDir, indexName);
  const lines = [
    '# Approved implementation plan index',
    '',
    `- **Status:** ${children.size === phases.length ? `Complete (${children.size}/${phases.length} phases)` : `Incomplete (${children.size}/${phases.length} phases)`}`,
    `- **Parent workflow:** ${parentRecord.id}`,
    `- **Updated:** ${new Date().toISOString()}`,
    '',
    'This file identifies the exact approved plan used for each implementation phase.',
    ''
  ];
  for (const [index, phase] of phases.entries()) {
    const child = children.get(index)?.record;
    const approvedPlan = child?.approvedPlanPath;
    const nestedIndex = child?.finalPlanIndexPath;
    const planReference = approvedPlan ?? nestedIndex;
    const relativePlan = planReference ? path.relative(path.dirname(file), planReference).split(path.sep).join('/') : undefined;
    lines.push(
      `## Phase ${index + 1}: ${phase.title}`,
      '',
      `- **Objective:** ${phase.objective}`,
      `- **Status:** ${child?.stage === 'split_complete' ? 'Completed through nested split' : child ? 'CODE_READY' : 'Not completed'}`,
      `- **Child workflow:** ${child?.id ?? 'None'}`,
      `- **Approved plan used for implementation:** ${relativePlan ? `[${path.basename(planReference!)}](${relativePlan})` : 'Unavailable'}`,
      ''
    );
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  parentRecord.finalPlanIndexPath = file;
  parentRecord.files = Array.isArray(parentRecord.files) ? parentRecord.files : [];
  if (!parentRecord.files.includes(file)) parentRecord.files.push(file);
  await fs.writeFile(path.join(parentRunDir, 'run.json'), JSON.stringify(parentRecord, null, 2), 'utf8');
  return file;
}

async function inferReturnToWaitingRun(runDir: string, record: RunRecord): Promise<string | undefined> {
  if (!/external prerequisite for the saved phase/i.test(record.task)) return undefined;
  const candidates: Array<{ file: string; score: number; modified: number }> = [];
  for (const entry of await fs.readdir(path.dirname(runDir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === record.id) continue;
    const file = path.join(path.dirname(runDir), entry.name, 'run.json');
    try {
      const candidate = JSON.parse(await fs.readFile(file, 'utf8')) as RunRecord;
      if (candidate.stage !== 'waiting_for_prerequisite') continue;
      let score = 0;
      if (candidate.prerequisite?.title && record.task.includes(candidate.prerequisite.title)) score += 3;
      const label = candidate.splitPhaseTitle || candidate.workflowName;
      if (label && record.task.includes(`saved phase “${label}”`)) score += 2;
      if (score) candidates.push({ file, score, modified: (await fs.stat(file)).mtimeMs });
    } catch { /* Ignore incomplete or unrelated run folders. */ }
  }
  candidates.sort((left, right) => right.score - left.score || right.modified - left.modified);
  return candidates[0]?.file;
}

function reportsCompletedPhaseRecheck(detail: string | undefined): boolean {
  const text = detail ?? '';
  return /\b(?:approve and close|phase (?:is|already) complete|already implemented)\b/i.test(text)
    && /\b(?:no unresolved|do not replan|do not reimplement|no further revision|required acceptance .* pass|acceptance .* passed)\b/i.test(text);
}

function markPrerequisiteComplete(record: RunRecord): void {
  record.stage = 'prerequisite_complete';
  record.decision = 'PREREQUISITE_COMPLETE';
  record.resumeStage = undefined;
  record.acceptanceStatus = 'complete';
  record.acceptanceInstructions = undefined;
  record.pendingHumanActions = undefined;
  record.acceptanceResponseTemplate = undefined;
}

function clearSupersededCodeCheckpoint(record: RunRecord): void {
  record.codeRound = undefined;
  record.codeStage = undefined;
  record.codeResumeStage = undefined;
  record.codeDecision = undefined;
  record.codeDetail = undefined;
  record.codeDirection = undefined;
  record.verificationRetryCount = undefined;
  record.acceptanceStatus = undefined;
  record.acceptanceInstructions = undefined;
  record.pendingHumanActions = undefined;
  record.acceptanceResponseTemplate = undefined;
}

class WorkflowView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private controller?: AbortController;
  private running = false;
  private pauseRequested = false;
  private stopRequested = false;
  private paused = false;
  private canReopenApprovedRequirements = false;
  private currentRunFile?: string;
  private returnToRunFile?: string;
  private accountModels: AccountModel[] = [];
  private ollamaModels: string[] = [];
  private pending?: ResumeContext & { question: string };
  private pendingSplit?: SplitContext;
  private pendingMore?: ResumeContext;
  private pendingImplementation?: { runDir: string; record: RunRecord; plan: string };
  private pendingCode?: CodeContext & { question?: string };
  private pendingMoreCode?: CodeContext;
  private pendingAcceptance?: { runDir: string; record: RunRecord };
  private pendingReopen?: { runDir: string; record: RunRecord };
  private pendingPrerequisite?: ResumeContext & { prerequisite: Prerequisite };
  private pendingNextPhase?: { parentRunDir: string; parentRecord: RunRecord; index: number };
  private pendingRequirements?: { runDir: string; record: RunRecord; resume: ResumeContext };
  private currentStatus = '';
  private currentTask = '';
  private currentWorkflowName = '';
  private activePresetName?: string;
  private currentArtifacts: { path: string; name: string }[] = [];
  private currentInteraction?: Interaction;
  private mobile?: MobileBridge;
  private mobileInitialization?: Promise<void>;
  private mobileSettings: MobileSettings = { enabled: false, ntfyServer: 'https://ntfy.sh', ntfyTopic: '' };
  private readonly mobileTunnelOwnerId = randomUUID();
  private mobileOwnsTunnel = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentRunFile = context.workspaceState.get<string>(lastRunKey);
    this.paused = Boolean(this.currentRunFile);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    void this.initializeMobile();
    view.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'load') {
          if (this.currentRunFile) {
            try {
              const saved = JSON.parse(await fs.readFile(this.currentRunFile, 'utf8')) as RunRecord;
              this.canReopenApprovedRequirements = saved.requirementsGuard?.status === 'approved'
                && ['paused', 'cancelled', 'failed'].includes(saved.stage);
              this.currentTask = saved.task ?? '';
              this.currentWorkflowName = saved.workflowName ?? '';
              this.currentArtifacts = (saved.files ?? []).map(file => ({ path: file, name: path.basename(file) }));
              if (!this.currentStatus && this.paused) this.currentStatus = `Saved workflow is ${saved.stage}. Add optional guidance, then resume or correct its approved requirements baseline.`;
            } catch { /* The resume action will report a missing or invalid saved run. */ }
          }
          this.sendPresets(message.name);
          this.sendViewState();
          await this.initializeMobile();
          this.sendMobileInfo();
        }
        if (message.type === 'refreshModels') {
          this.post({ type: 'modelStatus', text: 'Checking models available to this Codex account…' });
          try {
            const models = await discoverCodexModels();
            this.accountModels = models;
            this.post({ type: 'models', models });
            this.post({ type: 'modelStatus', text: models.length ? `${models.length} Codex models available for this account.` : 'Codex returned no picker-visible models.' });
          } catch (error) {
            this.post({ type: 'modelStatus', text: `Could not load Codex models: ${friendlyError(error)}` });
          }
        }
        if (message.type === 'save') {
          const preset = validatePreset(message.preset);
          const presets = this.getPresets();
          const index = presets.findIndex(item => item.name.toLocaleLowerCase() === preset.name.toLocaleLowerCase());
          if (index >= 0) presets[index] = preset; else presets.push(preset);
          await this.context.globalState.update(presetsKey, presets);
          this.sendPresets(preset.name);
          this.setStatus(`Preset “${preset.name}” saved on this machine.`);
        }
        if (message.type === 'renamePreset') {
          const previousName = String(message.previousName ?? '').trim();
          const preset = validatePreset(message.preset);
          const presets = this.getPresets();
          const index = presets.findIndex(item => item.name === previousName);
          if (index < 0) throw new Error('Load the preset you want to rename first.');
          const conflict = presets.findIndex((item, itemIndex) => itemIndex !== index && item.name.toLocaleLowerCase() === preset.name.toLocaleLowerCase());
          if (conflict >= 0) throw new Error(`A preset named “${preset.name}” already exists.`);
          presets[index] = preset;
          await this.context.globalState.update(presetsKey, presets);
          this.activePresetName = preset.name;
          this.sendPresets(preset.name);
          this.setStatus(`Preset “${previousName}” renamed to “${preset.name}”.`);
        }
        if (message.type === 'selectPreset') this.sendPresets(String(message.name ?? ''));
        if (message.type === 'deletePreset') {
          const name = String(message.name ?? '');
          const presets = this.getPresets().filter(item => item.name !== name);
          await this.context.globalState.update(presetsKey, presets);
          this.sendPresets(presets[0]?.name);
          this.setStatus(`Preset “${name}” deleted.`);
        }
        if (message.type === 'selectPlan') {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            filters: { 'Markdown plans': ['md', 'markdown'], 'All files': ['*'] },
            openLabel: 'Use this plan'
          });
          if (selected?.[0]) this.post({ type: 'planSelected', path: selected[0].fsPath, name: path.basename(selected[0].fsPath) });
        }
        if (message.type === 'selectRequirementsSource') {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            filters: { 'Specifications and Markdown': ['md', 'markdown', 'txt', 'json'], 'All files': ['*'] },
            openLabel: 'Use as approved requirements source'
          });
          if (selected?.[0]) this.post({ type: 'requirementsSourceSelected', path: selected[0].fsPath, name: path.basename(selected[0].fsPath) });
        }
        if (message.type === 'refreshOllamaModels') await this.refreshOllamaModels();
        if (message.type === 'start') await this.start(message.task, validatePreset(message.preset), message.humanInput, undefined, message.planPath, undefined, undefined, undefined, undefined, undefined, undefined, message.requirementsSourcePath);
        if (message.type === 'attachRequirementsGuard') {
          if (!this.pendingMore) throw new Error('Open a saved planning checkpoint before attaching the requirements guard.');
          const pending = this.pendingMore;
          const selectedPreset = validatePreset(message.preset);
          pending.record.preset = { ...pending.record.preset, requirementsGuard: true, ollamaModel: selectedPreset.ollamaModel, secondarySolApproval: selectedPreset.secondarySolApproval, secondaryApprovalModel: selectedPreset.secondaryApprovalModel, secondaryDecisionDelegation: selectedPreset.secondaryDecisionDelegation };
          pending.record.requirementsSourcePath = String(message.requirementsSourcePath ?? '').trim() || pending.record.requirementsSourcePath;
          const approvedAutomatically = await this.prepareRequirementsGuard(pending.runDir, pending.record, pending, String(message.humanInput ?? '').trim());
          if (approvedAutomatically) await this.start(pending.record.task, pending.record.preset, undefined, { ...pending, record: pending.record });
        }
        if (message.type === 'approveRequirements') await this.approveRequirementsBaseline();
        if (message.type === 'declineRequirements') await this.declineRequirementsBaseline(String(message.humanInput ?? '').trim());
        if (message.type === 'regenerateRequirements') {
          if (!this.pendingRequirements) throw new Error('Open the requirements baseline checkpoint again before regenerating it.');
          const pending = this.pendingRequirements;
          const approvedAutomatically = await this.prepareRequirementsGuard(pending.runDir, pending.record, pending.resume, String(message.humanInput ?? '').trim());
          if (approvedAutomatically) await this.start(pending.record.task, pending.record.preset, undefined, { ...pending.resume, record: pending.record });
        }
        if (message.type === 'continue') {
          if (!this.pending) throw new Error('There is no paused workflow to continue. Start a new workflow instead.');
          const pending = this.pending;
          await this.start(pending.record.task, pending.record.preset, message.humanInput, pending);
        }
        if (message.type === 'continuePlanning') {
          if (!this.pendingMore) throw new Error('Open the saved run again before continuing its planning.');
          const pending = this.pendingMore;
          const guidance = String(message.humanInput ?? '');
          const hardLimit = pending.record.parentRunId ? maxChildPlanningRounds : 50;
          const nextMaximum = Math.min(hardLimit, pending.record.preset.maxRounds + 3);
          if (nextMaximum <= pending.record.preset.maxRounds) throw new Error(pending.record.parentRunId
            ? 'This child phase reached its planning limit. Return to the nearest useful parent phase and restart it with a smaller executable scope; do not split this child again.'
            : 'This workflow reached the extended planning safety limit. Split it into a smaller task.');
          const preset = { ...pending.record.preset, maxRounds: nextMaximum };
          pending.record.preset = preset;
          beginHumanDirectedRequirementsPass(pending.record, guidance);
          await savePlanningGuidance(pending.runDir, pending.record, pending.round, guidance);
          await this.start(pending.record.task, preset, undefined, pending);
        }
        if (message.type === 'implementPlan') {
          if (!this.pendingImplementation) throw new Error('Open the approved planning run again before starting implementation.');
          const pending = this.pendingImplementation;
          await saveImplementationApprovalGuidance(pending.runDir, pending.record, String(message.humanInput ?? ''));
          await this.startCode(pending.runDir, pending.record, pending.plan);
        }
        if (message.type === 'continueCode') {
          if (!this.pendingCode) throw new Error('Open the code-review run again before responding.');
          const pending = this.pendingCode;
          const guidance = String(message.humanInput ?? '').trim();
          pending.record.humanInput = [pending.record.humanInput, guidance].filter(Boolean).join('\n\n');
          const implementation = pending.stage === 'code_reviewing' && guidance
            ? `${pending.implementation || ''}\n\nHuman-provided interactive verification evidence:\n${guidance}`
            : pending.implementation;
          await this.startCode(pending.runDir, pending.record, pending.plan, { ...pending, stage: pending.stage, implementation });
        }
        if (message.type === 'continueImplementation') {
          if (!this.pendingMoreCode) throw new Error('Open the saved code run again before continuing implementation.');
          const pending = this.pendingMoreCode;
          const guidance = String(message.humanInput ?? '').trim();
          pending.record.humanInput = [pending.record.humanInput, guidance].filter(Boolean).join('\n\n');
          const nextMaximum = Math.min(30, pending.record.preset.maxCodeRounds + 3);
          if (nextMaximum <= pending.record.preset.maxCodeRounds) throw new Error('This workflow reached the extended code-review safety limit. Review the saved findings and continue manually.');
          pending.record.preset = { ...pending.record.preset, maxCodeRounds: nextMaximum };
          await this.startCode(pending.runDir, pending.record, pending.plan, { ...pending, stage: 'implementing', round: pending.round + 1 });
        }
        if (message.type === 'runFinalVerification') await this.runFinalVerification(String(message.humanInput ?? '').trim());
        if (message.type === 'completeAcceptance') await this.completeAcceptance(String(message.humanInput ?? '').trim());
        if (message.type === 'reopenCompletedPhase') await this.reopenCompletedPhase(String(message.humanInput ?? '').trim());
        if (message.type === 'recheckPrerequisite') {
          if (!this.pendingPrerequisite) throw new Error('Open the waiting phase again before rechecking its prerequisite.');
          const pending = this.pendingPrerequisite;
          await this.start(pending.record.task, pending.record.preset, String(message.humanInput ?? '').trim(), { ...pending, stage: 'reviewing', review: undefined });
        }
        if (message.type === 'startPrerequisiteWorkflow') await this.startPrerequisiteWorkflow();
        if (message.type === 'acceptRoadmap') await this.acceptRoadmap(String(message.humanInput ?? '').trim());
        if (message.type === 'startSplitPhase') {
          if (!this.pendingSplit) throw new Error('Open the saved parent run again before starting a split phase.');
          const split = this.pendingSplit;
          await this.startPhase(split.runDir, split.record, Number(message.index), String(message.humanInput ?? '').trim(), String(message.presetName ?? '').trim());
        }
        if (message.type === 'startNextPhase') {
          if (!this.pendingNextPhase) throw new Error('Open the completed phase run again before starting the next phase.');
          const next = this.pendingNextPhase;
          await this.startPhase(next.parentRunDir, next.parentRecord, next.index, String(message.humanInput ?? '').trim(), String(message.presetName ?? '').trim());
        }
        if (message.type === 'pause') {
          this.pauseRequested = true;
          this.controller?.abort();
        }
        if (message.type === 'stop') {
          this.stopRequested = true;
          this.controller?.abort();
        }
        if (message.type === 'resumeCurrent') {
          if (!this.currentRunFile) throw new Error('There is no paused run in this VS Code session. Use “Resume saved run” instead.');
          await this.savePausedResumeGuidance(this.currentRunFile, String(message.humanInput ?? '').trim());
          const presetName = String(message.presetName ?? '').trim();
          if (presetName) await this.applyPresetToRun(this.currentRunFile, presetName);
          await this.resumeRun(this.currentRunFile);
        }
        if (message.type === 'reopenApprovedRequirements') {
          await this.reopenApprovedRequirements(String(message.humanInput ?? '').trim());
        }
        if (message.type === 'returnToWorkflow') await this.returnToWaitingWorkflow();
        if (message.type === 'selectRun') {
          const folder = vscode.workspace.workspaceFolders?.[0];
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: folder ? vscode.Uri.file(path.join(folder.uri.fsPath, '.review-workflow', 'runs')) : undefined,
            filters: { 'Workflow run': ['json'] },
            openLabel: 'Resume this run'
          });
          if (selected?.[0]) await this.resumeRun(selected[0].fsPath);
        }
        if (message.type === 'open' && typeof message.path === 'string') await vscode.window.showTextDocument(vscode.Uri.file(message.path));
        if (message.type === 'copyText') {
          const value = String(message.text ?? '').trim();
          if (!value) throw new Error('There is no workflow message to copy.');
          await vscode.env.clipboard.writeText(value);
          vscode.window.setStatusBarMessage('CodeFlow: workflow message copied.', 3000);
        }
        if (message.type === 'setupMobile') await this.enableMobile();
        if (message.type === 'testMobile') {
          await this.initializeMobile();
          await this.mobile?.notify('CodeFlow test', 'Phone notifications are connected.');
        }
        if (message.type === 'mobileSignIn') {
          const command = await discoverDevTunnel();
          if (!command) throw new Error('Microsoft dev tunnels is not installed. Install it with “brew install --cask devtunnel”, then reload VS Code.');
          const terminal = vscode.window.createTerminal('CodeFlow Mobile Setup');
          terminal.show();
          terminal.sendText(`${JSON.stringify(command)} user logout`);
          terminal.sendText(`${JSON.stringify(command)} user login -g`);
        }
        if (message.type === 'startMobileTunnel') {
          await this.startMobileDashboard();
        }
        if (message.type === 'stopMobileTunnel') await this.stopMobileDashboard();
        if (message.type === 'regeneratePairing') this.mobile?.regeneratePairingCode();
        if (message.type === 'openMobileDashboard') {
          const url = this.mobile?.info().remoteUrl;
          if (!url) throw new Error('Start the mobile dashboard tunnel first.');
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        if (message.type === 'disableMobile') await this.disableMobile();
      } catch (error) {
        if (String(message.type ?? '').toLocaleLowerCase().includes('mobile')) {
          const text = friendlyError(error);
          this.post({ type: 'mobileError', text });
          void vscode.window.showErrorMessage(`CodeFlow mobile setup: ${text}`);
        } else if (/ollama|requirements/i.test(String(message.type ?? ''))) {
          const text = friendlyError(error);
          this.setStatus(`Local requirements guard: ${text}`);
          showTemporaryWorkflowNotification(`Requirements guard: ${text}`);
        } else this.fail(error);
      }
    });
  }

  private post(value: unknown): void {
    void this.view?.webview.postMessage(value);
    if ((value as { type?: string } | undefined)?.type !== 'mobileInfo') this.syncMobile();
  }

  private async initializeMobile(): Promise<void> {
    if (this.mobileInitialization) return this.mobileInitialization;
    this.mobileInitialization = (async () => {
      const enabled = this.context.globalState.get<boolean>(mobileEnabledKey, false);
      const ntfyServer = this.context.globalState.get<string>(mobileServerKey, 'https://ntfy.sh');
      const ntfyTopic = await this.context.secrets.get(mobileTopicSecretKey) ?? '';
      this.mobileSettings = { enabled, ntfyServer, ntfyTopic };
      this.mobile = new MobileBridge(this.mobileSettings, (type, input, index) => this.handleRemoteAction(type, input, index), info => this.sendMobileInfo(info));
      this.syncMobile();
      if (enabled) {
        if (await this.acquireMobileTunnelOwnership()) {
          await this.mobile.startServer();
          const command = await discoverDevTunnel();
          if (command) await this.mobile.startTunnel(command);
        } else this.mobile.setTunnelOwnedElsewhere(true);
      }
      this.sendMobileInfo();
    })();
    return this.mobileInitialization;
  }

  private async enableMobile(): Promise<void> {
    await this.initializeMobile();
    let topic = this.mobileSettings.ntfyTopic;
    if (!topic) {
      topic = `plan-review-${randomUUID().replace(/-/g, '')}`;
      await this.context.secrets.store(mobileTopicSecretKey, topic);
    }
    this.mobileSettings = { enabled: true, ntfyServer: 'https://ntfy.sh', ntfyTopic: topic };
    await this.context.globalState.update(mobileEnabledKey, true);
    await this.context.globalState.update(mobileServerKey, this.mobileSettings.ntfyServer);
    this.mobile?.updateSettings(this.mobileSettings);
    await this.startMobileDashboard();
    this.sendMobileInfo();
  }

  private async disableMobile(): Promise<void> {
    await this.context.globalState.update(mobileEnabledKey, false);
    this.mobileSettings = { ...this.mobileSettings, enabled: false };
    this.mobile?.dispose();
    await this.releaseMobileTunnelOwnership();
    this.mobile = new MobileBridge(this.mobileSettings, (type, input, index) => this.handleRemoteAction(type, input, index), info => this.sendMobileInfo(info));
    this.syncMobile();
    this.sendMobileInfo();
  }

  private sendMobileInfo(info = this.mobile?.info()): void {
    if (info) this.post({ type: 'mobileInfo', info });
  }

  private async acquireMobileTunnelOwnership(): Promise<boolean> {
    if (this.mobileOwnsTunnel) return true;
    const directory = this.context.globalStorageUri.fsPath;
    const lockFile = path.join(directory, 'mobile-tunnel-owner.json');
    await fs.mkdir(directory, { recursive: true });
    const claim = async () => {
      const handle = await fs.open(lockFile, 'wx');
      try { await handle.writeFile(JSON.stringify({ ownerId: this.mobileTunnelOwnerId, pid: process.pid, createdAt: new Date().toISOString(), workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '' }, null, 2)); }
      finally { await handle.close(); }
      this.mobileOwnsTunnel = true;
      this.mobile?.setTunnelOwnedElsewhere(false);
      return true;
    };
    try { return await claim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      const existing = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { ownerId?: string; pid?: number };
      if (existing.ownerId === this.mobileTunnelOwnerId) {
        this.mobileOwnsTunnel = true;
        return true;
      }
      if (Number.isInteger(existing.pid)) {
        try { process.kill(existing.pid!, 0); return false; }
        catch { /* The former VS Code extension host exited without releasing its lock. */ }
      }
      await fs.unlink(lockFile);
      return await claim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await claim();
      throw error;
    }
  }

  private async releaseMobileTunnelOwnership(): Promise<void> {
    if (!this.mobileOwnsTunnel) return;
    const lockFile = path.join(this.context.globalStorageUri.fsPath, 'mobile-tunnel-owner.json');
    this.mobileOwnsTunnel = false;
    try {
      const existing = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { ownerId?: string };
      if (existing.ownerId === this.mobileTunnelOwnerId) await fs.unlink(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async startMobileDashboard(): Promise<void> {
    await this.initializeMobile();
    if (!await this.acquireMobileTunnelOwnership()) {
      this.mobile?.setTunnelOwnedElsewhere(true);
      this.sendMobileInfo();
      return;
    }
    try {
      await this.mobile?.startServer();
      const command = await discoverDevTunnel();
      if (!command) throw new Error('Microsoft dev tunnels is not installed. Install it with “brew install --cask devtunnel”, then reload VS Code.');
      await this.mobile?.startTunnel(command);
      this.sendMobileInfo();
    } catch (error) {
      await this.releaseMobileTunnelOwnership();
      throw error;
    }
  }

  private async stopMobileDashboard(): Promise<void> {
    this.mobile?.stopTunnel();
    await this.releaseMobileTunnelOwnership();
    this.sendMobileInfo();
  }

  private async refreshOllamaModels(): Promise<void> {
    this.setStatus('Checking locally installed Ollama models…');
    this.ollamaModels = await listOllamaModels();
    this.post({ type: 'ollamaModels', models: this.ollamaModels });
    this.setStatus(this.ollamaModels.length
      ? `Found ${this.ollamaModels.length} local Ollama model${this.ollamaModels.length === 1 ? '' : 's'}.`
      : 'Ollama is running, but no local models are installed.');
  }

  private async savePausedResumeGuidance(runFile: string, guidance: string): Promise<void> {
    if (!guidance) return;
    const record = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
    const createdAt = new Date().toISOString();
    const runDir = path.dirname(runFile);
    const file = path.join(runDir, `paused-resume-guidance-${createdAt.replace(/[:.]/g, '-')}.md`);
    await fs.writeFile(file, `# Guidance supplied while paused\n\nRecorded: ${createdAt}\n\n${guidance}\n`, 'utf8');
    record.humanInput = [record.humanInput, `Human guidance supplied while the workflow was paused:\n${guidance}`].filter(Boolean).join('\n\n');
    record.files = Array.isArray(record.files) ? record.files : [];
    record.files.push(file);
    await fs.writeFile(runFile, JSON.stringify(record, null, 2), 'utf8');
  }

  private async reopenApprovedRequirements(correction: string): Promise<void> {
    if (!this.currentRunFile) throw new Error('There is no paused run in this VS Code session. Use “Resume saved run” first.');
    if (!correction) throw new Error('Paste the cumulative requirements correction before reopening the baseline.');
    const runFile = this.currentRunFile;
    const runDir = path.dirname(runFile);
    const record = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
    if (record.requirementsGuard?.status !== 'approved') throw new Error('This run does not have an approved requirements baseline to reopen.');
    if (!['paused', 'cancelled', 'failed'].includes(record.stage)) throw new Error('Pause the workflow before reopening its approved requirements baseline.');
    const round = Math.max(1, record.round || 1);
    const readIfPresent = async (file: string): Promise<string | undefined> => {
      try { return await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const plan = await readIfPresent(path.join(runDir, `round-${round}-plan.md`))
      ?? (round > 1 ? await readIfPresent(path.join(runDir, `round-${round - 1}-plan.md`)) : undefined);
    const review = await readIfPresent(path.join(runDir, `round-${round}-review.md`));
    this.paused = false;
    this.canReopenApprovedRequirements = false;
    this.post({ type: 'paused', paused: false });
    const resume: ResumeContext = {
      runDir,
      record,
      stage: 'planning',
      round: round + 1,
      plan,
      review,
      orchestratorDirection: record.orchestratorDirection
    };
    const approvedAutomatically = await this.prepareRequirementsGuard(runDir, record, resume, correction);
    if (approvedAutomatically) await this.start(record.task, record.preset, undefined, { ...resume, record });
  }

  private async prepareRequirementsGuard(runDir: string, record: RunRecord, resume: ResumeContext, guidance = '', secondaryAttempt = 0): Promise<boolean> {
    const ownsRunningState = !this.running;
    if (ownsRunningState) {
      this.running = true;
      this.controller = new AbortController();
      this.post({ type: 'running', running: true });
    }
    try {
      const model = record.preset.ollamaModel.trim();
      if (!model) throw new Error('Choose a local Ollama model before attaching the requirements guard.');
      const previousBaseline = await readRequirementsBaseline(record);
      const existingCorrections = record.requirementsGuard?.corrections ?? [];
      const migratedCorrections: RequirementsCorrection[] = existingCorrections.length ? [] : (previousBaseline?.requirements ?? [])
        .filter(item => /human correction/i.test(item.source))
        .map(item => ({ createdAt: new Date().toISOString(), text: item.text }));
      const corrections: RequirementsCorrection[] = [...existingCorrections, ...migratedCorrections];
      const correction = guidance.trim();
      if (correction && !corrections.some(item => item.text.trim() === correction)) {
        corrections.push({ createdAt: new Date().toISOString(), text: correction });
      }
      const correctionsPath = path.join(runDir, 'requirements-corrections.md');
      if (corrections.length) {
        const correctionDocument = `# Locked requirements corrections\n\nThese owner-supplied or secondary-review corrections are cumulative. Later baseline regeneration may not remove or weaken an earlier entry.\n\n${corrections.map((item, index) => `## LOCK-${String(index + 1).padStart(3, '0')}\n\nRecorded: ${item.createdAt}\n\n${item.text}`).join('\n\n')}\n`;
        await fs.writeFile(correctionsPath, correctionDocument, 'utf8');
      }
      this.setStatus(`Extracting a requirements baseline locally with ${model}…`);
      const source = await requirementsSourceForRun(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', runDir, record);
      const cumulativeCorrectionSource = corrections.length
        ? `CUMULATIVE LOCKED CORRECTIONS — every entry remains authoritative. Apply all entries together and do not trade one correction for another:\n\n${corrections.map((item, index) => `LOCK-${String(index + 1).padStart(3, '0')} (${item.createdAt}):\n${item.text}`).join('\n\n---\n\n')}\n\n---\n\n`
        : '';
      const extractionSource = `${cumulativeCorrectionSource}${source.text}`;
      const candidate = await extractRequirements(model, extractionSource, this.controller?.signal);
      const repositoryPackageManager = await detectRepositoryPackageManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
      if (repositoryPackageManager) candidate.packageManager = repositoryPackageManager;
      const { baseline, preservedRequirements } = reconcileRequirementsBaseline(previousBaseline, candidate, corrections);
      const digest = baselineDigest(baseline);
      const baselinePath = path.join(runDir, 'requirements-baseline.json');
      const markdownPath = path.join(runDir, 'requirements-baseline.md');
      const candidateHistoryPaths = [...(record.requirementsGuard?.candidateHistoryPaths ?? [])];
      if (previousBaseline) {
        const historyDir = path.join(runDir, 'requirements-history');
        await fs.mkdir(historyDir, { recursive: true });
        const attempt = String(candidateHistoryPaths.length + 1).padStart(2, '0');
        const historyPath = path.join(historyDir, `baseline-before-regeneration-${attempt}.json`);
        await fs.writeFile(historyPath, JSON.stringify(previousBaseline, null, 2), 'utf8');
        candidateHistoryPaths.push(historyPath);
      }
      await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');
      await fs.writeFile(markdownPath, baselineMarkdown(baseline, digest), 'utf8');
      record.requirementsGuard = {
        model,
        status: 'draft',
        baselinePath,
        baselineMarkdownPath: markdownPath,
        digest,
        sourcePaths: source.paths,
        corrections,
        correctionsPath: corrections.length ? correctionsPath : undefined,
        candidateHistoryPaths,
        autoPreservedRequirements: preservedRequirements,
        preservationFailures: record.requirementsGuard?.preservationFailures ?? 0,
        architecturalReviews: record.requirementsGuard?.architecturalReviews ?? 0
      };
      let secondaryReview: SecondaryApprovalReview | undefined;
      if (record.preset.secondarySolApproval) {
        const secondaryRole = secondaryApprovalRole(record.preset);
        this.setStatus(`${secondaryRole.model} is independently reviewing the requirements baseline…`);
        const rawSecondaryReview = await invoke(secondaryRole,
          `Independently audit this generated requirements baseline before human approval. Do not edit files and do not invent product requirements. Reply with ONLY JSON: {"decision":"APPROVE|REVISE|NEEDS_HUMAN","summary":"concise assessment","findings":["specific missing, altered, contradictory, or out-of-scope requirement with source evidence"],"correctionPrompt":"cumulative correction text the human can apply, or empty when approved"}. Choose APPROVE only when the baseline faithfully preserves the current task's approved scope, technologies, constraints, milestones, deferrals, and acceptance conditions without importing later-phase work. Choose REVISE for concrete, source-traceable extraction defects. Choose NEEDS_HUMAN only for a genuine owner decision. Preferences and optional improvements are not defects.\n\nCurrent task:\n${record.task}\n\nSource paths:\n${source.paths.join('\n') || 'Task and parent workflow context'}\n\nGenerated baseline:\n${JSON.stringify(baseline, null, 2)}\n\nApproved source context:\n${source.text.slice(0, 140_000)}`,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', true, this.controller!.signal);
        secondaryReview = parseSecondaryApprovalReview(rawSecondaryReview);
        const reviewNumber = secondaryAttempt + 1;
        const reviewJsonPath = path.join(runDir, `requirements-secondary-approval-review-${reviewNumber}.json`);
        const reviewMarkdownPath = path.join(runDir, `requirements-secondary-approval-review-${reviewNumber}.md`);
        await fs.writeFile(reviewJsonPath, JSON.stringify(secondaryReview, null, 2), 'utf8');
        await fs.writeFile(reviewMarkdownPath, secondaryApprovalMarkdown('Secondary requirements approval review', secondaryRole.model, secondaryReview), 'utf8');
        for (const file of [reviewJsonPath, reviewMarkdownPath]) if (!record.files.includes(file)) record.files.push(file);
        if (secondaryReview.decision === 'NEEDS_HUMAN' && record.preset.secondaryDecisionDelegation && !requiresDirectHumanAction(`${secondaryReview.summary}\n${secondaryReview.findings.join('\n')}`)) {
          this.setStatus(`${secondaryRole.model} is resolving the baseline decision from approved evidence…`);
          const rawDelegation = await invoke(secondaryRole, delegatedDecisionPrompt(
            `${secondaryReview.summary}\n${secondaryReview.findings.join('\n')}`,
            `Current task:\n${record.task}\n\nGenerated baseline:\n${JSON.stringify(baseline, null, 2)}\n\nApproved source context:\n${source.text.slice(0, 140_000)}`
          ), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', true, this.controller!.signal);
          const delegation = parseDelegatedDecision(rawDelegation);
          const delegationJsonPath = path.join(runDir, `requirements-delegated-decision-${reviewNumber}.json`);
          const delegationMarkdownPath = path.join(runDir, `requirements-delegated-decision-${reviewNumber}.md`);
          await fs.writeFile(delegationJsonPath, JSON.stringify(delegation, null, 2), 'utf8');
          await fs.writeFile(delegationMarkdownPath, delegatedDecisionMarkdown('Delegated requirements decision', secondaryRole.model, delegation), 'utf8');
          for (const file of [delegationJsonPath, delegationMarkdownPath]) if (!record.files.includes(file)) record.files.push(file);
          if (delegation.decision === 'RESOLVED') {
            secondaryReview = {
              decision: 'REVISE',
              summary: `Delegated decision resolved from approved evidence: ${delegation.answer}`,
              findings: secondaryReview.findings,
              correctionPrompt: delegation.nextInstruction || delegation.answer
            };
          }
        }
      }
      for (const file of [baselinePath, markdownPath, ...(corrections.length ? [correctionsPath] : [])]) if (!record.files.includes(file)) record.files.push(file);
      if (secondaryReview?.decision === 'REVISE' && secondaryAttempt < 2) {
        const correction = secondaryReview.correctionPrompt || [secondaryReview.summary, ...secondaryReview.findings].join('\n');
        record.stage = 'requirements_secondary_revision';
        await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
        this.setStatus(`${secondaryApprovalRole(record.preset).model} requested a baseline correction. Regenerating and reviewing it automatically…`);
        return await this.prepareRequirementsGuard(runDir, record, resume, correction, secondaryAttempt + 1);
      }
      if (secondaryReview?.decision === 'APPROVE') {
        const approvedAt = new Date().toISOString();
        record.requirementsGuard = { ...record.requirementsGuard, status: 'approved', approvedAt };
        const approvalModel = secondaryApprovalRole(record.preset).model;
        const approvedMarkdown = baselineMarkdown(baseline, digest).replace('Status: Awaiting human approval', `Status: Approved by ${approvalModel} secondary reviewer at ${approvedAt}`);
        await fs.writeFile(markdownPath, approvedMarkdown, 'utf8');
        record.stage = resume.stage;
        await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
        this.pendingRequirements = undefined;
        this.setStatus(`${approvalModel} approved the requirements baseline. Continuing directly into planning…`);
        return true;
      }
      record.stage = 'waiting_for_requirements_approval';
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      this.pendingRequirements = { runDir, record, resume };
      this.pendingMore = undefined;
      this.currentTask = record.task;
      this.activePresetName = record.preset.name;
      this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
      this.currentInteraction = {
        type: 'requirementsApproval',
        text: `Local requirements baseline ready for human review. Open requirements-baseline.md, confirm that it preserves the approved scope without importing later-phase work, then approve it or add another correction. Corrections are cumulative and cannot be removed by regeneration.\n\nModel: ${model}\nExtracted requirements: ${baseline.requirements.length}\nLocked corrections: ${baseline.lockedCorrections.length}\nPrior requirements automatically preserved: ${preservedRequirements}\nDigest: ${digest.slice(0, 12)}…${secondaryReview ? `\n\n${secondaryApprovalRole(record.preset).model} secondary review: ${secondaryReview.decision}\n${secondaryReview.summary}` : ''}`,
        details: secondaryReview?.findings.length ? secondaryApprovalMarkdown('Secondary requirements approval review', secondaryApprovalRole(record.preset).model, secondaryReview) : undefined,
        responseTemplate: secondaryReview?.decision === 'REVISE' ? secondaryReview.correctionPrompt : undefined
      };
      this.setStatus(secondaryReview?.decision === 'REVISE'
        ? `${secondaryApprovalRole(record.preset).model} found requirements-baseline corrections. Review its findings before approval.`
        : 'Requirements baseline awaiting human approval. Planning is paused.');
      this.sendViewState();
      return false;
    } finally {
      if (ownsRunningState) {
        this.running = false;
        this.controller = undefined;
        this.post({ type: 'running', running: false });
      }
    }
  }

  private async approveRequirementsBaseline(): Promise<void> {
    if (!this.pendingRequirements) throw new Error('Open the requirements baseline checkpoint before approving it.');
    const pending = this.pendingRequirements;
    const baseline = await readRequirementsBaseline(pending.record);
    if (!baseline) throw new Error('The requirements baseline could not be read. Regenerate it before continuing.');
    const digest = baselineDigest(baseline);
    if (digest !== pending.record.requirementsGuard?.digest) throw new Error('The baseline JSON changed after extraction. Regenerate it so the human-readable baseline and digest stay synchronized.');
    const approvedAt = new Date().toISOString();
    pending.record.requirementsGuard = { ...pending.record.requirementsGuard!, status: 'approved', approvedAt };
    const markdown = baselineMarkdown(baseline, digest).replace('Status: Awaiting human approval', `Status: Human approved at ${approvedAt}`);
    await fs.writeFile(pending.record.requirementsGuard.baselineMarkdownPath, markdown, 'utf8');
    let resume = pending.resume;
    if (resume.plan) {
      const report = checkPlanPreservation(baseline, resume.plan);
      const reportPath = path.join(pending.runDir, `round-${Math.max(1, pending.record.round)}-preservation-report.md`);
      await fs.writeFile(reportPath, preservationMarkdown(report, Math.max(1, pending.record.round)), 'utf8');
      if (!pending.record.files.includes(reportPath)) pending.record.files.push(reportPath);
      if (!report.passed) {
        pending.record.requirementsGuard.preservationFailures += 1;
        resume = {
          ...resume,
          stage: 'planning',
          orchestratorDirection: `${resume.orchestratorDirection || pending.record.orchestratorDirection || ''}\n\nBefore another architectural review, repair only these deterministic requirements-preservation failures:\n${report.failures.map(item => `- ${item}`).join('\n')}\nAdd or correct the workflow-requirements block without changing unrelated plan content.`.trim()
        };
      }
    }
    const hardLimit = pending.record.parentRunId ? maxChildPlanningRounds : 50;
    pending.record.preset = { ...pending.record.preset, requirementsGuard: true, maxRounds: Math.min(hardLimit, Math.max(pending.record.preset.maxRounds, resume.round + 2)) };
    pending.record.stage = resume.stage;
    await fs.writeFile(path.join(pending.runDir, 'run.json'), JSON.stringify(pending.record, null, 2), 'utf8');
    this.pendingRequirements = undefined;
    await this.start(pending.record.task, pending.record.preset, undefined, { ...resume, record: pending.record });
  }

  private async declineRequirementsBaseline(reason: string): Promise<void> {
    if (!this.pendingRequirements) throw new Error('Open the requirements baseline checkpoint before declining it.');
    const pending = this.pendingRequirements;
    const declinedAt = new Date().toISOString();
    const explanation = reason || 'The local extraction was not reliable enough to approve. Continue from the approved task, specification, and parent roadmap without treating this candidate as authoritative.';
    const authoritativeSources = pending.record.requirementsGuard?.sourcePaths ?? [];
    const sourceDirections = authoritativeSources.length ? `\n\nAuthoritative source files to inspect directly:\n${authoritativeSources.map(item => `- ${item}`).join('\n')}` : '';
    const artifactPath = path.join(pending.runDir, 'requirements-baseline-declined.md');
    await fs.writeFile(artifactPath, `# Local requirements baseline declined\n\nDeclined: ${declinedAt}\n\n${explanation}\n\nThe generated baseline remains in the run history for diagnosis, but it is not an approved scope contract. The approved task, selected specification, parent roadmap, planning ledger, and human guidance remain authoritative.${sourceDirections}\n`, 'utf8');
    if (!pending.record.files.includes(artifactPath)) pending.record.files.push(artifactPath);
    pending.record.requirementsGuard = { ...pending.record.requirementsGuard!, status: 'declined', declinedAt, declineReason: explanation };
    pending.record.preset = { ...pending.record.preset, requirementsGuard: false };
    pending.record.humanInput = [pending.record.humanInput, `Local requirements baseline declined at ${declinedAt}. Do not use it as a scope contract. Continue from the approved task, selected specification, parent roadmap, and planning ledger. Inspect the authoritative source files directly rather than relying on the rejected extraction. Reason: ${explanation}${sourceDirections}`].filter(Boolean).join('\n\n');
    pending.record.stage = pending.resume.stage;
    await fs.writeFile(path.join(pending.runDir, 'run.json'), JSON.stringify(pending.record, null, 2), 'utf8');
    this.pendingRequirements = undefined;
    await this.start(pending.record.task, pending.record.preset, undefined, { ...pending.resume, record: pending.record });
  }

  private syncMobile(): void {
    const snapshot: MobileSnapshot = {
      status: this.currentStatus,
      task: this.currentTask,
      workflowName: this.currentWorkflowName || undefined,
      phaseName: this.currentTask.match(/(?:^|\n)Phase:\s*([^\n]+)/i)?.[1]?.trim(),
      running: this.running,
      paused: this.paused,
      canReturnToWorkflow: Boolean(this.returnToRunFile),
      interaction: this.currentInteraction,
      artifacts: this.currentArtifacts
    };
    this.mobile?.updateState(snapshot);
  }

  private async handleRemoteAction(type: string, humanInput = '', index?: number): Promise<void> {
    if (type === 'continue') {
      if (!this.pending) throw new Error('There is no planning question waiting for an answer.');
      await this.start(this.pending.record.task, this.pending.record.preset, humanInput, this.pending);
      return;
    }
    if (type === 'continueCode') {
      if (!this.pendingCode) throw new Error('There is no code-review question waiting for an answer.');
      const pending = this.pendingCode;
      pending.record.humanInput = [pending.record.humanInput, humanInput].filter(Boolean).join('\n\n');
      const implementation = pending.stage === 'code_reviewing' && humanInput
        ? `${pending.implementation || ''}\n\nHuman-provided interactive verification evidence:\n${humanInput}`
        : pending.implementation;
      await this.startCode(pending.runDir, pending.record, pending.plan, { ...pending, stage: pending.stage, implementation });
      return;
    }
    if (type === 'implementPlan') {
      if (!this.pendingImplementation) throw new Error('There is no approved plan waiting for implementation.');
      await saveImplementationApprovalGuidance(this.pendingImplementation.runDir, this.pendingImplementation.record, humanInput);
      await this.startCode(this.pendingImplementation.runDir, this.pendingImplementation.record, this.pendingImplementation.plan);
      return;
    }
    if (type === 'startNextPhase') {
      if (!this.pendingNextPhase) throw new Error('There is no next phase ready to plan.');
      await this.startPhase(this.pendingNextPhase.parentRunDir, this.pendingNextPhase.parentRecord, this.pendingNextPhase.index, humanInput);
      return;
    }
    if (type === 'reopenCompletedPhase') { await this.reopenCompletedPhase(humanInput); return; }
    if (type === 'acceptRoadmap') { await this.acceptRoadmap(humanInput); return; }
    if (type === 'startSplitPhase') {
      if (!this.pendingSplit || !Number.isInteger(index)) throw new Error('There is no split phase available at that position.');
      await this.startPhase(this.pendingSplit.runDir, this.pendingSplit.record, index!, humanInput);
      return;
    }
    if (type === 'continuePlanning') {
      if (!this.pendingMore) throw new Error('There is no planning checkpoint waiting to continue.');
      const pending = this.pendingMore;
      const hardLimit = pending.record.parentRunId ? maxChildPlanningRounds : 50;
      const nextMaximum = Math.min(hardLimit, pending.record.preset.maxRounds + 3);
      if (nextMaximum <= pending.record.preset.maxRounds) throw new Error(pending.record.parentRunId
        ? 'This child phase reached its planning limit. Return to the nearest useful parent phase instead of splitting it again.'
        : 'This workflow reached the planning safety limit.');
      pending.record.preset = { ...pending.record.preset, maxRounds: nextMaximum };
      beginHumanDirectedRequirementsPass(pending.record, humanInput);
      await savePlanningGuidance(pending.runDir, pending.record, pending.round, humanInput);
      await this.start(pending.record.task, pending.record.preset, undefined, pending);
      return;
    }
    if (type === 'continueImplementation') {
      if (!this.pendingMoreCode) throw new Error('There is no implementation checkpoint waiting to continue.');
      const pending = this.pendingMoreCode;
      pending.record.humanInput = [pending.record.humanInput, humanInput].filter(Boolean).join('\n\n');
      const nextMaximum = Math.min(30, pending.record.preset.maxCodeRounds + 3);
      if (nextMaximum <= pending.record.preset.maxCodeRounds) throw new Error('This workflow reached the code-review safety limit.');
      pending.record.preset = { ...pending.record.preset, maxCodeRounds: nextMaximum };
      await this.startCode(pending.runDir, pending.record, pending.plan, { ...pending, stage: 'implementing', round: pending.round + 1 });
      return;
    }
    if (type === 'runFinalVerification') { await this.runFinalVerification(humanInput); return; }
    if (type === 'completeAcceptance') { await this.completeAcceptance(humanInput); return; }
    if (type === 'recheckPrerequisite') {
      if (!this.pendingPrerequisite) throw new Error('There is no waiting prerequisite to recheck.');
      const pending = this.pendingPrerequisite;
      await this.start(pending.record.task, pending.record.preset, humanInput, { ...pending, stage: 'reviewing', review: undefined });
      return;
    }
    if (type === 'startPrerequisiteWorkflow') { await this.startPrerequisiteWorkflow(); return; }
    if (type === 'pause') { this.pauseRequested = true; this.controller?.abort(); return; }
    if (type === 'stop') { this.stopRequested = true; this.controller?.abort(); return; }
    if (type === 'resumeCurrent') {
      if (!this.currentRunFile) throw new Error('There is no saved current run to resume.');
      await this.resumeRun(this.currentRunFile);
      return;
    }
    if (type === 'returnToWorkflow') { await this.returnToWaitingWorkflow(); return; }
    throw new Error('Unsupported remote workflow action.');
  }

  dispose(): void {
    this.mobile?.dispose();
    void this.releaseMobileTunnelOwnership();
  }

  private async startPrerequisiteWorkflow(): Promise<void> {
    if (!this.pendingPrerequisite) throw new Error('Open the waiting phase again before starting its prerequisite.');
    const pending = this.pendingPrerequisite;
    const prerequisite = pending.prerequisite;
    const waitingPhase = pending.record.splitPhaseTitle || pending.record.workflowName || 'the saved phase';
    const task = `Review the repository's current backlog and planning documents, then create a standalone implementation plan for ${prerequisite.title}. This work is an external prerequisite for the saved phase “${waitingPhase}”. Keep this workflow limited to ${prerequisite.title}; do not absorb or complete the waiting phase.\n\nWhy it is required:\n${prerequisite.reason}\n\nEvidence needed before returning to the waiting phase:\n${prerequisite.resumeWhen}`;
    await this.start(task, pending.record.preset, 'This workflow was started from a saved phase that is waiting on this prerequisite.', undefined, undefined, undefined, undefined, undefined, undefined, undefined, path.join(pending.runDir, 'run.json'));
  }

  private async returnToWaitingWorkflow(): Promise<void> {
    if (this.running) throw new Error('Pause or stop the current workflow before returning to its parent workflow.');
    const target = this.returnToRunFile;
    if (!target) throw new Error('This workflow does not have a saved parent link. Use “Resume saved run…” for workflows created by an older extension version.');
    try { await fs.access(target); }
    catch { throw new Error('The parent workflow’s run.json could not be found. Use “Resume saved run…” to locate it.'); }
    await this.resumeRun(target);
  }

  private async completeAcceptance(results: string): Promise<void> {
    if (!this.pendingAcceptance) throw new Error('There is no human acceptance checklist waiting for results.');
    if (!results.trim()) throw new Error('Record which acceptance checks passed or failed before completing this phase.');
    if (hasUnresolvedAcceptanceTemplate(results)) throw new Error('Replace every PASS/FAIL choice and placeholder in the acceptance template with the actual result before submitting it.');
    const outcome = acceptanceOutcome(results);
    if (outcome === 'unknown') throw new Error('State an explicit overall acceptance result of PASS or FAIL before submitting.');
    const { runDir, record } = this.pendingAcceptance;
    const file = path.join(runDir, 'human-acceptance-results.md');
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const handoffText = `${record.acceptanceInstructions || ''}\n${record.acceptanceResponseTemplate || ''}`;
    const targetMatches = [...handoffText.matchAll(/(?:results file (?:to update|updated)|saved execution report(?: that)? must subsequently be updated)\s*(?::|is)\s*`?([^`\n]+\.md)`?/gi)];
    const updatedTargets: string[] = [];
    if (workspace) {
      for (const match of targetMatches) {
        const target = path.resolve(match[1].trim());
        if (!isInsideDirectory(target, path.resolve(workspace))) continue;
        try {
          await fs.appendFile(target, `\n\n## Human acceptance result (${new Date().toISOString()})\n\n${results.trim()}\n`, 'utf8');
          updatedTargets.push(target);
          if (!record.files.includes(target)) record.files.push(target);
        } catch { /* Preserve the dedicated result artifact even when an older referenced file is unavailable. */ }
      }
    }
    await fs.writeFile(file, `# Human acceptance results\n\n${results.trim()}\n${updatedTargets.length ? `\nUpdated workflow result files:\n${updatedTargets.map(target => `- ${target}`).join('\n')}\n` : ''}`, 'utf8');
    record.acceptanceResultsPath = file;
    record.humanInput = [record.humanInput, `Human acceptance results:\n${results.trim()}`].filter(Boolean).join('\n\n');
    if (!record.files.includes(file)) record.files.push(file);
    if (outcome === 'fail') {
      record.acceptanceStatus = 'failed';
      record.stage = 'waiting_for_prerequisite';
      record.prerequisite = {
        title: `${record.splitPhaseTitle || record.workflowName || 'Workflow'} acceptance remediation`,
        reason: `Human acceptance recorded an overall FAIL. The complete findings and evidence are saved in ${file}. Plan and implement the actionable product fixes before this acceptance phase can be rerun or completed.`,
        resumeWhen: 'The accepted remediation is implemented and reviewed, required automated checks pass, the tested changes are committed on the current branch, and the tracked working tree is clean. Then rerun the failed and invalidated acceptance checks and record a new overall PASS or FAIL.'
      };
      record.codeDetail = `Human acceptance failed. This phase remains incomplete and requires remediation before another acceptance run. Results: ${file}`;
      if (record.parentRunId && Number.isInteger(record.splitPhaseIndex)) {
        try {
          const parentFile = path.join(path.dirname(runDir), record.parentRunId, 'run.json');
          const parent = JSON.parse(await fs.readFile(parentFile, 'utf8')) as RunRecord;
          parent.completedPhaseIndexes = (parent.completedPhaseIndexes ?? []).filter(index => index !== record.splitPhaseIndex);
          const total = parent.splitPhases?.length ?? 0;
          parent.stage = 'split_in_progress';
          parent.detail = `${parent.completedPhaseIndexes.length} of ${total} split phases are complete. The failed acceptance phase remains open for remediation.`;
          await fs.writeFile(parentFile, JSON.stringify(parent, null, 2), 'utf8');
        } catch { /* The child remains failed even if an older parent record cannot be repaired. */ }
      }
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      const planPath = record.approvedPlanPath || path.join(runDir, `round-${record.round}-plan.md`);
      const plan = await fs.readFile(planPath, 'utf8');
      this.pendingAcceptance = undefined;
      this.showWaitingForPrerequisite(runDir, record, plan, undefined, record.prerequisite);
      return;
    }
    record.acceptanceStatus = 'complete';
    record.stage = 'code_ready';
    record.codeDetail = `Human acceptance completed with an overall PASS. The recorded results are saved in ${file}.`;
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
    this.pendingAcceptance = undefined;
    await this.showCodeReady(runDir, record);
  }

  private async invalidateCompletedPhaseChain(runDir: string, record: RunRecord, reason: string): Promise<void> {
    let child = record;
    let childRunDir = runDir;
    const visited = new Set<string>();
    while (child.parentRunId && !visited.has(child.parentRunId)) {
      visited.add(child.parentRunId);
      const parentRunDir = path.join(path.dirname(childRunDir), child.parentRunId);
      const parentFile = path.join(parentRunDir, 'run.json');
      const parent = JSON.parse(await fs.readFile(parentFile, 'utf8')) as RunRecord;
      const phases = parent.splitPhases ?? [];
      const index = Number.isInteger(child.splitPhaseIndex)
        ? child.splitPhaseIndex!
        : phases.findIndex(phase => phase.title === child.splitPhaseTitle || child.task.includes(`Phase: ${phase.title}\n`));
      if (index < 0) throw new Error('The completed phase could not be matched to its parent workflow. Open its saved run and try again.');
      parent.completedPhaseIndexes = (parent.completedPhaseIndexes ?? []).filter(completedIndex => completedIndex !== index);
      parent.stage = 'split_in_progress';
      parent.detail = `${parent.completedPhaseIndexes.length} of ${phases.length} split phases are complete. ${reason}`;
      await fs.writeFile(parentFile, JSON.stringify(parent, null, 2), 'utf8');
      child = parent;
      childRunDir = parentRunDir;
    }
  }

  private async reopenCompletedPhase(findings: string): Promise<void> {
    if (!this.pendingReopen) throw new Error('Open the completed phase again before recording post-completion findings.');
    if (!findings.trim()) throw new Error('Paste the outside review findings before reopening this phase.');
    const source = this.pendingReopen;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) throw new Error('Open the project folder in VS Code before reopening this phase.');
    const approvedPlanPath = await resolveApprovedPlanPath(workspace, source.record);
    if (!approvedPlanPath) throw new Error('The completed phase does not have an approved plan to use for bounded remediation.');
    await fs.writeFile(path.join(source.runDir, 'run.json'), JSON.stringify(source.record, null, 2), 'utf8');
    const plan = await fs.readFile(approvedPlanPath, 'utf8');
    if (!plan.trim()) throw new Error('The approved phase plan is empty or unavailable.');
    const remediationId = randomUUID();
    const remediationRunDir = path.join(path.dirname(source.runDir), remediationId);
    await fs.mkdir(remediationRunDir, { recursive: false });
    const findingsPath = path.join(remediationRunDir, 'post-completion-findings.md');
    const priorCompletionPath = path.join(remediationRunDir, 'superseded-completion-record.md');
    const priorPlanPath = path.join(remediationRunDir, 'prior-approved-plan.md');
    const reopenedAt = new Date().toISOString();
    await fs.writeFile(findingsPath, `# Post-completion findings\n\nRecorded: ${reopenedAt}\nSource completed run: ${source.record.id}\n\n${findings.trim()}\n`, 'utf8');
    await fs.writeFile(priorCompletionPath, `# Superseded completion record\n\nThe source phase was previously marked complete. Its artifacts remain in run ${source.record.id}. Completion was reopened at ${reopenedAt} because an outside review found additional bounded work.\n\nPrevious result:\n\n${source.record.codeDetail || source.record.detail || 'No completion summary was recorded.'}\n`, 'utf8');
    await fs.writeFile(priorPlanPath, `# Prior approved plan snapshot\n\nSource: ${approvedPlanPath}\nCaptured: ${reopenedAt}\n\n${plan.trim()}\n`, 'utf8');
    const phaseTitle = source.record.splitPhaseTitle || source.record.workflowName || 'completed phase';
    const remediationTask = `Create a focused correction plan for post-completion findings in ${phaseTitle}. Planning only: do not implement until the human separately approves the remediation plan. Do not begin the next phase.\n\nOutside review findings:\n${findings.trim()}`;
    const direction = `Produce and review a standalone, bounded remediation plan before any code changes. Treat the saved prior approved plan snapshot at ${priorPlanPath} as authoritative context, and apply only the recorded post-completion findings. Inspect the current repository and Git state read-only while planning. Preserve accepted work that the findings do not invalidate, preserve the human-owned Git index, and do not begin the next phase, broaden architecture, or repeat already satisfied work. The reviewer must verify that every proposed change traces to the outside findings or concrete repository evidence. The orchestrator may request targeted plan corrections, but implementation requires a separate human click after READY_TO_CODE. Treat .review-workflow/ as volatile orchestration metadata rather than product source.\n\nPost-completion findings:\n${findings.trim()}`;
    const sourcePreset = validatePreset(source.record.preset);
    const preset = { ...sourcePreset, requirementsGuard: false, maxRounds: Math.min(3, sourcePreset.maxRounds), maxCodeRounds: 3 };
    const remediationLedger: PlanningLedger = {
      objective: remediationTask,
      inScope: [findings.trim()],
      lockedDecisions: [
        'Apply only the recorded post-completion findings and preserve accepted work that they do not invalidate.',
        'Do not begin the next phase or reopen unrelated resolved findings.',
        'The user owns staging and committing; agents must preserve the Git index.'
      ],
      unresolvedFindings: [findings.trim()],
      deferred: [
        'All original phase scope not implicated by the outside findings.',
        'The next roadmap phase and unrelated future work.'
      ],
      findings: []
    };
    const remediationRecord: RunRecord = {
      id: remediationId,
      task: remediationTask,
      originalTask: remediationTask,
      workflowName: `${source.record.workflowName || phaseTitle} — remediation`.slice(0, 100),
      phasePath: source.record.phasePath,
      humanInput: `Original phase task:\n${source.record.originalTask ?? source.record.task}\n\nPrior approved plan snapshot (authoritative context):\n${priorPlanPath}\n\n${source.record.requirementsGuard?.status === 'approved' ? `Previously approved requirements baseline (context only; do not expand the remediation to re-cover unaffected requirements):\n${source.record.requirementsGuard.baselineMarkdownPath}\n\n` : ''}Outside post-completion review:\n${findings.trim()}\n\nThis run is planning-only until the human clicks “Implement approved plan”.`,
      sourcePlanPath: priorPlanPath,
      requirementsSourcePath: source.record.requirementsSourcePath,
      claudeSessions: {},
      parentRunId: source.record.parentRunId,
      returnToRunFile: source.record.returnToRunFile,
      splitPhaseIndex: source.record.splitPhaseIndex,
      splitPhaseTitle: source.record.splitPhaseTitle,
      orchestratorDirection: direction,
      planningLedger: remediationLedger,
      remediationOfRunId: source.record.id,
      implementationRequiresHumanApproval: true,
      preset,
      stage: 'planning',
      round: 0,
      detail: `Focused remediation planning is in progress for ${phaseTitle}. Implementation has not been authorized.`,
      additionalDirectories: source.record.additionalDirectories,
      files: [findingsPath, priorCompletionPath, priorPlanPath]
    };
    await persistOriginalTask(remediationRunDir, remediationRecord);
    await fs.writeFile(path.join(remediationRunDir, 'run.json'), JSON.stringify(remediationRecord, null, 2), 'utf8');
    source.record.supersededByRemediationRunId = remediationId;
    source.record.stage = 'superseded_by_remediation';
    source.record.detail = `Completion was reopened for bounded remediation in run ${remediationId}.`;
    await fs.writeFile(path.join(source.runDir, 'run.json'), JSON.stringify(source.record, null, 2), 'utf8');
    await this.invalidateCompletedPhaseChain(source.runDir, source.record, `The completed phase “${phaseTitle}” is reopened for bounded remediation.`);
    this.pendingReopen = undefined;
    await this.start(remediationTask, preset, undefined, {
      runDir: remediationRunDir,
      record: remediationRecord,
      stage: 'planning',
      round: 1,
      orchestratorDirection: direction
    });
  }

  private async runFinalVerification(humanInput = ''): Promise<void> {
    if (!this.pendingMoreCode) throw new Error('There is no verification checkpoint waiting to continue.');
    const pending = this.pendingMoreCode;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) throw new Error('Open the project folder in VS Code first.');
    const approvedDirectories = await inferApprovedHomeDirectories(pending.record.codeDetail ?? '', workspace);
    for (const directory of approvedDirectories) await fs.mkdir(directory, { recursive: true });
    pending.record.additionalDirectories = [...new Set([...(pending.record.additionalDirectories ?? []), ...approvedDirectories])];
    const round = Math.max(1, pending.record.codeRound || pending.round || 1);
    const attempt = (pending.record.verificationRetryCount ?? 0) + 1;
    pending.record.verificationRetryCount = attempt;
    const preservedFiles: string[] = [];
    for (const [kind, extension] of [['implementation', 'md'], ['review', 'md'], ['decision', 'json']] as const) {
      const source = path.join(pending.runDir, `code-round-${round}-${kind}.${extension}`);
      const destination = path.join(pending.runDir, `code-round-${round}-before-verification-attempt-${attempt}-${kind}.${extension}`);
      try {
        await fs.copyFile(source, destination);
        preservedFiles.push(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    pending.record.files = [...new Set([...pending.record.files, ...preservedFiles])];
    pending.record.humanInput = [pending.record.humanInput, humanInput].filter(Boolean).join('\n\n');
    pending.record.stage = 'final_verification';
    await fs.writeFile(path.join(pending.runDir, 'run.json'), JSON.stringify(pending.record, null, 2), 'utf8');
    const direction = `${gitIndexPolicy}\n\n${blockedCommandPolicy}\n\n${pending.direction || pending.record.codeDetail || 'Complete the remaining local verification.'}\n\nThis is an explicit final verification pass. Run every remaining repository-provided local command now, using bash or sh for repository scripts. Do not repeat a review-only summary.${approvedDirectories.length ? ` The human authorized these additional working directories by selecting this action: ${approvedDirectories.join(', ')}.` : ''} If a provider permission still blocks a command, report exactly “COMMAND_BLOCKED: <exact command>” and stop so the workflow asks the human immediately.`;
    await this.startCode(pending.runDir, pending.record, pending.plan, { ...pending, stage: 'implementing', round, implementation: undefined, direction });
  }

  private async acceptRoadmap(notesValue: string): Promise<void> {
    if (!this.pendingSplit || this.pendingSplit.record.decision !== 'ROADMAP_READY') throw new Error('Open a roadmap-ready workflow before recording provisional acceptance.');
    const pending = this.pendingSplit;
    const notes = notesValue.trim();
    const acceptedAt = new Date().toISOString();
    const file = path.join(pending.runDir, 'roadmap-provisional-acceptance.md');
    await fs.writeFile(file, `# Provisional roadmap acceptance\n\nRecorded: ${acceptedAt}\n\nThe architecture and phase roadmap are accepted as the working direction. This does not authorize implementation of later phases or make deferred decisions final.\n\n## Secondary-review notes\n\n${notes || 'No additional notes were supplied.'}\n`, 'utf8');
    pending.record.roadmapAcceptance = { status: 'provisional', acceptedAt, notes, artifactPath: file };
    if (!pending.record.files.includes(file)) pending.record.files.push(file);
    await fs.writeFile(path.join(pending.runDir, 'run.json'), JSON.stringify(pending.record, null, 2), 'utf8');
    this.showSplit(pending.runDir, pending.record, {
      decision: 'ROADMAP_READY',
      detail: 'Roadmap provisionally accepted. The saved secondary-review notes will be inherited by focused phase plans. Choose the next phase and optionally add phase-specific startup notes.',
      plannerPrompt: '',
      phases: pending.record.splitPhases ?? pending.phases
    }, pending.plan);
  }

  private async startPhase(parentRunDir: string, parentRecord: RunRecord, index: number, phaseGuidance = '', phasePresetName = ''): Promise<void> {
    const phase = parentRecord.splitPhases?.[index];
    if (!phase) throw new Error('That split phase is no longer available.');
    const selectedPreset = phasePresetName ? this.getPresets().find(item => item.name === phasePresetName) : undefined;
    if (phasePresetName && !selectedPreset) throw new Error(`The selected phase preset “${phasePresetName}” is no longer available.`);
    const inheritedPreset = validatePreset(selectedPreset ?? parentRecord.preset);
    const preset = { ...inheritedPreset, maxRounds: Math.min(3, inheritedPreset.maxRounds) };
    const parentPlan = parentRecord.workingDraftPath ?? path.join(parentRunDir, `round-${parentRecord.round}-plan.md`);
    const siblingEvidence = await completedSiblingEvidence(path.dirname(parentRunDir), parentRecord.id);
    const roadmapNotes = parentRecord.roadmapAcceptance?.notes?.trim();
    const task = `Create a standalone implementation plan for this focused phase of parent workflow ${parentRecord.id}.

Phase: ${phase.title}
Objective: ${phase.objective}
Dependencies: ${phase.dependsOn.length ? phase.dependsOn.join(', ') : 'None'}
Parent plan: ${parentPlan}
Parent orchestrator direction: ${parentRecord.orchestratorDirection || parentRecord.detail || 'Use the selected phase objective.'}
${roadmapNotes ? `Parent roadmap secondary-review notes:\n${roadmapNotes}\n\nApply only the notes relevant to this phase. Preserve later-phase findings and decision deadlines for their owning phases; do not absorb them into this plan.` : ''}
${siblingEvidence ? `
Evidence inherited from completed sibling phases:
${siblingEvidence}

Treat matching recorded PASS evidence as already satisfied. Do not prescribe or run the same acceptance check again unless a change made after that evidence invalidates it.
` : ''}

Use the parent plan and repository as context, but keep this child plan limited to this phase. Do not re-plan the remaining parent scope. Inspect the current working tree before prescribing changes. If earlier overlapping work already satisfies some or all of this phase, produce a bounded verification plan for the remaining acceptance checks instead of repeating implementation.`;
    await this.start(task, preset, phaseGuidance, undefined, undefined, parentRecord.id, index, phase.title, parentRecord.workflowName, [...(parentRecord.phasePath ?? []), index + 1], parentRecord.returnToRunFile);
  }
  private rememberRun(runFile: string): void {
    this.currentRunFile = runFile;
    void this.context.workspaceState.update(lastRunKey, runFile);
  }
  private async applyPresetToRun(runFile: string, presetName: string): Promise<void> {
    const record = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
    const selected = this.getPresets().find(item => item.name === presetName);
    if (!selected) throw new Error(`The selected retry preset “${presetName}” is no longer available.`);
    const current = validatePreset(record.preset);
    const replacement = validatePreset(selected);
    record.preset = {
      ...replacement,
      maxRounds: current.maxRounds,
      maxCodeRounds: current.maxCodeRounds,
      requirementsGuard: current.requirementsGuard || replacement.requirementsGuard
    };
    record.claudeSessions = {};
    record.humanInput = [record.humanInput, `Workflow preset changed at a saved checkpoint from “${current.name}” to “${replacement.name}”. Continue from the existing repository state and saved evidence; do not repeat completed work.`].filter(Boolean).join('\n\n');
    await fs.writeFile(runFile, JSON.stringify(record, null, 2), 'utf8');
    this.activePresetName = replacement.name;
  }
  private getPresets(): Preset[] {
    const saved = this.context.globalState.get<Preset[]>(presetsKey);
    if (Array.isArray(saved) && saved.length) return saved;
    const legacy = this.context.globalState.get<Preset>('preset');
    return [legacy ?? defaultPreset];
  }
  private sendPresets(selectedName?: string): void {
    const presets = this.getPresets();
    const selected = presets.find(item => item.name === (selectedName ?? this.activePresetName)) ?? presets[0];
    this.post({ type: 'presets', presets, selected });
    this.post({ type: 'running', running: this.running });
  }
  private setStatus(text: string): void {
    this.currentStatus = text;
    this.post({ type: 'status', text });
  }
  private sendViewState(): void {
    this.post({
      type: 'restore',
      running: this.running,
      paused: this.paused,
      status: this.currentStatus,
      task: this.currentTask,
      workflowName: this.currentWorkflowName,
      canReturnToWorkflow: Boolean(this.returnToRunFile),
      artifacts: this.currentArtifacts,
      interaction: this.currentInteraction,
      canReopenApprovedRequirements: this.canReopenApprovedRequirements
    });
  }
  private fail(error: unknown): void {
    const text = friendlyError(error);
    this.currentInteraction = { type: 'failed', text };
    this.setStatus(`Stopped: ${text}`);
    this.post({ type: 'failed', text });
    this.post({ type: 'running', running: false });
    showTemporaryWorkflowNotification(`Stopped: ${text}`);
  }

  private showSplit(runDir: string, record: RunRecord, result: DecisionResult, plan?: string): void {
    record.splitPhases = result.phases;
    this.pendingSplit = { runDir, record, phases: result.phases, plan };
    this.pending = undefined;
    this.pendingMore = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    this.currentInteraction = {
      type: 'split',
      text: result.detail,
      phases: result.phases,
      roadmapReady: record.decision === 'ROADMAP_READY',
      roadmapAccepted: record.roadmapAcceptance?.status === 'provisional',
      roadmapNotes: record.roadmapAcceptance?.notes
    };
    this.setStatus(record.decision === 'ROADMAP_READY'
      ? record.roadmapAcceptance?.status === 'provisional'
        ? `Roadmap provisionally accepted. Choose a phase to plan next; each phase can receive additional startup notes.`
        : `Architecture and roadmap approved after round ${record.round}/${record.preset.maxRounds}. Record provisional acceptance or choose a phase to plan; implementation is not authorized by the roadmap.`
      : `Split recommended after round ${record.round}/${record.preset.maxRounds}. Choose a focused phase to plan next.`);
    this.sendViewState();
  }

  private showMorePlanning(runDir: string, record: RunRecord, result: DecisionResult, plan?: string, review?: string): void {
    this.pendingMore = {
      runDir,
      record,
      stage: 'planning',
      round: record.round + 1,
      plan,
      review,
      orchestratorDirection: result.plannerPrompt || result.detail
    };
    this.pending = undefined;
    this.pendingSplit = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    const atChildLimit = Boolean(record.parentRunId) && record.round >= maxChildPlanningRounds;
    const atRequirementsGuardLimit = Boolean(record.requirementsGuard?.status === 'approved'
      && (record.requirementsGuard.architecturalReviews >= 2 || record.requirementsGuard.preservationFailures >= 2));
    const atRequirementsRestartLimit = atRequirementsGuardLimit && (record.requirementsGuard?.humanDirectedPasses ?? 0) >= 2;
    const finalCorrection = Boolean(record.parentRunId) && record.round === maxChildPlanningRounds - 1;
    this.currentInteraction = { type: planningCheckpointInteractionType(atChildLimit || atRequirementsRestartLimit), text: result.detail, finalCorrection, requirementsGuardAttached: Boolean(record.requirementsGuard), requirementsGuardLimit: atRequirementsGuardLimit };
    this.setStatus(atChildLimit
      ? 'This child used its final bounded correction pass. Return to the parent workflow; do not split this child again.'
      : atRequirementsRestartLimit
      ? 'This requirements-guarded run did not converge after two human-directed restarts. Start a smaller focused workflow instead of extending it again.'
      : atRequirementsGuardLimit
      ? 'Requirements-guarded planning stopped at its review limit. Human direction is required before another focused run.'
      : finalCorrection
        ? 'One final bounded correction pass is available. No implementation or acceptance rerun is required.'
        : `More planning is required after round ${record.round}/${record.preset.maxRounds}. The current plan is not ready to implement.`);
    this.sendViewState();
  }

  private showReadyToCode(runDir: string, record: RunRecord, plan: string): void {
    this.pendingImplementation = { runDir, record, plan };
    this.pending = undefined;
    this.pendingSplit = undefined;
    this.pendingMore = undefined;
    this.pendingCode = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    this.currentInteraction = { type: 'readyToCode', text: record.detail || 'The plan passed review and is ready for implementation.' };
    this.setStatus('Plan ready. Implementation will begin only when you click “Implement approved plan”.');
    this.sendViewState();
  }

  private showWaitingForPrerequisite(runDir: string, record: RunRecord, plan: string, review: string | undefined, prerequisite: Prerequisite): void {
    record.stage = 'waiting_for_prerequisite';
    record.prerequisite = prerequisite;
    this.pendingPrerequisite = { runDir, record, stage: 'deciding', round: Math.max(1, record.round || 1), plan, review, prerequisite };
    this.pendingImplementation = undefined;
    this.pendingAcceptance = undefined;
    this.pendingCode = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.paused = true;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    this.currentInteraction = {
      type: 'prerequisitePending',
      text: `Waiting for prerequisite: ${prerequisite.title}`,
      details: `${prerequisite.reason}\n\nResume condition:\n${prerequisite.resumeWhen}\n\nThis phase remains saved and incomplete. Choose “Start prerequisite workflow” to begin the outside work. After it is complete, return to this saved run and choose “Recheck prerequisite”.`
    };
    this.setStatus(`Waiting for prerequisite: ${prerequisite.title}. This phase is preserved and has not failed or completed.`);
    this.sendViewState();
  }

  private showPrerequisiteComplete(runDir: string, record: RunRecord): void {
    this.pending = undefined;
    this.pendingSplit = undefined;
    this.pendingMore = undefined;
    this.pendingImplementation = undefined;
    this.pendingPrerequisite = undefined;
    this.pendingCode = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    this.currentInteraction = { type: 'prerequisiteComplete', text: record.detail || 'This prerequisite workflow is complete. Return to the saved waiting workflow and recheck its resume condition.' };
    this.setStatus('Prerequisite workflow complete. Choose “Return to waiting workflow”.');
    this.sendViewState();
  }

  private async showCodeReady(runDir: string, record: RunRecord): Promise<void> {
    this.pendingImplementation = undefined;
    this.pendingCode = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.pendingAcceptance = undefined;
    this.pendingReopen = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    const acceptanceActions = pendingAcceptanceActions(record);
    if (acceptanceActions.length) {
      record.acceptanceStatus = 'pending';
      record.stage = 'acceptance_pending';
      record.pendingHumanActions = acceptanceActions;
      const actionText = [
        'Automated implementation and code review are complete. Human acceptance is still required before this phase can be marked complete.',
        record.acceptanceInstructions ? `What to do:\n${record.acceptanceInstructions}` : '',
        `What to verify:\n${acceptanceActions.map(item => `• ${item}`).join('\n')}`,
        record.acceptanceResponseTemplate ? `Response template:\n${record.acceptanceResponseTemplate}` : 'Record which checks passed or failed, along with the requested observations.'
      ].filter(Boolean).join('\n\n');
      const actionDetails = [
        record.acceptanceInstructions ? `What to do:\n${record.acceptanceInstructions}` : '',
        `What to verify:\n${acceptanceActions.map(item => `• ${item}`).join('\n')}`
      ].filter(Boolean).join('\n\n');
      const actionFile = path.join(runDir, 'human-acceptance-required.md');
      await fs.writeFile(actionFile, `# Human acceptance required\n\n${actionText}\n`, 'utf8');
      if (!record.files.includes(actionFile)) record.files.push(actionFile);
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
      this.pendingAcceptance = { runDir, record };
      this.currentInteraction = {
        type: 'acceptancePending',
        text: record.codeDetail ? `Why acceptance is still pending:\n${record.codeDetail}` : 'Open the checklist below, record the requested evidence, and submit the completed template.',
        details: actionDetails,
        responseTemplate: record.acceptanceResponseTemplate
      };
      this.setStatus('Automated work complete. Human acceptance checks remain before this phase is complete.');
      this.sendViewState();
      return;
    }
    if (record.returnToRunFile) {
      const completedSummary = record.codeDetail || 'Implementation, review, and any required human acceptance are complete.';
      record.detail = `Prerequisite workflow complete. Return to the saved waiting workflow and recheck its resume condition.\n\nLatest prerequisite result:\n${completedSummary}`;
      markPrerequisiteComplete(record);
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      this.showPrerequisiteComplete(runDir, record);
      return;
    }
    if (record.approvedPlanPath) this.pendingReopen = { runDir, record };
    let nextPhase: SplitPhase | undefined;
    let finalPlanIndex: string | undefined;
    let parentSummary: { total: number; completed: number; currentTitle: string; parentTitle: string; remainingTitles: string[]; blocked: boolean } | undefined;
    let hierarchyComplete = false;
    let hierarchyError = false;
    if (record.parentRunId) {
      try {
        let completedRecord = record;
        let completedRunDir = runDir;
        while (completedRecord.parentRunId) {
          const parentRunDir = path.join(path.dirname(completedRunDir), completedRecord.parentRunId);
          const parentFile = path.join(parentRunDir, 'run.json');
          const parentRecord = JSON.parse(await fs.readFile(parentFile, 'utf8')) as RunRecord;
          const phases = Array.isArray(parentRecord.splitPhases) ? parentRecord.splitPhases : [];
          const currentIndex = Number.isInteger(completedRecord.splitPhaseIndex) ? completedRecord.splitPhaseIndex! : phases.findIndex(phase =>
            phase.title === completedRecord.splitPhaseTitle || completedRecord.task.includes(`Phase: ${phase.title}\n`));
          if (currentIndex < 0 || !phases.length) {
            hierarchyError = true;
            break;
          }
          completedRecord.splitPhaseIndex = currentIndex;
          completedRecord.splitPhaseTitle = phases[currentIndex]?.title;
          parentRecord.completedPhaseIndexes = [...new Set([...(parentRecord.completedPhaseIndexes ?? []), currentIndex])].sort((left, right) => left - right);
          await fs.writeFile(path.join(completedRunDir, 'run.json'), JSON.stringify(completedRecord, null, 2), 'utf8');
          const completed = new Set(parentRecord.completedPhaseIndexes);
          const completedTitles = new Set(parentRecord.completedPhaseIndexes.map(index => phases[index]?.title).filter(Boolean));
          const nextIndex = phases.findIndex((phase, index) => !completed.has(index) && phase.dependsOn.every(dependency => completedTitles.has(dependency)));
          const remainingTitles = phases.flatMap((phase, index) => completed.has(index) ? [] : [phase.title]);
          parentSummary = {
            total: phases.length,
            completed: completed.size,
            currentTitle: phases[currentIndex]?.title ?? completedRecord.splitPhaseTitle ?? 'Current phase',
            parentTitle: parentRecord.splitPhaseTitle ?? parentRecord.task.split('\n')[0] ?? 'Parent workflow',
            remainingTitles,
            blocked: remainingTitles.length > 0 && nextIndex < 0
          };
          parentRecord.stage = completed.size === phases.length ? 'split_complete' : nextIndex >= 0 ? 'split_in_progress' : 'split_blocked';
          parentRecord.detail = completed.size === phases.length
            ? `All ${phases.length} split phases are complete, including nested replacement splits.`
            : `${completed.size} of ${phases.length} split phases are complete.`;
          await fs.writeFile(parentFile, JSON.stringify(parentRecord, null, 2), 'utf8');
          if (completed.size === phases.length && phases.length > 0) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (folder) {
              finalPlanIndex = await persistSplitPlanIndex(folder.uri.fsPath, parentRunDir, parentRecord);
              if (finalPlanIndex && !record.files.includes(finalPlanIndex)) {
                record.files.push(finalPlanIndex);
                await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
                const name = path.relative(folder.uri.fsPath, finalPlanIndex);
                this.currentArtifacts.push({ path: finalPlanIndex, name });
                this.post({ type: 'artifact', path: finalPlanIndex, name });
              }
            }
            completedRecord = parentRecord;
            completedRunDir = parentRunDir;
            if (!parentRecord.parentRunId) hierarchyComplete = true;
            continue;
          }
          if (nextIndex >= 0) {
            nextPhase = phases[nextIndex];
            this.pendingNextPhase = { parentRunDir, parentRecord, index: nextIndex };
          }
          break;
        }
      } catch {
        hierarchyError = true;
      }
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder && (!record.parentRunId || hierarchyComplete)) {
      await cleanupPublishedPlans(workspaceFolder.uri.fsPath, runDir, record, hierarchyComplete);
      this.currentArtifacts = record.files.map(file => ({ path: file, name: path.relative(workspaceFolder.uri.fsPath, file) || path.basename(file) }));
    }
    if (nextPhase) {
      this.currentInteraction = { type: 'nextPhase', text: `Completed: ${parentSummary?.currentTitle}.\n\nParent plan: ${parentSummary?.parentTitle}\nProgress: ${parentSummary?.completed}/${parentSummary?.total} phases complete.\n\nThe full workflow is not complete. The next dependency-ready phase is: ${nextPhase.title}\n\n${nextPhase.objective}`, phase: nextPhase, canReopen: Boolean(this.pendingReopen) };
      this.setStatus(`Parent plan ${parentSummary?.completed}/${parentSummary?.total} complete. Next: plan “${nextPhase.title}”.`);
    } else if (hierarchyComplete) {
      this.currentInteraction = { type: 'codeReady', text: `Entire split hierarchy complete. Every phase in the root workflow and its nested splits is complete. The root workflow is ready for human review.${finalPlanIndex ? `\n\nOpen the approved plan index to see the plans used during implementation: ${path.basename(finalPlanIndex)}` : ''}\n\nLatest phase result:\n${record.codeDetail || 'Implementation and automated code review are complete.'}`, canReopen: Boolean(this.pendingReopen) };
      this.setStatus(`Entire split hierarchy complete.${finalPlanIndex ? ' Open the approved plan index for the plans used during implementation.' : ''}`);
    } else if (parentSummary?.blocked) {
      this.currentInteraction = { type: 'codeReady', text: `Completed: ${parentSummary.currentTitle}.\n\nParent plan: ${parentSummary.parentTitle}\nProgress: ${parentSummary.completed}/${parentSummary.total} phases complete.\n\nThe full workflow is not complete. Remaining phases are blocked by unmet dependencies: ${parentSummary.remainingTitles.join(', ')}. Open the parent run to review its phase dependencies.`, canReopen: Boolean(this.pendingReopen) };
      this.setStatus(`Phase ${parentSummary.completed}/${parentSummary.total} complete. Parent plan blocked by unmet phase dependencies.`);
    } else if (record.parentRunId || hierarchyError) {
      this.currentInteraction = { type: 'codeReady', text: `This phase reached CODE_READY, but the complete ancestor chain could not be resolved. The extension cannot claim that the full plan is complete. Open the nearest saved parent run to review its remaining phases.\n\nLatest phase result:\n${record.codeDetail || 'Implementation and automated code review are complete.'}`, canReopen: Boolean(this.pendingReopen) };
      this.setStatus('Current phase complete. Full-plan completion could not be determined.');
    } else if (record.decision === 'PHASE_COMPLETE') {
      this.currentInteraction = { type: 'codeReady', text: `Workflow complete. No further planning, implementation, or acceptance is required.\n\nFinal result:\n${record.codeDetail || record.detail || 'The saved phase and its prerequisite recheck are complete.'}`, canReopen: Boolean(this.pendingReopen) };
      this.setStatus('Workflow complete. No further action is required for this workflow.');
    } else {
      this.currentInteraction = { type: 'codeReady', text: record.codeDetail || 'Implementation and automated code review are complete.', canReopen: Boolean(this.pendingReopen) };
      this.setStatus('Code ready for human review. Inspect the working tree before committing or deploying.');
    }
    this.sendViewState();
  }

  private showMoreCode(runDir: string, record: RunRecord, plan: string, implementation: string | undefined, review: string | undefined, direction: string, text: string, forceVerification = false): void {
    this.pendingMoreCode = { runDir, record, plan, stage: 'implementing', round: Math.max(1, record.codeRound || 1), implementation, review, direction };
    this.pendingImplementation = undefined;
    this.pendingCode = undefined;
    this.paused = false;
    this.rememberRun(path.join(runDir, 'run.json'));
    this.currentTask = record.task;
    this.activePresetName = record.preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    const atSafetyCeiling = record.preset.maxCodeRounds >= 30 && (record.codeRound ?? 0) >= record.preset.maxCodeRounds;
    this.currentInteraction = { type: atSafetyCeiling || forceVerification ? 'verificationRequired' : 'moreCode', text };
    this.setStatus(forceVerification
      ? 'A required command was blocked. Run or approve it once, then perform a final review.'
      : atSafetyCeiling
        ? 'The automatic safety ceiling was reached. Run the remaining verification once, then perform a final review.'
      : `More implementation work is required after code round ${record.codeRound}/${record.preset.maxCodeRounds}.`);
    this.sendViewState();
  }

  private async resumeRun(runFile: string): Promise<void> {
    if (path.basename(runFile) !== 'run.json') throw new Error('Choose the run.json file inside a saved workflow run folder.');
    const raw = JSON.parse(await fs.readFile(runFile, 'utf8')) as RunRecord;
    this.canReopenApprovedRequirements = raw.requirementsGuard?.status === 'approved'
      && ['paused', 'cancelled', 'failed'].includes(raw.stage);
    if (raw.supersededByRemediationRunId) {
      const remediationFile = path.join(path.dirname(path.dirname(runFile)), raw.supersededByRemediationRunId, 'run.json');
      try { await fs.access(remediationFile); }
      catch { throw new Error(`This completion was reopened, but its remediation run ${raw.supersededByRemediationRunId} could not be found.`); }
      await this.resumeRun(remediationFile);
      return;
    }
    raw.task = String(raw.task ?? raw.originalTask ?? '').trim();
    if (requiresExplicitImplementationApproval(raw) && raw.implementationRequiresHumanApproval !== true) {
      raw.implementationRequiresHumanApproval = true;
    }
    const preset = validatePreset(raw.preset);
    if (!raw.task || !Number.isInteger(raw.round)) throw new Error('This run.json does not contain a valid workflow run.');
    raw.preset = preset;
    raw.files = Array.isArray(raw.files) ? raw.files : [];
    const runDir = path.dirname(runFile);
    raw.returnToRunFile = raw.returnToRunFile ?? await inferReturnToWaitingRun(runDir, raw);
    this.returnToRunFile = raw.parentRunId ? path.join(path.dirname(runDir), raw.parentRunId, 'run.json') : raw.returnToRunFile;
    if (raw.acceptanceStatus === 'complete' && raw.acceptanceResultsPath) {
      try {
        const savedResults = await fs.readFile(raw.acceptanceResultsPath, 'utf8');
        const savedOutcome = acceptanceOutcome(savedResults);
        if (completedAcceptanceNeedsReopen(savedResults)) {
          raw.acceptanceStatus = 'pending';
          raw.stage = 'acceptance_pending';
          raw.decision = 'READY_TO_CODE';
          raw.detail = savedOutcome === 'fail'
            ? 'The saved acceptance evidence contains a failed check. The phase and its parent completion were reopened; correct the failure and record a new overall PASS before this workflow can finish.'
            : 'The saved acceptance response still contains unresolved template choices or placeholders. Complete the checklist with actual observations before this workflow can finish.';
          raw.codeDetail = raw.detail;
          raw.prerequisite = undefined;
          if (savedOutcome === 'fail') {
            await this.invalidateCompletedPhaseChain(runDir, raw, 'Previously accepted evidence now contains a failed check, so this phase is incomplete.');
          }
        }
      } catch { /* The ordinary missing-results handling below will surface the saved run state. */ }
    }
    if (raw.decision === 'STOP' && reportsCompletedPhaseRecheck(raw.detail)) {
      raw.decision = 'PHASE_COMPLETE';
      raw.stage = 'code_ready';
      raw.acceptanceStatus = 'complete';
      raw.codeDecision = 'CODE_READY';
      raw.codeDetail = raw.detail;
      raw.prerequisite = undefined;
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      await this.showCodeReady(runDir, raw);
      return;
    }
    if (raw.requirementsGuard?.status === 'draft') {
      raw.stage = 'waiting_for_requirements_approval';
    } else if (raw.decision === 'NEEDS_MORE_PLANNING') {
      clearSupersededCodeCheckpoint(raw);
      raw.stage = 'waiting_for_more_planning';
    }
    await persistOriginalTask(runDir, raw);
    await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
    this.rememberRun(runFile);
    if (isCompletedPrerequisiteState(raw)) {
      this.showPrerequisiteComplete(runDir, raw);
      return;
    }
    let round = Math.max(1, raw.round || 1);
    const readRound = async (targetRound: number, kind: 'plan' | 'review' | 'decision') => {
      try { return await fs.readFile(path.join(runDir, `round-${targetRound}-${kind}.${kind === 'decision' ? 'json' : 'md'}`), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    let plan = await readRound(round, 'plan');
    let review = await readRound(round, 'review');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (raw.stage === 'waiting_for_requirements_approval' && raw.requirementsGuard?.status === 'draft') {
      this.pendingRequirements = { runDir, record: raw, resume: { runDir, record: raw, stage: 'planning', round: Math.max(1, round + (plan ? 1 : 0)), plan, review, orchestratorDirection: raw.orchestratorDirection } };
      this.currentTask = raw.task;
      this.activePresetName = raw.preset.name;
      this.currentArtifacts = raw.files.map(file => ({ path: file, name: path.basename(file) }));
      this.currentInteraction = { type: 'requirementsApproval', text: `Local requirements baseline ready for human review. Open ${path.basename(raw.requirementsGuard.baselineMarkdownPath)}, then approve it or add another correction. Corrections are cumulative and cannot be removed by regeneration.\n\nModel: ${raw.requirementsGuard.model}\nLocked corrections: ${raw.requirementsGuard.corrections?.length ?? 0}\nPrior requirements automatically preserved: ${raw.requirementsGuard.autoPreservedRequirements ?? 0}\nDigest: ${raw.requirementsGuard.digest.slice(0, 12)}…` };
      this.setStatus('Requirements baseline awaiting human approval. Planning is paused.');
      this.sendViewState();
      return;
    }
    if (raw.stage === 'split_complete') {
      await this.showCodeReady(runDir, raw);
      return;
    }
    if (raw.codeRound || ['implementing', 'code_reviewing', 'code_deciding', 'code_paused', 'code_cancelled', 'code_failed', 'waiting_for_code_human', 'waiting_for_more_code', 'acceptance_pending', 'code_ready', 'code_stopped'].includes(raw.stage)) {
      if (!plan && folder) {
        const approvedPlanPath = await resolveApprovedPlanPath(folder.uri.fsPath, raw);
        if (approvedPlanPath) {
          plan = await fs.readFile(approvedPlanPath, 'utf8');
          await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
        }
      }
      if (!plan?.trim()) throw new Error('The approved plan for this implementation run could not be found.');
      await this.resumeCodeRun(runDir, raw, plan);
      return;
    }
    if (plan && folder) {
      const referencedPlan = await readClaudePlanReference(plan, folder.uri.fsPath);
      if (referencedPlan) {
        plan = referencedPlan;
        await fs.writeFile(path.join(runDir, `round-${round}-plan.md`), plan, 'utf8');
        await persistWorkingDraft(folder.uri.fsPath, raw, plan, 'resumed with full Claude plan');
      }
    }
    if (!raw.baselinePlanPath) {
      const firstPlan = round === 1 ? plan : await readRound(1, 'plan');
      if (firstPlan?.trim()) {
        const baselinePath = path.join(runDir, 'baseline-plan.md');
        await fs.writeFile(baselinePath, firstPlan, 'utf8');
        raw.baselinePlanPath = baselinePath;
        if (!raw.files.includes(baselinePath)) raw.files.unshift(baselinePath);
      }
    }
    const decisionText = await readRound(round, 'decision');
    let savedDecision = decisionText ? parseDecision(decisionText) : undefined;
    const requirementsBaseline = raw.requirementsGuard?.status === 'approved' ? await readRequirementsBaseline(raw) : undefined;
    const preservationStopDecision = savedDecision?.decision ?? raw.decision;
    const preservationStopDetail = savedDecision?.detail ?? raw.detail ?? '';
    const canRecoverCorrectedPreservationCheck = Boolean(
      plan?.trim()
      && requirementsBaseline
      && preservationStopDecision === 'NEEDS_MORE_PLANNING'
      && /deterministic requirements-preservation failures/i.test(preservationStopDetail)
      && checkPlanPreservation(requirementsBaseline!, plan!).passed
    );
    if (canRecoverCorrectedPreservationCheck) {
      raw.requirementsGuard!.preservationFailures = 0;
      raw.decision = undefined;
      raw.detail = 'The saved plan passed the corrected package-manager preservation check and is continuing to architectural review.';
      raw.orchestratorDirection = undefined;
      raw.stage = 'reviewing';
      raw.resumeStage = 'reviewing';
      savedDecision = undefined;
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
    }
    if (!raw.workflowName && savedDecision?.workflowName) raw.workflowName = savedDecision.workflowName;
    raw.planningLedger = mergePlanningLedger(raw.task, raw.planningLedger, savedDecision?.planningLedger);
    await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
    let orchestratorDirection = raw.orchestratorDirection ?? '';
    let stage: ResumeStage;
    if (raw.stage === 'waiting_for_human' && savedDecision?.decision === 'NEEDS_HUMAN') {
      stage = 'deciding';
      const context: ResumeContext = { runDir, record: raw, stage, round, plan, review, orchestratorDirection };
      this.pending = { ...context, question: savedDecision.detail };
      this.paused = true;
      this.rememberRun(runFile);
      this.currentTask = raw.task;
      this.activePresetName = preset.name;
      this.currentArtifacts = raw.files.map(file => ({ path: file, name: path.basename(file) }));
      this.currentInteraction = { type: 'needsInput', text: savedDecision.detail };
      this.setStatus(`Waiting for your input at round ${round}/${preset.maxRounds}.`);
      this.sendViewState();
      this.post({ type: 'needsInput', prompt: savedDecision.detail });
      return;
    }
    if (isCompletedPrerequisiteState(raw)) {
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      this.showPrerequisiteComplete(runDir, raw);
      return;
    }
    if (raw.stage === 'waiting_for_prerequisite' || savedDecision?.decision === 'WAITING_FOR_PREREQUISITE') {
      if (!plan?.trim()) throw new Error('The saved plan for this waiting phase could not be found.');
      const prerequisite = raw.prerequisite ?? savedDecision?.prerequisite ?? {
        title: 'External prerequisite',
        reason: savedDecision?.detail ?? raw.detail ?? 'This phase is waiting for outside work to finish.',
        resumeWhen: 'Resume after the prerequisite work and its required evidence are available.'
      };
      raw.stage = 'waiting_for_prerequisite';
      raw.prerequisite = prerequisite;
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      this.showWaitingForPrerequisite(runDir, raw, plan, review, prerequisite);
      return;
    }
    if (savedDecision?.decision === 'SPLIT' || savedDecision?.decision === 'ROADMAP_READY') {
      if (folder) {
        await persistWorkingDraft(folder.uri.fsPath, raw, plan, savedDecision.decision === 'ROADMAP_READY' ? 'architecture and roadmap approved' : 'split into focused phases');
        if (savedDecision.decision === 'ROADMAP_READY') raw.approvedPlanPath = await publishApprovedPlan(folder.uri.fsPath, raw, plan, 'architecture and roadmap approved; implementation not authorized');
        await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      }
      this.showSplit(runDir, raw, savedDecision, plan);
      return;
    }
    if (savedDecision?.decision === 'NEEDS_MORE_PLANNING' || savedDecision?.decision === 'STOP') {
      raw.stage = 'waiting_for_more_planning';
      raw.orchestratorDirection = savedDecision.plannerPrompt || savedDecision.detail;
      if (folder) await persistWorkingDraft(folder.uri.fsPath, raw, plan, 'needs more planning');
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      this.showMorePlanning(runDir, raw, savedDecision, plan, review);
      return;
    }
    if (savedDecision?.decision === 'READY_TO_CODE') {
      if (!plan?.trim()) throw new Error('The approved plan could not be found in this run.');
      raw.stage = 'ready_to_code';
      if (folder) {
        await persistWorkingDraft(folder.uri.fsPath, raw, plan, 'ready to code');
        raw.approvedPlanPath = await publishApprovedPlan(folder.uri.fsPath, raw, plan);
        await cleanupPublishedPlans(folder.uri.fsPath, runDir, raw, false);
      }
      await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
      this.showReadyToCode(runDir, raw, plan);
      return;
    }
    if (raw.resumeStage && ['planning', 'reviewing', 'deciding'].includes(raw.resumeStage)) stage = raw.resumeStage;
    else if (review && !decisionText) stage = 'deciding';
    else if (plan && !review) stage = 'reviewing';
    else if (savedDecision) {
      if (savedDecision.decision !== 'REVISE') {
        if (folder) {
          await persistWorkingDraft(folder.uri.fsPath, raw, plan, savedDecision.decision);
          await fs.writeFile(runFile, JSON.stringify(raw, null, 2), 'utf8');
        }
        this.pending = undefined;
        this.pendingSplit = undefined;
        this.paused = false;
        this.rememberRun(runFile);
        this.currentTask = raw.task;
        this.activePresetName = preset.name;
        this.currentArtifacts = raw.files.map(file => ({ path: file, name: path.basename(file) }));
        this.currentInteraction = undefined;
        this.setStatus(`${savedDecision.decision}: ${savedDecision.detail}`);
        this.sendViewState();
        return;
      }
      if (round >= preset.maxRounds) throw new Error('This run reached its maximum number of rounds.');
      orchestratorDirection = savedDecision.plannerPrompt;
      raw.orchestratorDirection = orchestratorDirection;
      round += 1;
      stage = 'planning';
    } else {
      stage = 'planning';
    }
    if (stage === 'planning' && !plan && round > 1) {
      plan = await readRound(round - 1, 'plan');
      review = await readRound(round - 1, 'review');
    }
    const context: ResumeContext = { runDir, record: raw, stage, round, plan, review, orchestratorDirection };
    await this.start(raw.task, preset, undefined, context);
  }

  private async start(taskValue: unknown, preset: Preset, humanInputValue?: unknown, continuation?: ResumeContext, sourcePlanPathValue?: unknown, parentRunId?: string, splitPhaseIndex?: number, splitPhaseTitle?: string, workflowNameValue?: unknown, phasePath?: number[], returnToRunFileValue?: string, requirementsSourcePathValue?: unknown): Promise<void> {
    if (this.running) throw new Error('A workflow is already running.');
    const task = String(taskValue ?? '').trim();
    const newHumanInput = String(humanInputValue ?? '').trim();
    const humanInput = [continuation?.record.humanInput, newHumanInput].filter(Boolean).join('\n\n');
    const sourcePlanPath = String(sourcePlanPathValue ?? '').trim();
    const requirementsSourcePath = String(requirementsSourcePathValue ?? continuation?.record.requirementsSourcePath ?? '').trim();
    const workflowName = String(workflowNameValue ?? continuation?.record.workflowName ?? '').trim().slice(0, 100);
    if (!task) throw new Error('Describe the planning task first.');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a project folder in VS Code first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running local agents.');
    if (this.accountModels.length) {
      if (preset.secondarySolApproval && !this.accountModels.some(model => model.id === secondaryApprovalRole(preset).model)) {
        throw new Error(`Secondary approval is enabled, but ${secondaryApprovalRole(preset).model} is not available to this Codex CLI account. Refresh available Codex models, select another model, or disable the option.`);
      }
      for (const [name, role] of [['planner', preset.planner], ['reviewer', preset.reviewer], ['orchestrator', preset.orchestrator], ['implementer', preset.implementer], ['code reviewer', preset.codeReviewer]] as const) {
        if (role.provider !== 'codex' || !role.model) continue;
        const available = this.accountModels.find(model => model.id === role.model);
        if (!available) throw new Error(`The ${name} model “${role.model}” is not available to this Codex account. Choose one from the account model list or leave it blank.`);
        if (available.supportedReasoningEfforts.length && !available.supportedReasoningEfforts.includes(role.effort)) {
          throw new Error(`${available.displayName} does not offer “${role.effort}” reasoning for this account. Available levels: ${available.supportedReasoningEfforts.join(', ')}.`);
        }
      }
    }
    let sourcePlan: string | undefined;
    if (sourcePlanPath) {
      const sourceStat = await fs.stat(sourcePlanPath);
      if (!sourceStat.isFile()) throw new Error('The selected plan is not a file.');
      if (sourceStat.size > 2_000_000) throw new Error('The selected plan is too large. Choose a plan under 2 MB.');
      sourcePlan = await fs.readFile(sourcePlanPath, 'utf8');
      if (!sourcePlan.trim()) throw new Error('The selected plan is empty.');
    }
    this.running = true;
    this.paused = false;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.canReopenApprovedRequirements = false;
    this.pending = undefined;
    this.pendingSplit = undefined;
    this.pendingMore = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.currentTask = task;
    this.currentWorkflowName = workflowName;
    this.activePresetName = preset.name;
    this.currentArtifacts = continuation?.record.files.map(file => ({ path: file, name: path.basename(file) })) ?? [];
    this.currentInteraction = undefined;
    this.post({ type: 'running', running: true });
    this.post({ type: 'paused', paused: false });
    if (continuation) this.sendViewState();
    this.controller = new AbortController();
    const cwd = folder.uri.fsPath;
    const runDir = continuation?.runDir ?? path.join(cwd, '.review-workflow', 'runs', randomUUID());
    const record: RunRecord = continuation?.record ?? { id: path.basename(runDir), task, originalTask: task, workflowName: workflowName || undefined, phasePath, parentRunId, returnToRunFile: returnToRunFileValue, splitPhaseIndex, splitPhaseTitle, preset, stage: 'planning', round: 0, files: [] };
    const recheckingPrerequisite = continuation?.record.stage === 'waiting_for_prerequisite';
    if (recheckingPrerequisite) clearSupersededCodeCheckpoint(record);
    record.humanInput = humanInput || record.humanInput;
    record.sourcePlanPath = sourcePlanPath || record.sourcePlanPath;
    record.requirementsSourcePath = requirementsSourcePath || record.requirementsSourcePath;
    record.preset = preset;
    record.returnToRunFile = record.returnToRunFile ?? returnToRunFileValue;
    record.planningLedger = mergePlanningLedger(task, record.planningLedger);
    this.returnToRunFile = record.parentRunId ? path.join(path.dirname(runDir), record.parentRunId, 'run.json') : record.returnToRunFile;
    this.rememberRun(path.join(runDir, 'run.json'));
    const writeRecord = () => fs.writeFile(this.currentRunFile!, JSON.stringify(record, null, 2), 'utf8');
    const save = async (name: string, content: string) => {
      const file = path.join(runDir, name);
      await fs.writeFile(file, content, 'utf8');
      if (!record.files.includes(file)) record.files.push(file);
      await writeRecord();
      if (!this.currentArtifacts.some(artifact => artifact.path === file)) {
        this.currentArtifacts.push({ path: file, name });
        this.post({ type: 'artifact', path: file, name });
      }
    };
    const publishDraft = async (plan: string | undefined, status: string) => {
      const file = await persistWorkingDraft(cwd, record, plan, status);
      if (!file) return;
      await writeRecord();
      if (!this.currentArtifacts.some(artifact => artifact.path === file)) {
        const name = path.relative(cwd, file);
        this.currentArtifacts.push({ path: file, name });
        this.post({ type: 'artifact', path: file, name });
      }
    };
    let latestPlan = continuation?.plan ?? sourcePlan ?? '';
    let latestReview = continuation?.review ?? '';
    try {
      await fs.mkdir(runDir, { recursive: true });
      const taskFile = await persistOriginalTask(runDir, record);
      if (taskFile && !this.currentArtifacts.some(artifact => artifact.path === taskFile)) {
        const name = path.basename(taskFile);
        this.currentArtifacts.unshift({ path: taskFile, name });
        this.post({ type: 'artifact', path: taskFile, name });
      }
      if (!continuation && parentRunId && newHumanInput) {
        const createdAt = new Date().toISOString();
        const guidanceFile = path.join(runDir, 'phase-start-guidance.md');
        await fs.writeFile(guidanceFile, `# Phase-start guidance\n\nRecorded: ${createdAt}\nPhase: ${splitPhaseTitle || `Phase ${Number(splitPhaseIndex ?? 0) + 1}`}\n\n${newHumanInput}\n`, 'utf8');
        record.guidanceEntries = [...(record.guidanceEntries ?? []), { createdAt, beforeRound: 1, text: newHumanInput, artifactPath: guidanceFile }];
        if (!record.files.includes(guidanceFile)) record.files.push(guidanceFile);
        if (!this.currentArtifacts.some(artifact => artifact.path === guidanceFile)) {
          this.currentArtifacts.push({ path: guidanceFile, name: path.basename(guidanceFile) });
          this.post({ type: 'artifact', path: guidanceFile, name: path.basename(guidanceFile) });
        }
      }
      await writeRecord();
      if (preset.requirementsGuard && record.requirementsGuard?.status !== 'approved') {
        const approvedAutomatically = await this.prepareRequirementsGuard(runDir, record, {
          runDir,
          record,
          stage: continuation?.stage ?? 'planning',
          round: continuation?.round ?? 1,
          plan: continuation?.plan,
          review: continuation?.review,
          orchestratorDirection: continuation?.orchestratorDirection
        });
        if (!approvedAutomatically) return;
      }
      const requirementsBaseline = record.requirementsGuard?.status === 'approved' ? await readRequirementsBaseline(record) : undefined;
      if (record.requirementsGuard?.status === 'approved' && !requirementsBaseline) throw new Error('The approved requirements baseline is missing or invalid. Restore it or regenerate the baseline before continuing.');
      const requirementsContract = requirementsBaseline ? planContractInstructions(requirementsBaseline, record.requirementsGuard?.digest) : '';
      let feedback = continuation?.review ?? '';
      let previousPlan = continuation?.plan ?? '';
      let orchestratorDirection = continuation?.orchestratorDirection ?? record.orchestratorDirection ?? '';
      let autoImplementAfterSecondaryApproval = false;
      const phaseDepth = record.phasePath?.length ?? 0;
      const manualAcceptancePhase = isManualAcceptancePhase(task);
      const splitAllowed = canSplitPhase(task, record.phasePath);
      const roadmapPlanning = isArchitectureRoadmapTask(task, record.parentRunId);
      const humanAcceptanceGuard = 'When the requested outcome is a hands-on, visual, device, native-app, or interactive acceptance session, produce a concise operator checklist and results-recording plan. Reuse existing repository QA steps and ordinary evidence such as date, version, commit, fixture, observations, and PASS/FAIL results. Do not invent a harness, cryptographic attestation, evidence schema, trust anchor, semantic gate, or new automation unless the original human request or an existing repository requirement explicitly requires that machinery.';
      const planningTargetGuard = roadmapPlanning
        ? 'This root task requests architecture and a phased roadmap, not authorization to implement the whole system. Make the architecture, trust boundaries, invariants, dependencies, phase ownership, decision deadlines, and phase-level acceptance outcomes coherent. Do not expand every later phase into implementation-ready mechanics. Details needed only by a later phase belong in that phase or its decision deadline. The terminal outcome for a coherent roadmap is ROADMAP_READY, never READY_TO_CODE.'
        : 'This task is being planned for implementation. Make only the current task or focused child phase implementation-ready; do not absorb sibling or later-phase work.';
      const findingGuard = `For every material finding, identify a stable ID, source requirement or repository evidence, severity, affected phase, canonical plan location, closure condition, and status. A later-phase detail does not block the roadmap or an earlier phase unless the missing boundary would invalidate the architecture or current work. Revisions must replace the canonical rule and remove contradictory copies; review history stays in run artifacts, not in the plan. Separate correctness defects from wording preferences and optional improvements. Verify material provider claims against authoritative evidence or label them unverified; do not turn an unverified provider assumption into an invariant.${requirementsBaseline ? ' This run has a human-approved requirements baseline. Only a finding explicitly labeled BLOCKING and traced to a baseline ID or concrete repository evidence may cause revision. OPTIONAL findings are recorded but must not cause revision, and the orchestrator must not create new requirements.' : ''}`;
      const firstRound = continuation?.round ?? 1;
      let firstStage: ResumeStage = continuation?.stage ?? 'planning';
      for (let round = firstRound; round <= preset.maxRounds; round++) {
        const finalChildConvergence = Boolean(record.parentRunId) && round >= 10;
        record.round = round;
        record.resumeStage = undefined;
        const stage = round === firstRound ? firstStage : 'planning';
        const useSourcePlan = round === 1 && sourcePlan !== undefined;
        let plan = stage === 'reviewing' || stage === 'deciding' ? continuation?.plan : undefined;
        if (!plan) {
          record.stage = 'planning';
          await writeRecord();
          let localStarter = '';
          if (!useSourcePlan && preset.localPlanningStarter && preset.ollamaModel.trim()) {
            const starterFile = path.join(runDir, `round-${round}-local-planning-starter.md`);
            try { localStarter = await fs.readFile(starterFile, 'utf8'); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              this.setStatus(`Round ${round}/${preset.maxRounds}: Ollama is preparing a local planning starter`);
              try {
                localStarter = await createLocalWorkStarter(preset.ollamaModel, 'planning', [
                  `Current task:\n${task}`,
                  requirementsBaseline ? `Approved requirements baseline:\n${JSON.stringify(requirementsBaseline, null, 2)}` : '',
                  `Planning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}`,
                  previousPlan ? `Prior canonical plan:\n${previousPlan}` : '',
                  feedback ? `Reviewer feedback:\n${feedback}` : '',
                  `Orchestrator direction:\n${orchestratorDirection || 'Create the smallest implementation-ready plan for the current scope.'}`
                ].filter(Boolean).join('\n\n---\n\n'), this.controller.signal);
                await save(`round-${round}-local-planning-starter.md`, `# Local planning starter\n\nAdvisory only. Claude remains the canonical planner.\n\n${localStarter}\n`);
              } catch (starterError) {
                localStarter = '';
                await save(`round-${round}-local-planning-starter-warning.txt`, `The optional Ollama planning starter was skipped. Claude planning continued normally.\n\n${friendlyError(starterError)}\n`);
              }
            }
          }
          const plannerSessionId = preset.planner.provider === 'claude'
            ? reusableClaudeSession(preset.claudeSessionPolicy, record.claudeSessions?.planner, record.claudeSessions?.plannerStartedRound, round)
            : '';
          const fullPlannerContext = `${requirementsContract ? `\n\nRequirements preservation contract:\n${requirementsContract}` : ''}\n\nOriginal task:\n${task}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nHuman guidance:\n${humanInput || 'None provided'}\n\nPrevious complete plan:\n${previousPlan}`;
          const resumedPlannerContext = `Continue the saved planning session. The original task, approved baseline, and prior canonical plan are unchanged. Return the complete revised canonical plan, not a patch or summary.`;
          this.setStatus(useSourcePlan ? `Round ${round}/${preset.maxRounds}: loading existing plan` : `Round ${round}/${preset.maxRounds}: ${plannerSessionId ? 'continuing Claude planning session' : 'planning'}`);
          plan = useSourcePlan ? sourcePlan! : await invoke(preset.planner,
            `Create or revise the complete planning artifact requested by the original task. Return the full canonical Markdown artifact, not a summary or a pointer to another file. Do not edit repository files. ${planningTargetGuard} Follow the orchestrator direction while retaining the review evidence needed to address it. Treat the planning ledger as the scope contract: preserve its locked decisions, resolve its open findings, keep deferred work out, and do not add unrelated requirements. ${findingGuard} Replace superseded text and every contradictory duplicate instead of appending revision history. Keep the artifact no larger than its requested planning purpose requires.${record.parentRunId ? ' This is a child phase. Limit the plan to the selected phase objective. Do not absorb, duplicate, complete, or replace sibling phases from any ancestor workflow.' : ''} ${humanAcceptanceGuard}${!splitAllowed ? manualAcceptancePhase ? ' This is a human acceptance phase and must remain one executable operator plan. Do not subdivide it or add prerequisite infrastructure to justify a subdivision.' : ' This phase is already at the nested-split safety limit. Produce one bounded executable plan; do not propose another subdivision or add prerequisite infrastructure to justify one.' : ''}${finalChildConvergence ? ' This is a final convergence pass. Apply only the saved reviewer and orchestrator corrections, remove superseded wording, and return the smallest executable plan. Do not introduce new requirements, optional improvements, evidence categories, or architecture.' : ''}\n\n${plannerSessionId ? resumedPlannerContext : fullPlannerContext}${localStarter ? `\n\nLocal Ollama planning starter (advisory; verify it and discard unsupported suggestions):\n${localStarter}` : ''}\n\nReviewer feedback:\n${feedback}\n\nOrchestrator direction for this revision:\n${orchestratorDirection || 'No additional direction; address the reviewer feedback without expanding scope.'}`,
            cwd, true, this.controller.signal, [], preset.claudeExploreModel, plannerSessionId, sessionId => {
              record.claudeSessions = { ...record.claudeSessions, planner: sessionId, plannerStartedRound: plannerSessionId ? record.claudeSessions?.plannerStartedRound ?? round : round };
            });
          await save(`round-${round}-plan.md`, plan);
        }
        if (!record.baselinePlanPath) {
          record.baselinePlanPath = path.join(runDir, 'baseline-plan.md');
          await save('baseline-plan.md', plan);
        }
        latestPlan = plan;
        await publishDraft(plan, `under review in planning round ${round}`);
        if (requirementsBaseline) {
          const preservation = checkPlanPreservation(requirementsBaseline, plan);
          await save(`round-${round}-preservation-report.md`, preservationMarkdown(preservation, round));
          if (!preservation.passed) {
            record.requirementsGuard!.preservationFailures += 1;
            const correction = `Repair only these deterministic requirements-preservation failures before architectural review:\n${preservation.failures.map(item => `- ${item}`).join('\n')}\nDo not change unrelated plan content or add requirements.`;
            record.detail = correction;
            record.orchestratorDirection = correction;
            record.decision = round < preset.maxRounds && record.requirementsGuard!.preservationFailures < 2 ? 'REVISE' : 'NEEDS_MORE_PLANNING';
            await writeRecord();
            if (record.decision === 'REVISE') {
              feedback = preservationMarkdown(preservation, round);
              previousPlan = plan;
              orchestratorDirection = correction;
              firstStage = 'planning';
              continue;
            }
            break;
          }
        }
        let review = stage === 'deciding' ? continuation?.review : undefined;
        if (!review) {
          record.stage = 'reviewing';
          await writeRecord();
          this.setStatus(`Round ${round}/${preset.maxRounds}: reviewing`);
          review = await invoke(preset.reviewer,
            `Review this planning artifact against the repository, original request, and planning ledger. Do not edit files. The run's working-plan.md was refreshed from the supplied Plan immediately before this review. It may begin with an extension-owned HTML provenance comment; that comment is metadata, not revision history. Treat the supplied Plan body as authoritative and do not report working-plan.md as stale unless its body materially differs from the supplied Plan. ${planningTargetGuard} Give High, Medium, and Low findings with evidence, then a recommendation. ${findingGuard} For each finding, explicitly label it BLOCKING or OPTIONAL. A BLOCKING finding must trace to a requirements-baseline ID or concrete repository evidence and must state an observable closure condition. Suggestions, preferences, future hardening, and later-phase details are OPTIONAL and must not trigger another revision. Treat the original task and ledger as the scope boundary. Explicitly flag any lost locked decision, unresolved finding, deferred work pulled into scope, unnecessary expansion, contradictory duplicate, or revision-history accumulation.${record.parentRunId ? ' This is a child phase. Treat absorption, duplication, completion, or replacement of an ancestor workflow sibling as a High scope finding.' : ''} Do not invent improvements unrelated to the task, repository constraints, or recorded findings. On later rounds, identify newly discovered correctness defects separately from style preferences and optional improvements, and check whether each repair broke another confirmed requirement. For a narrow maintenance task, an executable plan that identifies the correct files, constraints, and verification commands is sufficient; do not require implementation results or command output during planning. ${humanAcceptanceGuard} For a human acceptance phase, the absence of newly invented automation or cryptographic proof is not a finding.${finalChildConvergence ? ' This is a final convergence review. Confirm whether the previously directed corrections are present. Raise a new blocking finding only when repository evidence shows that the procedure would be unsafe, impossible to execute, or unable to capture a required result. Treat wording preferences, optional hardening, additional evidence, and improvements beyond the original acceptance contract as non-blocking.' : ''}${requirementsBaseline ? `\n\nThe deterministic preservation check passed. Use this approved baseline for traceability; do not reinterpret or expand it:\n${JSON.stringify(requirementsBaseline, null, 2)}` : ''}\n\nOriginal task:\n${task}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nHuman guidance:\n${humanInput || 'None provided'}\n\nPlan:\n${plan}`,
            cwd, true, this.controller.signal, [], preset.claudeExploreModel);
          await save(`round-${round}-review.md`, review);
          if (record.requirementsGuard) {
            record.requirementsGuard.architecturalReviews += 1;
            await writeRecord();
          }
        }
        latestReview = review;
        record.stage = 'deciding';
        await writeRecord();
        this.setStatus(`Round ${round}/${preset.maxRounds}: deciding`);
        const rawDecision = await invoke(preset.orchestrator,
          `Decide the next step for this planning artifact while acting as its scope keeper. Do not edit files. ${planningTargetGuard} Reply with ONLY JSON: {"decision":"REVISE|ROADMAP_READY|READY_TO_CODE|PHASE_COMPLETE|SPLIT|WAITING_FOR_PREREQUISITE|NEEDS_HUMAN|NEEDS_MORE_PLANNING|STOP","detail":"specific explanation or recommendation","workflowName":"short stable workflow name","plannerPrompt":"complete instructions for the planner's next revision","prerequisite":{"title":"outside work that must finish first","reason":"why this phase cannot execute yet","resumeWhen":"specific evidence or repository state that makes it resumable"},"planningLedger":{"objective":"stable objective","inScope":["bounded deliverable"],"lockedDecisions":["accepted decision that must not disappear"],"unresolvedFindings":["specific remaining blocker"],"deferred":["explicitly excluded work"],"findings":[{"id":"stable finding ID","summary":"specific finding","source":"requirement or repository evidence","severity":"High|Medium|Low","affectedPhase":"roadmap, current phase, or named later phase","canonicalLocation":"section where the rule belongs","closureCondition":"observable condition that resolves it","status":"open|resolved|deferred"}]},"phases":[{"title":"phase name","objective":"bounded objective","dependsOn":["earlier phase name"]}]}. ${record.parentRunId ? `This child belongs to workflow “${record.workflowName || 'the parent workflow'}”; return that exact workflowName unchanged.` : record.workflowName ? `Keep the existing workflowName exactly as “${record.workflowName}”.` : 'Create a concise, descriptive workflowName of two to six words from the root task. Avoid generic phrases such as implementation plan, workflow, task, or project. Keep that name unchanged in later rounds.'} Update the existing planning ledger conservatively. Preserve its objective, in-scope items, locked decisions, and deferred items unless repository evidence or explicit human guidance requires a change. ${findingGuard} The unresolvedFindings list must contain only blockers for the artifact currently being approved and must remove findings the new artifact demonstrably resolves. Put later-phase mechanics in the structured register as deferred to their owning phase unless they invalidate the architecture or current phase. Every new requirement must trace to the original task, a ledger item, repository evidence, or a reviewer finding; otherwise reject it as scope expansion. ${humanAcceptanceGuard}${record.parentRunId ? ' This is a child phase. Reject phases that absorb, duplicate, complete, or replace sibling phases from any ancestor workflow.' : ''}${splitAllowed ? ' A nested SPLIT is allowed only when this child contains independently implementable product deliverables. Repeated review findings, plan length, evidence formatting, or a desire for prerequisite infrastructure do not justify a split.' : manualAcceptancePhase ? ' SPLIT is forbidden because this is a human acceptance phase. Keep the operator session and its result recording together as one executable plan.' : ' SPLIT is forbidden because this phase is at the nested-split safety limit. Produce one simplified executable plan or close the phase when its existing implementation and acceptance are proven complete.'} ${roadmapPlanning ? 'Choose ROADMAP_READY once the architecture, boundaries, dependencies, phase outline, decision deadlines, and phase-level acceptance outcomes are coherent. Return the ordered phases with ROADMAP_READY. ROADMAP_READY explicitly does not authorize implementation; never use READY_TO_CODE for this root artifact. Do not block it on implementation mechanics that belong to a later phase.' : 'Use READY_TO_CODE only when the current focused plan still needs implementation.'} ${recheckingPrerequisite ? 'This is a prerequisite recheck. Choose PHASE_COMPLETE when repository and acceptance evidence prove the saved phase was already implemented and its resume condition is satisfied; do not send completed work back through planning or implementation. Choose WAITING_FOR_PREREQUISITE only when the recorded resume condition still is not met. PHASE_COMPLETE is forbidden outside a prerequisite recheck.' : 'PHASE_COMPLETE is forbidden because this is not a prerequisite recheck.'} Choose WAITING_FOR_PREREQUISITE when the plan itself is ready but explicitly cannot execute until work outside this root workflow or split hierarchy is completed. This state preserves the phase without failing, completing, implementing, or repeatedly replanning it. Name the outside work and give a concrete resume condition. Do not use it for an earlier phase inside the current split hierarchy; the extension already sequences those dependencies. Direct the planner to replace the canonical rule, remove contradictory copies, and keep review history out of the artifact. Judge convergence by closed findings and coherent dependencies, not word count or the phrase “one final revision.” A real new correctness or security defect remains blocking at its proper level even late in the run; narrow it explicitly instead of suppressing it to meet a round limit. Wording preferences and optional improvements do not justify another round. For narrow maintenance work, choose READY_TO_CODE as soon as the plan identifies the correct changes, constraints, and verification commands; do not require implementation-time evidence or keep revising wording. If the same material finding persists for two rounds, use one targeted correction or NEEDS_HUMAN for a genuine product decision; do not rewrite unrelated sections or manufacture another phase solely to house the finding. After six rounds, require targeted canonical corrections rather than another unrestricted rewrite. For REVISE or NEEDS_MORE_PLANNING, plannerPrompt must be a self-contained handoff that names each open finding ID, the canonical location to replace, contradictory copies to remove, what to preserve, and the exact closure condition. Use NEEDS_MORE_PLANNING on the final allowed round when bounded, actionable revisions remain. Use STOP only when further planning cannot productively continue and there is no actionable revision path; never use STOP to mean an already-complete phase. Use an empty plannerPrompt for other terminal decisions. Use an empty phases array unless the decision is SPLIT or ROADMAP_READY. For SPLIT or ROADMAP_READY, return ordered, independently actionable phases and preserve prerequisites in dependsOn. Round ${round} of ${preset.maxRounds}. On the final round, do not choose REVISE. If a human decision is required, choose NEEDS_HUMAN and put one clear question in detail.${finalChildConvergence ? ' This is a final convergence decision. If the directed corrections are present and no High issue makes the procedure unsafe, impossible, or unable to capture a required result, choose READY_TO_CODE. Do not extend planning for optional improvements, extra evidence, wording preferences, or speculative hardening.' : ''}\n\nOriginal task:\n${task}\n\nExisting workflow name:\n${record.workflowName || 'Not assigned yet'}\n\nExisting planning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nHuman guidance:\n${humanInput || 'None provided'}\n\nComplete current plan:\n${plan}\n\nReview:\n${review}`,
          cwd, true, this.controller.signal, [], preset.claudeExploreModel);
        await save(`round-${round}-decision.json`, rawDecision);
        let result = parseDecision(rawDecision);
        if (recheckingPrerequisite && result.decision === 'STOP' && reportsCompletedPhaseRecheck(result.detail)) {
          result = { ...result, decision: 'PHASE_COMPLETE', plannerPrompt: '', phases: [] };
          await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        let autoFinalCanonicalCorrection = false;
        if (record.requirementsGuard?.status === 'approved' && record.requirementsGuard.architecturalReviews >= 2 && result.decision === 'REVISE') {
          const canApplyFinalCorrection = canAutoApplyFinalCanonicalCorrection(
            result.planningLedger?.findings ?? [],
            record.requirementsGuard.finalCanonicalCorrectionUsed === true
          );
          if (canApplyFinalCorrection) {
            record.requirementsGuard.finalCanonicalCorrectionUsed = true;
            autoFinalCanonicalCorrection = true;
            result = {
              ...result,
              detail: `Applying one automatic final correction for a single non-High canonical bookkeeping contradiction. No human confirmation is required.\n\n${result.detail}`
            };
          } else {
            result = {
              ...result,
              decision: 'NEEDS_MORE_PLANNING',
              detail: `The requirements-guarded workflow reached its two-review limit. Automatic revision has stopped. Confirm or narrow the remaining blocking findings before starting another focused planning pass.\n\n${result.detail}`,
              plannerPrompt: result.plannerPrompt,
              phases: []
            };
          }
          await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        const normalizedPrerequisiteDecision = normalizePrerequisitePlanningDecision(result.decision, Boolean(record.returnToRunFile));
        if (normalizedPrerequisiteDecision !== result.decision) {
          result = {
            ...result,
            decision: normalizedPrerequisiteDecision as Decision,
            detail: `Prerequisite plan ready for implementation. Complete implementation, review, and required acceptance before returning to the waiting workflow.\n\n${result.detail}`,
            plannerPrompt: '',
            phases: []
          };
          await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        if (result.decision === 'SPLIT' && !splitAllowed) {
          const retryDecision: Decision = round < preset.maxRounds ? 'REVISE' : 'NEEDS_MORE_PLANNING';
          result = {
            ...result,
            decision: retryDecision,
            detail: `${manualAcceptancePhase ? 'Split prevented because this is a human acceptance phase.' : `Nested split prevented at phase depth ${phaseDepth}.`} The current child must converge into one executable plan instead of creating another layer. ${result.detail}`,
            plannerPrompt: `Replace the current plan with the smallest executable plan for this child objective. Remove unrequested prerequisite infrastructure, evidence frameworks, schemas, attestations, semantic gates, and other machinery that is not explicitly required by the original task or repository. Preserve actual product requirements and existing QA procedures. If this is a hands-on acceptance phase, provide the operator checklist, ordinary PASS/FAIL evidence fields, cleanup, and result-recording edits directly. Do not split again.\n\nLast split rationale to resolve without splitting:\n${result.detail}`,
            phases: []
          };
          await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        const shouldRunCheckpointAudit = !autoFinalCanonicalCorrection
          && !roadmapPlanning
          && round % 3 === 0
          && (result.decision === 'REVISE' || result.decision === 'NEEDS_MORE_PLANNING');
        if (shouldRunCheckpointAudit) {
          const previousOpenIds = new Set((record.planningLedger?.findings ?? []).filter(item => item.status === 'open').map(item => item.id));
          const proposedOpenIds = new Set((result.planningLedger?.findings ?? []).filter(item => item.status === 'open').map(item => item.id));
          const repeatedIds = [...proposedOpenIds].filter(id => previousOpenIds.has(id));
          const newIds = [...proposedOpenIds].filter(id => !previousOpenIds.has(id));
          const resolvedIds = [...previousOpenIds].filter(id => !proposedOpenIds.has(id));
          this.setStatus(`Round ${round}/${preset.maxRounds}: auditing planning convergence`);
          try {
            const rawAudit = await invoke(preset.orchestrator,
              `Audit whether this planning workflow should consume another revision round. Inspect the repository read-only when needed, but do not edit files and do not rewrite the plan. Reply with ONLY JSON: {"recommendation":"TARGETED_REVISION|READY|NEEDS_HUMAN|RETURN_TO_PARENT|STOP","summary":"short human-readable assessment of convergence","confirmedFindings":["finding ID and why it truly blocks"],"rejectedFindings":["finding ID and why it is resolved, optional, duplicated, unsupported, or out of scope"],"plannerPrompt":"one bounded self-contained correction handoff, or empty when no correction is recommended"}.

This is a meta-review of the reviewer and orchestrator, not another architectural review. Evaluate only findings already present in the saved review, proposed decision, or planning ledger. Do not invent a requirement, improvement, evidence category, phase, or finding. Confirm a blocker only when it traces to the approved task or concrete repository evidence and would make implementation unsafe, impossible, or unable to satisfy a required observable outcome. A Low finding may justify TARGETED_REVISION only when it names a concrete unavailable dependency or command, credential/security cleanup omission, contradiction, or other defect that makes the prescribed implementation unsafe or non-executable; wording preferences and optional hardening are nonblocking. Reject resolved findings that were reopened without new evidence, repeated restatements, later-phase details, and scope expansion.

Choose READY when no confirmed High or actionable Medium blocker remains and any remaining Low items are optional. Choose TARGETED_REVISION only for a small set of confirmed, bounded corrections and make plannerPrompt name the existing finding IDs, canonical locations to replace, contradictory copies to remove, preserved decisions, and observable closure conditions. Choose NEEDS_HUMAN only for a genuine owner decision. Choose RETURN_TO_PARENT when a child is solving the wrong phase or has reached a useful parent boundary. Choose STOP only when another revision cannot productively converge. Do not recommend splitting merely because the plan is long or has accumulated review rounds.

Round: ${round} of ${preset.maxRounds}
Repeated open finding IDs: ${JSON.stringify(repeatedIds)}
New open finding IDs: ${JSON.stringify(newIds)}
Resolved finding IDs: ${JSON.stringify(resolvedIds)}

Original task:
${task}

Planning ledger before this decision:
${JSON.stringify(record.planningLedger, null, 2)}

Current plan:
${plan}

Latest review:
${review}

Proposed orchestrator decision:
${JSON.stringify(result, null, 2)}`,
              cwd, true, this.controller.signal, [], preset.claudeExploreModel);
            await save(`round-${round}-checkpoint-audit-response.json`, rawAudit);
            const audit = parsePlanningCheckpointAudit(rawAudit);
            await save(`round-${round}-checkpoint-audit.md`, planningCheckpointMarkdown(audit, round, repeatedIds, newIds, resolvedIds));
            if (audit.recommendation === 'READY') {
              result = { ...result, decision: 'READY_TO_CODE', detail: audit.summary, plannerPrompt: '', phases: [] };
            } else if (audit.recommendation === 'TARGETED_REVISION') {
              result = {
                ...result,
                decision: round < preset.maxRounds ? 'REVISE' : 'NEEDS_MORE_PLANNING',
                detail: `Planning checkpoint audit: ${audit.summary}`,
                plannerPrompt: audit.plannerPrompt || result.plannerPrompt,
                phases: []
              };
            } else if (audit.recommendation === 'NEEDS_HUMAN') {
              result = { ...result, decision: 'NEEDS_HUMAN', detail: audit.summary, plannerPrompt: '', phases: [] };
            } else {
              result = {
                ...result,
                decision: 'STOP',
                detail: `${audit.recommendation === 'RETURN_TO_PARENT' ? 'Return to the nearest useful parent workflow. ' : ''}${audit.summary}`,
                plannerPrompt: '',
                phases: []
              };
            }
            await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
          } catch (auditError) {
            await save(`round-${round}-checkpoint-audit-warning.txt`, `The optional planning checkpoint audit could not be completed. The saved reviewer and orchestrator decision remains authoritative.\n\n${friendlyError(auditError)}\n`);
          }
        }
        if (preset.secondarySolApproval && preset.secondaryDecisionDelegation && result.decision === 'NEEDS_HUMAN' && !requiresDirectHumanAction(result.detail)) {
          const secondaryRole = secondaryApprovalRole(preset);
          this.setStatus(`Round ${round}/${preset.maxRounds}: ${secondaryRole.model} is resolving the planning decision from approved evidence`);
          const rawDelegation = await invoke(secondaryRole, delegatedDecisionPrompt(
            result.detail,
            `Original task:\n${task}\n\nHuman guidance already recorded:\n${humanInput || 'None'}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nCurrent plan:\n${plan}\n\nPlan review:\n${review}\n\nOrchestrator decision:\n${JSON.stringify(result, null, 2)}`
          ), cwd, true, this.controller.signal);
          const delegation = parseDelegatedDecision(rawDelegation);
          await save(`round-${round}-delegated-decision.json`, JSON.stringify(delegation, null, 2));
          await save(`round-${round}-delegated-decision.md`, delegatedDecisionMarkdown('Delegated planning decision', secondaryRole.model, delegation));
          if (delegation.decision === 'RESOLVED') {
            const hardLimit = record.parentRunId ? maxChildPlanningRounds : 50;
            if (round >= preset.maxRounds && preset.maxRounds < hardLimit) {
              preset.maxRounds = Math.min(hardLimit, preset.maxRounds + 3);
              record.preset = preset;
            }
            record.humanInput = [record.humanInput, `Decision delegated to ${secondaryRole.model}:\n${delegation.answer}\n\nRationale:\n${delegation.rationale}`].filter(Boolean).join('\n\n');
            result = {
              ...result,
              decision: round < preset.maxRounds ? 'REVISE' : 'NEEDS_MORE_PLANNING',
              detail: `${secondaryRole.model} resolved the decision from approved evidence: ${delegation.answer}`,
              plannerPrompt: delegation.nextInstruction || `Apply this delegated owner decision without expanding scope: ${delegation.answer}`,
              phases: []
            };
            await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
          }
        }
        if (preset.secondarySolApproval && result.decision === 'READY_TO_CODE') {
          const secondaryRole = secondaryApprovalRole(preset);
          this.setStatus(`Round ${round}/${preset.maxRounds}: ${secondaryRole.model} is independently reviewing the completed plan`);
          const rawSecondaryReview = await invoke(secondaryRole,
            `Perform the final independent approval review of this implementation plan. Inspect the repository read-only when useful, but do not edit files. Reply with ONLY JSON: {"decision":"APPROVE|REVISE|NEEDS_HUMAN","summary":"concise assessment","findings":["specific blocking defect with requirement or repository evidence"],"correctionPrompt":"one bounded self-contained planner handoff, or empty when approved"}. Choose APPROVE only when the plan is safe, executable, correctly scoped, preserves accepted requirements, and has sufficient verification. Confirm the existing reviewer and orchestrator did not miss a High or actionable Medium defect. Reject optional hardening, stylistic preferences, speculative concerns, later-phase details, and requirements not grounded in the task, ledger, approved baseline, or repository. Choose NEEDS_HUMAN only for a genuine owner decision. An APPROVE decision authorizes this extension to begin implementation automatically.\n\nOriginal task:\n${task}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nCompleted plan:\n${plan}\n\nExisting plan review:\n${review}\n\nExisting orchestrator decision:\n${JSON.stringify(result, null, 2)}`,
            cwd, true, this.controller.signal);
          const secondaryReview = parseSecondaryApprovalReview(rawSecondaryReview);
          await save(`round-${round}-secondary-approval-review.json`, JSON.stringify(secondaryReview, null, 2));
          await save(`round-${round}-secondary-approval-review.md`, secondaryApprovalMarkdown('Secondary final plan review', secondaryRole.model, secondaryReview));
          let reviewedDecision = secondaryReview;
          if (reviewedDecision.decision === 'NEEDS_HUMAN' && preset.secondaryDecisionDelegation && !requiresDirectHumanAction(`${reviewedDecision.summary}\n${reviewedDecision.findings.join('\n')}`)) {
            const rawDelegation = await invoke(secondaryRole, delegatedDecisionPrompt(
              `${reviewedDecision.summary}\n${reviewedDecision.findings.join('\n')}`,
              `Original task:\n${task}\n\nRecorded human guidance:\n${humanInput || 'None'}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nCompleted plan:\n${plan}\n\nPlan review:\n${review}`
            ), cwd, true, this.controller.signal);
            const delegation = parseDelegatedDecision(rawDelegation);
            await save(`round-${round}-secondary-delegated-decision.json`, JSON.stringify(delegation, null, 2));
            await save(`round-${round}-secondary-delegated-decision.md`, delegatedDecisionMarkdown('Delegated final-plan decision', secondaryRole.model, delegation));
            if (delegation.decision === 'RESOLVED') {
              const hardLimit = record.parentRunId ? maxChildPlanningRounds : 50;
              if (round >= preset.maxRounds && preset.maxRounds < hardLimit) {
                preset.maxRounds = Math.min(hardLimit, preset.maxRounds + 3);
                record.preset = preset;
              }
              reviewedDecision = {
                decision: 'REVISE',
                summary: `Delegated decision resolved from approved evidence: ${delegation.answer}`,
                findings: secondaryReview.findings,
                correctionPrompt: delegation.nextInstruction || delegation.answer
              };
              record.humanInput = [record.humanInput, `Decision delegated to ${secondaryRole.model}:\n${delegation.answer}\n\nRationale:\n${delegation.rationale}`].filter(Boolean).join('\n\n');
            }
          }
          if (reviewedDecision.decision === 'APPROVE') {
            autoImplementAfterSecondaryApproval = true;
            result = { ...result, detail: `${result.detail}\n\n${secondaryRole.model} secondary approval: ${reviewedDecision.summary}` };
          } else if (reviewedDecision.decision === 'REVISE') {
            const correction = reviewedDecision.correctionPrompt || [reviewedDecision.summary, ...reviewedDecision.findings].join('\n');
            result = {
              ...result,
              decision: round < preset.maxRounds ? 'REVISE' : 'NEEDS_MORE_PLANNING',
              detail: `${secondaryRole.model} secondary review requires a bounded plan correction: ${reviewedDecision.summary}`,
              plannerPrompt: correction,
              phases: []
            };
          } else {
            result = { ...result, decision: 'NEEDS_HUMAN', detail: reviewedDecision.summary, plannerPrompt: '', phases: [] };
          }
          await save(`round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        if (!record.workflowName && result.workflowName) {
          record.workflowName = result.workflowName;
          this.currentWorkflowName = result.workflowName;
        }
        record.planningLedger = mergePlanningLedger(task, record.planningLedger, result.planningLedger);
        record.decision = result.decision;
        record.detail = result.detail;
        record.orchestratorDirection = result.plannerPrompt || undefined;
        record.splitPhases = result.decision === 'SPLIT' || result.decision === 'ROADMAP_READY' ? result.phases : undefined;
        record.prerequisite = result.decision === 'WAITING_FOR_PREREQUISITE' ? result.prerequisite : undefined;
        await save(`round-${round}-ledger.json`, JSON.stringify(record.planningLedger, null, 2));
        await writeRecord();
        if (result.decision === 'NEEDS_HUMAN') {
          record.stage = 'waiting_for_human';
          record.resumeStage = 'deciding';
          await writeRecord();
          this.pending = { runDir, record, stage: 'deciding', round, plan, review, question: result.detail };
          this.paused = true;
          this.currentInteraction = { type: 'needsInput', text: result.detail };
          this.setStatus(`Waiting for your input at round ${round}/${preset.maxRounds}.`);
          this.post({ type: 'needsInput', prompt: result.detail });
          this.post({ type: 'paused', paused: true });
        }
        if (result.decision !== 'REVISE') break;
        feedback = review;
        previousPlan = plan;
        orchestratorDirection = result.plannerPrompt;
        firstStage = 'planning';
      }
      if (record.decision === 'NEEDS_HUMAN') {
        await publishDraft(latestPlan, 'waiting for human input');
        return;
      }
      if (record.decision === 'SPLIT') {
        record.stage = 'split';
        record.resumeStage = undefined;
        await publishDraft(latestPlan, 'split into focused phases');
        await writeRecord();
        this.showSplit(runDir, record, { decision: 'SPLIT', detail: record.detail ?? 'Split this plan into focused phases.', plannerPrompt: '', phases: record.splitPhases ?? [] }, latestPlan);
        showTemporaryWorkflowNotification('This plan should be split into focused phases. Choose a phase in the sidebar.');
        return;
      }
      if (record.decision === 'ROADMAP_READY') {
        record.stage = 'roadmap_ready';
        record.resumeStage = undefined;
        await publishDraft(latestPlan, 'architecture and roadmap approved');
        record.approvedPlanPath = await publishApprovedPlan(cwd, record, latestPlan, 'architecture and roadmap approved; implementation not authorized');
        await cleanupPublishedPlans(cwd, runDir, record, false);
        await writeRecord();
        this.showSplit(runDir, record, { decision: 'ROADMAP_READY', detail: record.detail ?? 'Architecture and roadmap approved. Choose a focused phase to plan next.', plannerPrompt: '', phases: record.splitPhases ?? [] }, latestPlan);
        showTemporaryWorkflowNotification('Architecture and roadmap approved. Choose a phase to plan next; no implementation has been authorized.');
        return;
      }
      if (record.decision === 'WAITING_FOR_PREREQUISITE' && record.prerequisite) {
        record.stage = 'waiting_for_prerequisite';
        record.resumeStage = undefined;
        await publishDraft(latestPlan, `waiting for prerequisite: ${record.prerequisite.title}`);
        await writeRecord();
        this.showWaitingForPrerequisite(runDir, record, latestPlan, latestReview, record.prerequisite);
        showTemporaryWorkflowNotification(`This phase is saved and waiting for ${record.prerequisite.title}.`);
        return;
      }
      if (record.decision === 'PREREQUISITE_COMPLETE' && record.returnToRunFile) {
        markPrerequisiteComplete(record);
        await publishDraft(latestPlan, 'prerequisite workflow complete');
        await writeRecord();
        this.showPrerequisiteComplete(runDir, record);
        showTemporaryWorkflowNotification('Prerequisite complete. Return to the saved waiting workflow.');
        return;
      }
      if (record.decision === 'PHASE_COMPLETE') {
        record.stage = 'code_ready';
        record.resumeStage = undefined;
        record.acceptanceStatus = 'complete';
        record.codeDecision = 'CODE_READY';
        record.codeDetail = record.detail;
        record.prerequisite = undefined;
        await publishDraft(latestPlan, 'phase complete after prerequisite recheck');
        await writeRecord();
        await this.showCodeReady(runDir, record);
        showTemporaryWorkflowNotification('The saved phase is complete. No further planning or implementation is required.');
        return;
      }
      if (record.decision === 'NEEDS_MORE_PLANNING' || record.decision === 'STOP') {
        record.stage = 'waiting_for_more_planning';
        record.resumeStage = undefined;
        await publishDraft(latestPlan, 'needs more planning');
        await writeRecord();
        this.showMorePlanning(runDir, record, {
          decision: record.decision,
          detail: record.detail ?? 'The current plan needs another bounded planning pass.',
          plannerPrompt: record.orchestratorDirection || record.detail || '',
          phases: []
        }, latestPlan, latestReview);
        showTemporaryWorkflowNotification('This plan is not ready to implement. Continue planning from the sidebar.');
        return;
      }
      if (record.decision === 'READY_TO_CODE') {
        record.stage = 'ready_to_code';
        record.resumeStage = undefined;
        await publishDraft(latestPlan, 'ready to code');
        record.approvedPlanPath = await publishApprovedPlan(cwd, record, latestPlan);
        await cleanupPublishedPlans(cwd, runDir, record, false);
        await writeRecord();
        if (preset.secondarySolApproval && autoImplementAfterSecondaryApproval && !requiresExplicitImplementationApproval(record)) {
          const secondaryModel = secondaryApprovalRole(preset).model;
          await saveImplementationApprovalGuidance(runDir, record, `${secondaryModel} independently approved the completed plan and the preset authorized automatic implementation. Preserve the approved scope and all human-owned Git index state.`);
          this.running = false;
          this.controller = undefined;
          this.post({ type: 'running', running: false });
          this.setStatus(`${secondaryModel} approved the completed plan. Beginning implementation automatically…`);
          await this.startCode(runDir, record, latestPlan);
          return;
        }
        this.showReadyToCode(runDir, record, latestPlan);
        showTemporaryWorkflowNotification('The plan is ready. Start implementation from the sidebar when you are ready.');
        return;
      }
      record.stage = 'finished';
      record.resumeStage = undefined;
      await publishDraft(latestPlan, record.decision ?? 'finished');
      await writeRecord();
      this.setStatus(`${record.decision}: ${record.detail}`);
      showTemporaryWorkflowNotification(`${record.decision}. ${record.detail}`);
    } catch (error) {
      if (this.controller?.signal.aborted && (this.pauseRequested || this.stopRequested)) {
        record.resumeStage = ['planning', 'reviewing', 'deciding'].includes(record.stage) ? record.stage as ResumeStage : 'planning';
        record.stage = this.pauseRequested ? 'paused' : 'cancelled';
        await publishDraft(latestPlan, record.stage);
        await writeRecord();
        this.paused = true;
        this.canReopenApprovedRequirements = record.requirementsGuard?.status === 'approved';
        this.currentInteraction = undefined;
        this.setStatus(`${this.pauseRequested ? 'Paused' : 'Stopped'} at round ${record.round}/${preset.maxRounds} during ${record.resumeStage}. You can resume this run.`);
        this.post({ type: 'paused', paused: true });
        this.sendViewState();
      } else {
        record.resumeStage = ['planning', 'reviewing', 'deciding'].includes(record.stage) ? record.stage as ResumeStage : 'planning';
        record.stage = 'failed';
        const failureText = friendlyError(error);
        record.detail = failureText;
        try {
          await save('failure.txt', `${new Date().toISOString()}\nStage: ${record.resumeStage}\n\n${failureText}\n`);
          await publishDraft(latestPlan, 'failed');
        } catch { /* Preserve the provider failure as the primary error. */ }
        await writeRecord();
        this.fail(error);
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.pauseRequested = false;
      this.stopRequested = false;
      this.post({ type: 'running', running: false });
    }
  }

  private async resumeCodeRun(runDir: string, record: RunRecord, plan: string): Promise<void> {
    const round = Math.max(1, record.codeRound || 1);
    const read = async (name: string) => {
      try { return await fs.readFile(path.join(runDir, name), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const implementation = await read(`code-round-${round}-implementation.md`);
    const review = await read(`code-round-${round}-review.md`);
    const decisionText = await read(`code-round-${round}-decision.json`);
    const decision = decisionText ? parseCodeDecision(decisionText) : undefined;
    if (record.stage === 'waiting_for_prerequisite') {
      const prerequisite = record.prerequisite ?? explicitUnmetPrerequisite(plan) ?? {
        title: 'External prerequisite',
        reason: 'This phase is saved until work outside the current workflow is complete.',
        resumeWhen: 'Resume after the prerequisite work and its required evidence are available.'
      };
      record.prerequisite = prerequisite;
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      this.showWaitingForPrerequisite(runDir, record, plan, review, prerequisite);
      return;
    }
    const migratedPrerequisite = record.stage === 'acceptance_pending' && /(?:blocked[- ]gate|prerequisite|gated)/i.test(record.codeDetail ?? '')
      ? explicitUnmetPrerequisite(plan)
      : undefined;
    if (migratedPrerequisite) {
      record.stage = 'waiting_for_prerequisite';
      record.decision = 'WAITING_FOR_PREREQUISITE';
      record.prerequisite = migratedPrerequisite;
      record.acceptanceStatus = undefined;
      record.acceptanceInstructions = undefined;
      record.pendingHumanActions = undefined;
      record.acceptanceResponseTemplate = undefined;
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      this.showWaitingForPrerequisite(runDir, record, plan, review, migratedPrerequisite);
      return;
    }
    const blockedCommands = implementation?.split('\n').filter(line => line.trim().startsWith('COMMAND_BLOCKED:')) ?? [];
    const recoveredHandoff = blockedCommands.length ? blockedHumanHandoff(plan, blockedCommands, implementation) : undefined;
    if (record.stage === 'waiting_for_more_code' && recoveredHandoff) {
      const humanPrompt = await buildCodeHumanPrompt(runDir, recoveredHandoff);
      record.stage = 'waiting_for_code_human';
      record.codeResumeStage = 'code_reviewing';
      record.codeDecision = 'NEEDS_HUMAN';
      record.codeDetail = recoveredHandoff.detail;
      await fs.writeFile(path.join(runDir, `code-round-${round}-decision.json`), JSON.stringify(recoveredHandoff, null, 2), 'utf8');
      const actionFile = await saveHumanActionArtifact(runDir, record, round, humanPrompt);
      this.pendingCode = { runDir, record, stage: 'code_reviewing', round, plan, implementation, review, direction: record.codeDirection, question: recoveredHandoff.question };
      this.paused = true;
      this.currentTask = record.task;
      this.activePresetName = record.preset.name;
      this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
      if (!this.currentArtifacts.some(artifact => artifact.path === actionFile)) this.currentArtifacts.push({ path: actionFile, name: path.basename(actionFile) });
      this.currentInteraction = { type: 'codeNeedsInput', text: recoveredHandoff.question, details: humanPrompt, responseTemplate: recoveredHandoff.responseTemplate };
      this.setStatus(`Interactive acceptance requires your input at code round ${round}/${record.preset.maxCodeRounds}. Starting the app alone does not complete the check.`);
      this.sendViewState();
      return;
    }
    const secondaryCodeApprovalMissing = record.preset.secondarySolApproval
      && (record.codeDecision === 'CODE_READY' || decision?.decision === 'CODE_READY')
      && (record.secondaryCodeApprovalStatus !== 'approved' || record.secondaryCodeApprovalRound !== round);
    if (secondaryCodeApprovalMissing) {
      record.stage = 'code_deciding';
      record.codeResumeStage = 'code_deciding';
      record.secondaryCodeApprovalStatus = 'pending';
      record.secondaryCodeApprovalRound = round;
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
      await this.startCode(runDir, record, plan, { runDir, record, plan, stage: 'code_deciding', round, implementation, review, direction: record.codeDirection });
      return;
    }
    if (record.stage === 'code_ready' || decision?.decision === 'CODE_READY') {
      record.codeDetail = decision?.detail ?? record.codeDetail;
      if (decision && record.acceptanceStatus !== 'complete') {
        record.acceptanceStatus = decision.humanAcceptanceRequired ? 'pending' : record.acceptanceStatus;
        record.acceptanceInstructions = decision.humanAcceptanceRequired ? decision.humanInstructions : record.acceptanceInstructions;
        record.pendingHumanActions = decision.humanAcceptanceRequired ? decision.expectedEvidence : record.pendingHumanActions;
        record.acceptanceResponseTemplate = decision.humanAcceptanceRequired ? decision.responseTemplate : record.acceptanceResponseTemplate;
      }
      await this.showCodeReady(runDir, record);
      return;
    }
    const pendingHumanDecision = recoveredHandoff ?? (decision?.decision === 'NEEDS_HUMAN' ? decision : undefined);
    if (record.stage === 'waiting_for_code_human' && pendingHumanDecision) {
      if (recoveredHandoff) {
        record.codeDetail = recoveredHandoff.detail;
        await fs.writeFile(path.join(runDir, `code-round-${round}-decision.json`), JSON.stringify(recoveredHandoff, null, 2), 'utf8');
      }
      this.pendingCode = { runDir, record, stage: recoveredHandoff ? 'code_reviewing' : 'code_deciding', round, plan, implementation, review, direction: record.codeDirection, question: pendingHumanDecision.question };
      this.paused = true;
      this.currentTask = record.task;
      this.activePresetName = record.preset.name;
      this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
      const humanPrompt = await buildCodeHumanPrompt(runDir, { ...pendingHumanDecision, implementerPrompt: pendingHumanDecision.implementerPrompt || record.codeDirection || '' });
      const actionFile = await saveHumanActionArtifact(runDir, record, round, humanPrompt);
      for (const supportFile of await findHumanSupportFiles(runDir)) {
        if (!this.currentArtifacts.some(artifact => artifact.path === supportFile)) this.currentArtifacts.push({ path: supportFile, name: path.basename(supportFile) });
      }
      if (!this.currentArtifacts.some(artifact => artifact.path === actionFile)) this.currentArtifacts.push({ path: actionFile, name: path.basename(actionFile) });
      this.currentInteraction = { type: 'codeNeedsInput', text: pendingHumanDecision.question || 'Human input is required to continue.', details: humanPrompt, responseTemplate: pendingHumanDecision.responseTemplate };
      this.setStatus(`Code review is waiting for your input at round ${round}/${record.preset.maxCodeRounds}.`);
      this.sendViewState();
      return;
    }
    if (record.stage === 'waiting_for_more_code' || decision?.decision === 'NEEDS_MORE_CODE') {
      const detail = decision?.detail ?? record.codeDetail ?? 'The code needs another bounded implementation pass.';
      if (record.preset.maxCodeRounds < 30) {
        record.preset = { ...record.preset, maxCodeRounds: Math.min(30, record.preset.maxCodeRounds + 3) };
        await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
        this.setStatus(`Continuing automatically to complete bounded local work: ${detail}`);
        await this.startCode(runDir, record, plan, { runDir, record, plan, stage: 'implementing', round: round + 1, review, direction: decision?.implementerPrompt || record.codeDirection || detail });
      } else {
        this.showMoreCode(runDir, record, plan, implementation, review, decision?.implementerPrompt || record.codeDirection || detail, `The automatic safety ceiling was reached. ${detail}`);
      }
      return;
    }
    if (record.stage === 'code_stopped' || decision?.decision === 'STOP') {
      const detail = decision?.detail ?? record.codeDetail ?? 'The workflow cannot safely continue.';
      this.showMoreCode(runDir, record, plan, implementation, review, decision?.implementerPrompt || record.codeDirection || detail, detail);
      return;
    }
    if (decision?.decision === 'FIX') {
      if (round >= record.preset.maxCodeRounds) throw new Error('This code workflow reached its maximum number of fix rounds.');
      await this.startCode(runDir, record, plan, { runDir, record, plan, stage: 'implementing', round: round + 1, review, direction: decision.implementerPrompt });
      return;
    }
    const stage: CodeResumeStage = record.codeResumeStage
      ?? (review && !decisionText ? 'code_deciding' : implementation && !review ? 'code_reviewing' : 'implementing');
    await this.startCode(runDir, record, plan, { runDir, record, plan, stage, round, implementation, review, direction: record.codeDirection });
  }

  private async startCode(runDir: string, record: RunRecord, plan: string, continuation?: CodeContext): Promise<void> {
    if (this.running) throw new Error('A workflow is already running.');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open the project folder in VS Code first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running local agents.');
    const preset = validatePreset(record.preset);
    if (this.accountModels.length) {
      if (preset.secondarySolApproval && !this.accountModels.some(model => model.id === secondaryApprovalRole(preset).model)) {
        throw new Error(`Secondary approval is enabled, but ${secondaryApprovalRole(preset).model} is not available to this Codex CLI account. Refresh available Codex models, select another model, or disable the option.`);
      }
      for (const [name, role] of [['implementer', preset.implementer], ['code reviewer', preset.codeReviewer], ['orchestrator', preset.orchestrator]] as const) {
        if (role.provider !== 'codex' || !role.model) continue;
        const available = this.accountModels.find(model => model.id === role.model);
        if (!available) throw new Error(`The ${name} model “${role.model}” is not available to this Codex account. Choose one from the account model list or leave it blank.`);
        if (available.supportedReasoningEfforts.length && !available.supportedReasoningEfforts.includes(role.effort)) throw new Error(`${available.displayName} does not offer “${role.effort}” reasoning for this account.`);
      }
    }
    this.running = true;
    this.paused = false;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.pendingImplementation = undefined;
    this.pendingCode = undefined;
    this.pendingMoreCode = undefined;
    this.pendingNextPhase = undefined;
    this.currentInteraction = undefined;
    this.currentTask = record.task;
    this.activePresetName = preset.name;
    this.currentArtifacts = record.files.map(file => ({ path: file, name: path.basename(file) }));
    this.controller = new AbortController();
    this.post({ type: 'running', running: true });
    this.post({ type: 'paused', paused: false });
    const runFile = path.join(runDir, 'run.json');
    this.rememberRun(runFile);
    record.preset = preset;
    record.approvedPlanPath = record.approvedPlanPath ?? await publishApprovedPlan(folder.uri.fsPath, record, plan);
    const writeRecord = () => fs.writeFile(runFile, JSON.stringify(record, null, 2), 'utf8');
    const save = async (name: string, content: string) => {
      const file = path.join(runDir, name);
      await fs.writeFile(file, content, 'utf8');
      if (!record.files.includes(file)) record.files.push(file);
      await writeRecord();
      if (!this.currentArtifacts.some(artifact => artifact.path === file)) {
        this.currentArtifacts.push({ path: file, name });
        this.post({ type: 'artifact', path: file, name });
      }
    };
    let round = continuation?.round ?? 1;
    let stage: CodeResumeStage = continuation?.stage ?? 'implementing';
    let implementation = continuation?.implementation;
    let review = continuation?.review;
    let direction = `${gitIndexPolicy}\n\n${blockedCommandPolicy}\n\n${continuation?.direction ?? record.codeDirection ?? ''}`.trim();
    try {
      for (; round <= preset.maxCodeRounds; round++) {
        record.codeRound = round;
        record.codeResumeStage = undefined;
        if (stage === 'implementing') {
          record.stage = record.codeStage = 'implementing';
          await writeRecord();
          let localImplementationStarter = '';
          if (preset.localImplementationStarter && preset.ollamaModel.trim()) {
            const starterFile = path.join(runDir, `code-round-${round}-local-implementation-starter.md`);
            try { localImplementationStarter = await fs.readFile(starterFile, 'utf8'); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: Ollama is preparing an implementation work packet`);
              try {
                localImplementationStarter = await createLocalWorkStarter(preset.ollamaModel, 'implementation', [
                  `Original task:\n${record.originalTask ?? record.task}`,
                  `Approved plan:\n${plan}`,
                  `Planning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}`,
                  review ? `Prior code review:\n${review}` : '',
                  `Orchestrator fix instructions:\n${direction || 'Implement the approved plan without expanding scope.'}`
                ].filter(Boolean).join('\n\n---\n\n'), this.controller.signal);
                await save(`code-round-${round}-local-implementation-starter.md`, `# Local implementation starter\n\nAdvisory only. This file does not claim that edits or tests were completed. Claude remains the canonical implementer.\n\n${localImplementationStarter}\n`);
              } catch (starterError) {
                localImplementationStarter = '';
                await save(`code-round-${round}-local-implementation-starter-warning.txt`, `The optional Ollama implementation starter was skipped. Claude implementation continued normally.\n\n${friendlyError(starterError)}\n`);
              }
            }
          }
          const implementerSessionId = preset.implementer.provider === 'claude'
            ? reusableClaudeSession(preset.claudeSessionPolicy, record.claudeSessions?.implementer, record.claudeSessions?.implementerStartedRound, round)
            : '';
          this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: ${implementerSessionId ? 'continuing Claude implementation session' : 'implementing the approved plan'}`);
          const firstImplementationContext = `Original task:\n${record.originalTask ?? record.task}\n\nApproved plan:\n${plan}\n\nPlanning ledger:\n${JSON.stringify(record.planningLedger, null, 2)}\n\nHuman guidance:\n${record.humanInput || 'None provided'}`;
          const resumedImplementationContext = `Continue the saved implementation session. The approved plan, scope boundaries, and existing user changes are unchanged. Inspect the current working tree and complete only the remaining work. Treat the newly recorded human guidance and verification evidence below as authoritative for unchanged checks; do not rerun a command solely to reconfirm evidence already marked PASS.\n\nNewly recorded human guidance and verification evidence:\n${record.humanInput || 'None provided'}`;
          implementation = await invoke(preset.implementer,
            `Implement the approved plan in the current workspace. Inspect the current working tree first and continue safely from any partial prior attempt. Preserve unrelated user changes. Do not commit, push, deploy, reset, or discard work. Run the existing local checks appropriate to the changed code, including repository-provided guardrails, mock harnesses, shell-script harnesses, and isolated database checks when their local prerequisites such as Docker are available. Repository verification scripts may be run with bash or sh, using workspace-relative paths when possible. Local Supabase lifecycle and psql commands may be used when required by the approved plan, but never add hosted-project flags, a remote database URL, or any command that links, pushes, deploys, or changes a hosted Supabase project. Treat .review-workflow/ as volatile orchestration metadata rather than product source; exclude it from product checksum invariants unless the approved plan explicitly names a narrowly scoped exception. If the prior review names a missing local check, inspect package scripts, workflow files, and repository documentation to find and actually run its local command; do not merely describe the check again. If human guidance or inherited sibling evidence records a PASS for an unchanged acceptance check, reuse that evidence and do not attempt the interactive command again. If the provider permission layer refuses a required command with no matching recorded evidence, stop immediately and include a line exactly formatted as “COMMAND_BLOCKED: <exact command>”; do not consume later rounds repeating that it was not run. Return a concise Markdown summary with each command run, its result, files changed, and any remaining issue. Remote CI, commits, pushes, pull requests, and hosted artifacts are human follow-up steps and must never block completion of this local implementation workflow.\n\n${implementerSessionId ? resumedImplementationContext : firstImplementationContext}${localImplementationStarter ? `\n\nLocal Ollama implementation starter (advisory; verify every file and command before using it):\n${localImplementationStarter}` : ''}\n\nPrior code review:\n${review || 'This is the first implementation pass.'}\n\nOrchestrator fix instructions:\n${direction || 'Implement the approved plan without expanding its scope.'}`,
            folder.uri.fsPath, false, this.controller.signal, record.additionalDirectories, preset.claudeExploreModel, implementerSessionId, sessionId => {
              record.claudeSessions = { ...record.claudeSessions, implementer: sessionId, implementerStartedRound: implementerSessionId ? record.claudeSessions?.implementerStartedRound ?? round : round };
            });
          implementation = `${implementation}\n\nWorkflow verification policy:\n${gitIndexPolicy}\n${blockedCommandPolicy}`;
          await save(`code-round-${round}-implementation.md`, implementation);
          let blockedCommands = implementation.split('\n').filter(line => line.trim().startsWith('COMMAND_BLOCKED:'));
          const executedCommands = blockedCommands.filter(line => blockedCommandHasExecutionEvidence(implementation!, line));
          if (executedCommands.length) {
            implementation = implementation.split('\n').map(line => executedCommands.includes(line)
              ? line.replace(/^\s*COMMAND_BLOCKED:/i, 'CHECK_FAILED:')
              : line).join('\n');
            blockedCommands = blockedCommands.filter(line => !executedCommands.includes(line));
            await save(`code-round-${round}-implementation.md`, implementation);
          }
          const isProhibitedIndexMutation = (line: string) => /^COMMAND_BLOCKED:\s*git\s+(?:restore\s+--staged\b|reset\b|add\b|rm\s+--cached\b)/i.test(line.trim());
          const ignoredIndexMutations = blockedCommands.filter(isProhibitedIndexMutation);
          if (ignoredIndexMutations.length) {
            implementation = implementation.split('\n').map(line => isProhibitedIndexMutation(line)
              ? 'SKIPPED_BY_WORKFLOW: Git index mutation was not authorized. Existing staged and unstaged changes were preserved for review.'
              : line).join('\n');
            blockedCommands = blockedCommands.filter(line => !isProhibitedIndexMutation(line));
            record.humanInput = [record.humanInput, 'Workflow policy preserved all existing staged and unstaged changes. Git index state is human-owned and is not a readiness blocker.'].filter(Boolean).join('\n\n');
            await save(`code-round-${round}-implementation.md`, implementation);
          }
          if (blockedCommands.length) {
            const procedure = manualProcedureForBlockedCommand(plan, blockedCommands);
            const siblingEvidence = await completedSiblingEvidence(path.dirname(runDir), record.parentRunId, record.id);
            const currentRevision = await cleanRepositoryRevision(folder.uri.fsPath);
            const handoff = blockedHumanHandoff(plan, blockedCommands, implementation);
            if (siblingEvidenceSatisfiesProcedure(procedure, siblingEvidence, currentRevision)) {
              implementation = implementation.replace(/^\s*COMMAND_BLOCKED:.*$/gm, 'The interactive command was unavailable to the implementer; matching acceptance evidence from a completed sibling phase is reused below.');
              implementation += `\n\nInherited completed-sibling acceptance evidence:\n${siblingEvidence}`;
              record.humanInput = [record.humanInput, `Automatically inherited completed-sibling acceptance evidence:\n${siblingEvidence}`].filter(Boolean).join('\n\n');
              await save(`code-round-${round}-implementation.md`, implementation);
              this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: reused matching acceptance evidence from a completed sibling phase`);
            } else if (handoff) {
              const humanPrompt = await buildCodeHumanPrompt(runDir, handoff);
              record.stage = 'waiting_for_code_human';
              record.codeResumeStage = 'code_reviewing';
              record.codeDetail = handoff.detail;
              record.codeDecision = 'NEEDS_HUMAN';
              await save(`code-round-${round}-decision.json`, JSON.stringify(handoff, null, 2));
              await save(`code-round-${round}-human-action.md`, `# Human action required\n\n${humanPrompt}\n`);
              this.pendingCode = { runDir, record, stage: 'code_reviewing', round, plan, implementation, review, direction, question: handoff.question };
              this.paused = true;
              this.currentInteraction = { type: 'codeNeedsInput', text: handoff.question, details: humanPrompt, responseTemplate: handoff.responseTemplate };
              this.setStatus(`Interactive verification requires your input at code round ${round}/${preset.maxCodeRounds}. Follow the complete saved procedure.`);
              this.sendViewState();
              return;
            } else {
              record.stage = 'waiting_for_more_code';
              record.codeDetail = `A required local command was blocked by the provider permission layer. Approve or run it once, then use the final verification action.\n\n${blockedCommands.join('\n')}`;
              await writeRecord();
              this.showMoreCode(runDir, record, plan, implementation, review, direction, record.codeDetail, true);
              return;
            }
          }
        }
        if (stage === 'implementing' || stage === 'code_reviewing') {
          record.stage = record.codeStage = 'code_reviewing';
          await writeRecord();
          this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: reviewing the working tree`);
          review = await invoke(preset.codeReviewer,
            `Review the current working tree against the approved plan. Inspect the repository and git diff. Do not edit files. Report High, Medium, and Low findings with file evidence, the implementer's reported local check results, and any deviation from the approved scope. End with a clear recommendation. Ignore unrelated pre-existing changes except where they create a concrete conflict. Your environment is intentionally read only: do not treat your inability to run a command that writes files as a product finding. Identify missing local verification from the implementation summary and send it back as required work for the implementer. Never require a commit, push, pull request, deployment, remote CI run, or hosted artifact for CODE_READY; list those as optional human follow-up steps.\n\nOriginal task:\n${record.originalTask ?? record.task}\n\nApproved plan:\n${plan}\n\nImplementation summary:\n${implementation || 'No implementation summary was available; inspect the working tree directly.'}`,
            folder.uri.fsPath, true, this.controller.signal, [], preset.claudeExploreModel);
          await save(`code-round-${round}-review.md`, review);
        }
        record.stage = record.codeStage = 'code_deciding';
        await writeRecord();
        this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: deciding whether fixes are needed`);
        const rawDecision = await invoke(preset.orchestrator,
          `Decide the next step after implementation and code review. Do not edit files. Reply with ONLY JSON: {"decision":"FIX|CODE_READY|NEEDS_HUMAN|NEEDS_MORE_CODE|STOP","detail":"specific explanation","implementerPrompt":"complete bounded instructions for the next fix pass","question":"one explicit question when human input is truly required, otherwise empty","humanInstructions":"complete numbered operator or acceptance procedure when human action is required, otherwise empty","expectedEvidence":["specific observation to report"],"responseTemplate":"ready-to-edit response containing every requested result, otherwise empty","humanAcceptanceRequired":false}. Choose CODE_READY when the approved code changes are implemented, no High findings remain, no actionable Medium code findings remain, and required local checks passed. Set humanAcceptanceRequired to true when CODE_READY still has manual, operator, device, visual, packaged-app, or other human-only acceptance checks that must be completed before the phase itself can be declared complete. In that case, fill humanInstructions, expectedEvidence, and responseTemplate completely; CODE_READY means automated work is complete while phase completion remains pending. Set it to false only when no required human acceptance remains. Choose FIX for bounded corrections and make implementerPrompt self-contained. Choose NEEDS_MORE_CODE on the final configured round when bounded, actionable corrections or missing local verification remain. Choose NEEDS_HUMAN only for a product decision, unavailable credential, destructive or irreversible action, unavailable external service, an interactive desktop action unavailable to the provider, or an explicit COMMAND_BLOCKED report from the implementer. Never send a blocked command through another automatic round: ask once with the exact command and expected evidence. Routine local edits, tests, Docker use, verification, and inspection must proceed without human input. When human action is required, inspect the approved plan and saved implementation/review evidence to recover the complete original procedure. The question must say plainly what outcome is needed. humanInstructions must include prerequisites, exact commands with the correct working directory and variable setup, ordered UI actions, expected result after each step, failure/stop conditions, and cleanup. Do not tell the human merely to 'run the check' or refer them to an unnamed plan section. expectedEvidence must enumerate every observation the workflow needs. responseTemplate must be ready to paste after replacing PASS/FAIL or requested values and must name any results file that should be updated. For a product choice, use humanInstructions to explain the options and consequences instead. Choose STOP only when implementation cannot productively or safely continue and there is no actionable fix path. A read-only reviewer sandbox is not itself a blocker: require the implementer to run and report local checks. Never require a commit, push, pull request, deployment, remote CI run, or hosted artifact for CODE_READY; those are explicitly outside this workflow and may be listed only as human follow-up. This is code round ${round} of ${preset.maxCodeRounds}.${round === preset.maxCodeRounds ? ' This is the final configured round; choose NEEDS_MORE_CODE instead of FIX when another bounded pass can resolve the findings.' : ''}\n\nOriginal task:\n${record.originalTask ?? record.task}\n\nApproved plan:\n${plan}\n\nHuman guidance:\n${record.humanInput || 'None provided'}\n\nImplementation summary:\n${implementation}\n\nCode review:\n${review}`,
          folder.uri.fsPath, true, this.controller.signal, [], preset.claudeExploreModel);
        await save(`code-round-${round}-decision.json`, rawDecision);
        let result = parseCodeDecision(rawDecision);
        if (preset.secondarySolApproval && preset.secondaryDecisionDelegation && result.decision === 'NEEDS_HUMAN' && !requiresDirectHumanAction(`${result.question}\n${result.detail}\n${result.humanInstructions}`)) {
          const secondaryRole = secondaryApprovalRole(preset);
          this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: ${secondaryRole.model} is resolving the implementation decision from approved evidence`);
          const rawDelegation = await invoke(secondaryRole, delegatedDecisionPrompt(
            `${result.question || result.detail}\n\n${result.humanInstructions}`,
            `Original task:\n${record.originalTask ?? record.task}\n\nRecorded human guidance:\n${record.humanInput || 'None'}\n\nApproved plan:\n${plan}\n\nImplementation summary:\n${implementation}\n\nCode review:\n${review}\n\nCode orchestrator decision:\n${JSON.stringify(result, null, 2)}`
          ), folder.uri.fsPath, true, this.controller.signal);
          const delegation = parseDelegatedDecision(rawDelegation);
          await save(`code-round-${round}-delegated-decision.json`, JSON.stringify(delegation, null, 2));
          await save(`code-round-${round}-delegated-decision.md`, delegatedDecisionMarkdown('Delegated implementation decision', secondaryRole.model, delegation));
          if (delegation.decision === 'RESOLVED') {
            record.humanInput = [record.humanInput, `Decision delegated to ${secondaryRole.model}:\n${delegation.answer}\n\nRationale:\n${delegation.rationale}`].filter(Boolean).join('\n\n');
            result = {
              ...result,
              decision: 'FIX',
              detail: `${secondaryRole.model} resolved the decision from approved evidence: ${delegation.answer}`,
              implementerPrompt: delegation.nextInstruction || `Continue using this delegated owner decision: ${delegation.answer}`,
              question: '',
              humanInstructions: '',
              expectedEvidence: [],
              responseTemplate: '',
              humanAcceptanceRequired: false
            };
            await save(`code-round-${round}-decision.json`, JSON.stringify(result, null, 2));
          }
        }
        if (preset.secondarySolApproval && result.decision === 'CODE_READY') {
          const secondaryRole = secondaryApprovalRole(preset);
          record.secondaryCodeApprovalStatus = 'pending';
          record.secondaryCodeApprovalRound = round;
          await writeRecord();
          this.setStatus(`Code round ${round}/${preset.maxCodeRounds}: ${secondaryRole.model} is independently reviewing the completed implementation`);
          const rawSecondaryReview = await invoke(secondaryRole,
            `Perform a final independent review of the completed implementation against the approved plan and current working tree. Inspect the repository and staged and unstaged diffs read-only. Do not edit files. Reply with ONLY JSON: {"decision":"APPROVE|REVISE|NEEDS_HUMAN","summary":"concise assessment","findings":["specific High or actionable Medium defect with file evidence"],"correctionPrompt":"bounded implementer instructions, or empty when approved"}. Choose APPROVE only when the implementation satisfies the approved plan, contains no High or actionable Medium defect, preserves scope and the Git index, and the required automated checks have credible passing evidence. Do not require commits, pushes, deployment, remote CI, or optional hardening. Preserve genuine human-only acceptance as a later handoff rather than treating it as a code defect. Choose NEEDS_HUMAN only for a genuine product decision, unavailable credential, destructive action, unavailable external service, or required interactive acceptance.\n\nOriginal task:\n${record.originalTask ?? record.task}\n\nApproved plan:\n${plan}\n\nImplementation summary:\n${implementation}\n\nPrimary code review:\n${review}\n\nPrimary orchestrator decision:\n${JSON.stringify(result, null, 2)}`,
            folder.uri.fsPath, true, this.controller.signal);
          const secondaryReview = parseSecondaryApprovalReview(rawSecondaryReview);
          await save(`code-round-${round}-secondary-approval-review.json`, JSON.stringify(secondaryReview, null, 2));
          await save(`code-round-${round}-secondary-approval-review.md`, secondaryApprovalMarkdown('Secondary final implementation review', secondaryRole.model, secondaryReview));
          let reviewedDecision = secondaryReview;
          if (reviewedDecision.decision === 'NEEDS_HUMAN' && preset.secondaryDecisionDelegation && !requiresDirectHumanAction(`${reviewedDecision.summary}\n${reviewedDecision.findings.join('\n')}`)) {
            const rawDelegation = await invoke(secondaryRole, delegatedDecisionPrompt(
              `${reviewedDecision.summary}\n${reviewedDecision.findings.join('\n')}`,
              `Original task:\n${record.originalTask ?? record.task}\n\nRecorded human guidance:\n${record.humanInput || 'None'}\n\nApproved plan:\n${plan}\n\nImplementation summary:\n${implementation}\n\nPrimary code review:\n${review}`
            ), folder.uri.fsPath, true, this.controller.signal);
            const delegation = parseDelegatedDecision(rawDelegation);
            await save(`code-round-${round}-secondary-delegated-decision.json`, JSON.stringify(delegation, null, 2));
            await save(`code-round-${round}-secondary-delegated-decision.md`, delegatedDecisionMarkdown('Delegated final-implementation decision', secondaryRole.model, delegation));
            if (delegation.decision === 'RESOLVED') {
              reviewedDecision = {
                decision: 'REVISE',
                summary: `Delegated decision resolved from approved evidence: ${delegation.answer}`,
                findings: secondaryReview.findings,
                correctionPrompt: delegation.nextInstruction || delegation.answer
              };
              record.humanInput = [record.humanInput, `Decision delegated to ${secondaryRole.model}:\n${delegation.answer}\n\nRationale:\n${delegation.rationale}`].filter(Boolean).join('\n\n');
            }
          }
          if (reviewedDecision.decision === 'APPROVE') {
            record.secondaryCodeApprovalStatus = 'approved';
            record.secondaryCodeApprovalRound = round;
            result = { ...result, detail: `${result.detail}\n\n${secondaryRole.model} secondary approval: ${reviewedDecision.summary}` };
          } else if (reviewedDecision.decision === 'REVISE') {
            record.secondaryCodeApprovalStatus = undefined;
            record.secondaryCodeApprovalRound = undefined;
            result = {
              ...result,
              decision: 'FIX',
              detail: `${secondaryRole.model} secondary review found bounded implementation work: ${reviewedDecision.summary}`,
              implementerPrompt: reviewedDecision.correctionPrompt || [reviewedDecision.summary, ...reviewedDecision.findings].join('\n'),
              humanAcceptanceRequired: false
            };
          } else {
            record.secondaryCodeApprovalStatus = undefined;
            record.secondaryCodeApprovalRound = undefined;
            result = {
              ...result,
              decision: 'NEEDS_HUMAN',
              detail: reviewedDecision.summary,
              implementerPrompt: '',
              question: reviewedDecision.summary,
              humanInstructions: reviewedDecision.findings.join('\n'),
              expectedEvidence: reviewedDecision.findings,
              responseTemplate: 'Owner decision or acceptance result: <record the decision and requested evidence>',
              humanAcceptanceRequired: false
            };
          }
          await save(`code-round-${round}-decision.json`, JSON.stringify(result, null, 2));
        }
        record.codeDecision = result.decision;
        record.codeDetail = result.detail;
        record.codeDirection = result.implementerPrompt || undefined;
        if (result.decision === 'CODE_READY') {
          record.acceptanceStatus = result.humanAcceptanceRequired ? 'pending' : record.acceptanceStatus === 'pending' ? 'complete' : undefined;
          record.acceptanceInstructions = result.humanAcceptanceRequired ? result.humanInstructions : undefined;
          record.pendingHumanActions = result.humanAcceptanceRequired ? result.expectedEvidence : undefined;
          record.acceptanceResponseTemplate = result.humanAcceptanceRequired ? result.responseTemplate : undefined;
        }
        await writeRecord();
        if (result.decision === 'FIX') {
          if (round >= preset.maxCodeRounds) {
            if (preset.maxCodeRounds < 30) {
              preset.maxCodeRounds = Math.min(30, preset.maxCodeRounds + 3);
              record.preset = preset;
              await writeRecord();
              this.setStatus(`Continuing automatically through round ${preset.maxCodeRounds} to complete bounded fixes.`);
            } else {
              record.stage = 'waiting_for_more_code';
              record.codeDetail = `The automatic safety ceiling was reached with fixes remaining: ${result.detail}`;
              await writeRecord();
              this.showMoreCode(runDir, record, plan, implementation, review, result.implementerPrompt || result.detail, record.codeDetail);
              return;
            }
          }
          direction = result.implementerPrompt;
          stage = 'implementing';
          implementation = undefined;
          continue;
        }
        if (result.decision === 'NEEDS_HUMAN') {
          record.stage = 'waiting_for_code_human';
          record.codeResumeStage = 'code_deciding';
          this.pendingCode = { runDir, record, stage: 'code_deciding', round, plan, implementation, review, direction, question: result.question };
          this.paused = true;
          const humanPrompt = await buildCodeHumanPrompt(runDir, result);
          for (const supportFile of await findHumanSupportFiles(runDir)) {
            if (!record.files.includes(supportFile)) record.files.push(supportFile);
            if (!this.currentArtifacts.some(artifact => artifact.path === supportFile)) this.currentArtifacts.push({ path: supportFile, name: path.basename(supportFile) });
          }
          await save(`code-round-${round}-human-action.md`, `# Human action required\n\n${humanPrompt}\n`);
          this.currentInteraction = { type: 'codeNeedsInput', text: result.question || 'Human input is required to continue.', details: humanPrompt, responseTemplate: result.responseTemplate };
          this.setStatus(`Code review is waiting for your input at round ${round}/${preset.maxCodeRounds}.`);
          this.sendViewState();
          return;
        }
        if (result.decision === 'NEEDS_MORE_CODE') {
          if (preset.maxCodeRounds < 30) {
            preset.maxCodeRounds = Math.min(30, preset.maxCodeRounds + 3);
            record.preset = preset;
            direction = result.implementerPrompt || result.detail;
            stage = 'implementing';
            implementation = undefined;
            await writeRecord();
            this.setStatus(`Continuing automatically through round ${preset.maxCodeRounds} to complete remaining local verification.`);
            continue;
          }
          record.stage = 'waiting_for_more_code';
          record.codeDetail = `The automatic safety ceiling was reached with local work remaining: ${result.detail}`;
          await writeRecord();
          this.showMoreCode(runDir, record, plan, implementation, review, result.implementerPrompt || result.detail, record.codeDetail);
          return;
        }
        if (result.decision === 'CODE_READY') {
          record.stage = 'code_ready';
          await writeRecord();
          await this.showCodeReady(runDir, record);
          showTemporaryWorkflowNotification('Implementation and automated code review are complete.');
          return;
        }
        record.stage = 'code_stopped';
        await writeRecord();
        this.setStatus(`Code workflow stopped: ${result.detail}`);
        showTemporaryWorkflowNotification(`Implementation stopped: ${result.detail}`);
        return;
      }
    } catch (error) {
      const activeStage = ['implementing', 'code_reviewing', 'code_deciding'].includes(record.codeStage ?? '') ? record.codeStage as CodeResumeStage : stage;
      record.codeResumeStage = activeStage;
      if (this.controller.signal.aborted && (this.pauseRequested || this.stopRequested)) {
        record.stage = this.pauseRequested ? 'code_paused' : 'code_cancelled';
        await writeRecord();
        this.paused = true;
        this.setStatus(`${this.pauseRequested ? 'Paused' : 'Stopped'} during ${activeStage} in code round ${round}/${preset.maxCodeRounds}. You can resume this run.`);
        this.post({ type: 'paused', paused: true });
      } else {
        record.stage = 'code_failed';
        record.codeDetail = friendlyError(error);
        try { await save('code-failure.txt', `${new Date().toISOString()}\nStage: ${activeStage}\n\n${record.codeDetail}\n`); } catch { /* keep original error */ }
        await writeRecord();
        this.fail(error);
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.pauseRequested = false;
      this.stopRequested = false;
      this.post({ type: 'running', running: false });
    }
  }
}

function validatePreset(value: unknown): Preset {
  if (!value || typeof value !== 'object') throw new Error('Invalid preset.');
  const data = value as Record<string, unknown>;
  const role = (input: unknown): Role => {
    if (!input || typeof input !== 'object') throw new Error('Each role needs a provider.');
    const r = input as Record<string, unknown>;
    if (r.provider !== 'claude' && r.provider !== 'codex') throw new Error('Provider must be Claude or Codex.');
    const effort = String(r.effort ?? 'medium');
    if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Unsupported effort level.');
    return { provider: r.provider, model: String(r.model ?? '').slice(0, 100), effort };
  };
  const planner = role(data.planner);
  const reviewer = role(data.reviewer);
  const maxRounds = Number(data.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new Error('The workflow round limit must be 1 to 50.');
  const maxCodeRounds = data.maxCodeRounds === undefined ? 3 : Number(data.maxCodeRounds);
  if (!Number.isInteger(maxCodeRounds) || maxCodeRounds < 1 || maxCodeRounds > 30) throw new Error('The code review round limit must be 1 to 30.');
  const name = String(data.name ?? '').trim().slice(0, 100);
  if (!name) throw new Error('Give the preset a name.');
  const claudeExploreModel = String(data.claudeExploreModel ?? 'haiku').trim().slice(0, 100);
  const claudeSessionPolicy = String(data.claudeSessionPolicy ?? 'checkpoint') as ClaudeSessionPolicy;
  if (!['checkpoint', 'continuous', 'fresh'].includes(claudeSessionPolicy)) throw new Error('Unsupported Claude session reuse policy.');
  const requirementsGuard = data.requirementsGuard === true;
  const ollamaModel = String(data.ollamaModel ?? '').trim().slice(0, 200);
  const localPlanningStarter = data.localPlanningStarter !== false;
  const localImplementationStarter = data.localImplementationStarter !== false;
  const secondarySolApproval = data.secondarySolApproval === true;
  const secondaryApprovalModel = String(data.secondaryApprovalModel ?? 'gpt-6.1-sol').trim().slice(0, 100) || 'gpt-6.1-sol';
  const secondaryDecisionDelegation = secondarySolApproval && data.secondaryDecisionDelegation === true;
  return { name, planner, reviewer, orchestrator: role(data.orchestrator), implementer: data.implementer ? role(data.implementer) : planner, codeReviewer: data.codeReviewer ? role(data.codeReviewer) : reviewer, claudeExploreModel, claudeSessionPolicy, requirementsGuard, ollamaModel, localPlanningStarter, localImplementationStarter, secondarySolApproval, secondaryApprovalModel, secondaryDecisionDelegation, maxRounds, maxCodeRounds };
}

function html(): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>
  :root{--blue:#58a6ff;--green:#3fb950;--purple:#bc8cff;--orange:#d29922;--pink:#f778ba;--cyan:#39c5cf}html{overflow-y:auto;scroll-padding-bottom:96px}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 12px 96px;margin:0;overflow-y:auto}h1{font-size:18px;margin:0}.app-header{margin:2px 0 14px}.title-row{display:flex;align-items:center;gap:8px}.version{font-size:11px;font-weight:600;padding:2px 7px;border:1px solid var(--blue);border-radius:10px;color:var(--blue)}h2{font-size:14px;margin:10px 0 4px}label{display:block;margin:10px 0 4px}input,select,textarea,button{box-sizing:border-box;width:100%;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}textarea{min-height:85px}button{margin-top:8px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled,input:disabled,select:disabled,textarea:disabled{cursor:not-allowed;opacity:.5}.row,.button-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}.check-row{display:flex;align-items:flex-start;gap:8px;margin:12px 0 4px}.check-row input{width:auto;margin:2px 0 0}.check-row label{margin:0;line-height:1.35}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.workflow-section{--accent:var(--blue);border:1px solid var(--vscode-panel-border);border-left:3px solid var(--accent);border-radius:4px;margin:0 0 12px;overflow:hidden;background:var(--vscode-sideBar-background)}.workflow-section>summary{cursor:pointer;font-size:13px;font-weight:700;padding:9px 10px;color:var(--accent);background:var(--vscode-sideBarSectionHeader-background);user-select:none}.workflow-section[open]>summary{border-bottom:1px solid var(--vscode-panel-border)}.section-body{padding:3px 10px 11px}.tone-green{--accent:var(--green)}.tone-purple{--accent:var(--purple)}.tone-orange{--accent:var(--orange)}.tone-pink{--accent:var(--pink)}.tone-cyan{--accent:var(--cyan)}.role{border-top:1px solid var(--vscode-panel-border);margin-top:12px;padding-top:4px}.role:first-child{border-top:0;margin-top:4px}.role h2{color:var(--vscode-descriptionForeground)}#status,#interactionPrompt,#interactionDetailsText{white-space:pre-wrap;user-select:text;-webkit-user-select:text}#status{font-weight:600;line-height:1.4;padding:8px;border-left:3px solid var(--green);background:var(--vscode-textBlockQuote-background)}#status:empty{display:none}#interaction{padding-bottom:36px}#interactionDetails{margin:10px 0;border:1px solid var(--vscode-panel-border);padding:8px}#interactionDetails summary{cursor:pointer;font-weight:600}#interactionDetailsText{font-family:var(--vscode-font-family);font-size:12px;line-height:1.4}#artifacts{margin-top:10px}#artifacts button{text-align:left;font-size:12px}.muted{opacity:.8;font-size:12px}.phase{border:1px solid var(--vscode-panel-border);padding:8px;margin-top:8px}.phase strong,.phase span{display:block}.phase span{margin-top:5px;white-space:pre-wrap}</style></head><body>
  <header class="app-header"><div class="title-row"><h1>CodeFlow Conductor</h1><span class="version">v0.47.5</span></div><p class="muted">From requirements to reviewed, accepted code.</p></header>
  <details class="workflow-section tone-purple" open><summary>Presets</summary><div class="section-body"><label>Saved preset</label><select id="presetList"></select><div class="button-row"><button id="loadPreset" class="secondary">Load selected</button><button id="deletePreset" class="secondary">Delete selected</button></div><label>Preset name</label><input id="name"><div class="button-row"><button id="save" class="secondary">Save preset</button><button id="renamePreset" class="secondary">Rename selected</button></div><p class="muted">To rename, load a preset, edit its name, then choose Rename selected.</p></div></details>
  <details class="workflow-section tone-green" open><summary>Starting point</summary><div class="section-body"><label>Task</label><textarea id="task" placeholder="Describe the change to plan"></textarea><label>Existing plan (optional)</label><button id="choosePlan" class="secondary">Choose an existing plan</button><p id="selectedPlan" class="muted">No plan selected — the planner will create one.</p></div></details>
  <details class="workflow-section tone-orange"><summary>Local Ollama assistance</summary><div class="section-body"><label>Requirements baseline</label><select id="requirementsGuard"><option value="off">Off — use the existing workflow</option><option value="ollama">Ollama — extract locally, then require human approval</option></select><label>Ollama model</label><input id="ollamaModel" list="ollamaModels" placeholder="Choose an installed local model"><datalist id="ollamaModels"></datalist><button id="refreshOllamaModels" class="secondary">Refresh local Ollama models</button><button id="chooseRequirementsSource" class="secondary">Choose approved specification (optional)</button><p id="selectedRequirementsSource" class="muted">The task and approved parent roadmap will be used when no separate specification is selected.</p><label>Local planning starter</label><select id="localPlanningStarter"><option value="on">On — prepare a first draft or revision packet for Claude</option><option value="off">Off</option></select><label>Local implementation starter</label><select id="localImplementationStarter"><option value="on">On — prepare an advisory file-and-test work packet first</option><option value="off">Off — Claude starts implementation without it</option></select><p class="muted">Ollama starters are advisory and cannot approve work. Claude sessions are resumed between rounds when Claude Code returns a session ID.</p></div></details>
  <details class="workflow-section tone-cyan"><summary>Workflow models and limits</summary><div class="section-body"><button id="refreshModels" class="secondary">Refresh available Codex models</button><p id="modelStatus" class="muted">Model list has not been checked.</p><div class="check-row"><input id="secondarySolApproval" type="checkbox"><label for="secondarySolApproval"><strong>Use a secondary approval reviewer</strong><br><span class="muted">Audits and may approve requirements, the final plan, and completed implementation. Approved requirements continue into planning; an approved final plan starts implementation automatically.</span></label></div><label>Secondary approval model</label><input id="secondaryApprovalModel" list="codexModels" placeholder="gpt-6.1-sol"><div class="check-row"><input id="secondaryDecisionDelegation" type="checkbox"><label for="secondaryDecisionDelegation"><strong>Let the secondary reviewer resolve decision-only human pauses</strong><br><span class="muted">Uses approved requirements, prior guidance, and repository evidence. UI/device acceptance, credentials, destructive authorization, and unsupported owner preferences still pause for you.</span></label></div><datalist id="codexModels"></datalist><datalist id="claudeModels"><option value="sonnet"></option><option value="opus"></option><option value="haiku"></option><option value="fable"></option></datalist><div id="roles"></div><section class="role"><h2>Claude context</h2><label>Planner and implementer session reuse</label><select id="claudeSessionPolicy"><option value="checkpoint">Balanced — start fresh every 3 rounds (recommended)</option><option value="continuous">Always resume the same session</option><option value="fresh">Start fresh every round</option></select><p class="muted">Balanced keeps short-term continuity but starts a clean Claude context at each three-round boundary. Saved plans, ledgers, reviews, and implementation evidence are supplied to the new session.</p></section><section class="role"><h2>Claude subagents</h2><label>Explore model (blank = Claude Code default)</label><input id="claudeExploreModel" list="claudeExploreModels" placeholder="haiku"><datalist id="claudeExploreModels"><option value="haiku"></option><option value="sonnet"></option><option value="opus"></option><option value="fable"></option></datalist><p class="muted">Applies only to Claude Code’s read-only Explore subagent. Haiku reduces usage while the selected planner, reviewer, orchestrator, and implementer models stay unchanged.</p></section><label>Maximum planning rounds</label><input id="rounds" type="number" min="1" max="50"><label>Implementation review checkpoint</label><input id="codeRounds" type="number" min="1" max="30"><p class="muted">Bounded local work continues automatically in three-round blocks, up to a hard limit of 30.</p></div></details>
  <details id="progressSection" class="workflow-section tone-green" open><summary>Workflow progress and controls</summary><div class="section-body"><button id="start">Start planning</button><button id="returnToWorkflow" class="secondary" hidden>Return to waiting workflow</button><div class="button-row"><button id="pause" class="secondary">Pause</button><button id="stop" class="secondary">Stop</button></div><label>Change preset when resuming (optional)</label><select id="currentRunPreset"><option value="">Keep the preset saved with this run</option></select><label id="resumeGuidanceLabel" hidden>Guidance for the resumed run (optional)</label><textarea id="resumeGuidance" hidden placeholder="Add instructions, corrections, or decisions to preserve when the run resumes"></textarea><button id="reopenApprovedRequirements" class="secondary" hidden>Reopen requirements baseline with correction</button><button id="resumeCurrent" class="secondary">Resume current run</button><button id="resumeSaved" class="secondary">Resume saved run…</button><p id="status" role="status"></p><section id="interaction" hidden><label id="interactionPrompt">Your response</label><details id="interactionDetails" hidden><summary>Show step-by-step instructions</summary><pre id="interactionDetailsText"></pre></details><button id="copyInteraction" class="secondary">Copy workflow message</button><button id="returnToPrerequisite" hidden>Return to waiting workflow</button><div id="roadmapAcceptance" class="phase" hidden><strong id="roadmapAcceptanceTitle">Provisional roadmap acceptance</strong><span class="muted">Paste the secondary review or owner notes. These notes will be inherited by focused phase plans without changing the approved roadmap.</span><textarea id="roadmapNotes" placeholder="Paste the secondary review or roadmap notes"></textarea><button id="acceptRoadmap">Provisionally accept roadmap</button></div><label id="phasePresetLabel" hidden>Preset for the phase you start</label><select id="phasePreset" hidden></select><p id="approvalGuidanceHelp" class="muted" hidden>Add optional instructions, constraints, or owner decisions for implementation. This guidance is saved with the run and given to the implementer; it does not rewrite the approved plan.</p><textarea id="humanInput" placeholder="Answer the question or give guidance"></textarea><button id="approveRequirements">Approve requirements baseline</button><button id="regenerateRequirements" class="secondary">Add correction and reconcile baseline</button><button id="attachRequirementsGuard">Attach local requirements guard to this run</button><button id="continue">Respond and continue planning</button><button id="continueCode">Respond and continue code review</button><button id="completeAcceptance">Record acceptance results and complete phase</button><button id="startPrerequisiteWorkflow">Start prerequisite workflow</button><button id="recheckPrerequisite" class="secondary">Recheck prerequisite</button><button id="implementPlan">Implement approved plan</button><button id="startNextPhase">Plan next phase</button><button id="continuePlanning">Continue planning with guidance</button><button id="continueImplementation">Continue implementation for 3 more rounds</button><button id="runFinalVerification">Run remaining verification and final review</button><button id="retry" class="secondary">Retry failed stage</button><div id="splitPhases" hidden></div></section><div id="artifacts"></div></div></details>
  <details class="workflow-section tone-pink"><summary>Phone alerts and remote controls</summary><div class="section-body"><p id="mobileStatus" class="muted">Mobile access is loading…</p><p id="mobileTopic" class="muted"></p><p id="mobilePairing" class="muted"></p><button id="setupMobile" class="secondary">Enable phone access</button><button id="testMobile" class="secondary">Send test phone alert</button><button id="mobileSignIn" class="secondary">Refresh Microsoft dev tunnel sign-in</button><button id="startMobileTunnel" class="secondary">Start phone dashboard</button><button id="stopMobileTunnel" class="secondary">Stop phone dashboard</button><button id="openMobileDashboard" class="secondary">Open phone dashboard</button><button id="regeneratePairing" class="secondary">Create new pairing code</button><button id="disableMobile" class="secondary">Disable phone access</button><p id="mobileError" class="muted"></p></div></details>
  <script>const vscode=acquireVsCodeApi();const roles=['planner','reviewer','orchestrator','implementer','codeReviewer'];const roleLabels={planner:'Planner',reviewer:'Plan reviewer',orchestrator:'Orchestrator',implementer:'Implementer',codeReviewer:'Code reviewer'};const roleBox=document.getElementById('roles');for(const name of roles){const box=document.createElement('div');box.className='role';box.innerHTML='<h2>'+roleLabels[name]+'</h2><div class="row"><div><label>Provider</label><select id="'+name+'Provider"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></div><div><label>Effort</label><select id="'+name+'Effort"><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></div></div><label>Model (blank = CLI default)</label><input id="'+name+'Model" list="claudeModels" placeholder="Choose an available model">';roleBox.appendChild(box)}const declineRequirementsButton=document.createElement('button');declineRequirementsButton.id='declineRequirements';declineRequirementsButton.className='secondary';declineRequirementsButton.textContent='Decline baseline and continue with approved source';declineRequirementsButton.hidden=true;document.getElementById('approveRequirements').insertAdjacentElement('afterend',declineRequirementsButton);declineRequirementsButton.onclick=()=>vscode.postMessage({type:'declineRequirements',humanInput:document.getElementById('humanInput').value});
  const el=id=>document.getElementById(id);let selectedPlanPath='';let selectedRequirementsSourcePath='';let loadedPresetName='';let availablePresets=[];let isRunning=false;let canResume=false;let canReopenApprovedRequirements=false;const collect=()=>({name:el('name').value,claudeExploreModel:el('claudeExploreModel').value,claudeSessionPolicy:el('claudeSessionPolicy').value,requirementsGuard:el('requirementsGuard').value==='ollama',ollamaModel:el('ollamaModel').value,localPlanningStarter:el('localPlanningStarter').value==='on',localImplementationStarter:el('localImplementationStarter').value==='on',secondarySolApproval:el('secondarySolApproval').checked,secondaryApprovalModel:el('secondaryApprovalModel').value,secondaryDecisionDelegation:el('secondaryDecisionDelegation').checked,maxRounds:Number(el('rounds').value),maxCodeRounds:Number(el('codeRounds').value),...Object.fromEntries(roles.map(n=>[n,{provider:el(n+'Provider').value,model:el(n+'Model').value,effort:el(n+'Effort').value}]))});const apply=p=>{loadedPresetName=p.name;el('name').value=p.name;el('claudeExploreModel').value=p.claudeExploreModel===undefined?'haiku':p.claudeExploreModel;el('claudeSessionPolicy').value=p.claudeSessionPolicy||'checkpoint';el('requirementsGuard').value=p.requirementsGuard?'ollama':'off';el('ollamaModel').value=p.ollamaModel||'';el('localPlanningStarter').value=p.localPlanningStarter===false?'off':'on';el('localImplementationStarter').value=p.localImplementationStarter===false?'off':'on';el('secondarySolApproval').checked=p.secondarySolApproval===true;el('secondaryApprovalModel').value=p.secondaryApprovalModel||'gpt-6.1-sol';el('secondaryDecisionDelegation').checked=p.secondaryDecisionDelegation===true;el('rounds').value=p.maxRounds;el('codeRounds').value=p.maxCodeRounds||3;for(const n of roles){const fallback=n==='implementer'?p.planner:n==='codeReviewer'?p.reviewer:p[n];el(n+'Provider').value=fallback.provider;el(n+'Model').value=fallback.model;el(n+'Effort').value=fallback.effort}updateControls()};const updateControls=()=>{el('start').disabled=isRunning;el('start').textContent=isRunning?'Workflow in progress…':selectedPlanPath?'Review existing plan':'Start planning';el('pause').disabled=!isRunning;el('stop').disabled=!isRunning;el('resumeCurrent').disabled=isRunning||!canResume;el('resumeSaved').disabled=isRunning;el('reopenApprovedRequirements').disabled=isRunning||!canResume||!canReopenApprovedRequirements;el('continuePlanning').disabled=isRunning;el('continueCode').disabled=isRunning;el('completeAcceptance').disabled=isRunning;el('startPrerequisiteWorkflow').disabled=isRunning;el('recheckPrerequisite').disabled=isRunning;el('continueImplementation').disabled=isRunning;el('runFinalVerification').disabled=isRunning;el('implementPlan').disabled=isRunning;el('startNextPhase').disabled=isRunning;el('acceptRoadmap').disabled=isRunning;el('approveRequirements').disabled=isRunning;el('regenerateRequirements').disabled=isRunning;el('attachRequirementsGuard').disabled=isRunning;for(const id of ['presetList','loadPreset','deletePreset','renamePreset','phasePreset','currentRunPreset','refreshModels','name','task','choosePlan','requirementsGuard','ollamaModel','localPlanningStarter','localImplementationStarter','secondarySolApproval','secondaryApprovalModel','secondaryDecisionDelegation','refreshOllamaModels','chooseRequirementsSource','claudeExploreModel','claudeSessionPolicy','rounds','codeRounds','save',...roles.flatMap(n=>[n+'Provider',n+'Model',n+'Effort'])])el(id).disabled=isRunning;el('secondaryDecisionDelegation').disabled=isRunning||!el('secondarySolApproval').checked;for(const button of el('splitPhases').querySelectorAll('button'))button.disabled=isRunning;for(const textarea of el('splitPhases').querySelectorAll('textarea'))textarea.disabled=isRunning};const setRunning=running=>{isRunning=running;updateControls()};const setPaused=paused=>{canResume=paused;el('resumeGuidanceLabel').hidden=!paused;el('resumeGuidance').hidden=!paused;el('reopenApprovedRequirements').hidden=!(paused&&canReopenApprovedRequirements);updateControls()};const run=(humanInput,type='start')=>{el('interaction').hidden=true;if(type==='start')el('artifacts').replaceChildren();setPaused(false);setRunning(true);vscode.postMessage({type,task:el('task').value,preset:collect(),humanInput,planPath:selectedPlanPath,requirementsSourcePath:selectedRequirementsSourcePath})};el('secondarySolApproval').addEventListener('change',updateControls);
  const artifactFileName=value=>String(value||'').split('/').pop();const artifactRoundFromName=(name,pattern)=>{const match=artifactFileName(name).match(pattern);return match?Number(match[1]):-1};const artifactFriendlyName=name=>{const file=artifactFileName(name);let match=file.match(/^round-([0-9]+)-plan[.]md$/);if(match)return'Current plan — round '+match[1];match=file.match(/^round-([0-9]+)-local-planning-starter[.]md$/);if(match)return'Ollama planning starter — round '+match[1];match=file.match(/^code-round-([0-9]+)-implementation[.]md$/);if(match)return'Latest implementation report — round '+match[1];match=file.match(/^code-round-([0-9]+)-local-implementation-starter[.]md$/);if(match)return'Ollama implementation starter — round '+match[1];if(file==='requirements-baseline.md')return'Requirements baseline';if(file==='requirements-corrections.md')return'Locked requirements corrections';if(file==='working-plan.md')return'Working plan';if(file==='human-acceptance-required.md')return'Human acceptance checklist';if(file==='human-acceptance-results.md')return'Human acceptance results';if(file==='00-workflow-overview.md')return'Approved workflow overview';return name};let artifactObserver;const organizeArtifactButtons=()=>{const host=el('artifacts');const buttons=[...host.querySelectorAll('button')];if(!buttons.length)return;for(const button of buttons)if(!button.dataset.artifactName)button.dataset.artifactName=button.textContent||'';const latestPlan=Math.max(-1,...buttons.map(button=>artifactRoundFromName(button.dataset.artifactName,/^round-([0-9]+)-plan[.]md$/)));const latestLocalPlan=Math.max(-1,...buttons.map(button=>artifactRoundFromName(button.dataset.artifactName,/^round-([0-9]+)-local-planning-starter[.]md$/)));const latestImplementation=Math.max(-1,...buttons.map(button=>artifactRoundFromName(button.dataset.artifactName,/^code-round-([0-9]+)-implementation[.]md$/)));const latestLocalImplementation=Math.max(-1,...buttons.map(button=>artifactRoundFromName(button.dataset.artifactName,/^code-round-([0-9]+)-local-implementation-starter[.]md$/)));const primary=[];const technical=[];for(const button of buttons){const name=button.dataset.artifactName;const file=artifactFileName(name);const useful=file==='requirements-baseline.md'||file==='requirements-corrections.md'||file==='working-plan.md'||file==='human-acceptance-required.md'||file==='human-acceptance-results.md'||file==='00-workflow-overview.md'||/-approved(?:-plan-index)?[.]md$/.test(file)||/^code-round-[0-9]+-human-action[.]md$/.test(file)||/failure[.]txt$/.test(file)||(artifactRoundFromName(name,/^round-([0-9]+)-plan[.]md$/)===latestPlan&&latestPlan>=0)||(artifactRoundFromName(name,/^round-([0-9]+)-local-planning-starter[.]md$/)===latestLocalPlan&&latestLocalPlan>=0)||(artifactRoundFromName(name,/^code-round-([0-9]+)-implementation[.]md$/)===latestImplementation&&latestImplementation>=0)||(artifactRoundFromName(name,/^code-round-([0-9]+)-local-implementation-starter[.]md$/)===latestLocalImplementation&&latestLocalImplementation>=0);button.textContent=useful?artifactFriendlyName(name):name;(useful?primary:technical).push(button)}artifactObserver.disconnect();host.replaceChildren(...primary);if(technical.length){const details=document.createElement('details');details.className='phase';const summary=document.createElement('summary');summary.textContent='Technical run history ('+technical.length+' files)';details.append(summary,...technical);host.appendChild(details)}artifactObserver.observe(host,{childList:true,subtree:true})};artifactObserver=new MutationObserver(organizeArtifactButtons);artifactObserver.observe(el('artifacts'),{childList:true,subtree:true});
  el('returnToWorkflow').onclick=()=>{el('returnToWorkflow').disabled=true;vscode.postMessage({type:'returnToWorkflow'})};
  el('returnToPrerequisite').onclick=()=>{el('returnToPrerequisite').disabled=true;vscode.postMessage({type:'returnToWorkflow'})};
  const reopenPhaseButton=document.createElement('button');reopenPhaseButton.id='reopenPhase';reopenPhaseButton.className='secondary';reopenPhaseButton.textContent='Reopen completed phase with findings';reopenPhaseButton.hidden=true;el('startNextPhase').insertAdjacentElement('afterend',reopenPhaseButton);reopenPhaseButton.onclick=()=>{const findings=el('humanInput').value.trim();if(!findings){el('status').textContent='Paste the outside review findings before reopening this phase.';return}el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'reopenCompletedPhase',humanInput:findings})};
  const acceptanceButtonLabel='Record acceptance results and complete phase';let acceptanceConfirmationArmed=false;const resetAcceptanceConfirmation=()=>{acceptanceConfirmationArmed=false;el('completeAcceptance').textContent=acceptanceButtonLabel;el('completeAcceptance').disabled=isRunning};el('humanInput').addEventListener('input',resetAcceptanceConfirmation);el('completeAcceptance').onclick=()=>{if(!acceptanceConfirmationArmed){acceptanceConfirmationArmed=true;el('completeAcceptance').textContent='Confirm: record results and complete phase';return}el('completeAcceptance').disabled=true;el('completeAcceptance').textContent='Recording acceptance results…';vscode.postMessage({type:'completeAcceptance',humanInput:el('humanInput').value})};
  for(const id of ['status','interactionPrompt','interactionDetailsText'])el(id).addEventListener('mousedown',()=>{const active=document.activeElement;if(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement)active.blur()});
  const updateModelList=name=>el(name+'Model').setAttribute('list',el(name+'Provider').value==='codex'?'codexModels':'claudeModels');for(const name of roles)el(name+'Provider').addEventListener('change',()=>updateModelList(name));
  el('start').onclick=()=>run('');el('pause').onclick=()=>vscode.postMessage({type:'pause'});el('resumeCurrent').onclick=()=>{setRunning(true);vscode.postMessage({type:'resumeCurrent',presetName:el('currentRunPreset').value,humanInput:el('resumeGuidance').value})};el('resumeSaved').onclick=()=>vscode.postMessage({type:'selectRun'});el('reopenApprovedRequirements').onclick=()=>{const correction=el('resumeGuidance').value.trim();if(!correction){el('status').textContent='Paste the cumulative requirements correction before reopening the baseline.';return}setRunning(true);vscode.postMessage({type:'reopenApprovedRequirements',humanInput:correction})};el('stop').onclick=()=>vscode.postMessage({type:'stop'});el('save').onclick=()=>vscode.postMessage({type:'save',preset:collect()});el('renamePreset').onclick=()=>vscode.postMessage({type:'renamePreset',previousName:loadedPresetName,preset:collect()});el('loadPreset').onclick=()=>vscode.postMessage({type:'selectPreset',name:el('presetList').value});el('deletePreset').onclick=()=>vscode.postMessage({type:'deletePreset',name:el('presetList').value});el('refreshModels').onclick=()=>vscode.postMessage({type:'refreshModels'});el('choosePlan').onclick=()=>vscode.postMessage({type:'selectPlan'});el('continue').onclick=()=>run(el('humanInput').value,'continue');el('continueCode').onclick=()=>run(el('humanInput').value,'continueCode');el('completeAcceptance').onclick=()=>{if(confirm('Record these results as the final acceptance outcome and complete this phase?'))vscode.postMessage({type:'completeAcceptance',humanInput:el('humanInput').value})};el('acceptRoadmap').onclick=()=>vscode.postMessage({type:'acceptRoadmap',humanInput:el('roadmapNotes').value});el('startPrerequisiteWorkflow').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'startPrerequisiteWorkflow'})};el('recheckPrerequisite').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'recheckPrerequisite'})};el('implementPlan').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'implementPlan',humanInput:el('humanInput').value})};el('startNextPhase').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'startNextPhase',humanInput:el('humanInput').value,presetName:el('phasePreset').value})};el('continuePlanning').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'continuePlanning',humanInput:el('humanInput').value})};el('continueImplementation').onclick=()=>run(el('humanInput').value,'continueImplementation');el('runFinalVerification').onclick=()=>run(el('humanInput').value,'runFinalVerification');el('retry').onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'resumeCurrent',presetName:el('currentRunPreset').value})};el('setupMobile').onclick=()=>vscode.postMessage({type:'setupMobile'});el('testMobile').onclick=()=>vscode.postMessage({type:'testMobile'});el('mobileSignIn').onclick=()=>vscode.postMessage({type:'mobileSignIn'});el('startMobileTunnel').onclick=()=>vscode.postMessage({type:'startMobileTunnel'});el('stopMobileTunnel').onclick=()=>vscode.postMessage({type:'stopMobileTunnel'});el('openMobileDashboard').onclick=()=>vscode.postMessage({type:'openMobileDashboard'});el('regeneratePairing').onclick=()=>vscode.postMessage({type:'regeneratePairing'});el('disableMobile').onclick=()=>vscode.postMessage({type:'disableMobile'});
  el('refreshOllamaModels').onclick=()=>vscode.postMessage({type:'refreshOllamaModels'});el('chooseRequirementsSource').onclick=()=>vscode.postMessage({type:'selectRequirementsSource'});el('approveRequirements').onclick=()=>vscode.postMessage({type:'approveRequirements'});el('regenerateRequirements').onclick=()=>vscode.postMessage({type:'regenerateRequirements',humanInput:el('humanInput').value});el('attachRequirementsGuard').onclick=()=>vscode.postMessage({type:'attachRequirementsGuard',preset:collect(),requirementsSourcePath:selectedRequirementsSourcePath,humanInput:el('humanInput').value});
  el('completeAcceptance').onclick=()=>{if(!acceptanceConfirmationArmed){acceptanceConfirmationArmed=true;el('completeAcceptance').textContent='Confirm: record results and complete phase';return}el('completeAcceptance').disabled=true;el('completeAcceptance').textContent='Recording acceptance results…';vscode.postMessage({type:'completeAcceptance',humanInput:el('humanInput').value})};
  const instructionNewline=String.fromCharCode(10);const fillCurrentRunPreset=()=>{const keep=document.createElement('option');keep.value='';keep.textContent='Keep the preset saved with this run';el('currentRunPreset').replaceChildren(keep,...availablePresets.map(p=>{const o=document.createElement('option');o.value=p.name;o.textContent=p.name;return o}))};const fillPhasePreset=()=>{el('phasePreset').replaceChildren(...availablePresets.map(p=>{const o=document.createElement('option');o.value=p.name;o.textContent=p.name;return o}));if(loadedPresetName&&availablePresets.some(p=>p.name===loadedPresetName))el('phasePreset').value=loadedPresetName};const formatInstructions=value=>String(value||'').split(instructionNewline).map((line,index)=>index&&/^[0-9]+[.] /.test(line)?instructionNewline+line:line).join(instructionNewline);const addArtifact=artifact=>{const b=document.createElement('button');b.className='secondary';b.textContent=artifact.name;b.onclick=()=>vscode.postMessage({type:'open',path:artifact.path});el('artifacts').appendChild(b)};const showInteraction=interaction=>{el('interaction').hidden=!interaction;el('splitPhases').hidden=true;el('splitPhases').replaceChildren();el('roadmapAcceptance').hidden=true;if(!interaction)return;el('copyInteraction').onclick=()=>vscode.postMessage({type:'copyText',text:[el("status").textContent,interaction.text,interaction.details].filter((value,index,items)=>Boolean(value)&&items.indexOf(value)===index).join(instructionNewline+instructionNewline)});el('interactionPrompt').textContent=interaction.text;el('interactionDetails').hidden=!interaction.details;el('interactionDetails').open=interaction.type==='prerequisitePending';el('interactionDetailsText').textContent=formatInstructions(interaction.details);const needsInput=interaction.type==='needsInput';const codeNeedsInput=interaction.type==='codeNeedsInput';const acceptancePending=interaction.type==='acceptancePending';const prerequisitePending=interaction.type==='prerequisitePending';const failed=interaction.type==='failed';const morePlanning=interaction.type==='morePlanning';const moreCode=interaction.type==='moreCode';const verificationRequired=interaction.type==='verificationRequired';const nextPhase=interaction.type==='nextPhase';const readyToCode=interaction.type==='readyToCode';const phasePresetVisible=nextPhase||interaction.type==='split';el('phasePresetLabel').hidden=!phasePresetVisible;el('phasePreset').hidden=!phasePresetVisible;if(phasePresetVisible)fillPhasePreset();el('approvalGuidanceHelp').hidden=!readyToCode;el('humanInput').hidden=!(needsInput||codeNeedsInput||acceptancePending||morePlanning||moreCode||verificationRequired||nextPhase||readyToCode);el('humanInput').placeholder=verificationRequired?'Optional guidance or verification results':'Answer the question or give guidance';if(morePlanning)el('humanInput').placeholder='Paste an outside review or add guidance for the next planning round (optional)';if(moreCode)el('humanInput').placeholder='Give optional guidance before continuing implementation';if(nextPhase)el('humanInput').placeholder='Add notes for this phase planning run (optional)';if(readyToCode)el('humanInput').placeholder='Optional approval guidance for the implementer';el('humanInput').value=interaction.responseTemplate||'';el('humanInput').scrollTop=0;el('continue').hidden=!needsInput;el('continueCode').hidden=!codeNeedsInput;el('completeAcceptance').hidden=!acceptancePending;el('startPrerequisiteWorkflow').hidden=!prerequisitePending;el('recheckPrerequisite').hidden=!prerequisitePending;el('implementPlan').hidden=interaction.type!=='readyToCode';el('startNextPhase').hidden=!nextPhase;if(nextPhase)el('startNextPhase').textContent='Plan next phase: '+interaction.phase.title;el('continuePlanning').hidden=!morePlanning;el('continueImplementation').hidden=!moreCode;el('runFinalVerification').hidden=!verificationRequired;el('retry').hidden=!failed;if(interaction.type==='split'){el('splitPhases').hidden=false;if(interaction.roadmapReady){el('roadmapAcceptance').hidden=false;el('roadmapAcceptanceTitle').textContent=interaction.roadmapAccepted?'Roadmap provisionally accepted':'Provisional roadmap acceptance';el('acceptRoadmap').textContent=interaction.roadmapAccepted?'Update provisional acceptance notes':'Provisionally accept roadmap';el('roadmapNotes').value=interaction.roadmapNotes||''}for(const [index,phase] of interaction.phases.entries()){const card=document.createElement('div');card.className='phase';const title=document.createElement('strong');title.textContent='Planning phase: '+phase.title;const objective=document.createElement('span');objective.textContent=phase.objective;const notes=document.createElement('textarea');notes.placeholder='Add notes for this phase planning run (optional)';card.append(title,objective);if(phase.dependsOn.length){const dependencies=document.createElement('span');dependencies.className='muted';dependencies.textContent='Depends on: '+phase.dependsOn.join(', ');card.appendChild(dependencies)}card.appendChild(notes);const button=document.createElement('button');button.textContent='Plan this phase';button.onclick=()=>{el('interaction').hidden=true;setRunning(true);vscode.postMessage({type:'startSplitPhase',index,humanInput:notes.value,presetName:el('phasePreset').value})};card.appendChild(button);el('splitPhases').appendChild(card)}updateControls()}};
  const showMobile=info=>{el('mobileStatus').textContent=info.enabled?info.notificationStatus+' '+info.tunnelStatus:'Phone access is disabled.';el('mobileTopic').textContent=info.enabled&&info.ntfyTopic?'In the ntfy phone app, subscribe to: '+info.ntfyTopic+' on '+info.ntfyServer:'';el('mobilePairing').textContent=info.enabled&&info.pairingCode?'Phone pairing code: '+info.pairingCode+(info.remoteUrl?'\\nDashboard: '+info.remoteUrl:''):'';el('setupMobile').hidden=info.enabled;el('testMobile').hidden=!info.enabled;el('mobileSignIn').hidden=!info.enabled||Boolean(info.remoteUrl)||info.tunnelOwnedElsewhere;el('startMobileTunnel').hidden=!info.enabled||info.tunnelActive||info.tunnelOwnedElsewhere;el('stopMobileTunnel').hidden=!info.enabled||!info.tunnelActive||info.tunnelOwnedElsewhere;el('openMobileDashboard').hidden=!info.remoteUrl;el('regeneratePairing').hidden=!info.enabled||info.tunnelOwnedElsewhere;el('disableMobile').hidden=!info.enabled};window.addEventListener('message',event=>{const m=event.data;if(m.type==='presets'){availablePresets=m.presets||[];fillCurrentRunPreset();el('presetList').replaceChildren(...m.presets.map(p=>{const o=document.createElement('option');o.value=p.name;o.textContent=p.name;return o}));if(m.selected){el('presetList').value=m.selected.name;apply(m.selected);for(const name of roles)updateModelList(name)}}if(m.type==='models'){el('codexModels').replaceChildren(...m.models.map(model=>{const o=document.createElement('option');o.value=model.id;o.label=model.displayName+(model.isDefault?' — recommended':'')+(model.supportedReasoningEfforts.length?' — '+model.supportedReasoningEfforts.join(', '):'');return o}))}if(m.type==='modelStatus')el('modelStatus').textContent=m.text;if(m.type==='planSelected'){selectedPlanPath=m.path;el('selectedPlan').textContent='Selected: '+m.name;setRunning(false)}if(m.type==='restore'){canReopenApprovedRequirements=Boolean(m.canReopenApprovedRequirements);setPaused(Boolean(m.paused));setRunning(Boolean(m.running));el('status').textContent=m.status||'';if(m.task)el('task').value=m.task;el('artifacts').replaceChildren();for(const artifact of m.artifacts||[])addArtifact(artifact);showInteraction(m.interaction)}if(m.type==='running')setRunning(m.running);if(m.type==='paused')setPaused(m.paused);if(m.type==='status')el('status').textContent=m.text;if(m.type==='needsInput')showInteraction({type:'needsInput',text:m.prompt});if(m.type==='failed')showInteraction({type:'failed',text:m.text});if(m.type==='artifact')addArtifact(m);if(m.type==='mobileInfo'){showMobile(m.info);el('mobileError').textContent=''}if(m.type==='mobileError')el('mobileError').textContent=m.text});setPaused(false);setRunning(false);vscode.postMessage({type:'load'});vscode.postMessage({type:'refreshModels'});
  window.addEventListener('message',event=>{const m=event.data;if(m.type==='restore'){const prerequisiteComplete=m.interaction?.type==='prerequisiteComplete';el('returnToWorkflow').hidden=!m.canReturnToWorkflow;el('returnToWorkflow').disabled=Boolean(m.running);el('returnToPrerequisite').hidden=!prerequisiteComplete;el('returnToPrerequisite').disabled=Boolean(m.running);if(m.interaction?.type==='morePlanning')el('continuePlanning').textContent=m.interaction.finalCorrection?'Apply one final bounded correction':'Continue planning for 3 more rounds'}if(m.type==='running'){el('returnToWorkflow').disabled=Boolean(m.running);el('returnToPrerequisite').disabled=Boolean(m.running)}});
  window.addEventListener('message',event=>{const m=event.data;if(m.type==='ollamaModels'){el('ollamaModels').replaceChildren(...m.models.map(name=>{const o=document.createElement('option');o.value=name;return o}));if(!el('ollamaModel').value&&m.models.length)el('ollamaModel').value=m.models[0]}if(m.type==='requirementsSourceSelected'){selectedRequirementsSourcePath=m.path;el('selectedRequirementsSource').textContent='Selected: '+m.name}if(m.type==='restore'){const i=m.interaction;const approval=i?.type==='requirementsApproval';el('approveRequirements').hidden=!approval;el('regenerateRequirements').hidden=!approval;el('attachRequirementsGuard').hidden=!(i?.type==='morePlanning'&&!i.requirementsGuardAttached);if(approval){el('humanInput').hidden=false;el('humanInput').placeholder='Add a correction. Earlier corrections remain locked.';el('humanInput').value=''}}});
  window.addEventListener('message',event=>{const m=event.data;if(m.type==='restore'){const canReopen=Boolean(m.interaction?.canReopen);reopenPhaseButton.hidden=!canReopen;reopenPhaseButton.disabled=Boolean(m.running);if(canReopen){el('humanInput').hidden=false;el('humanInput').placeholder='Paste the outside review findings that require this completed phase to be reopened'}}if(m.type==='running')reopenPhaseButton.disabled=Boolean(m.running)});
  window.addEventListener('message',event=>{const m=event.data;if(m.type==='restore'){const approval=m.interaction?.type==='requirementsApproval';declineRequirementsButton.hidden=!approval;declineRequirementsButton.disabled=Boolean(m.running)}if(m.type==='running')declineRequirementsButton.disabled=Boolean(m.running)});
  window.addEventListener('message',event=>{const m=event.data;if(m.type==='restore'&&m.interaction?.type==='morePlanning'&&m.interaction.requirementsGuardLimit){el('humanInput').placeholder='Paste the targeted revision prompt or human direction required for the next focused pass';el('continuePlanning').textContent='Apply guidance and start focused revision'}});
  </script></body></html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new WorkflowView(context);
  context.subscriptions.push({ dispose: () => provider.dispose() });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('planReview.sidebar', provider));
  context.subscriptions.push(vscode.commands.registerCommand('planReview.open', () => vscode.commands.executeCommand('workbench.view.extension.planReview')));
}
