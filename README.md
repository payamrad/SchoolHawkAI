# SchoolHawkAI

Read-only family school collection, local storage, and opt-in agent analysis. See [ProjectPlan.md](ProjectPlan.md)
for the architecture and staged delivery plan.

## Workspace Layout

- `apps/collector`: Skyward messages/assignments/grades, Canvas assignments, and protected portal login.
- `apps/cli`: local inspection, Canvas matching, `Review`, and narrowly scoped cleanup commands.
- `packages/core`: Zod contracts, deterministic review/change detection, priorities, and source matching.
- `packages/briefing`: bounded briefing input, full student snapshots, and deterministic text rendering.
- `packages/agent`: provider-neutral agent interface and the Azure Foundry Responses adapter.
- `packages/storage`: persistence interfaces, SQLite implementation, migrations,
  encryption helpers, and Vitest tests.
- `config`: public portal URLs.
- `data`: ignored encrypted collection results and private SQLite data.
- `playwright/.auth`: ignored browser state and encryption key.

Only currently needed parts of the planned structure exist. Additional portal
adapters and a dashboard will be added when implemented.

## Setup and Commands

Use Node.js 20.19+, 22.12+, or a newer supported LTS release with npm. For a
new installation, run as the app's normal Linux user, not root or sudo:

```bash
bash scripts/setup-database.sh
```

The script locates the repository independently of the current working directory,
installs locked workspace dependencies using npm 10 without replacing system npm,
and initializes `data/database/schoolhawk.sqlite` using the storage migrations.
It creates a random 32-byte `playwright/.auth/messages.key` for a fresh installation,
with private directories (`0700`) and files (`0600`). No SQLite server, portal login,
account alias, or previously collected messages are needed. This is installation
tooling under `scripts/`, not part of the user-facing CLI design.

Reruns preserve the existing key and database records. Existing keys, including
keys created by the collector, are reused. Insecure paths are rejected, not silently
changed. If the key is missing and `data/` contains anything, setup stops: restore
the original key before proceeding. Setup does not import, delete, or reset data.
Keep a separately protected recovery copy of the key; it is required to restore
encrypted data. Deployment still requires the encrypted volume described below.

Dependency installation needs network access. If a native SQLite prebuilt binary
is unavailable for the machine, npm also needs Python 3, make, and a C++ compiler;
install those OS prerequisites separately. Setup does not install OS packages,
browsers, services, or configure disk encryption. Stop running app processes before
rerunning dependency installation. With dependencies already installed, use:

```bash
bash scripts/setup-database.sh --skip-install
```

The root `package-lock.json` is the single
lockfile for all npm workspaces. The private workspace packages currently expose
TypeScript source and are executed with `tsx`; a compiled deployment build is a
later milestone.

```bash
npm run typecheck
npm test
npm run skyward:login
npm run skyward:messages -- 7 --account lkwash-parent
npm run skyward:messages -- 7 --account lkwash-parent --all
npm run skyward:assignments -- 7 --account lkwash-parent
npm run skyward:grades -- --account lkwash-parent
npm run canvas:assignments -- --account canvas-parent
```

Login requires locally supplied credentials. See
[apps/collector/README.md](apps/collector/README.md) for login and collection details.
Tests use synthetic data and do not contact school portals.

## Run the Pipeline by Phase

[scripts/run-pipeline.sh](scripts/run-pipeline.sh) runs the existing npm commands
in order: login, collection, deterministic change detection, and local reporting. Login
is required whenever collection is selected. It reads
account aliases and enabled sections from the same private review configuration;
there is no second list of hardcoded accounts.

```bash
# Preview everything without opening browsers or a database.
bash scripts/run-pipeline.sh --dry-run

# Run the full pipeline, starting with fresh portal logins.
bash scripts/run-pipeline.sh --phase all

# Login only, or explicitly log in before a local-only reporting run.
bash scripts/run-pipeline.sh --phase login
bash scripts/run-pipeline.sh --phase reporting --login

# Select phases independently or combine them (execution order stays fixed).
bash scripts/run-pipeline.sh --phase login,collection --days 14
bash scripts/run-pipeline.sh --phase collection --days 14
bash scripts/run-pipeline.sh --phase change-detection
bash scripts/run-pipeline.sh --phase reporting --format text
bash scripts/run-pipeline.sh --phase change-detection,reporting --format json

# Generate a student snapshot from stored data, without logging in.
bash scripts/run-pipeline.sh --phase reporting --report-type student-snapshot --format json

# Collect, detect changes, then generate the snapshot instead of the brief digest.
bash scripts/run-pipeline.sh --phase all --report-type student-snapshot --format json

# Root npm shortcut; "review" is an alias for "change-detection".
npm run pipeline -- --phase review,reporting
bash scripts/run-pipeline.sh --help
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--phase` | `all` | `login`, `collection`, `change-detection` (or `review`), `reporting`, or a comma-separated combination; every collection run logs in first |
| `--login` | Automatic for collection | Explicitly prepend login to local-only phases; accepted but redundant for `all`/`collection` |
| `--config` | `config/review.local.json` | Existing private review configuration; relative paths are repository-root-relative |
| `--env-file` | Repository-root `.env`, if present | Private dotenv settings; existing exported variables win, and an explicitly selected file must exist |
| `--days` | `7` for briefing runs | Override both Skyward collection windows; snapshot runs otherwise use their separate assignment/message windows |
| `--messages` | `unread` | Preserve the collector default, or use `all` to include read messages within the window |
| `--format` | `text` | JSON or deterministic text output for the selected report type |
| `--report-type` | `briefing` | Small `briefing`, or full `student-snapshot`; requires the reporting phase or `all` |
| `--assignment-days` | `60` | Past-assignment detail window for `student-snapshot`, 1–366 days |
| `--message-days` | `14` | Recent-message window for `student-snapshot`, 1–366 days |
| `--dry-run` | Off | Validate configuration and display exact commands without running them |

Collection runs configured Skyward assignments, grades, messages, and Canvas
assignments sequentially. The day count does not restrict upcoming/missing work,
grade snapshots, or Canvas full active-course snapshots. To include messages already
read manually or opened during an earlier failed collection, explicitly use:

```bash
bash scripts/run-pipeline.sh --phase all --days 14 --messages all
```

**Both message modes open records and may mark messages read or send receipts.**
Use only approved accounts/workflows. The runner does not initialize storage,
guess student mappings, or approve assignment links. Set up the database and private
configuration first. **The default run, `--phase all`, and `--phase collection`
always log in first**, even if saved session files already exist. A successful
login is required before that portal's collectors can run. Local-only
change-detection/reporting does not access a portal unless `--login` or a `login`
phase is explicitly requested.

Login calls `npm run skyward:login` and/or `npm run canvas:login` once for the portals
in your configuration. **No preparatory `read` or `export` commands are needed for
interactive use:**

```bash
npm run pipeline -- --phase all
```

For actual runs, the runner automatically loads the repository-root `.env` after
configuration preflight and before login. No separate Node command or shell
`source` is needed. Existing exported variables take precedence, including
explicitly empty values. A missing default `.env` is reported and leaves the
existing environment/interactive behavior intact. An explicitly selected
`--env-file` must exist. Relative file paths are repository-root-relative.

