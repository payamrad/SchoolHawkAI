# SchoolHawkAI Project Plan

Updated: 2026-10-25

Status: Local collection, storage, deterministic review, bounded briefings, and full current-student snapshots are implemented. Live portal compatibility, downstream summarization/delivery, and unattended-deployment acceptance gates remain to be verified.

An opt-in Azure Foundry agent interface now supports connection tests, full
student-report submission, and encrypted persistence of completed AI responses.
AI-output grounding, delivery, and the remaining Phase 6 acceptance gates are not
yet complete.

## 1. Purpose and Product Boundary

SchoolHawkAI is a private family school-monitoring system hosted on a Raspberry Pi. It collects information from authorized school and childcare accounts, detects meaningful changes, and produces evidence-backed briefings for Nicole, Zach, and Evander.

The governing principle is: **Playwright observes, application code determines changes, an approved summarizer explains, and the parent decides whether to act.**

The system will collect the following where the portal permits access and the collector can do so without unapproved side effects:

- Assignments, projects, submission status, and missing work.
- Grades and grade changes.
- Attendance and attendance exceptions.
- Teacher messages and announcements.
- Forms requiring attention, without submitting them.
- School and childcare dates, closures, and calendar changes.

The primary outputs are a daily family briefing, narrowly defined urgent alerts, and a CLI for status and evidence inspection. A private dashboard is optional and follows reliable collection.

Every actionable statement must identify the child where applicable, what changed, why it matters, relevant dates, source, collection time, and confidence. An incomplete collection must never produce an unqualified all-clear message.

### Non-Goals and Prohibited Actions

- No autonomous replies, acknowledgments, form submissions, uploads, or changes to portal records or preferences.
- No bypassing MFA, CAPTCHA, bot controls, or portal access policies.
- No model-controlled browsing, arbitrary shell execution, or self-expanded tool permissions.
- No public dashboard or unspecified third-party uploads of educational records.
- No simultaneous rollout of multiple unproven portal scrapers.

## 2. Architecture and Ownership

```text
Authorized portals / approved APIs / calendar feeds
                        |
             Deterministic collectors
                        |
           Portal-specific parsing and validation
                        |
           Normalized records + source evidence
                        |
                  Local SQLite
                        |
         Change detection and priority rules
                        |
          Minimized, validated briefing input
                        |
         Provider-neutral briefing-input contract
                        |
        Approved Azure API adapter / OpenClaw
                        |
      Daily briefing / urgent alerts / optional UI
```

Short-lived encrypted raw snapshots are an optional evidence branch, not a prerequisite for every collection. Prefer approved structured APIs, exports, and calendar feeds when they provide the required information with fewer side effects than browser navigation.

| Component | Responsibilities | Must not do |
| --- | --- | --- |
| Playwright collector | Session reuse, verified navigation, extraction, permitted downloads, failure evidence | Let the model choose clicks or expose unrestricted browser control |
| Portal adapters | Interpret portal-specific content and return typed results | Turn errors into empty datasets |
| Application core | Validation, identity, deduplication, dates, changes, priorities, retention, redaction | Depend on an LLM for correctness |
| Storage | Transactions, history, run status, provenance, encrypted evidence references | Silently replace good data with incomplete observations |
| OpenClaw | Restricted orchestration, grounded summaries, questions, approved delivery | Receive credentials, raw HTML, or arbitrary execution capabilities |
| Direct model adapter | Send approved minimized briefing input and return structured report data | Determine changes/priorities or obtain collector credentials |
| Parent | Authenticate, approve collection scope, verify claims, act in the portal | Delegate unrestricted account access to the model |

Separate collection, summarization, and notification permissions. The collector does not need model API credentials or notification credentials. Any summarization consumer receives only the operations and data needed for briefing. OpenClaw is optional; a direct Azure AI Foundry integration must use the same boundary.

## 3. Platform and Repository

### Raspberry Pi Baseline

- Raspberry Pi 5 with 8 GB RAM, active cooling, reliable power, and preferably a USB SSD.
- A Playwright-compatible 64-bit ARM Linux image; verify the exact OS release, Node version, and browser combination before building portal adapters.
- A supported Node.js LTS release and TypeScript with strict mode enabled.
- Wired networking where practical; optional UPS for storage integrity.

Use the Playwright-managed Chromium build if supported on the chosen image. A system Chromium executable is a fallback to investigate and test, not an assumed drop-in replacement. Record the working versions and launch options. Do not disable the browser sandbox as a routine compatibility fix.

