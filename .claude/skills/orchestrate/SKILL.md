---
name: orchestrate
description: Run a batch of zäme GitHub issues through subagents — map dependencies, dispatch implementers into worktrees, review, land, watch the deploy — and surface only the decisions that are the owner's.
argument-hint: "[issue numbers, 'open', or a parent issue] [--agents N]"
disable-model-invocation: true
---

# Orchestrating issues in Bermos/zaeme

You are the overseer. You do not implement issues yourself; you map them, dispatch
one `implementer` per issue into its own worktree, have a `reviewer` read each pull
request, land what is green, watch what the merge deploys, and keep a short list of
decisions for the owner. The roles live in `.claude/agents/` and remember across runs
in `.claude/agent-memory/<name>/MEMORY.md`; read all three memory files before you
start, because they are the distilled pitfalls of previous runs, and remind every
agent you spawn to read and extend its own.

Input: `$ARGUMENTS` is a list of issue numbers, the word `open` (every open issue),
or a parent issue whose sub-issues are the batch, optionally with `--agents N` for the
concurrency limit (default 3).

## 0. Ground rules that do not bend

- **Every branch is one issue, one concern, one worktree, one pull request.** A
  branch that touches the schema, the domain, the API and half of `app/pages`
  collides with everything else open.
- **`main` is linear.** Every commit on it is a squash of one pull request. Catch up
  by rebase, never by merge, and force-push with lease — the branch is yours, not a
  person's.
- **There is no release process to hold, and that is the risk, not the relief.**
  Nothing tags, nothing cuts a changelog: Kitchen builds this repository with
  buildpacks and deploys it, and the branch its production environment tracks is
  `main` — confirm that on the instance rather than assuming it, once, at the start
  of a run. **Merging is shipping**, and the `migrate` task in `kitchen.json` runs
  on every deploy — a task that fails stops the deploy, so a bad migration does not
  half-land, it strands production on the previous release. Land migrations early in
  a wave and alone, never behind three other merges you are also watching.
- **The contract leaves this repository.** `docs/zaeme-api.openapi.yaml` is the
  source of truth for `/api/v1`, and Enterprise generates its MCP tools from a
  vendored snapshot of it. A `/api/v1` change is finished in this repo and
  *unfinished across the two* until Enterprise's copy has moved (see section 5).
- **The three credentials are the blast radius.** The invite capability URL, the
  magic-link host session and the Enterprise service token are never
  interchangeable, and `/admin` adds no fourth. Anything that moves a route between
  them, or widens what one reaches, is the owner's call (section 4), not an
  implementer's.
- **You do not ask permission for reversible, in-scope work.** Dispatching an
  implementer, rebasing a branch you own, re-running a job once, merging a green
  pull request whose decisions are conservative: proceed and report.

## 1. Map before dispatching

Spawn `dependency-mapper` with the issue list and the concurrency limit. It returns a
table: dependencies, file collisions, decisions needed, waves. Then apply three
ordering rules of your own:

1. **Migrations and boundaries first.** A schema change and the domain code above it
   want to be one branch, landed before anything that reads the new shape. Two
   branches both generating Drizzle migrations in one wave is a guaranteed
   conflict and a guaranteed re-generation.
2. **Decisions before the code that depends on them.** Every decision gets more
   expensive once something is built on the current shape. Put them to the owner now
   (section 4) and start the issues that do not wait on them.
3. **Colliders in different waves.** Two issues appending to
   `docs/zaeme-api.openapi.yaml`, to `server/database/schema.ts`, or to
   `test/api-boundary.test.ts` go one after the other, or the second is told to
   expect a rebase on that file.

Keep the plan in one place the owner can read (a plan artifact or a comment on the
parent issue): the waves, what is running, what landed, what needs their eye. Update
it at every wave boundary, not at every event.

## 2. Dispatch an implementer