The file must be a private regular file owned by the app user (`0600`), not a
symlink, and at most 100 KB. Parsing uses Node's dotenv syntax, not shell
evaluation or variable expansion. Quoted spaces, multiline values, and literal
`$`/command-substitution text are preserved without execution or tracing.
Only `SKYWARD_`/`CANVAS_` username, password, headed, and success-selector settings,
plus the five Azure Foundry settings in `.env.example`, are accepted. Unknown
variables, including shell/runtime startup settings such as `BASH_ENV`,
`NODE_OPTIONS`, and `PATH`, are rejected before any pipeline command runs.
Help and dry-run never open the environment file.

The runner uses exported or file-loaded credentials and prompts on your terminal
for anything still missing. Password input is hidden, including when Bash tracing is enabled.
Prompts use the controlling terminal, not piped stdin or the internal collection
plan, so they also work when command output is redirected. Empty input or EOF skips
that portal without making a login attempt; Ctrl-C stops the pipeline.

Each login subprocess receives only its matching
`SKYWARD_USERNAME`/`SKYWARD_PASSWORD` or `CANVAS_USERNAME`/`CANVAS_PASSWORD`.
File-loaded settings stay in the pipeline process until it exits; the caller's
shell is not modified. The Azure API key is excluded from every current pipeline
child command, since the pipeline still performs no AI calls.
Prompted credentials disappear when that process exits and are never saved to
files, added to command arguments, or exported into your parent shell. Other portal
credentials are excluded, as are all credentials from configuration preflight,
collection, and local review/reporting.