### Technology Choices

| Concern | Choice |
| --- | --- |
| Runtime automation | `playwright` as a production dependency of the collector |
| Browser tests | `@playwright/test` as a development dependency |
| Unit and fixture tests | Vitest |
| Language and validation | TypeScript strict mode and Zod |
| Persistence | SQLite with migrations and transactions |
| Logging | Pino with allowlisted fields and redaction |
| Agent integration | Azure AI Foundry through a provider-neutral interface; OpenClaw remains optional |
| Scheduling | systemd timers as the initial single scheduling authority |
| Dependency management | npm workspaces with a root lockfile once the monorepo foundation is established |

Keep Playwright library and test-runner versions aligned. Validate SQLite driver availability on ARM64 before committing to a binding.

### Intended Layout

```text
SchoolHawkAI/
  apps/
    collector/
      src/
      tests/
    cli/
    dashboard/                 # Optional, after the core workflow is reliable
  packages/
    core/
      schemas/
      change-detection/
      prioritization/
      redaction/
    portals/
      <portal-id>/
    storage/
    briefing/
  openclaw/
    skills/school-review/
    prompts/
    policies/
  config/
    family.example.yaml
    portals.example.yaml
  playwright/.auth/            # Ignored local development state only
  data/                       # Ignored local development data only
  scripts/
  systemd/
  docs/
    source-inventory.md
    runbook.md
  .env.example
  .gitignore
  package.json
  package-lock.json
  ProjectPlan.md
  README.md
```

Create directories as their implementation begins, not as empty scaffolding. Preserve the existing collector package when introducing workspaces and consolidate lockfiles deliberately.

For the current standalone collector, run npm commands in `apps/collector`, never in `src`. Install `playwright` for runtime use and `@playwright/test` for tests. Once workspaces exist, install from the root with a workspace selector, such as `npm install playwright --workspace apps/collector`. Browser installation uses the correctly spelled command `npx playwright install chromium` from the collector package.

## 4. Security and Privacy Design

### Access and Read-Only Semantics

Use only legitimate parent accounts and approved access patterns. Document portal terms and available official integrations during discovery.

Read-only means no unapproved school-data changes, not simply no HTTP POST requests. Login and read APIs may use POST, while opening a message may mark it read or send a receipt. For each portal:

1. Inventory actions and their observable side effects, including message views and attachment previews.
2. Prefer metadata, previews, or official endpoints that do not acknowledge messages.
3. Exclude a section if it cannot be collected without a prohibited side effect; report that limitation explicitly.
4. Require an explicit scope decision before enabling a workflow that changes read state or sends a receipt. The default remains disabled.

Use deterministic action allowlists and exact destination allowlists, including required identity-provider redirects. Validate redirects and attachment destinations; do not follow arbitrary links from portal content. Method-based request blocking alone is not sufficient enforcement. Never replay unknown requests against a live school account to discover whether they mutate data.

### Authentication and Secrets

- Bootstrap authentication locally in a visible browser. The parent enters credentials, completes MFA and CAPTCHA, and confirms the expected account dashboard.
- Verify the authenticated dashboard before saving session state and verify it again when reusing state.
- Store passwords, API credentials, and encryption keys outside the repository. Do not pass them through model prompts or logs.
- Treat Playwright storage state as a credential. Store state files with mode `0600` in service-owned directories with mode `0700`.
- Use a dedicated unprivileged `schoolagent` service account for deployed collection.
- Use `/var/lib/schoolagent` for service data and a protected system credential mechanism or `/etc/schoolagent` configuration for secrets. A root-only environment file can be loaded by systemd; the application must not depend on reading it directly.
- On session expiry, stop that account's collection, retain last-known data, and request manual renewal. Do not retry authentication aggressively.
- Protect local interactive authentication separately from headless service operation; choose a secure desktop or local display workflow during the Pi spike.

The pipeline imports a private repository-root `.env` before actual execution,
or a selected `--env-file`, using dotenv parsing rather than shell evaluation.
Existing exported settings win. Help/dry-run do not read credentials; unsafe or
unsupported environment files stop execution before login. Only the matching
portal credentials reach each login subprocess, and Azure credentials are excluded
from the current collection/local-reporting commands. Scheduled-service secret
storage, run locking, and daily scheduling remain separate deployment work.

Before generating sensitive artifacts, ignore `.env` files except sanitized examples, `.auth` directories, local data, snapshots, screenshots, traces, downloads, database files including WAL/SHM files, and browser profiles. Ignore rules do not remove files already tracked by Git; verify tracked files as well.

