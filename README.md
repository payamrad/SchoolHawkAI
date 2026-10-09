# SchoolHawkAI

Read-only family school collection and local storage. See [ProjectPlan.md](ProjectPlan.md)
for the architecture and staged delivery plan.

## Workspace Layout

- `apps/collector`: Skyward messages/assignments/grades, Canvas assignments, and protected portal login.
- `apps/cli`: user-facing `Messages` and `Truncate` commands; provisional storage utilities also remain here.
- `packages/core/schemas`: Zod schemas and shared TypeScript message, assignment, grade, and run types.
- `packages/storage`: persistence interfaces, SQLite implementation, migrations,
  encryption helpers, and Vitest tests.
- `config`: public portal URLs.
- `data`: ignored encrypted collection results and private SQLite data.
- `playwright/.auth`: ignored browser state and encryption key.

Only currently needed parts of the planned structure exist. Additional portal,
briefing, and dashboard packages will be created when implemented.

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
run health before treating them as current. No grade-change events or alerts
are generated yet.

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

The schema supports Skyward messages, student-scoped assignments, and course
grade snapshots. Mapping portal students to household profiles, change events,
and prioritization are not implemented yet.

The same `SqliteMessageStore` also implements `AssignmentStore`, with
`importAssignmentRun`, `getAssignmentRun`, `listAssignmentRuns`, and
`listAssignments`. Existing message APIs are unchanged. `listAssignments` accepts
an optional portal `studentId` and a bounded `limit` (1-1000, default 100). It
deduplicates by account, student, and assignment ID using complete section
observations, including complete sections from otherwise partial runs.
`getAssignmentRun` returns the full validated snapshot with all student coverage.
Stored assignments are last-observed records, not a claim about current portal
state; consult run coverage and observation timestamps. No removals or semantic
change events are inferred.

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

Migrations 001 through 006 run transactionally. Existing version-1 through version-5 databases upgrade
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