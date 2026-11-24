# CodeFlow Conductor

Implementation approval is tracked independently of deployment and other owner decisions. Existing pending lists cannot suppress an explicit implementation gate; fresh planning, plan publication, resume, and code entry check the current task and plan. Recorded implementation consent prevents the same gate from being added again.

Implementation consent consumes only the standalone implementation approval. Deployment, provider access, and combined approvals remain pending for their own decision. Reply with only `I approve implementation` for implementation consent. Other decisions use the exact item-specific response shown in the prompt; quoted examples or a contradictory multiline reply cannot authorize implementation. Saved approval questions are restored on resume, including recovery from interrupted saves and stale code-round metadata.

Bounded document delivery requires owner-entered destination fields, one per line, such as `Write destination: docs/planning/summary.md`. Prose that describes a source document grants no write authority. Destination lists saved before this explicit format was introduced are re-derived only from the original owner request; generated child text cannot grant access.

When explicit implementation approval remains pending, answer with `I approve implementation` to record that decision. Answers to other questions and model resolution claims cannot supply this consent. Phone actions carry a server-issued checkpoint ID; stale drafts and submissions from another run are rejected even when checklist text is identical.

A local VS Code extension that coordinates AI-assisted requirements, planning, implementation, review, acceptance, and remediation using your own Claude Code and Codex sign-ins. It does not ask for API keys or send requests to a paid API directly.

The technical extension ID, VSIX filename prefix, command IDs, and legacy `Plan Review Workflow` provenance marker remain unchanged so existing installations, published plans, and saved runs continue to work after the CodeFlow Conductor rename.

## Current features