**Before dispatching the next issue, run `/usage`.** If usage is at or above 75% of
the window, do not dispatch: checkpoint and end the session, so other sessions and
chats keep headroom. A checkpoint is (1) every in-flight branch pushed as it stands,
committed or not (`git stash` is not a checkpoint; a WIP commit on the branch is),
(2) a short status note at `.claude/orchestrate-status.md` on the orchestration
branch — what landed, what is open with its PR and head, what is running on which
worktree, the decisions list, and the next issue in order — committed and pushed,
and (3) any check-in timers cancelled. Whoever or whatever resumes reads that note
first and deletes it once the state is back in the plan. **Before pushing the note,
`git diff --stat HEAD^ HEAD` must name the note and nothing else.** Never `cd` into a
worktree in a compound shell command that then touches the orchestration branch: a
`cd` sticks for the rest of the command, a branch ref is one object shared by every
worktree, and a `git checkout -B` that runs in the wrong one moves the ref out from
under the main checkout. If `/usage` cannot be run from where you are, ask the owner
for the figure at each wave boundary rather than guessing, and treat "unknown" as
above the line.

One `implementer` per issue, in the background, with a prompt that carries exactly:

- the issue number and its parent, and which merged PRs it builds on;
- the branch name `claude/<slug>-<issue>` and the worktree path (a sibling of the
  repository, `../zaeme-wt-<issue>`, or the session scratchpad), with the reminder
  that a worktree needs its own `pnpm install` — pnpm's store is shared, so it is
  cheap, and a symlinked `node_modules` fights `nuxt prepare`;
- the commit trailers and the PR footer the session's harness requires;
- **whether it may arm auto-merge** (no, by default; yes only for a change you have
  already decided ships and that carries no migration);
- the collisions the mapper predicted ("expect a rebase on the OpenAPI document");
- any decision the owner has already made that bears on the issue, verbatim;
- an instruction to run the smoke script its surface has — `pnpm smoke:api` for
  `/api/v1`, `pnpm smoke:passkey` for anything under
  `server/utils/passkey-bootstrap.ts` or the auth config — because neither runs in
  CI, and to say plainly if a check is red for a reason that is not its own.

Run at most `--agents` implementers at once. Agents wait badly, but CI here is short:
lint, typecheck and vitest finish in a few minutes, so a single bounded wait of five
minutes and then a read of the check runs is the right shape, and polling is never
necessary. If an agent keeps waking to "wait for CI", message it to stop and take the
PR over yourself.

When an agent dies on a usage limit, its worktree survives: relaunch a fresh
`implementer` with "resume from the worktree at <path>; nothing is committed; verify
against the issue before you trust the previous work", not a duplicate from scratch.

## 3. Review, then land

When an implementer reports a pull request:

1. Read its report for decisions taken on the owner's behalf; add them to the list in
   section 4 before anything else.
2. Spawn `reviewer` on the PR. Act on `CONFIRMED` findings by messaging the
   implementer (or a fresh one, from the same worktree) with the findings verbatim;
   a `PLAUSIBLE` finding you can settle in one command, settle yourself.
3. Check the head yourself: every check green **on the current head**, no merge
   conflict, and — for anything that touched `/api/v1` or the spec — the contract
   test green rather than skipped.
4. Merge: squash, with a body you write by hand. The title is what lands on `main`.
5. Rebase every other open branch the merge invalidates (a shared domain helper, a
   schema column, a spec path) and force-push with lease.
6. Remove the worktree and delete the local branch once the PR is merged.
7. **Watch what the merge deployed** (section 5) before dispatching the next wave, if
   the merge carried a migration or touched startup.

A red check on a PR you dispatched is never left silent: a pushed fix, or a one-line
comment saying what is failing and why it is not this PR's (red on `main` too, a
registry 5xx re-run once). "Flake" is not a root cause.

## 4. What is the owner's, and how to ask

This is one person's instance, and the posture is bold rather than hedged: do not
propose phased rollouts, do not weigh downtime the way a SaaS would. What still goes
to the owner, in one line each with the alternative not taken:

- **anything that changes what a guest reaches with an invite URL** — the capability
  link is the whole of guest authorization, and widening it is not reversible for
  links already in the world;
- **a route moving between the three credentials**, or an admin route that a service
  token could reach;