For unattended use, fill in the four portal credential variables in private `.env`,
select a private file with `--env-file`, or have the scheduler provide them through
the environment. See the [collector login instructions](apps/collector/README.md#skyward-login).
Missing credentials without an interactive terminal fail explicitly rather than
hanging or reading piped input. Help, dry-runs, and runs without a login phase never
prompt. If you exported credentials yourself, unset them in your terminal afterward;
the runner cannot erase the caller's environment. Environment variables are not
encrypted storage. Do not put credentials in the review JSON or shell arguments.

For Canvas manual browser login, set `CANVAS_HEADED=1` with both Canvas credential
variables unset; the runner leaves credential entry to that browser without terminal
prompts. For Skyward, `SKYWARD_HEADED=1` opens a visible browser; the runner supplies
its credentials from the environment or terminal prompts. A local desktop/display is required for headed
operation. The existing bounded login verification and MFA/CAPTCHA behavior are
unchanged; the runner never bypasses challenges or retries credentials automatically.
Failed login skips that portal's collections even if an old session file remains;
the other portal and local review/reporting can still proceed.

Keep the saved session matched to its account alias. Login and collection reject multiple
aliases for the same portal because current session files are portal-wide; local
review/reporting may still combine multiple previously collected accounts.

`change-detection` calls `Review run`. `reporting` calls `Review briefing`, which
also reevaluates local changes/priorities and saves an evaluation even when selected
alone. It is the **current model-free summary or structured AI input**, not an Azure
report, and it performs no email/SMS delivery.
With `--report-type student-snapshot`, reporting calls `Review snapshot` instead.
That report includes recent assignment details, all grades, and new/recent messages.
Snapshot pipelines default to collecting 60 days of past assignments and **all**
messages from the recent 14-day window, so recently read messages can also provide
context. Custom snapshot windows adjust these collection defaults. Explicit
`--days` and `--messages` overrides are still honored and may leave report coverage
dependent on older retained observations. `--days` does not change report filtering.
Report generation alone does not backfill records that were never collected.

Independent login/collection failures do not prevent subsequent portals or review.
Unsupported configured sections are reported explicitly and count as failures.
The runner exits nonzero if any step fails; a failed change-detection step prevents
reporting. Interruption stops the remaining steps. Earlier collection preflight
failures may not have stored run-health records, so treat any resulting report as
potentially stale even if its saved coverage looks complete.

Progress/failure notices go to stderr; commands keep their normal npm output and
diagnostic logs. Combined output is not a single JSON document, and reporting may
contain private data. The runner does not create separate report files or schedule
itself. Run only one pipeline/collection at a time; this script does not introduce
the planned shared scheduling lock.

Runner tests mock npm and use Python 3's standard-library pseudo-terminal support
to verify interactive prompts, hidden passwords, and cancellation without real logins.

## Fault Tolerance and Local Diagnostics

Collection is best-effort within the authorized scope. A malformed record or an
unverifiable student/course response does not stop independent valid records,
students, or courses from being processed. Recoverable failures are logged at the
record or scope boundary. Unknown optional values remain unknown; records with
untrustworthy identities are not assigned to a guessed student or course.

Best-effort does not mean an incomplete run is reported as complete. Skipped
records, uncertain state, unverified pagination, and missing coverage remain
visible as `partial` or `failed`. Successfully parsed observations are retained,
but incomplete scopes do not replace complete baselines or imply deletion.
Collector commands still exit nonzero for incomplete coverage. Authentication
failures, unsafe destinations, collection limits, and storage/key failures remain
explicit stopping conditions rather than being converted into empty success.

Login, collection, CLI, and storage commands print a diagnostic file path to
stderr. Each execution writes a private Pino JSON-lines log under:

```text
logs/YYYY-MM-DD-<operation-id>.jsonl
```

These logs do not require a database, session, or encryption key, so preflight
failures can also be investigated. The directory is `0700`, files are `0600`, and
the entire directory is ignored by Git. Log creation never replaces an existing
file. Help commands do not require or create logs.

Events include timestamps, command/operation IDs, collection run IDs, processing
stages, fixed error codes, student/course/record ordinals, and structural counts
or flags. For example, grade-response diagnostics distinguish missing,
conflicting, and ambiguous student binding instead of only reporting an npm
lifecycle failure. Inspect the file printed by the failed command before rerunning
collection.

Log fields are allowlisted. Names, portal student IDs, grades, message bodies,
credentials, raw HTML, URLs, and raw exception messages/stacks are not logged.
Logs describe why validation failed; they are not raw snapshots of school records.
Explicit data-query commands can still print private plaintext to stdout.

Warnings/errors are flushed immediately, and logs are flushed and closed on
command completion or failure. Failure to create or write the private diagnostic
log is an explicit error. Repeated detail events are capped at 2,000 per execution;
final run/command outcomes and a suppressed-event count remain available.
Starting a logged command removes recognized logs older than seven days and
prunes excess older files toward a 100-file limit. Files modified within the
last hour are protected from count-based pruning so concurrent commands retain
their active logs.

Existing runs cannot gain diagnostics retroactively. Programmatic callers can
use `withLocalDiagnostics` from `@schoolhawk/storage/diagnostics` to obtain the same
logging lifecycle; collection helpers emit sanitized warnings when called without
a logging context.

## Deterministic Review and Briefing Input

The local review pipeline consumes stored observations, not browser pages or model
responses. It does not log in, collect new data, call Azure/OpenClaw, send email/SMS,
or create notification jobs. Collection, review, summarization, and delivery remain
separate permissions and execution steps.

### Configure the authorized review scope

Create a private local configuration, then edit its account aliases and student IDs
using your existing stored source identities:

```bash
install -m 600 config/review.example.json config/review.local.json
```

`config/review.local.json` is ignored by Git. The CLI rejects non-private files,
symlinks, invalid configuration, duplicate sources, and conflicting child bindings.
Database setup does not create this review configuration. A missing configuration
stops `Review run` and `Review briefing` before database access and reports the copy
command above; it is not a database/key failure. Copy the template only when the
local configuration is missing, then edit it before reviewing real accounts.
Never put credentials in this file. `children[].id` should be a local pseudonym;
bindings associate that child with portal/account/student IDs. The default
`studentMatching: "bindings"` preserves explicit-only identity matching.
Opt in to `studentMatching: "unique-full-name"` to reconcile the same child across
different portal IDs within the configured family accounts. Keep at least one
known binding per child as an anchor; an additional portal identity can then join
that child by its full name without another manual binding. Duplicate configured
child aliases with the same verified full name and effective rules also combine;
the alphabetically first alias becomes the report label.

Full-name comparison normalizes case, whitespace, Unicode, and `Last, First`
versus `First Last` order. Structured first/last fields or a sortable full name
take precedence over a display label. It does not use first-name-only, initial,
nickname, or fuzzy matching. Incomplete historical labels cannot override a full
name for the same source identity. Conflicting full-name history, duplicate names
on distinct children in one portal account, or conflicting child rules prevent
automatic merging and produce explicit identity warnings. Existing explicit
bindings remain authoritative; unmatched identities stay separate and flagged.
Source IDs, observations, and provenance are never rewritten or deduplicated.

Resolved bindings are saved in the encrypted review evaluation and reused by
both briefing and snapshot generation. Names and raw student IDs are not added to
the minimized briefing or diagnostic logs. Course/assignment matching remains a
separate operation: review reuses confirmed links but never creates them.

Choose only the accounts and sections you intend to review. Assignments from both
portals, Skyward grades, and Skyward messages are supported. Configuring attendance,
calendar, announcements, forms, or another unsupported portal/section combination
produces an explicit unsupported-coverage warning, not an empty success.

`profileId` names an independent review baseline. After first use, changing its
source selection, configured child bindings, or student-matching mode requires a
new profile ID. Newly collected identities resolved automatically by name do not
reset source-record baselines. Rules and briefing limits can be changed without
resetting baselines. The old profile and its audit history remain intact.

### Run and inspect

```bash
npm run cli -- Review run --config config/review.local.json
npm run cli -- Review status --profile family
npm run cli -- Review changes --profile family --limit 100 --offset 0
npm run cli -- Review priorities --profile family --limit 100
npm run cli -- Review briefing --config config/review.local.json
npm run cli -- Review briefing --config config/review.local.json --text
npm run cli -- Review source --profile family --review <review-id> --source <source-id>
npm run cli -- Review --help
```

`run` processes newly stored observations and saves an encrypted evaluation.
`briefing` also reevaluates clock-based priorities before printing its input.
Inspection commands read saved evaluations; their `evaluatedAt` is not a promise
of current portal state. Query limits default to 100 and are capped at 1000.
Help does not require a database, configuration, key, or diagnostic log.

For a machine-readable JSON stream without npm's lifecycle banners:

```bash
node --import tsx apps/cli/src/index.ts Review briefing --config config/review.local.json
```

Diagnostics go to stderr/private logs, not the JSON stream. Exit zero means that
local processing produced a valid result, **not** that all school information was
collected successfully. Consumers must inspect `conclusion`, coverage, notices,
and omission counts. Explicit local inspection may print private plaintext.

### Change and baseline semantics

- Initial processing establishes baselines from retained history and labels active
  records `first-observed`. It does not backfill a stream of historical change alerts.
- Subsequent events are `newly-observed`, `updated`, `no-longer-observed`, or
  `reappeared`, with stable IDs, semantic field differences, and before/after source
  references. Newly observed is **not** a claim that the portal just posted an item.
- Whitespace, collection timestamps, and presentation-only changes do not create
  semantic events. Unknown grades/scores remain unknown, never zero.
- Complete sections advance independently. Partial/failed sections cannot overwrite
  complete review records. Conflicting same-ID observations do not advance a baseline.
- Date-window expansion is not treated as newly posted old work. Late or equal-time
  observations cannot rewind a stream: they are retained in source storage, skipped
  by the review checkpoint, and reported with `late-observations-ignored`.
- Absence requires two consecutive comparable complete observations by default.
  Skyward assignment checks require all three lists and an item still inside the
  comparable past window; moves between lists and shrinking windows are not removal.
  Canvas/grade scope or term changes cannot remove records from an older scope.
  No message removals are inferred. `no-longer-observed` never means completed,
  submitted, or deleted in the portal.
- Read-state changes describe observations only. Opening messages can itself mark
  them read; review does not attribute that change to the parent.
- Collection status transitions (including authentication failure and recovery)
  are recorded once as deterministic events; ongoing health warnings still
  appear on later evaluations without duplicating those transition events.
- If reviewed source history changes through explicit cleanup, processing stops
  with an actionable error. Use a new profile ID to rebuild from retained records.
  Saved review evaluations/events are separate encrypted audit history; message
  truncation does not delete them or backups.

Migration 007 stores review profiles/checkpoints, immutable events, and immutable
evaluation snapshots. They use existing AES-GCM/HMAC protections and the original
key. Events, state advancement, and evaluation save commit in one SQLite write
transaction. Identical retries do not duplicate events. Source observations are
never rewritten by review. Backups include review history.

Safety limits are explicit errors, not silent truncation: 20,000 source runs per
profile, 200,000 newly processed records or 50 MiB of normalized input per batch,
100,000 tracked records, and 10,000 scopes. Review requires non-future observations
and a clock no earlier than its retained state.

### Priority policy

Defaults are 24 hours for exact imminent deadlines, seven days for upcoming work,
36 hours for stale collection, three consecutive collection failures for operational
escalation eligibility, and two comparable absences for disappearance confirmation.
`children[].rules` can override individual settings without replacing other defaults.

- Missing work is high priority. An unknown missing flag cannot clear a previously
  verified missing-work concern; its older evidence and uncertainty remain visible.
- Exact deadlines within 24 hours and date-only deadlines today/tomorrow are high.
  Date-only Skyward deadlines remain Pacific calendar dates, not invented midnight
  timestamps. Exact timestamps use elapsed time, including across DST.
- Upcoming work is normal priority. A non-missing assignment already exposing a
  grade/score is not repeatedly described as pending solely because of its deadline;
  this does not assert that it was submitted.
- Ordinary grade changes and newly observed unread messages are normal daily items.
  No message text is interpreted as urgent.
- Failed/stale coverage and source conflicts are prominent operational warnings.
  Linked source values remain separate; Skyward marks are never replaced by Canvas.

Importance and delivery eligibility are separate. Both immediate-alert switches
default to false. Opting in only marks eligible candidates: newly discovered,
fresh, exact deadlines inside the urgent window, or threshold-crossing collection
failures. This phase performs **no delivery**. Quiet hours, a notification outbox,
delivery retries/rate limits, and provider integration are later work.

### Provider-neutral boundary

Programmatic callers can use `ReviewStore` / `SqliteReviewStore.processReview`,
then `buildBriefingInput(review)` from `@schoolhawk/briefing`. Neither requires a
model SDK, credentials, prompts, browser, or notification provider.

`briefingInputSchema` validates the versioned output, source/child references, limits,
and qualified conclusions. `serializeBriefingInput` returns compact JSON.
The default limits are 40 items and **32,768 UTF-8 JSON bytes**, not an estimated
token budget. The CLI also reserves room for its newline. High-priority items sort
first; omitted items, high-priority counts, health details, and shortened text are
explicit. Truncated input cannot claim no material changes.

The payload uses `child-1`, `child-2`, etc., ordered by configured child pseudonym,
and opaque source references. It contains minimized facts, deterministic reasons,
effective rule parameters, before/after changes, dates, extraction confidence, and coverage/freshness warnings.
Account aliases, portal student IDs, source URLs, names from identity records,
full message bodies, raw HTML, and instruction bodies are not exported.
Source links and identity mapping stay local and can be inspected with `Review source`.

**Minimized is not anonymized:** assignment titles, course labels, marks, and other
selected source text may still contain personal information. All source text remains
untrusted data, never system instructions or authorization to use tools. Approve the
provider, fields, retention policy, and delivery channel before transmitting anything.
The Azure Foundry agent adapter below consumes the full student snapshot; this
bounded contract remains available for other summarization consumers.
Completed agent analyses are saved locally as described below. Fact-checking model
conclusions and email/SMS delivery are not implemented.
`renderDeterministicBriefing` / `--text` provides a local model-free fallback.

## Full Current-Student Snapshot

This report is designed for an AI agent with **no conversation memory**. The
database is treated as the current school year's dataset, so no school-year start
date is required. All grades are retained for progress analysis, while assignment
details and messages use explicit windows to keep context relevant. Annual database
reset is an operator responsibility; snapshot generation never truncates or deletes data.

```bash
npm run cli -- Review snapshot --config config/review.local.json
npm run cli -- Review snapshot --config config/review.local.json --text
npm run pipeline -- --phase reporting --report-type student-snapshot --format json

# Optional reporting windows; grades remain unfiltered.
npm run pipeline -- --phase reporting --report-type student-snapshot \
  --assignment-days 60 --message-days 14 --format json
```

For machine-readable JSON without npm lifecycle banners:

```bash
node --import tsx apps/cli/src/index.ts Review snapshot --config config/review.local.json
```

### Included context

- **Past assignment details from the last 60 days** (approximately two months),
  including unchanged and already-graded work. Future/upcoming, still-missing,
  undated, and confirmed-linked assignment details remain included even when an
  ordinary past-date filter would exclude them.
- **All retained course/period grades and grade history**, with no date filter.
  Older graded assignments also contribute compact grade/score histories under
  `earlierAssignmentGrades`, without their full descriptions or instructions.
- Assignment details and grades grouped by student and course, with source-specific
  details, instructions/descriptions, marks, scores, due dates, grading periods,
  section references, and unknown values preserved.
- Observation history: consecutive identical values at the same scope quality
  share a version with first/last timestamps, evidence references, and an
  observation count. Changed values and changes in completeness remain visible.
- **Recent messages from the last 14 days**, newly observed messages in the review
  window, and messages with recently detected changes beyond read state. Recent
  read messages can qualify, too. Older unread messages alone do not qualify.
  Selected messages retain their full sender, subject, body, canonical sent date,
  and observed read state. Relative display labels such as "Today" are not forwarded.
- Deterministic attention items, recent changes, global/per-child priority rules,
  and all collection-health warnings. Included assignments/messages retain their
  value histories, and all grade histories remain available in the same payload.
- Opaque, schema-validated record/source references and confirmed cross-source
  course/assignment links, so the agent can cite evidence and avoid double counting.

The current value prefers the latest complete-scope observation. If only partial
observations exist they are included as `partial-only`; newer partial values remain
in history even when an older complete value is preferred. Conflicting observations
at the same time produce an ambiguous current value, not a guessed mark.
`observedInLatestCollection` and record issues distinguish retained historical
values from current collection coverage.
The report records each assignment/message's `selectionReasons`, both actual date
windows, available-record counts, and explicit exclusion counts. Grade-only
summaries of earlier assignments are historical evidence, not outstanding work.

Student grouping uses the same resolved child identities as deterministic review:
explicit bindings by default, or conservative full-name matching when enabled in
the private configuration. Canonical child aliases become report labels; unresolved
identities remain separate and flagged. Name matching combines students, not school
records: every qualifying source record and history remains included. Within Skyward, course labels
are used for grouping, with section details retained on records. Across Skyward and
Canvas, courses merge only through confirmed mappings; mapping section constraints
and individual assignment links remain explicit. Counts are **source-record counts**,
not an inferred count of unique tasks across both portals.

Messages remain account-wide. Their `studentRefs` identify potentially related
students sharing that account, not a claim that the message belongs to each child.
`newlyObservedInReviewWindow` uses first-observed time and the configured recent
review window (24 hours by default); it does not mean newly posted. This can include
an older message first discovered during a recent backfill, with that distinction
visible. Read status is the status observed
before the collector opened the message, not a guarantee of the current website state.

### Completeness, size, and privacy

`omittedRecords: 0` means no records qualifying for the reporting policy were
dropped to meet a size limit. `excludedRecords` separately counts assignment
details and messages outside that policy; earlier assignment grades remain as
compact summaries. This does **not** mean the school portals were fully collected. The current
Skyward parsing gaps, collection lookbacks, unsupported sections, and stale data
remain explicit in `collectionHealth`, record issues, and report status. Missing
records or message bodies cannot be reconstructed by report generation.

The small briefing's 40-item / 32 KiB limits do not apply to full snapshots.
Snapshots never silently shorten selected descriptions/messages or drop
lower-priority qualifying records. Safety limits fail explicitly: 50 MiB of output, 100,000 distinct source
records, 500,000 retained value versions, and the existing review/source-run
processing limits (source history is read before reporting-window selection). The
agent adapter also enforces an HTTP request-byte limit, but that is not a model
token budget. Oversized requests and provider context-limit errors fail explicitly.
Context-aware partitioning remains future work; records are never silently discarded.

The snapshot includes private educational text, sender/teacher details, and full
message content. Portal/student identity keys are represented by opaque references
and configured aliases, but **this is not anonymized data**: names or sensitive
details may appear inside source text. Keep output private and approve the AI
provider and its data handling before transmission. Source text remains untrusted
data, never instructions or permission to browse or execute tools.

Programmatic callers can use
`ReviewStore.createStudentSnapshot(config, now, { assignmentDays: 60, messageDays: 14 })`.
`buildStudentSnapshot`, `studentSnapshotSchema`, and `serializeStudentSnapshot`
are exported by `@schoolhawk/core/student-snapshot`; text rendering is available
from `@schoolhawk/briefing/student-snapshot`. The builder accepts typed history and
review input and is independent of Azure, OpenClaw, or a delivery provider.
For name-matched input, use a review containing its `resolvedChildren`; the pure
builder rejects missing or mismatched resolution metadata instead of regrouping
the snapshot differently from its review. Name resolution reads retained student
identity history with explicit limits of 200,000 identity observations and 100,000
distinct source identities; it never silently skips records to meet those limits.

Generation refreshes the deterministic review and reads source history under one
SQLite transaction. It preserves source records and mappings; the source data and
review history retain their existing encryption. The full snapshot is returned to
the caller/stdout, not automatically written to a plaintext file or sent anywhere.
The separate agent-analysis command persists completed AI responses. Evidence-based
validation of their conclusions and email/SMS delivery remain later stages.

## Azure Foundry Agent Integration

`@schoolhawk/agent` exposes the provider-neutral `StudentReportAgent` interface:

- `testConnection()` sends synthetic text and requires a completed, nonempty agent
  reply. It does not load school data or require a school database/key. The agent
  need not echo a special marker; its existing system prompt remains in control.
- `analyzeStudentReport(report)` accepts a schema-valid full student snapshot,
  transmits every included field, and returns the agent's text with the input
  snapshot/review IDs and student references.

The `AzureFoundryAgent` implementation targets the existing
`StudentGradesConsultant` Responses endpoint. It uses the `api-key` header and
`api-version=2025-11-15-preview`, not Chat Completions or a direct model deployment.
It does not replace the agent's configured system prompt, select a different model,
or recalculate deterministic priorities.

### Configure and test

Provide credentials through the process environment. For local use, create a
private environment file **only if it does not already exist**, then edit its
blank API-key value locally:

```bash
install -m 600 .env.example .env
node --env-file=.env --import tsx apps/cli/src/index.ts Agent test
```

`.env` is ignored by Git. Do not put credentials in command-line arguments,
review configuration, report JSON, or source code. The direct CLI does not automatically
load environment files; Node's `--env-file` above applies only to that process.
The Bash pipeline loads `.env` itself for its own steps, but still does not invoke
the agent. With
credentials already supplied by a secret manager or environment, use:

```bash
npm run cli -- Agent test
npm run cli -- Agent --help
```

Required variables are `AZURE_FOUNDRY_AGENT_ENDPOINT` and `AZURE_FOUNDRY_API_KEY`.
Optional variables are `AZURE_FOUNDRY_API_VERSION`, `AZURE_FOUNDRY_TIMEOUT_MS`
(default 120,000; maximum 300,000), and `AZURE_FOUNDRY_MAX_REQUEST_BYTES`
(default 50 MiB; minimum 1 KiB). Only HTTPS Foundry agent Responses endpoints are
accepted; redirects and URL-embedded credentials are rejected. Some newer Azure
Agent Application endpoints require Microsoft Entra authentication instead of
API keys; this connector reports that failure rather than switching endpoints.

### Submit a student report

**These commands explicitly send private educational data to Azure.** Approve the
provider, fields, and retention terms before using real records. Regular `Review`
commands and the existing pipeline remain local; they do not call the agent.

```bash
# Generate the current name-matched snapshot, send it, and save the AI response.
node --env-file=.env --import tsx apps/cli/src/index.ts Agent analyze --config config/review.local.json

# Or send an existing private, schema-valid student snapshot.
node --env-file=.env --import tsx apps/cli/src/index.ts Agent analyze --report /private/path/student-snapshot.json
```

Existing report files must be private regular files (`0600`), not symlinks.
`--config` uses the normal 60-day assignment and 14-day message windows; use
`Review snapshot` to prepare different windows before choosing `--report`.
CLI responses are JSON and may contain private AI-generated text.
Both analysis modes require the existing local database and its original encryption
key. Storage is opened and validated before the request is sent. The database
connection remains available, but no SQL transaction or write lock is held while
waiting for the agent. After the response completes, saving is a separate atomic
transaction. Success is printed only after the saved report has committed.

### Saved AI reports

Migration 008 adds append-only `agent_reports` storage. Each report retains the
complete returned analysis text, provider/response ID, receipt time, duration,
token usage when available, snapshot/review IDs, student references, and source
coverage warnings. The JSON response includes a local `reportId`, `savedAt`, and
storage `version` in addition to the existing analysis fields.

The full payload is encrypted with the existing AES-256-GCM storage protection and
original database key. Only its opaque local ID, provider, timestamps, and student
count remain indexable metadata. Backups include these reports; no plaintext
report file is created automatically. Identical saves of the same provider response
reuse the original record; conflicting contents cannot overwrite it. There is no
automatic report-retention/deletion job, and source-message cleanup does not delete
AI reports or backups.

Inspect saved reports without an Azure key or network access:

```bash
npm run cli -- Agent reports --limit 20
npm run cli -- Agent reports --limit 20 --offset 20
npm run cli -- Agent report --id <reportId>
```

Lists show metadata only, newest receipt first; `report` returns the full saved
response. These commands still require the local storage key. A connection test
does not require storage and is not saved as a student report. Previously unsaved
responses are not backfilled automatically.

Only the returned analysis and its provenance IDs are archived, not an additional
copy of the full submitted snapshot. Keep externally supplied report files if you
need to reproduce their exact inputs; their review IDs need not belong to this
database. The storage contract is `AgentReportStore`, implemented by
`SqliteReviewStore`, with `saveAgentReport`, `getAgentReport`, and `listAgentReports`.

Programmatic callers can create `AzureFoundryAgent` from
`@schoolhawk/agent/azure-foundry`, supplying `endpoint` and `apiKey`, or call
`createAzureFoundryAgentFromEnv()`. Both implement the same transport interface.
Custom orchestration must pass completed analyses to `AgentReportStore`; the CLI
does this automatically for both `--config` and `--report`.

Each call uses a fresh, non-streaming Responses request with `store: false`, no
conversation/previous-response ID, and no client tools. Report JSON is user-input
data, never a replacement system prompt. `store: false` requests no stored
Responses history; it does not replace Azure's wider data-retention agreement.
The adapter accepts completed text replies, bounds response bodies to 1 MiB, and
rejects refusals, unfinished replies, malformed responses, and unsupported tool
operations. It never follows source URLs or executes commands requested by a model.

Timeouts, HTTP errors, invalid reports, and size failures are explicit and
sanitized. There are no automatic retries, since a timeout can leave the remote
outcome uncertain. Private diagnostics contain operation status, duration, HTTP
status, and structural counts, not keys, endpoints, prompts, reports, or AI text.

Returned analysis is labeled `unverified-ai-analysis`: transport/schema checks do
not fact-check the model's academic conclusions or validate its citations. Parents
must verify recommendations against source evidence and collection limitations.
The returned `sourceStatus` and `sourceNotices` preserve deterministic input
coverage warnings independently of anything the model says.
Stored analyses retain that unverified label; saving is not approval of their
recommendations. No analysis is automatically delivered or used to change school
records or deterministic priorities. Storage failures fail the command instead of
printing an unsaved success result. On an agent outage, the independent local
`Review briefing --text` remains available.

## Canvas Login

On a local desktop, open a visible browser and enter Canvas credentials directly:

```bash
CANVAS_HEADED=1 npm run canvas:login
```

With no Canvas credential variables exported, this waits up to two minutes for
manual login and any required MFA/CAPTCHA. The public login page is
https://lwsd414.instructure.com/login/canvas. For an automatic single attempt,
set `CANVAS_USERNAME` and `CANVAS_PASSWORD` locally as described in the
[collector README](apps/collector/README.md#canvas-login), then run
`npm run canvas:login`. Do not put credentials in chat or command arguments.

Canvas verifies its dashboard and proves session reuse in a fresh browser context
before saving `playwright/.auth/canvas.json` atomically with mode `0600`. The
directory is `0700` and ignored by Git. Failed verification preserves any old
session. Canvas and Skyward use separate state files; Canvas login does not touch
the database, encryption key, or Skyward session. Saved state is a credential,
not encrypted storage. Login is independent of the Canvas assignment collector below.

Skyward collector commands and their storage contracts remain available. Shared
private-session loading and browser/database cleanup live in
`apps/collector/src/portal-collection.ts`; Pacific date windows, student discovery,
and browse-registration parsing remain in `apps/collector/src/skyward.ts`.
Both login commands share the session lifecycle in
`apps/collector/src/portal-session.ts`; each portal keeps its own form and
authenticated-page checks.

## Canvas Assignments and Correlation

After Canvas login and database setup, collect full assignment snapshots from all
active courses for the account's linked observees:

```bash
npm run canvas:assignments -- --account canvas-parent
npm run cli -- Canvas status --account canvas-parent
npm run cli -- Canvas scopes --account canvas-parent --skyward-account lkwash-parent
```

`canvas-parent` is a stable local alias, not a username. Keep the same alias for
the same Canvas account. The collector uses the protected Canvas session and
documented read-only APIs, including paginated student-specific assignment lists.
There is no day count: full active-course snapshots keep older linked assignments
eligible for refresh. Account-linked observees are covered; one-off course-level
observer relationships and archived courses are not included. The dashboard's
manual done checkboxes are never used as submission or missing status.

Stored Canvas fields include student/course/assignment IDs, names, fuller titles,
plain-text instructions, exact due/unlock/lock times, source update time, possible
points, grading type, and submission types. External-tool and locked flags are
retained, but files/tools/iframes are not opened. Canvas and Skyward observations
are separate; Canvas never overwrites a Skyward score, due date, or missing flag.

Confirm the student and exact course/section mapping using IDs from `Canvas scopes`:

```bash
npm run cli -- Canvas map --account canvas-parent \
    --student <canvas-student-id> --course <canvas-course-id> \
    --skyward-account lkwash-parent --skyward-student <skyward-student-id> \
    --skyward-course "ALGEBRA 1" --skyward-section "23"
```

Type `CONFIRM` when prompted, or supply `--yes` for explicit noninteractive approval.
Omit `--skyward-section` only if the source section is null. Names are not used to
merge student identities automatically. Mappings are encrypted cross-source
references, not a new student roster or initialization step. Conflicting mappings
are rejected and preserved; this version does not automatically remap them.

For routine matching, preview a lookback window, then authorize a batch:

```bash
npm run canvas:match -- --account canvas-parent --lookback 30 --dry-run
npm run canvas:match -- --account canvas-parent --lookback 30 --yes
```

`canvas:match` works from the repository root or `apps/collector`, like the other
Canvas commands. The original `npm run cli -- Canvas match` form remains supported
from the repository root. Student/course mappings are a one-time identity setup,
not something to repeat for every matching run.

This operates on stored data only. It uses all confirmed course mappings for the
Canvas account, or one mapping selected with `--mapping <mapping-id>`. It does not
guess student/course identity or collect fresh data. With no mappings it stops
with an actionable error. Without `--yes` or `--dry-run`, it previews and requires
interactive `CONFIRM`. Use `--yes` for an explicitly authorized unattended run.

`--lookback N` means today and the preceding N-1 dates in `America/Los_Angeles`,
based on the Skyward assignment's due date (N: 1-366). For example, N=2 on
October 9 covers October 8-9 inclusive. Future-due and undated assignments are
counted as skipped, not silently treated as eligible. Confirmed links are skipped
without increasing attempt counts. Unlinked assignments, including earlier
unmatched/review-required results, are reconsidered on each run while in the
window. Once they age out they retain their last status; widening the window
makes them eligible again.

The default source freshness limit is 48 hours; `--max-source-age-hours N` accepts
1-168. Relevant Canvas roster/course and Skyward student/section observations must
be complete, and the Skyward assignment must have been observed in the latest run.
Refresh both collectors before matching. A lookback larger than the Skyward
collection window does not refresh retained records: those are deferred as
`not-observed`. Collection and its known short-lookback limitations are separate
from this local linking operation.

The matcher examines the full stored course scope before filtering eligible
Skyward records, so out-of-window competitors cannot conceal ambiguity. Only
unique title/code matches with identical Pacific due dates are linked. Date
disagreements, unknown Canvas dates, multiple candidates, existing reservations,
stale/incomplete sources, and conflicting course mappings remain unlinked with a
review reason. Scores, point totals, and Canvas planner checkboxes never determine
identity. Multi-resource relationships such as two TLAS 6 items for one Skyward
assignment require review; this implementation enforces one-to-one links.

Each Skyward assignment query exposes these matching fields:

| Field | Meaning |
| --- | --- |
| `canvasStatus` | `pending`, `unmatched`, `review-required`, or `linked` |
| `canvasRecordId` | Nullable stable Canvas record foreign key (opaque keyed hash, not the public Canvas assignment ID) |
| `canvasAccountId`, `canvasLinkId` | Canvas account scope and stored association evidence |
| `canvasMatchReason` | Why a candidate needs review; null for other statuses |
| `lastMatchAttemptAt`, `matchAttempts` | Latest attempted match and number of attempts |

`pending` means never attempted; `unmatched` means no candidate was found in the
verified scope; `review-required` means the matcher could not safely link; `linked`
means the source-ID relationship is established. No status means "no schoolwork"
or overrides the source's missing/submission state. The batch summary reports
linked, would-link, already-linked, unmatched, review-required, outside-window,
and undated counts. Matching decisions, source run IDs, matcher version, and the
chosen lookback/freshness policy are stored in an encrypted append-only audit.
The entire write batch, statuses, links, and audit commit or roll back together.

Dry runs do not change match statuses, links, attempts, or matching audits. Opening
the store can still apply pending migrations; keep a protected backup before an
upgrade. Existing history is retained and the original key is reused.

You can also review proposals and explicitly confirm an individual link:

```bash
npm run cli -- Canvas mappings --account canvas-parent
npm run cli -- Canvas matches --account canvas-parent --mapping <mapping-id>
npm run cli -- Canvas confirm --account canvas-parent --mapping <mapping-id> \
    --proposal <confirmation-key>
npm run cli -- Canvas links --account canvas-parent
npm run cli -- Assignments --account lkwash-parent --limit 100
```

Matching requires the confirmed student/course scope, an equal Pacific due date,
and an exact normalized title or lesson code (for example, `U1L6` versus
`U1L6 More Visual Patterns`). Lesson codes are also recognized inside longer titles
such as `Sept 28: Unit 2 Lesson 1 Practice`. Science `TLAS` and `I2C` codes are
supported; a title containing multiple different task codes is not a single-code
match. Candidate generation checks both directions for
ambiguity. Unknown dates, duplicate titles, and many-to-one candidates remain
unlinked. Scores, point totals, `post_to_sis`, and presumed equal portal IDs are
not matching keys. Inspect the evidence before confirming; no fuzzy proposal is
silently applied. A confirmation key is tied to both observed runs, so a refresh
requires reviewing a new proposal rather than accepting stale evidence.

Confirmed links retain both source IDs permanently; later title/date changes do
not trigger rematching. Repeating the same confirmation is idempotent. Automatic
unlink/remap and manual overrides for ambiguous candidates are not implemented.
The `Assignments` query returns original Skyward fields plus a separate `canvas`
object containing the confirmed link, latest complete Canvas observation, and
freshness/coverage indicators. It follows the stored Canvas foreign key rather
than matching again. `skyward` contains the latest Skyward run/section health and
an `observedInLatestCollection` flag. `canvas.conflicts` identifies known
`due-date` and `possible-points` disagreements without reconciling them silently.
Both original values remain available with source timestamps. Unlinked assignments
have `canvas: null` and a separate `canvasStatus`; a link alone is not a freshness
guarantee.

Read-only inspection can print private plaintext. Protect terminal output:

```bash
npm run cli -- Canvas assignments --account canvas-parent --student <id> --course <id> --limit 100 --offset 0
npm run cli -- Canvas --help
```

Queries use bounded limits (default 100, maximum 1000) and offsets. Collector output
contains counts/status only. API failures, pagination errors, and partial course
collections do not replace complete observations or imply deletion. Look at
`latestCollection`, `scopeStatus`, `observedInLatestCollection`, and capture time:
retained data may be stale even when some other course was collected successfully.
Migrations 005 and 006, encrypted backups, and append-only audits cover collection,
confirmed mappings/links, and batch matching. Use the original key; no replacement
key is generated.

## Assignments

Collect assignments for every student available to the authenticated Skyward
account and store them directly in the existing SQLite database:

```bash
npm run skyward:assignments -- 7 --account lkwash-parent
```

N is the same inclusive Pacific-calendar day count used by messages (1-366).
For N=7 on September 26, past assignments due September 20 or later are retained.
Every assignment in Skyward's Upcoming and Missing lists is retained regardless
of that cutoff. Undated assignments are retained with an unknown due date.

The collector selects the All Year view, verifies the student roster, and reads
Upcoming, Missing, and Past separately for each student. It stores the information
exposed by those lists: student, stable assignment ID, title, class/section,
teacher, due date, category, grade, score/status, maximum score, weight, attempts,
attachment count, and provenance. Unknown scores are not treated as zero.
Student details include the Skyward `id`, `firstName`, `lastName`, and the complete
display `name`. The ID remains the account-scoped reference; no initialization
command or separate student table is required. Names remain encrypted.
Parser-version-1 snapshots remain readable without separate name fields and are
not rewritten; new version-2 collections capture both name parts. Refresh through
normal assignment collection after renewing the session when necessary.
Assigned dates and descriptions are null when absent from the list; attachments
are not opened or downloaded. The All Year filter changes Skyward's view state,
not assignment records. It covers the school year exposed by the portal, not an
unverified archive of previous years.

Output contains counts and coverage only. Missing students, unverified empty
lists, capped or incomplete results, and expired sessions produce a nonzero exit
status. Returned partial/failed runs are still saved for inspection. A complete
section can advance independently of another student's failed section; failed
observations and empty lists never erase previously stored records.

See [apps/collector/README.md](apps/collector/README.md) for collection details.

## Grades

Collect the course grades exposed by Skyward's Grading view for every student:

```bash
npm run skyward:grades -- --account lkwash-parent
```

Grades are snapshots, so this command does not take a day count. It captures all
displayed grading periods, including records whose mark is not yet available.
Letter grades, numeric marks, and standards-based marks are retained as source
text; a blank grade remains unknown rather than becoming zero.

Each record includes the Skyward student ID and first/last names, stable student
grade-bucket ID, student-section ID, course code/name, class details, period label,
open/closed period status, and source/capture metadata. Fields not independently
exposed by the matrix, such as a grading-scale definition, score denominator, or
effective date, remain unknown. GPA, earned credits, prior-year archives, and
grade-detail popups are not collected by this command.

Student identities and grades are encrypted in the existing SQLite database using
the original key. Migration 004 runs automatically after key verification.
History is retained; changed marks keep their source identity. A student's failed
or incomplete collection cannot replace that student's last complete observations.
Other students' successful collections remain available. Empty views never imply
deletion. Output contains counts and coverage, not names or marks.

`GradeStore` exposes `importGradeRun`, `getGradeRun`, `listGradeRuns`, and
`listGrades` on the existing `SqliteMessageStore`. Queries are account-scoped,
accept an optional portal `studentId`, and have a bounded `limit` (1-1000,
default 100). `getGradeRun` reconstructs the full snapshot, including incomplete
student results. Stored grades are last-observed values: consult timestamps and
run health before treating them as current. The separate `Review` pipeline generates
deterministic grade-change events; the collector itself does not generate alerts.

## CLI

### Messages

Return up to N stored messages for an account:

```bash
npm run cli -- Messages --account lkwash-parent -- 10
```

N must be an integer from 1 to 1000. `Messages 10 --account lkwash-parent` is also
accepted after `npm run cli --`. Account options must precede the inner `--`,
which marks the end of options.

The command prints a JSON array of deduplicated messages, ordered by sent date
newest first (message ID breaks same-date ties). Each entry includes the decrypted
sender, subject, body, source metadata, run ID, and first/last seen timestamps.
It uses the most recent complete observation per message ID; partial/failed-only
messages are excluded. Fewer than N available messages returns fewer entries;
an account with no matching stored messages returns `[]`.

This queries local SQLite without contacting Skyward or modifying message records.
It requires the existing database and original key; opening storage can apply
pending schema migrations. Output contains private plaintext: protect terminal
scrollback and any redirected files. Stored results do not establish current
portal completeness; use run status information when assessing collection health.

### Truncate

The first user-facing command is `Truncate`, with an explicit cleanup target and
account alias. Preview matching login notifications without deleting records:

```bash
npm run cli -- Truncate --LoginNotification --account lkwash-parent --dry-run
```

To delete them, run the command without `--dry-run`, review the counts, and type
`DELETE` at the confirmation prompt:

```bash
npm run cli -- Truncate --LoginNotification --account lkwash-parent
```

For noninteractive use, add `--yes` to explicitly authorize deletion without a
prompt. Use `npm run cli -- --help` for command help. No system `sqlite3` executable
is required. The database and original encryption key must already exist.

`--LoginNotification` matches subjects containing `New Login Device Detected`
(case-sensitive) only when the sender is exactly
`LAKE WASHINGTON SCHOOL DIST (No Reply)`. Additional text before or after the
subject phrase is allowed. A match in the message body alone does not qualify.

All observations of each matching message ID are deleted for the specified
account, including older versions and partial/failed run observations. Unrelated
messages and other accounts are retained. The command reports unique messages,
historical observations, and affected runs separately. It decrypts locally for
matching but never displays message content.

Deletion, retained-message counts, run hashes, and the cleanup audit commit in one
transaction. Run metadata and original import audit entries remain. Run summaries
include `removedMessageCount`; `getRun` returns only retained messages after
truncation. Reimporting an original file for a truncated run is rejected as a
conflict rather than undoing deletion. New collection runs can collect these
notifications again; this command is not a future-ingestion filter.

Keep a protected backup before deletion. Backups and legacy `data/messages/` files
are not changed or removed. This is logical database deletion, not guaranteed
secure erasure from SQLite pages, WAL files, storage media, or backups. Opening
storage applies pending schema migrations, including when using `--dry-run`.

## SQLite Storage

The collector writes each run directly to `data/database/schoolhawk.sqlite` using
the storage package. Run database setup before first collection. SQLite and the
existing key are checked before launching the browser. There is no intermediate
run file or separate import step for new collections.

The `--account` alias is required for collection. Use `lkwash-parent` for the
account whose existing files were imported under that alias. The alias is manually
assigned; it is not automatically verified against the authenticated portal account.

Storage inspection and backup remain available through the provisional storage
utilities. Import is only needed for legacy encrypted files:

```bash
npm run data -- import --account lkwash-parent
npm run data -- status --account lkwash-parent
npm run data -- backup --account lkwash-parent
```

`lkwash-parent` is a stable, non-sensitive account alias, not a login username.
Keep using the same alias for the same account. Each import processes all
`data/messages/*.json.enc` files, which must belong to that account. Multi-account
collection directories and automatic account binding are not implemented yet.

The database is `data/database/schoolhawk.sqlite`. No live login is required for
importing saved files. The importer authenticates/decrypts each file in memory,
validates its schema, imports it transactionally, then reconstructs the stored
run and verifies it against the source. It reports counts only. Repeating an
import skips identical runs; changed data under an existing run ID is rejected.
Rejected files produce a nonzero exit status while other valid files can still
be imported. Files larger than 50 MiB are rejected.

**Existing source files are never deleted or modified.** The `data/messages/`
folder is no longer required or created by the collector. Its saved files remain
available for legacy imports and recovery until an explicit retention decision.

### Data Interface

`MessageStore` exposes `importRun`, `getRun`, `listRuns`, `listMessages`,
`truncateMessages`, and `close`. `SqliteMessageStore` also exposes an online `backup` method. Callers
must close stores. Queries are account-scoped with bounded limits (100 by default,
maximum 1000). `listMessages` accepts a date-only `since` filter.

`getRun` reconstructs the retained validated observation, including messages,
source timestamps/URLs, window, status, warnings, parser version, and selection.
Older files without `selection` are normalized to `all`.

The storage layer deduplicates the current message view by account and Skyward
message ID. Recollecting the same ID does not create another current message.
Each run's observations are still stored, including repeated content, to preserve
history, provenance, and exact run reconstruction unless explicitly truncated; this is not physical payload
deduplication. Identical run retries are skipped and conflicting run IDs rejected.

`listMessages` returns the most recent complete observation per message ID,
regardless of import order. `firstSeenAt` and `lastSeenAt` refer to complete
observations. Partial and failed runs remain available through run queries but
cannot overwrite the current complete-message view. Empty and unread-only runs
do not imply deletion or establish a complete all-message baseline. Read status
is the observed status before opening, not a claim about the current portal.
Consumers must consult run health and selection when presenting completeness.

The source schema supports Skyward messages, student-scoped assignments, and course
grade snapshots. The separate `Review` pipeline adds explicitly configured child
bindings, deterministic change events, priorities, and bounded briefing input.

The same `SqliteMessageStore` also implements `AssignmentStore`, with
`importAssignmentRun`, `getAssignmentRun`, `listAssignmentRuns`, and
`listAssignments`. Existing message APIs are unchanged. `listAssignments` accepts
an optional portal `studentId` and a bounded `limit` (1-1000, default 100). It
deduplicates by account, student, and assignment ID using complete section
observations, including complete sections from otherwise partial runs.
`getAssignmentRun` returns the full validated snapshot with all student coverage.
Stored assignments are last-observed records, not a claim about current portal
state; consult run coverage and observation timestamps. These source queries do not
infer removals or changes; `Review` maintains its own conservative derived history.

### Persistence and Protection

- `collection_runs`: run scope/status and encrypted run metadata.
- `message_observations`: indexed message history and encrypted message payloads.
- `audit_events`: append-only import audit protected by application API and triggers.
- `cleanup_events`: append-only, account-scoped truncation audit with counts, target, and time.
- `storage_settings`: encryption-key check; schema version uses `PRAGMA user_version`.
- `assignment_runs`: encrypted all-student snapshots and run summaries.
- `assignment_sections`: per-student Upcoming/Missing/Past coverage.
- `assignment_observations`: encrypted student/assignment observations with keyed-hash identity indexes.
- `assignment_import_events`: append-only assignment import audit.
- `grade_runs`: encrypted all-student grade snapshots and run summaries.
- `grade_students`: per-student grade collection coverage.
- `grade_observations`: encrypted grade history with keyed-hash identity indexes.
- `grade_import_events`: append-only grade import audit.
- `canvas_assignment_runs`: encrypted Canvas snapshots and run summaries.
- `canvas_assignment_courses`: per-student/course coverage and encrypted scope metadata.
- `canvas_assignment_observations`: encrypted Canvas history with keyed-hash indexes.
- `canvas_course_mappings`: explicitly confirmed student/course scope references.
- `canvas_assignment_links`: confirmed one-to-one source-ID links and encrypted evidence.
- `canvas_audit_events`: append-only import and confirmation audit.
- `canvas_assignments`: stable, account/student/course-scoped Canvas identity index across observation runs.
- `skyward_assignments`: stable Skyward identity index, matching status/reason/attempts, and a unique nullable Canvas foreign key.
- `canvas_match_runs`: encrypted, append-only batch decisions with source-run references and matching policy.
- `review_profiles`: encrypted source checkpoints, scope baselines, and last-known review records.
- `review_events`: encrypted, append-only semantic and collection-health transitions.
- `review_evaluations`: encrypted, append-only priority/coverage snapshots with policy and evidence references.

Migrations 001 through 007 run transactionally. Existing version-1 through version-6 databases upgrade
on open after key verification. Unknown future schema versions are rejected.
Each run and its observations/audit event commit together. Foreign keys, WAL,
a 5-second busy timeout, and full synchronous durability are enabled.

SQLite is **not whole-database encrypted**. Sender, subject, body, displayed/read
status, source details, and other payload fields use AES-256-GCM with row identity
bound as authenticated data. Dates, IDs, run status, selection, and counts remain
plaintext for querying. The existing `playwright/.auth/messages.key` encrypts
payloads; no new key is silently generated by the storage layer. Losing it makes
both collected files and stored payloads unreadable. Wrong keys are rejected on open.

Assignment snapshots and observation payloads use the same encryption and key.
Student names and portal student/assignment IDs are encrypted; keyed hashes are
used for identity indexes. Assignment due dates, run timestamps/status, section
status, and student counts remain queryable metadata, not whole-volume encryption.

Grade snapshots use the same protection: student and grade identities, course
details, period labels, and marks are encrypted. Account aliases, run IDs,
timestamps/status, student counts, and keyed identity hashes remain plaintext
metadata. Online backups include grade history and audits.

Canvas names, IDs, instructions, exact dates, mappings, and matching evidence use
the same encrypted payload protection. Account aliases, run/link identifiers,
status/counts, timestamps, and keyed lookup hashes remain plaintext metadata.
Migration 006 backfills stable identities and existing confirmed links without
rewriting source payloads or hashes. Foreign keys and uniqueness constraints
enforce at most one Canvas record per Skyward assignment and vice versa, within
their stored account/student scope. Established links cannot be reassigned through
the application or identity-index updates; unmatched relationships remain nullable.
`SqliteCanvasStore` extends the existing storage implementation to share migrations,
transactions, authenticated encryption, and backups. It adds Canvas run/query APIs,
mapping/proposal/confirmation methods, `matchCanvasAssignments(accountId, options)`,
`getCanvasMatchRun`, and `listEnrichedAssignments`. The matcher accepts required
`lookbackDays`, optional `mappingId`, `dryRun`, `maxSourceAgeHours`, and an injectable
`now` for deterministic tests. `listAssignments` retains its pagination and source
data, with additional linkage and attempt metadata. Historical `getAssignmentRun`
snapshots are unchanged by matching.

Directories must be private (`0700`) and data files private (`0600`). These
controls do not protect against a compromised user account, privileged host
access, or theft of an unencrypted disk containing both key and ciphertext. The
planned encrypted volume is still required for production deployment.

`backup` creates a consistent SQLite online backup under `data/backups`, covering
all accounts, without overwriting existing backups. Message payloads remain
encrypted but query metadata does not; protect backup storage accordingly. Keep
a separately protected recovery copy of the key. Restore by opening a backup
with the same key, or stopping all database users before restoring it to the
configured database location. Never copy only a live database file and omit its WAL.

Backups and retention are manual at this stage. Do not remove original collected
files solely because an import command exited successfully; verify completeness
and recovery first and make an explicit retention decision.