### Encryption and Retention Decisions

- Filesystem permissions are access controls, not encryption, and do not protect a stolen unencrypted disk or a compromised service account.
- Encrypt raw snapshots, retained screenshots, and opted-in attachments using a maintained authenticated-encryption implementation. Keep keys outside the repository and separate from ciphertext backups.
- Store normalized SQLite data and session state on an encrypted data volume for deployment. Document how the volume is unlocked and the tradeoff between unattended reboot and physical-theft protection.
- Block unattended deployment until encryption and restart behavior are tested. Use synthetic data for initial development; real-data trials require the agreed protection controls first.
- Back up only necessary records using encrypted backups. Exclude sessions by default and require reauthentication after restore. Test key recovery without including plaintext keys in the same backup.
- Retain current normalized records while active, retain change history through the school year plus a configurable 90-day grace period, and default raw evidence retention to seven days.
- Keep screenshots and traces disabled by default except for bounded diagnostic capture. Attachments are opt-in with size limits, allowed types, and no automatic execution.
- Delete expired session state and expired evidence through audited retention jobs. Account for SQLite WAL files and backups; a logical delete is not a promise of physical secure erasure.

### Logs and External Services

Logs contain run IDs, portal IDs, section status, durations, and sanitized error codes. Do not log message bodies, child names, student IDs, passwords, cookies, tokens, authenticated URLs with sensitive queries, or full browser/network error dumps.

The implemented local diagnostics use private, Git-ignored `logs/` JSON-lines
files with allowlisted metadata, per-command/run correlation, bounded detail,
and seven-day retention. Persist recoverable record/scope failures as they occur,
including structural validation reasons, so troubleshooting does not require
repeating an entire collection. These logs are not raw source evidence.

External model use is opt-in and must name the provider and approved retention/privacy settings. Send only minimized normalized fields with pseudonymous child identifiers where possible. Keep evidence and identity mapping local. Notification channels must also be approved; prefer minimal alerts with a private local reference over complete educational records.

## 5. Domain Model and Identity

Define canonical Zod schemas and derive TypeScript types. Portal-specific HTML must not enter the reasoning layer.

Primary entities are `ChildProfile`, `Assignment`, `GradeRecord`, `Message`, `Announcement`, `AttendanceRecord`, `CalendarItem`, `AttachmentRef`, `ChangeEvent`, and `ActionCandidate`.

Use configurable internal child identifiers, not names embedded in algorithms. Every entity carries source metadata: portal, account scope, source URL, capture time, parser version, and optional evidence reference. Account scope must distinguish records collected through different accounts without storing credentials in identifiers.

Portal student IDs identify source records, not necessarily different children.
Review can opt in to conservative full-name matching within configured family
accounts, anchored by explicit child bindings. Normalize case, whitespace, and
name order; do not use first-name-only or fuzzy matching. Ambiguous names,
conflicting name history, and conflicting child rules remain qualified rather
than being silently merged. Preserve original source identities and history.

Important domain fields include:

- Assignments: title, course, assigned/due/submitted dates, explicit status, score, points possible, and teacher where available.
- Grades: course or assessment identity, numeric or textual grading scale, score, denominator, and source effective date.
- Messages: sender, subject, minimized body text, sent time, observed unread status, and opted-in attachment references.
- Attendance: local school date, explicit status, and minimized note.
- Calendar items: start/end, timezone or date-only representation, cancellation status, and source identity.
- Action candidates: type, reason, urgency, due date, source IDs, and confidence.

Preserve unknown values instead of inventing defaults. Do not confuse an ungraded assignment with a zero or assume all grade scales are percentages. Represent date-only deadlines as dates; retain source timezone and uncertainty instead of silently assigning midnight UTC.

### Stable Identity and Deduplication

Prefer a portal-provided persistent ID, scoped by portal, account, child where applicable, and record type. Keep mutable content separate from identity.

Do not include due date, score, status, unread state, or relative display text in an identity hash. A deadline change must update the same assignment rather than create an unrelated record.

Where source IDs are absent:

1. Use the strongest available stable source reference, such as a documented persistent record URL.
2. Generate and persist an internal ID on first observation.
3. Match later observations using conservative, portal-specific rules and stable context such as course and source position only where it is proven stable.
4. Treat title changes, duplicate titles, and ambiguous matches explicitly. Do not silently merge uncertain records or claim a verified change without a reliable match.