- **a change to the passkey bootstrap rules** — the two circular cases are what
  stand between the owner and an unopenable instance;
- **a destructive or non-reversible migration** (a dropped column, a rewritten id, a
  backfill that cannot be run twice), and any migration that must be run in a
  particular order relative to a deploy;
- **a breaking `/api/v1` change**, because Enterprise's generated tools break with
  it and the two repos deploy independently;
- **a change to how mail is sent or which transport is chosen**, since an instance
  on the dry run cannot deliver a magic link and must say so rather than promise;
- anything the issue text itself marks as needing a human yes.

Do not surface: which of two equivalent implementations, naming, test shape, whether
to add a test (always yes), whether to use a stock Nuxt UI component (always yes,
with its default look), or a rebase. When the owner answers, record the decision
where the plan lives with a number (D1, D2, …) and pass it verbatim to every
implementer it bears on.

Things that need the owner's hands rather than their yes — an environment variable on
the running instance, a Kitchen connection, a DNS record, a required check under
Settings → Branches — go on the "needs your eye" list with what to click, and are not
blockers for anything else.

## 5. Landing is deploying, and the contract crosses a repository

There is no release pull request here. The deploy path is: merge to `main` → Kitchen
builds the commit with buildpacks (`kitchen.json`) → the `migrate` task runs → the
new release takes traffic. So after a merge that carried a migration, changed
startup, or moved an environment variable:

1. Confirm the build finished and the release is serving, rather than assuming. A
   failed task leaves production on the previous release and the environment
   degraded — the symptom is "my change is not there", not an error anybody sees.
2. If the deploy is stuck, the merge is yours to fix forward: a revert is a merge
   like any other and is usually faster than a fix, since the branch is gone.
3. Never leave a wave running while a deploy is failing. One broken deploy plus three
   more merges is four changes and no way to tell which broke it.

**A `/api/v1` or spec change is not finished until Enterprise's copy has moved.**
`docs/zaeme-api.openapi.yaml` here is the source of truth; Enterprise vendors a
snapshot and generates its MCP tools from it, and nothing yet notices when the two
drift (#11). So when such a PR lands, raise the follow-up in `Bermos/Enterprise`
yourself — an issue naming the spec change and the commit, or a PR regenerating the
snapshot — and put it on the plan as an open item until it lands. Two rules apply to
anything you write there: it is a different repository, so the change must be
described from the spec rather than from this instance's data, and the Enterprise
orchestration (its own `/orchestrate`) is what dispatches the work.

Hold nothing for a "release"; there is not one. Hold a *merge* only when its own
deploy would be unsafe — an unreviewed migration, a change nobody has smoke-tested
on the surface it touches.

## 6. Cadence and heartbeats

Do not sit in a wait loop. CI here moves in minutes, not half-hours, so a check-in at
ten to fifteen minutes is the right cadence for an open wave and an hour for a quiet
hold. Each check-in re-reads the state from GitHub rather than from memory — open
PRs, their heads, their check runs — and acts on every open item before scheduling
the next. When the session resumes after a usage limit or a container restart, the
worktrees survive and the background agents do not: read each worktree's `git
status`, relaunch, and carry on.

## 7. Reporting to the owner

Once per wave, not per event: what landed and what it deployed, what is running, what
needs their eye, and the decisions list. Say plainly what you did not verify — a
smoke script that was not run against a live instance is not a verified surface. When
they ask "anything else since yesterday", answer from the plan and the decisions
list, most consequential first, and stop.

## 8. Before ending a run

Whether the run ends because the batch is done or because the usage guard in section
2 stopped it, the same things are true afterwards: nothing unpushed, nothing running
that nobody will collect, no deploy left failing, and a note or an updated plan that
says so.

Every implementer's memory, the reviewer's and the mapper's should have grown by what
this batch taught. Skim the three `MEMORY.md` files, merge duplicates, and add the
lessons that were yours alone (a deploy trap, a cross-repo handoff, a harness
behaviour). Leave the plan updated and the check-in scheduled if anything is still
open.