- Sidebar settings for planner, plan reviewer, orchestrator, implementer, and code reviewer provider, model, and effort
- Optional local requirements guard using an installed Ollama model. Ollama extracts a structured baseline, but cannot approve a plan or make a readiness decision.
- Human corrections are stored in a cumulative locked ledger. Regeneration cannot discard an earlier correction, and approved prior requirements omitted by a later candidate are carried forward automatically.
- Only requirements from an approved prior baseline are automatically carried forward. An unapproved or rejected extraction can be replaced without preserving its mistaken constraints, while locked owner and source-traceable corrections remain authoritative.
- Generated-baseline capacity and generation failures preserve the complete candidate, review, corrections, and failure evidence without truncation. With secondary approval enabled, the optional baseline is declined automatically; otherwise **Continue from approved source without generated baseline** resumes the same run from its task, selected specification, owner decisions, and parent context.
- A human approval checkpoint freezes the reconciled requirements baseline before planning continues.
- Existing planning checkpoints offer **Attach local requirements guard to this run**, so an in-progress workflow can adopt the guard without restarting.
- Deterministic pre-review checks verify the approved baseline digest, required IDs, technologies, package manager, and milestones before another Claude or Codex architectural review is used.
- Optional Ollama planning and implementation starters prepare an advisory first draft or file-and-test work packet before Claude begins. They cannot edit files, approve work, or make readiness decisions.
- Claude planner and implementer session IDs are saved per run. Follow-up rounds resume the same Claude Code session and send the new review or fix direction instead of repeating the complete task and plan.
- The sidebar shows the current plan, approved requirements, local starter, and active human-action files by default. Round reviews, decisions, ledgers, JSON, preservation reports, and older plans remain available under **Technical run history**.
- Requirements-guarded architectural review distinguishes traceable BLOCKING findings from OPTIONAL suggestions and stops automatic revision after two architectural reviews.
- Multiple named presets per machine, with load, save, rename, and delete controls kept together
- Split and next-phase screens include a phase preset selector, allowing a child phase to change providers, models, effort, or local Ollama assistance without losing its parent roadmap, evidence, or workflow lineage
- Paused or failed runs can optionally select a different saved preset before **Resume current run** or **Retry failed stage**. The switch preserves accumulated round limits and evidence, clears old Claude session IDs so the new model is honored, and continues from the existing working tree
- Color-accented, collapsible sidebar sections for presets, starting point, Ollama assistance, model settings, workflow progress, and phone controls, with the installed version shown beside the title
- Optional Claude Explore subagent model override, defaulting to Haiku to reduce usage without changing the primary role models
- Completed prerequisite side workflows end on a dedicated **Return and recheck parent** action. It attaches a structured, idempotent completion report and immediately rechecks the saved parent, including migrated links for older runs.
- Prerequisites have an explicit purpose—implementation, planning-document delivery, verification, or external evidence—and their own `p01`, `p02` hierarchy. They appear in the workflow index but never inflate implementation phase counts.
- A completed prerequisite clears only its parent gate. Open owner questions, explicit approval, or other recorded parent work remain pending until a review names the exact item resolved by affirmative owner evidence; partial or still-pending replies cannot clear the queue.
- Rechecking with identical submitted evidence and unchanged repository state does not consume another review round.
- Acceptance templates cannot be submitted while they still contain `PASS/FAIL`, `YES/NO`, or placeholder values; resuming a run also repairs older false completions created from an untouched template
- Claude directory permissions preserve quoted paths containing spaces and grant the narrowest required folder instead of a broader home-directory ancestor
- Prerequisite-completion detection that prevents completed side workflows from being sent through additional planning rounds
- Resume precedence that prevents stale implementation or acceptance checkpoints from reopening after a newer prerequisite-completion decision
- One final bounded child-plan correction pass at the safety ceiling, plus direct return navigation from split children to their nearest parent workflow
- Planning-resume precedence that discards stale active code and acceptance checkpoints after a newer prerequisite recheck returns to planning
- A short workflow name created and preserved by the root orchestrator, used for readable planning folders and filenames without another user field
- Planning loop with a configurable 1–50 round limit and a separate implementation/code-review checkpoint
- A guidance box at extended-planning checkpoints for pasting an outside review or adding your own findings; guidance is saved as a round-specific run artifact and passed to the next planner, reviewer, and orchestrator
- Architecture/roadmap task detection with a distinct `ROADMAP_READY` outcome that approves the planning artifact without authorizing implementation
- Provisional roadmap acceptance that saves a secondary review as `roadmap-provisional-acceptance.md` without turning deferred decisions into final implementation authorization
- Optional notes on every **Plan this phase** and **Plan next phase** action; notes are saved as `phase-start-guidance.md` in the child run and are included in that phase's planning loop
- Focused phase plans inherit the parent roadmap's provisional-review notes while applying only the findings relevant to their own phase
- Structured finding records with source, severity, affected phase, canonical location, closure condition, and open/resolved/deferred status
- Automatic planning checkpoint audits every three rounds when another revision is proposed. The configured orchestrator independently checks whether findings are supported, repeated, resolved, optional, or out of scope before more planning is authorized.
- Phase-aware review rules that keep later-phase mechanics from blocking roadmap approval unless they invalidate an architectural boundary or the current phase
- Start from an existing Markdown plan and go directly to review
- Discover the Codex models and reasoning levels available to the current signed-in account
- Locate Claude Code and Codex across the VS Code process path, stable user bin directories, and installed NVM Node versions
- Markdown plan and review artifacts, JSON decisions, and a run record under `.review-workflow/runs/<id>/`
- Pause, stop, resume-current, and resume-saved-run controls with stage-aware checkpoints
- A `SPLIT` decision screen with ordered phase cards and one-click child workflow creation
- Explicit **Planning phase** labels and **Plan this phase** actions, leaving implementation actions clearly distinguishable later
- Structured planner handoffs from the orchestrator on every `REVISE` decision
- A distinct `NEEDS_MORE_PLANNING` outcome when the round budget ends with bounded corrections remaining
- A **Continue planning for 3 more rounds** action that preserves the current plan, review, and orchestrator handoff
- Parent/child run lineage when a focused split phase is started
- Completed split-phase tracking with a **Plan next phase** action when the next phase's dependencies are satisfied
- Recursive split tracking that carries completed nested splits through every ancestor and offers the next unfinished phase from the correct parent
- Explicit split-workflow completion messages showing `completed/total` phase counts, the applicable parent plan, the next phase, blocked dependencies, and whether the entire root hierarchy is complete
- An approved-plan index generated when a split workflow completes, linking each phase to the exact plan used for its implementation
- Numbered approved plans such as `01-02-implement-quit-gate-approved.md`, plus clearly named `00-workflow-overview.md` and nested phase-overview files for new workflows
- Durable original task storage in each run's `original-task.md`
- Workspace-level memory of the most recent run, including across VS Code restarts
- Working plans stay with their run history under `.review-workflow/runs/<id>/working-plan.md`
- Only plans approved for implementation are published to `docs/planning/`, except an explicitly authorized planning-document-delivery prerequisite. Every destination needs an explicit write, create, update, or replacement instruction; merely mentioning a Markdown file for context is not authorization. The bounded path canonicalizes equivalent spellings before its dirty-file, backup, and Git checks, preserves the Git index and unrelated working changes, and rejects undeclared or symbolic-link targets.
- Human response control when the orchestrator returns `NEEDS_HUMAN`; the answer continues the same round and decision stage
- Complete human handoffs that display why the workflow paused, the required actions, saved checklist/result files, and the expected response format
- Provider failures are shown separately from human questions and include Codex's structured error detail
- Claude failures now include structured stdout errors when stderr is empty, and are saved as `failure.txt`
- **Retry failed stage** resumes the failed planning, review, or decision stage without restarting the workflow
- Claude plan-file capture: when Claude returns a summary pointing to its private plan file, the extension reads and stores the complete Markdown plan
- An immutable baseline plan plus a durable planning ledger for objective, scope, accepted decisions, unresolved findings, and deferred work
- Scope-aware planner, reviewer, and orchestrator prompts that reject unrelated expansion and revision-history accumulation
- Restore the active task, current round and stage, artifacts, and pending interaction when the sidebar is reopened
- Read-only provider runs during planning
- An explicit **Implement approved plan** handoff; reaching `READY_TO_CODE` never edits files automatically
- A bounded implementation, code review, and orchestrator loop with `FIX`, `CODE_READY`, `NEEDS_HUMAN`, `NEEDS_MORE_CODE`, and `STOP` decisions
- Implementation summaries, code reviews, and decisions saved beside the planning artifacts in the same run folder
- Stage-aware pause, stop, failure retry, and resume during implementation and code review
- A clear **Code ready for human review** endpoint before any commit or deployment
- Automatic continuation when a code-review checkpoint finds bounded local edits or verification work, with a hard safety ceiling of 30 rounds
- Optional human guidance before continuing implementation, such as noting that Docker is now available
- Repository verification scripts can run through `bash` or `sh` during implementation. Common bounded setup and inspection commands such as `mkdir`, `cp`, `grep`, `cmp`, `diff`, `find`, `curl`, and `lsof` are also available so required local harnesses do not silently repeat as missing evidence. Read-only system checks such as `sw_vers`, `uname`, and `arch` run without asking for human approval.
- Approved local Supabase phases may run CLI version/help checks, `supabase init`, `start`, `stop`, `status`, and `db reset`, plus local `psql` checks. Implementer instructions prohibit hosted-project flags, remote database URLs, linking, pushing, or deploying. Workflow-owned `.review-workflow/` files are treated as volatile orchestration metadata rather than ordinary product checksum inputs.
- Reopening a completed phase with outside findings now creates a focused remediation planning run. The planner, reviewer, and orchestrator must approve its bounded correction plan before the extension shows **Implement approved plan**; reopening never starts implementation automatically.
- Presets can enable a selectable **secondary approval reviewer**, using any available Codex model such as GPT-6.1 Sol or GPT-6.2 Sol. An approved requirements baseline continues directly into planning, an approved completed plan starts implementation automatically, and approved completed implementation proceeds to `CODE_READY` or required human-only acceptance. Concrete baseline, plan, or code findings return to the appropriate correction loop.
- A separate preset switch lets that secondary reviewer resolve decision-only human pauses when the answer is already established by approved requirements, prior owner guidance, the plan, or repository evidence. It must leave credentials, destructive authorization, unsupported owner preferences, UI/device observations, and human-only acceptance with the human.
- Newly recorded human verification evidence is included explicitly when a saved Claude implementation session resumes, preventing already-passed commands from being retried solely for confirmation
- Provider-blocked commands stop at the first explicit `COMMAND_BLOCKED` report and surface the exact command for human action
- Interactive app launch blocks such as `npm start` and `npm run dev` now open the complete human acceptance procedure and a results template immediately; approving the launcher no longer causes an identical automatic retry. Resuming an affected run created by an earlier version repairs that checkpoint automatically.
- Human acceptance instructions omit automated verification steps that the implementation report already records as passed, and remove internal state commentary when the corresponding user observation is clear.
- Human acceptance submissions require an explicit overall PASS or FAIL. PASS completes the phase; FAIL preserves the results, keeps the parent phase incomplete, rolls back any premature completion marker, and offers a dedicated remediation workflow before acceptance can be rerun.
- Recording final human acceptance requires an explicit confirmation on both desktop and phone dashboards.
- Human acceptance phases stay as one operator checklist and results-recording plan. Planning agents are instructed not to invent harnesses, cryptographic evidence systems, schemas, or semantic gates unless the original task or repository explicitly requires them.
- Nested phase splitting is capped at two levels. Repeated findings, plan length, or evidence formatting cannot create another split; the child must converge into one executable plan or ask for a genuine human decision. Child planning is capped at twelve rounds, with rounds 10–12 reserved for a final convergence pass that applies existing corrections without introducing new requirements or optional hardening.
- Plans blocked by work outside their current split hierarchy enter **Waiting for prerequisite** instead of implementation, failure, or another planning loop. The phase remains saved and incomplete, states the exact resume condition, and offers **Start prerequisite workflow** plus **Recheck prerequisite**. Existing acceptance runs with an explicit unmet gate are repaired when resumed.
- **Recheck prerequisite** runs a fresh repository review before the orchestrator decides, so completed commits and a changed tree replace the evidence from the original blocked review. It does not require a clean tree unless the parent’s own acceptance contract does.
- Sibling evidence inheritance accepts only completed child runs, so an abandoned or failed attempt for the same parent phase cannot be mistaken for the replacement run that eventually completed it.
- Provider prompts and returned plans replace literal null bytes with visible `\\0` text so malformed generated examples cannot crash the Claude or Codex command process.
- At the 30-round safety ceiling, **Run remaining verification and final review** retries the saved final round once, preserves its previous artifacts, and performs a concluding review
- When a blocked verification command targets a folder under the user's home directory but outside the repository, choosing the final-verification action records that folder in the run and passes it to Claude Code with `--add-dir`
- Free phone notifications through a private, randomly generated ntfy topic
- An authenticated phone dashboard for answering workflow questions and using pause, resume, phase, planning, and implementation controls. Human prerequisite checkpoints show their results field and refuse an untouched checklist template.
- A six-digit pairing step in addition to Microsoft dev tunnel authentication; the phone dashboard never accepts arbitrary commands
- Microsoft tunnel failures show the provider's actual error. Temporary rate limits wait for the cooldown and retry automatically instead of leaving an unexplained exit-code message.
- Only one VS Code window can own the phone dashboard tunnel at a time. The sidebar includes a dedicated stop action, gives each tunnel a one-hour maximum lifetime, and explicitly removes the tunnel when its host exits.
- Refreshing the Microsoft dev tunnel sign-in first clears the cached credential, then starts a fresh GitHub sign-in. This also recovers from an expired login token.
- Workflow messages and expanded instructions have an explicit **Copy workflow message** action. Selecting visible message text also clears stale selection in the task field so ordinary copy works again.