Hash canonical structured content separately to detect updates. Normalize irrelevant whitespace and presentation text without erasing meaningful distinctions. Cross-source deduplication links related records while preserving each source's provenance.

## 6. Collection and Adapter Contract

Each portal adapter verifies the session, discovers authorized children, and collects the agreed sections. Supported sections include assignments, grades, attendance, messages, announcements, calendar items, and optional attachments.

Each section returns a discriminated result with:

- Status: `complete`, `partial`, `failed`, `auth-required`, or `unsupported`.
- Portal, account, child where applicable, section, and capture time.
- Validated records and sanitized warnings or errors.
- Evidence for explicit emptiness, pagination completion, and relevant source metadata.

A `complete` result with zero records requires a positively verified empty state. Loading failures, missing selectors, inaccessible child data, and unfinished pagination are not empty results. Partial records may be retained as observations, but they do not replace a complete baseline or imply removals.

Process independent records and scopes after a recoverable parsing failure.
Preserve unknown optional values where the canonical schema permits them, skip
records whose identity or scope cannot be trusted, and log each failure with
bounded structural context. Do not abandon later valid rows because an earlier
row was invalid. Authentication, unsafe navigation, resource limits, and storage
integrity failures still stop the affected operation explicitly. Finishing this
best-effort work does not turn incomplete coverage into a `complete` result.

Distinguish unsupported sections agreed during setup from expected sections that unexpectedly fail. The run summary reports both coverage and failures, with per-account, per-child, and per-section status.

Prefer locators in this order: accessible role/name, form label, stable test identifier, stable semantic container or URL, CSS, and XPath only as a last resort. Avoid generated classes, positional selectors, and arbitrary sleeps. Verify navigation and loading completion explicitly.

Evidence should contain capture time, source reference, parser version, normalized content, and a hash of relevant canonical source content. Screenshots and raw HTML are exceptional, bounded, encrypted evidence. Sanitize stored URLs without losing the ability to navigate back to the source.

## 7. Storage and Change Detection

Use SQLite migrations and transactions. Proposed tables:

`children`, `portal_accounts`, `collection_runs`, `section_observations`, `source_documents`, `assignments`, `grade_records`, `messages`, `announcements`, `attendance_records`, `calendar_items`, `change_events`, `action_candidates`, `briefings`, `notification_deliveries`, and `audit_events`.

Domain records need internal ID, source ID where available, child/account/portal scope, first and last seen times, source update time, content hash, parser version, active status, and evidence references. Keep observation history sufficient to explain reported changes.

Maintain the last successful complete baseline per account, child, and section. A failed message collection must not block a successful assignment section from advancing, and must not make old messages disappear.

### Deterministic Events

- Assignment added, deadline changed, submission status changed, or newly missing.
- Grade added or changed, with grading-scale-aware comparisons.
- Message added or observed read status changed, only through approved observation paths.
- Attendance exception added or changed.
- Announcement or form added or meaningfully updated.
- Calendar event added, rescheduled, or canceled.
- Session expired, section inaccessible, collection failed, or coverage reduced.

The first successful collection establishes a baseline. Existing items are labeled first observed, not falsely described as newly posted. Current urgent deadlines can still trigger attention rules during bootstrap.

Never infer deletion from a failed or partial observation. Default removal confirmation to two consecutive complete observations within the same scope, unless an explicit portal deletion/cancellation is available. Make this threshold configurable and test it against pagination and filtering behavior.

Use transactions and unique event/delivery keys so re-running a job does not duplicate changes or alerts. Use a transactional notification outbox and record delivery attempts. Provider failures can leave delivery uncertain; document retry behavior rather than promising exactly-once external delivery where the provider cannot support it.

Keep audit events append-only through the application API, with restricted access and backup coverage. This is not tamper-proof against a privileged host administrator.

## 8. Priorities, Briefings, and Agent Boundary

### Deterministic Priority Rules

Configure rules per child and source, using the household and source timezones explicitly.

| Condition | Default handling |
| --- | --- |
| Collector failure or unexpected loss of coverage | Prominent operational warning; urgent after configured retry/failure threshold |
| Confirmed school/childcare closure or same-day schedule change | Urgent alert when relevant to the family |
| Newly detected attendance exception | High priority; urgent delivery subject to approved rules |
| Deadline within 24 hours | High priority; immediate alert only when newly discovered in the urgent window |
| Missing assignment | High priority in daily briefing |
| Deadline within seven days | Normal priority in daily briefing |
| New unread message | Normal priority unless a validated urgent rule applies |
| Ordinary grade change | Daily briefing, not an automatic immediate alert |

An ordinary event occurring today is not inherently critical. Optional activities and routine calendar entries must not create urgent-alert noise. Interpret a teacher request as urgent only through explicit source signals or validated deterministic rules; AI interpretation alone is not an urgent trigger.

### Briefing Products

The daily briefing covers due-today and upcoming work, missing work, new messages, grade and attendance changes, closures, forms, and collection health. Distinguish newly detected changes from previously known open items. Say "No material changes" only for the successfully checked scope, and state missing coverage prominently.

Each actionable item includes what changed, why it matters, due date if known, child, source link, capture time, and confidence. Separate extraction confidence from interpretive confidence. Uncertain dates and stale data must be visible.

Urgent notifications use configurable quiet-hour exceptions, deduplication, and rate limits. Authentication alerts should be actionable and avoid repeatedly notifying the parent about the same expired session.

Provide a deterministic template-based briefing when the model is offline. Collection, changes, priority rules, and approved urgent notifications must continue without an LLM.

### Provider-Neutral Briefing Input (Implemented Local Slice)

The deterministic review engine and briefing-input builder have no model/provider
dependency. Local `Review` commands process stored Skyward/Canvas assignments,
Skyward grades/messages, and collection health. Explicit configuration supplies
account scope, child bindings, rules, and payload limits.
Opt-in `unique-full-name` student matching reconciles cross-portal identities
before change rules and priorities are evaluated. Persist the resolved bindings
with each encrypted evaluation so bounded briefings and full snapshots agree on
the children. Changing configured bindings or matching mode requires a new review
profile; automatically recognizing a newly collected portal identity does not
reset source-record baselines. Existing profiles and audit history are retained.

Migration 007 persists encrypted checkpoints, idempotent immutable events, and
evaluation snapshots transactionally. First processing establishes baselines rather
than announcing historical changes as new. Complete sections advance independently;
partial scopes, filtering, period changes, and ambiguous identities cannot establish
false removals. Late observations are reported and do not rewind current state.

The `@schoolhawk/briefing` contract exposes pseudonymous children, opaque locally
resolvable evidence references, minimized facts, deterministic priorities, and
coverage/uncertainty metadata. Default limits are 40 items and 32,768 UTF-8 JSON
bytes, with explicit omission counts and no unqualified all-clear on incomplete
or truncated input. It also supports deterministic local text output.

This implements the local change/priority and structured-input stages only.
Attendance/calendar/form collection, semantic urgency from teacher text,
report grounding, scheduling, and email/SMS delivery remain outside this
slice. The separate opt-in Foundry client can submit full student snapshots.
Immediate-delivery eligibility is opt-in and sends nothing.
Review audit history has no automatic retention/deletion job yet.