## First-time setup on another machine

The VSIX contains the workflow extension only. Each person uses their own Claude, ChatGPT/Codex, and optional Ollama installation. No account token, API key, model download, or saved preset is transferred with the VSIX.

The commands below are for macOS. Install and verify the provider CLIs before installing the VSIX so VS Code can discover them after it reloads.

### 1. Install and sign into Claude Code

Install Claude Code using Anthropic's recommended native installer:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new terminal and verify the installation:

```sh
claude --version
claude doctor
```

Then run `claude` and follow the browser prompts to sign into that person's Claude account. Claude Code requires an eligible Claude or Console account; the free Claude plan does not include Claude Code. See [Anthropic's Claude Code setup guide](https://code.claude.com/docs/en/getting-started).

### 2. Install and sign into Codex CLI

Install the Codex coding agent using OpenAI's standalone installer:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Open a new terminal and verify that the command is available:

```sh
codex --version
```

From a project directory, run `codex`. The first launch asks how to authenticate; choose **Sign in with ChatGPT** to use that person's ChatGPT plan. This extension needs the `codex` coding-agent command, not the separate `openai` API command. See the [official Codex CLI quickstart](https://developers.openai.com/codex/cli/).

### 3. Install Ollama and a local model (optional)

Ollama is required only for the local requirements guard and the planning or implementation starters. Download the macOS application from [Ollama](https://ollama.com/download), move it to Applications, and open it. The app offers to make the `ollama` command available in the shell.

Download a model and confirm that Ollama can see it. For the local model used while developing this extension:

```sh
ollama pull qwen3.5:35b
ollama ls
```

Keep the Ollama app open while using local assistance. If the app is not used, `ollama serve` starts the local service manually. Large models can require tens of gigabytes of storage and substantial unified memory; choose a smaller installed model on a less capable machine. See Ollama's [macOS installation](https://docs.ollama.com/macos) and [CLI reference](https://docs.ollama.com/cli).

### 4. Install the workflow VSIX

1. In VS Code, open **Extensions**.
2. Choose **… → Install from VSIX…**.
3. Select the shared `plan-review-workflow-<version>.vsix` file.
4. Run **Developer: Reload Window**.
5. Open a trusted Git project folder and open the **CodeFlow** sidebar.

In a new VS Code terminal, confirm that all installed commands are visible from the same environment VS Code is using:

```sh
claude --version
codex --version
ollama ls
```

Skip `ollama ls` when local assistance will not be used.

### 5. Create the first preset

1. Open **Workflow models and limits** and click **Refresh available Codex models**.
2. Choose each provider and effort level. Leaving a model field blank uses that CLI's account-compatible default and is the safest initial choice.
3. If using Ollama, open **Local Ollama assistance**, click **Refresh local Ollama models**, and select an installed model.
4. Turn on the local planning and implementation starters if local preparation is wanted. Enable the requirements baseline only when there is an approved specification or roadmap to preserve.
5. Enter a name under **Presets** and click **Save preset**.

Presets are stored only in that machine's VS Code extension storage. They do not contain provider credentials and are not included when the VSIX is shared.

### 6. Run a small smoke test

Start with a small, bounded planning task in a trusted disposable or test repository. Confirm that the workflow reaches Claude planning, Codex review, and Codex orchestration before trying a large split roadmap. Reaching **Plan ready** is enough for the setup test; implementation is optional.

### Troubleshooting first-time setup

- **Provider command not found:** Run the corresponding `--version` command in a new VS Code terminal, then run **Developer: Reload Window**. Installing only the Claude or Codex VS Code chat extension is insufficient; the standalone CLI command must exist.
- **Codex model is not supported for this account:** Clear that model field to use the CLI default, or click **Refresh available Codex models** and choose from the returned account catalog.
- **Ollama could not be reached:** Open the Ollama app, confirm `ollama ls` works, and click **Refresh local Ollama models** again. The extension connects only to the local Ollama service on `127.0.0.1`.
- **Claude or Codex asks for an API key:** Exit and use the provider's subscription sign-in flow instead. The extension removes common provider API-key environment variables before launching its agents so an old key does not accidentally take precedence.
- **Usage limit reached:** The run remains saved. Wait for that provider's account limit to reset, then choose **Resume current run**.

Claude and Codex activity counts against the signed-in person's provider subscription and usage limits. Ollama inference runs on that person's computer and has no per-token provider charge.

## Local requirements guard

1. Install and open Ollama, with the intended extraction model already downloaded.
2. In the sidebar, choose **Ollama — extract locally, then require human approval** and click **Refresh local Ollama models**.
3. Choose the approved specification when it is a separate file. Root workflows otherwise use the task; child phases also use their approved parent planning artifact and recorded human decisions.
4. Start planning. The extension saves `requirements-baseline.json` and a readable `requirements-baseline.md`, then pauses for human approval.
5. Open the readable baseline. Approve it when correct, or enter a correction and choose **Add correction and reconcile baseline**. Corrections accumulate in `requirements-corrections.md`; later generations cannot replace them. Previous requirements that disappear from a new local-model candidate are restored deterministically.
6. If local extraction is not reliable enough for the current scope, choose **Decline baseline and continue with approved source**. The rejected candidate remains diagnostic run history, while planning continues from the approved task, selected specification, parent roadmap, planning ledger, and human guidance.

For an existing run paused at **More planning required**, select the local model and choose **Attach local requirements guard to this run**. The current plan is checked before another planning or paid-review pass. Requirements-guarded runs permit no more than two Claude/Codex architectural reviews; optional suggestions do not trigger revision.

The Ollama calls stay on `127.0.0.1` and use the locally installed model. A large model may take a minute or two to load the first time. Continue is not required. Generated baselines are rejected and repaired once when they contain substantial exact duplication, and the repository's declared package manager (or lockfile family) overrides an incorrect model guess.

Requirements extraction accepts plain JSON, fenced JSON, or a JSON object wrapped in brief local-model commentary. If the first response remains malformed, the extension performs one constrained local repair attempt without consuming Claude or Codex usage.

### Local-first planning and implementation preparation

- **Local planning starter** asks Ollama for an advisory first draft or bounded revision packet. Claude verifies it and returns the canonical plan.
- **Local implementation starter** asks Ollama for an advisory file, edit, risk, and test work packet. It does not change the working tree; Claude remains the implementer.
- If an optional starter fails or Ollama is temporarily unavailable, the extension saves a warning and continues with Claude normally.
- Claude planner and implementer context reuse is configurable per preset. **Balanced** (the default) starts a fresh Claude session every three rounds while preserving continuity inside each block; **Always resume** keeps the prior behavior; **Start fresh every round** gives every pass an empty Claude conversation. Reviewer and orchestrator calls are already fresh. Durable plans, ledgers, reviews, findings, implementation evidence, and repository state are supplied when a fresh session begins.

## Phone setup

1. Install the free **ntfy** app on your phone.
2. Install Microsoft dev tunnels on the Mac with `brew install --cask devtunnel`, then reload VS Code.
3. In the CodeFlow sidebar, click **Enable phone access**. The extension generates a private ntfy topic; subscribe to the displayed topic in the ntfy app using `https://ntfy.sh`.
4. Click **Send test phone alert**.
5. Click **Refresh Microsoft dev tunnel sign-in** and complete the GitHub sign-in in the terminal/browser that opens. Use the same action if Microsoft reports that the cached login token expired.
6. Click **Start phone dashboard**, open the displayed dashboard, and enter the six-digit pairing code shown in VS Code.

The hosted ntfy service and Microsoft dev tunnels can be used without adding a paid model API. Their providers may apply their own free-service limits. The ntfy topic acts like a secret, so do not share it. The dashboard requires both the Microsoft tunnel sign-in and the pairing code. The temporary dashboard address can change after VS Code restarts; alerts always use the currently active address. Use **Stop phone dashboard** when remote access is no longer needed. Starting it in another VS Code window is blocked until the current owner stops or closes.

Portable preset export, provider setup checks, a polished run history, and import/provider generation of a human-reviewable requirements baseline are planned next.

## Build and package

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm run build
npm run package
```

The resulting `.vsix` can be copied to another machine. The VSIX packages the extension, not the Claude Code or Codex CLIs.

## Important behavior

- CLI processes inherit local sign-in state and run in the open workspace. The extension removes common API key environment variables before launching them, so an existing API key does not accidentally take precedence over subscription login.
- An NVM default-version change can remove a globally installed Claude command from the new shell path. The extension searches other installed NVM versions and reports the exact missing provider when discovery fails.
- Planning roles are launched with read-only modes. Existing provider configuration, hooks, and local policy can still affect behavior; review those before using the extension on a sensitive repository.
- The implementer receives workspace write access. The code reviewer and orchestrator remain read only. Prompts prohibit committing, pushing, deploying, resetting, or discarding unrelated work.
- The Git staging area is treated as human-owned state. Agents review staged and unstaged changes in place and never run or request `git add`, `git restore --staged`, `git reset`, or `git rm --cached`. Intentional staging does not block readiness.
- Claude implementers are allowed to run common Node package-manager, Docker, and read-only Git status/diff commands in noninteractive mode so installs and checks do not fail at an invisible permission prompt.
- Provider model names and supported effort levels vary by installed CLI version and account. The extension reports CLI errors rather than pretending every choice is available.
- Workflows stop at the round limit even if the orchestrator asks to revise again.
- When a plan passes review, the extension normally waits for **Implement approved plan**. A preset with secondary approval enabled may start implementation automatically after that reviewer approves; reopened remediation runs always retain an explicit human implementation gate.
- Stopping or pausing terminates and awaits the provider's owned process tree before another run can start. POSIX systems use an isolated process group; Windows validates and separately awaits graceful `taskkill /T` and forced `/T /F` attempts, and never reports cleanup complete when every attempt failed.
- A saved primary `CODE_READY` decision cannot bypass an interrupted secondary implementation review. That approval is a durable checkpoint and is resumed before readiness is declared.
- Each code round saves `code-round-N-implementation.md`, `code-round-N-review.md`, and `code-round-N-decision.json`. A `FIX` decision sends the review and the orchestrator's bounded instructions back to the implementer.
- At a configured code-review checkpoint, bounded findings produce `NEEDS_MORE_CODE` and the workflow automatically adds another three-round block. At the hard 30-round safety ceiling, it pauses with the saved evidence instead of looping indefinitely.
- `CODE_READY` means the automated review loop is complete. You still inspect and approve the working tree before committing or deploying.
- Completion is tracked in three explicit states: automated work complete, human acceptance pending, and entire workflow complete. A split phase with required operator or visual checks is not counted as complete until you record those results. Only then does the extension unlock the next phase or declare the split hierarchy complete.
- A completed phase can be reopened from an outside review before the next phase begins. **Reopen completed phase with findings** preserves the prior completion artifacts, creates a linked bounded remediation run against the same approved plan, removes the phase from its parent’s completed set, and restores completion only after remediation passes review and any required acceptance.
- Commits, pushes, pull requests, deployments, remote CI runs, and hosted artifacts are human follow-up work. The reviewer and orchestrator must not use their absence to block `CODE_READY`.
- Local edits, tests, Docker checks, and repository inspection continue automatically. Human input is reserved for product decisions, unavailable credentials, destructive actions, or unavailable external services, and the prompt must contain one explicit question.
- When a human must perform an interactive or permission-gated check, the orchestrator must provide the complete operator procedure: prerequisites, exact commands, ordered UI actions, expected observations, stop conditions, cleanup, and a ready-to-edit response template. The extension saves this as `code-round-N-human-action.md`, shows it in the sidebar and phone dashboard, and lists the source instruction files used for the handoff.
- A blocked command is classified before it is shown. Interactive launches, commands with setup variables, and commands inside a longer manual plan section surface that complete section instead of the isolated command. Ordinary one-command permission blocks retain the one-click final-verification flow.
- `COMMAND_BLOCKED` is accepted only when a command did not execute. If the implementation report shows that the same command ran and returned PASS, FAIL, or an exit code, the extension treats it as check evidence and sends the real failure to review instead of asking the human to approve an already-executed command.
- New split phases inherit completion summaries and recorded human evidence from completed sibling phases. Evidence is reused only when every named check has its own PASS inside a sibling evidence record tied to the same clean Git revision currently under review; outcomes and revisions from different sibling records cannot be combined.
- Acceptance submissions reject contradictory evidence, including an overall PASS accompanied by any failed check.
- Resuming an older run repairs historical state: legacy remediation runs regain their human implementation gate, and completed acceptance containing a failed check is reopened and removed from parent completion.
- When automated code work is ready but acceptance remains, the extension saves `human-acceptance-required.md`, pre-fills the result template, and shows **Record acceptance results and complete phase**. An inline second click confirms completion without relying on a hidden browser dialog. Submitted evidence is preserved in `human-acceptance-results.md` before parent progress advances.
- Human handoffs show the short reason and required outcome first. Long terminal and UI procedures are collapsed under **Show step-by-step instructions** in both the VS Code sidebar and phone dashboard.
- Expanded procedures add visual spacing between numbered sections, while the prefilled results box opens at its first field and stays separate from the instructions.
- Pausing or stopping saves the run and interrupted stage. Resuming repeats only that interrupted provider stage because a partial model response cannot be continued mid-response.
- **Resume current run** remembers the latest run for this VS Code workspace across restarts. **Resume saved run…** opens any prior run's `run.json`, including runs stopped by an earlier extension version.
- The original prompt is stored in both `run.json` and `original-task.md`. Resuming uses that saved prompt automatically; it does not ask you to type it again.
- After `REVISE`, the planner receives the previous plan, complete reviewer findings, human guidance, and a self-contained revision prompt written by the orchestrator. Older decisions fall back to their saved detail text.
- On the last allowed round, the orchestrator uses `NEEDS_MORE_PLANNING` when the plan has actionable corrections and is not ready to code. `STOP` is reserved for cases where planning cannot productively continue. Existing `STOP` runs can still be continued from the sidebar for backward compatibility.
- Each round saves `round-N-ledger.json`. Accepted scope and locked decisions accumulate rather than silently disappearing; unresolved findings are replaced with the current blocker list. After six rounds, the orchestrator is instructed to split or ask for human guidance when the work is not converging.
- For architecture-and-roadmap requests, convergence means coherent boundaries, dependencies, phase ownership, decision deadlines, and phase-level acceptance outcomes. `ROADMAP_READY` publishes the approved roadmap with an explicit “implementation not authorized” status and offers focused phase-planning actions.
- A roadmap may be provisionally accepted after secondary review. That records the working direction and review notes while preserving later owner decisions and requiring a separate implementation-ready plan for every phase.
- Later-round revisions target named finding IDs at their canonical sections, remove contradictory copies, keep review history in run artifacts, and distinguish new correctness defects from preferences or optional improvements.
- `baseline-plan.md` preserves the first complete plan. Claude summary responses never replace the working plan: the referenced full file is captured, and resume migrates affected saved runs when the file is still available.
- `SPLIT` ends the parent planning loop. Choose a phase in the sidebar to create a focused child workflow with a maximum of three planning rounds. The child record points back to its parent run. When a phase reaches `CODE_READY`, the parent is updated and the next dependency-ready phase is offered in the sidebar. Older child runs infer their phase from the saved task when resumed.
- When a phase is split again, completing its nested replacement phases now carries completion upward one parent at a time. The extension stops at the first ancestor with unfinished work and offers that ancestor's next dependency-ready phase. It declares the entire workflow complete only after reaching a root run with every descendant phase complete. Resuming a completed run from an older extension version repairs this progress chain.
- For new workflows, the root orchestrator creates a concise two-to-six-word workflow name and keeps it stable across later rounds and child phases. Plans are published under `docs/planning/<workflow-name>/`. Approved filenames begin with their complete numbered phase path; workflow and nested phase indexes use `workflow-overview` and `phase-overview` names. Run IDs remain inside provenance metadata. Existing workflows retain their recorded paths and names.
- The extension keeps drafts, paused work, failed attempts, reviews, and detailed history under `.review-workflow/runs/`. A plan is copied to `docs/planning/` only after the orchestrator approves it for implementation. Phase plans use the phase title in their filenames. A completed split workflow also writes `*-approved-plan-index.md` with the parent run, phase names, child runs, completion states, and links to the exact approved plans used for coding.
- When a plan is approved for implementation, the extension removes superseded extension-generated plans for that run from `docs/planning/`. When code review completes an entire split workflow, it cleans the full workflow family and keeps each phase plan used for implementation plus the final approved-plan index. Older public drafts are first copied back into their saved run folders so those runs remain resumable. Files without CodeFlow Conductor's legacy `Plan Review Workflow` provenance marker are never removed.
- Codex planning and review can run in a VS Code trusted folder that is not yet a Git repository. The extension supplies Codex's repository-check override only for these read-only stages.
- The initial version uses the first workspace folder in a multi-root window.