See [README.md](README.md#deterministic-review-and-briefing-input) for commands,
configuration, supported comparisons, privacy limits, and recovery semantics.

### Full Current-Student Snapshot (Implemented Local Slice)

For a reporting agent without memory, provide a separate full snapshot rather than
only recent/high-priority changes. Treat the retained database as one school year;
no explicit school-year start date is required, and report generation never
performs the operator's annual database reset. Retain all grade history, with
configurable 60-day past-assignment details and 14-day recent-message defaults.

The snapshot includes recent assignments and all grades by student/course,
including unchanged and already-graded work. Preserve older assessment grades as
compact histories without full old assignment details. Upcoming, missing, undated,
and confirmed-linked assignment context remains visible. Messages qualify when
recently sent, newly observed, or recently changed beyond read state; older unread
messages alone do not qualify. Preserve full text/history for selected messages and
report exclusions explicitly. Include resolved child identities, explicit course mappings, confirmed
assignment links, source references, effective rules, and current collection health.
Unknown marks, incomplete observations, stale data, and ambiguous identities remain
qualified. Do not infer assignment completion or student well-being from missing
data or source marks alone.

Expose this as `Review snapshot` and the pipeline's
`--report-type student-snapshot` reporting option. The bounded daily briefing
remains available separately. Full snapshots do not apply its 40-item / 32 KiB cap:
resource limits fail explicitly rather than silently omitting school records.
Any future model adapter must partition oversized input without assuming memory
or hiding missing context. The snapshot is private model input, not a generated
AI assessment; external transmission, AI-output validation/storage, and delivery
are still separate stages.

### Optional OpenClaw Integration

Expose a narrow `school-review` skill with schema-validated operations: `collect`, `status`, `changes`, `briefing`, `child-summary`, `upcoming`, and `explain-source`.

The `collect` operation invokes only the predefined collector with allowlisted portal/child selections, bounded timeouts, and a shared run lock. It does not accept command strings, arbitrary URLs, filesystem paths, or browser instructions. Other operations query normalized local records or redacted evidence.

Agent policy must require source-backed claims, clear incomplete-collection warnings, and no invented grades, dates, statuses, or teacher requests. Do not expose prohibited operations such as replies, form submission, uploads, preference changes, or message deletion.

Treat all portal content as untrusted data. Keep it out of system instructions, discard scripts, bound field lengths, validate tool arguments, and restrict outbound destinations. Validate model output against a structured briefing schema and known source IDs; fall back to a deterministic briefing if validation fails. Prompt wording alone is not a security boundary.

Verify the chosen OpenClaw version can enforce the required tool and execution restrictions. Do not proceed with integration if the school-review agent retains unrestricted shell or browser access.

## 9. Phased Delivery and Acceptance Gates

### Phase 0: Discovery and Browser Feasibility

- Inventory portal URLs, account scope, children, authentication/MFA, relevant sections, official APIs/feeds/exports, and automation policies in `docs/source-inventory.md`.
- Document the parent's current review workflow and rank information by importance.
- Identify message-read, receipt, and attachment side effects before live collection.
- Produce sanitized or synthetic development fixtures and choose one MVP portal.
- Run Chromium on the exact Pi image, load a harmless public page, and verify a known element.
- After session-file protections are in place, navigate to the selected sign-in page, complete manual authentication, save state, and prove reuse in a fresh context.

Exit gate: repeatable browser launch and extraction on ARM64; manual MFA works; session reuse works; selected portal access is permitted; known side effects and MVP scope are documented. Do not build full adapters before this gate passes.

### Phase 1: Repository and Security Foundation

- Introduce npm workspaces while preserving current collector work.
- Enable strict TypeScript, linting, formatting, unit tests, and synthetic fixture checks in CI.
- Add ignore rules, sanitized configuration examples, redacted structured logging, and an append-only audit interface.
- Establish the service account, protected paths, encrypted storage/evidence, backup policy, and key recovery procedure.
- Define canonical schemas, section result types, identity rules, and configuration validation.

Exit gate: no tracked secrets or session artifacts; private directory/file permissions verified; redaction tests pass; service runs without root; protection and retention choices are implemented before real-data trials.

### Phase 2: First Portal Adapter

Implement in order: dashboard/session detection, child enumeration, assignments, approved message/announcement collection, grades, attendance, calendar, then optional attachments.

Exit gate: all agreed MVP sections return validated typed results; unchanged runs produce stable records; explicit-empty and error states differ; child/account isolation and pagination are tested; every item has provenance; excluded side-effecting workflows remain disabled.

### Phase 3: Persistent History and Evidence

- Add SQLite migrations and complete section baselines, observation history, and source/evidence references.
- Implement transactional ingestion, retention, bounded evidence capture, and local inspection commands.
- Test encrypted backup and restore, including key availability and database consistency.

Exit gate: retries are idempotent; partial runs cannot erase known records; restore recovers records and provenance; evidence expiration does not break the meaning of retained changes.

### Phase 4: Change Engine

Implement identity matching, semantic comparison, baseline behavior, removal confirmation, and cross-source deduplication using fixtures only.

Exit gate: all defined events are detected without an LLM; a changed due date remains the same assignment; ambiguous matches are surfaced; failed observations cause no false removals; no-change runs create no false events.

### Phase 5: Priorities and Deterministic Briefing

Implement configurable deadlines, timezone handling, urgency rules, template briefings, and notification outbox/deduplication.

Exit gate: stale and incomplete scopes are clear; routine items do not trigger urgent noise; first-run items are described accurately; deterministic outputs work without a model.

### Phase 6: Approved Summarization Adapter

Implement a direct Azure AI Foundry adapter or the optional narrow OpenClaw skill against the provider-neutral input contract. Add a source-grounded report schema, output validation/storage, injection tests, and model-outage fallback. Approve the external provider and delivery channel before sending real records.

Implemented transport slice: `StudentReportAgent.testConnection()` and
`analyzeStudentReport(report)`, the Azure Foundry Responses adapter, and explicit
`Agent test` / `Agent analyze` CLI commands. The adapter preserves the configured
agent system prompt, sends complete validated snapshots as untrusted user data,
and makes stateless requests without client tools. Credentials and model content
are excluded from diagnostics; timeouts, HTTP failures, refusals, and oversized
or incomplete replies fail explicitly. Migration 008 stores completed analyses
and provenance transactionally as encrypted, append-only `agent_reports`.
`Agent analyze` requires local storage before contacting the model and commits the
response before reporting success; `Agent reports` and `Agent report` inspect
saved results without model credentials. Duplicate response saves are idempotent,
and storage failures remain explicit. This is not yet source-grounded validation
of AI conclusions, context-aware partitioning, or delivery.

Exit gate: agent cannot obtain secrets, browse arbitrarily, run arbitrary commands, or mutate portal data; actionable claims reference known evidence; model failures do not break collection or deterministic alerts.

### Phase 7: Deployment and Operations

Install hardened systemd services/timers, health reporting, encrypted backups, retention jobs, and the manual reauthentication runbook. Select delivery time based on the household routine.

Exit gate: reboot/unlock behavior is documented and tested; exactly one scheduler is active; overlapping runs are prevented; health and authentication alerts reach the approved destination; backup recovery has been exercised.

### Phase 8: Observation and Second Portal

Run the MVP for at least two weeks, inspect discrepancies, tune priorities, and validate failure recovery. Add a second portal only after the first portal's acceptance gates hold. Reuse contracts, not unverified locator assumptions.

Exit gate: two weeks without duplicate or unexplained alerts, misleading all-clear reports, or unapproved state-changing operations.

## 10. Verification Strategy

### Unit and Fixture Tests

Test schema validation, date-only and timezone handling including DST, stable identity, mutable titles/deadlines, grading scales, deduplication, change detection, priority rules, redaction, retention, and digest rendering.

Each adapter needs sanitized fixtures for normal records, verified empty state, loading/incomplete pages, pagination, session expiry, permission denial, maintenance, errors, redesign, and partial child coverage. Never commit live student HTML as a fixture.

### Integration and End-to-End Tests

Cover new assignments, changed deadlines, grade changes, messages, canceled events, duplicate announcements across sources, incomplete collection, expired authentication, schema-invalid records, portal prompt injection, model outage, and notification retries.

Also test crashes during ingestion, database locking, insufficient disk space, missing encryption keys, evidence retention, backup restore, and overlapping scheduled/manual jobs. Ensure exceptions do not leak sensitive content into logs or traces.

### Live Smoke Tests

Keep live checks minimal and explicitly enabled: valid session, expected dashboard, authorized child scope, stable navigation, and one approved section. Do not run live portal tests in public CI or use them to experiment with mutations. Limit retries and navigation frequency according to source policy.

Required merge checks for implemented slices are typecheck, lint, focused unit/fixture tests, and relevant browser tests. Document unavailable ARM or live checks rather than marking them passed.

## 11. Deployment and Resource Management

Use separate collector, digest, healthcheck, and optional dashboard services. Run as unprivileged users with only required credentials and filesystem access. Apply `NoNewPrivileges`, private temporary storage, read-only system paths, and bounded writable paths; test hardening against Chromium sandbox and cache requirements on the actual Pi.

Use systemd timers initially. OpenClaw may request a bounded manual collection through the same run lock, but must not add an independent periodic schedule. A future scheduler migration disables the old schedule first.

- Run one browser and one portal at a time initially.
- Reuse the browser within a job, but use a fresh context per portal account.
- Close pages and contexts deterministically, including on failure.
- Apply bounded navigation timeouts and retries; distinguish transient failures from expired sessions.
- Block unnecessary resources only after proving that portal behavior is unaffected.
- Limit evidence volume, browser cache growth, and total run duration.
- Avoid heavyweight local inference alongside Chromium during initial deployment.
- Bind any dashboard to localhost by default; use authenticated private access if remote access is needed.

Health reporting includes last successful and last complete runs, per-portal and per-section health, authentication status, parser warnings, stale data age, disk space, memory pressure, notification status, backup age, and application/parser versions.

The runbook must cover authentication renewal, portal redesign, disk pressure, model outage, lost credentials, encryption-key recovery, backup restore, upgrades, and rollback. Pin reproducible dependencies and rerun fixtures and Pi smoke checks when upgrading Playwright or Chromium.

## 12. Suggested Schedule and Ordered Backlog

The schedule is indicative, not a substitute for acceptance gates. Portal authentication, access limitations, and ARM compatibility may change estimates.

| Time | Focus |
| --- | --- |
| Week 1 | Source inventory, read-side-effect review, Pi Chromium spike, manual authentication |
| Week 2 | Monorepo, security controls, schemas, storage foundation, fixture infrastructure |
| Weeks 3-4 | First adapter, source evidence, persistent history, backup validation |
| Week 5 | Change detection, identity edge cases, priorities, deterministic briefing |
| Week 6 | Azure Foundry agent integration, approved delivery, injection and outage testing |
| Week 7 | systemd deployment, monitoring, recovery procedures |
| Week 8 onward | At least two weeks of observation; second portal only after stability |

Ordered starting backlog:

1. `SPIKE-001`: Launch Chromium on Pi ARM64 and extract a harmless known element.
2. `DISC-001`: Inventory sources, permitted access, read side effects, and MVP scope.
3. `SEC-001`: Protect session artifacts and establish ignore rules before authentication.
4. `SPIKE-002`: Complete manual login, verify dashboard, and reuse protected session state.
5. `FOUND-001`: Establish npm workspaces, strict TypeScript, linting, and fixture tests.
6. `SEC-002`: Create service identity, encrypted storage/evidence, redaction, and retention controls.
7. `CORE-001`: Define canonical schemas, section completeness, and stable identity contracts.
8. `DB-001`: Implement SQLite migrations, observation history, and transactional ingestion.
9. `PORTAL-001`: Verify authenticated dashboard and authorized child enumeration.
10. `PORTAL-002`: Extract assignments with pagination and explicit-empty verification.
11. `PORTAL-003`: Extract approved messages and announcements without prohibited side effects.
12. `PORTAL-004`: Extract grades, attendance, and calendar items.
13. `EVIDENCE-001`: Capture provenance and bounded encrypted failure evidence.
14. `CHANGE-001`: Implement persistent identity matching and mutable-deadline/title tests.
15. `CHANGE-002`: Detect assignment, grade, message, attendance, and schedule changes.
16. `CHANGE-003`: Enforce incomplete-run safety, first-run semantics, and removal confirmation.
17. `RULES-001`: Implement deterministic priorities and template-based briefings.
18. `NOTIFY-001`: Implement approved delivery, outbox retries, deduplication, and rate limits.
19. `AGENT-001`: Build and verify the provider-neutral agent interface and Azure Foundry adapter.
20. `AGENT-002`: Add minimized evidence-backed summaries, output validation, and fallback.
21. `OPS-001`: Deploy hardened services, single scheduler, and shared run lock.
22. `OPS-002`: Verify health alerts, retention, authentication renewal, and encrypted restore.
23. `TEST-001`: Complete two-week observation and document remaining source limitations.

## 13. Version 1 Definition of Done

- One school portal supports all agreed MVP sections and all authorized children in that portal; any unavailable section is explicitly agreed and documented as a scope change.
- Assignments, grades, approved messages, announcements, attendance, and dates are normalized with provenance.
- Daily collection is unattended while sessions remain valid; MFA renewal remains manual and understandable.
- Changes compare against successful complete baselines at the correct section scope.
- Deadline changes do not create false new assignments; ambiguous identities remain visible.
- New versus first-observed versus previously known items are distinguished.
- Every actionable claim has a valid source reference, capture time, and appropriate confidence.
- Partial failures and stale data never produce an unqualified all-clear report.
- No prohibited state-changing operation is available to the collector or agent.
- The summarization adapter has minimized, restricted access; OpenClaw, if used, cannot initiate arbitrary browsing or shell execution.
- Collection, deterministic changes, and approved rule-based alerts work when the model is unavailable.
- Secrets and real student artifacts are absent from Git; permissions, encryption, redaction, and retention controls are verified.
- Backup and restore, authentication expiry, and portal-layout failures have been tested.
- Two weeks of observation show no duplicate or unexplained alerts, with discrepancies investigated and documented.

## 14. Decisions Required During Discovery

These are implementation inputs, not permission for the system to guess or expand its scope:

- Exact Pi OS release, display availability for manual login, and supported browser/runtime versions.
- First portal, approved account scope, permitted automation, and any message-read side effects.
- Household timezone, source timezones, briefing time, urgency thresholds, and quiet hours.
- Encrypted-volume unlock method, recovery-key custody, and backup destination.
- Whether to use an external model at all, and the approved provider, data fields, and retention terms.
- Approved notification channel and how much educational information may leave the Pi.

Until these decisions are made, use synthetic data, local deterministic output, and the smallest verified collection scope.