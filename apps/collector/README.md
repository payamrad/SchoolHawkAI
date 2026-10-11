# Collector

Install dependencies from the repository root using the workspace lockfile (see
the root README). From this directory, install the browser with
`npx playwright install chromium`.

## Skyward Login

In your own Bash terminal, enter credentials without putting them in shell history:

```bash
read -r -p 'Skyward username: ' SKYWARD_USERNAME
read -r -s -p 'Skyward password: ' SKYWARD_PASSWORD
printf '\n'
export SKYWARD_USERNAME SKYWARD_PASSWORD
npm run skyward:login
unset SKYWARD_USERNAME SKYWARD_PASSWORD
```

Do not enter credentials into chat or commit them. Environment variables are not
encrypted storage; for scheduled operation use a protected service credential
mechanism. This bootstrap script performs one login attempt, not a retry loop.

The script uses the district's public parent login form, verifies a visible sign-out
link or button on a same-origin page outside the login service, then proves session
reuse in a fresh browser context. Only then does it atomically save state to the
repository's ignored `playwright/.auth/skyward.json` with mode `0600`, inside a
directory restricted to `0700`. Existing saved state is not replaced on failure.

The saved JSON also includes `entryUrl`, the exact verified application landing
URL. Its query parameters can be session-sensitive, so do not share it. The
messages collector resumes that URL before following the portal's My Messages
link; opening the inbox directly without application initialization did not work
with the tested session.

If the dashboard's sign-out control is hidden or named differently, set `SKYWARD_SUCCESS_SELECTOR` to
a verified CSS selector unique to the authenticated dashboard. Do not choose a
generic body element or a marker visible on an MFA page. An unexpected destination
or missing marker fails closed; a redirect alone is never treated as success.

MFA or CAPTCHA may require manual completion. On a desktop, `SKYWARD_HEADED=1`
opens a visible browser, but the confirmation timeout is still 30 seconds. This
script does not bypass challenges. Protected state enables later scheduled
collectors to reuse a session while valid; scheduling is not yet implemented.
No student information, screenshots, or raw errors are logged.

Run `npm run typecheck` and `npm test` to check the implementation. Browser tests
intercept all requests and use synthetic pages; they do not contact the portal or
verify your real credentials.

## Canvas Login

The Canvas local-login URL is https://lwsd414.instructure.com/login/canvas.
For manual login on a local desktop, leave both `CANVAS_USERNAME` and
`CANVAS_PASSWORD` unset and run:

```bash
CANVAS_HEADED=1 npm run canvas:login
```

Enter credentials and complete any MFA/CAPTCHA in the browser. The script waits
up to 120 seconds; it does not bypass challenges or retry authentication. This
mode needs a desktop/display and must be run in your own terminal.

For one automatic attempt, use the same environment-variable pattern as Skyward:

```bash
read -r -p 'Canvas login: ' CANVAS_USERNAME
read -r -s -p 'Canvas password: ' CANVAS_PASSWORD
printf '\n'
export CANVAS_USERNAME CANVAS_PASSWORD
npm run canvas:login
unset CANVAS_USERNAME CANVAS_PASSWORD
```

Use the login identifier accepted by the district's Canvas form. The form labels
are `Login` and `Password`, with a `Log In` button; the collector does not change
Remember me. Add `CANVAS_HEADED=1` to the login command if manual verification
is needed after the single automatic attempt. Headless confirmation is bounded
to 30 seconds. A partial credential configuration is rejected before browser
launch rather than guessing or falling back to another portal's credentials.

The verifier requires Canvas's Account control in Global Navigation and the
Dashboard heading, on the configured Canvas origin and outside the login service.
Password/one-time-code forms are not accepted as success. A verified alternative
dashboard marker can be supplied through `CANVAS_SUCCESS_SELECTOR`; never use a
generic body element or a marker present during authentication. Unexpected form
destinations are rejected before credentials are filled. Canvas login and its
fresh-context verification allow the exact HTTPS SSO origin
`https://sso.canvaslms.com`, configured in `canvas.authenticationOrigins` in
`config/portals.json`. Canvas uses this handoff after the district login form;
blocking it prevents headless login from reaching the dashboard. Other origins
remain blocked for navigation and credential posts. Success still requires the
district Canvas origin, not an SSO page. Collection requests do not receive this
authentication exception. Redirects alone never prove success.

Failed automatic login reports a specific `CONFIRMATION` code and a bounded
`CANVAS_CONNECTION` diagnostic with request counts, HTTP status, destination
hostname, and connection error code when available. No credential values,
response bodies, full URLs, or query strings are printed. This distinguishes
rejected login, manual challenges, connection failures, and changed page markers
without weakening authentication checks or automatically retrying credentials.

After confirming login, a fresh context must also verify the captured session.
Only then is `playwright/.auth/canvas.json` replaced atomically, with mode `0600`
inside a `0700` directory. Its cookies, storage, and `entryUrl` are credentials:
keep the file private and out of Git/logs. Canvas login does not read or overwrite
`skyward.json`, `messages.key`, or the database. Session creation does not require
database setup. On any login/reuse failure, existing saved state is retained.

The public form and authenticated Canvas dashboard selectors were verified in
the browser. Credential submission, fresh-context reuse, isolation, and protected
file persistence are covered by synthetic tests; the new CLI's full live login
and saved-session reuse still require the parent's local run. This command adds
authentication only; assignment collection is a separate command below.
The exported `loginCanvas()` function runs the same protected workflow as the command.

## Collect Canvas Assignments

```bash
npm run canvas:assignments -- --account canvas-parent
```

This collects full snapshots for active courses of every account-linked observee.
It does not accept a day count, so older assignments can refresh their instructions
and confirmed links. One-off course-level observer relationships and archived
courses are outside this collection scope. Existing database setup, original
encryption key, and a valid protected Canvas session are required.

The collector uses only these documented API GET paths:

- `/api/v1/users/self/observees`
- `/api/v1/users/<observed-student-id>/courses?enrollment_state=active`
- `/api/v1/users/<observed-student-id>/courses/<course-id>/assignments`

Student-specific lists provide the assignment dates in the observed student's
context. Every response is validated. Link-header pagination cannot change origin,
path, student/course identity, or filters. Unknown parameters, redirects, duplicate
IDs, cycles, oversized responses, and incomplete pages fail closed. Requests are
sequential: at most 50 pages per list, 500 requests and five minutes per run,
20 MB per response, 100 students, and 200 courses per student. Individual requests
default to 15 seconds. Authentication failures and rate limiting halt remaining
requests without retrying login or bypassing permissions.

Descriptions are converted to plain text with `html-to-text`; scripts, forms,
iframes, image sources, and link URLs are not retained as executable content.
No dashboard completion toggles, file downloads, external-tool launches, replies,
or submissions are performed. A description unavailable to this account remains
null; the collector does not claim to have read hidden external-tool content.
Precise timestamps and Pacific date-only values are both retained. Canvas points
and submission types are source-specific and never become Skyward grades/status.

Every course has explicit complete/partial/failed/auth-required coverage, page and
record counts, and verified-empty evidence. Good course observations can advance
independently of failures elsewhere. Partial records remain inspectable through
run queries but cannot overwrite the current complete view. An empty collection
never erases known data. Collection/import retries are idempotent by run ID;
fresh runs intentionally retain additional historical observations.

Use the root CLI's `Canvas scopes` and `Canvas map` actions to confirm the
student/course scope before correlating records. Batch linking then runs locally:

```bash
npm run canvas:match -- --account canvas-parent --lookback 30 --dry-run
npm run canvas:match -- --account canvas-parent --lookback 30 --yes
```

The shortcut works from the repository root or this collector directory and
delegates to the existing CLI implementation. Confirmed student/course mappings
are reused; they do not need to be entered again on each run.

The inclusive Pacific-date lookback applies to Skyward due dates through today
(1-366 days). Future and undated records are skipped. Existing links are never
reassigned; unlinked results are retried on later calls while in the window.
Only unique title/lesson-code plus same-date candidates link automatically.
Embedded Algebra lesson codes and Science TLAS/I2C codes are recognized; date
disagreements, combined/duplicate candidates, missing coverage, and stale records
stay unlinked. All candidate competitors are examined before window filtering.

The default source freshness limit is 48 hours, configurable from 1-168 using
`--max-source-age-hours`. Both sources must have complete relevant scopes, and
the Skyward record must appear in its latest observation. Collect before matching;
the command does not log in, fetch data, or schedule itself. Optional `--mapping`
restricts the batch to one already-confirmed course. Dry runs make no status/link
writes, but opening storage can apply migrations. Without `--yes`, writes require
an interactive confirmation. Individual `Canvas matches`/`Canvas confirm` workflows
remain available for explicit review.

Migration 006 adds stable identity indexes, a unique nullable Canvas foreign key
on Skyward assignments, and `pending`/`unmatched`/`review-required`/`linked` statuses.
Attempt counts/reasons and encrypted batch audit records explain deferred matches.
Links, statuses, and audit commit atomically, preserving all source history.
`npm run cli -- Assignments --account <skyward-alias>` returns source-separated
Canvas enrichment, source-specific freshness, and explicit due-date/point conflicts.
It never replaces Skyward grades or missing status with Canvas values. See the root
[README](../../README.md#canvas-assignments-and-correlation) for the full workflow.

## Shared Collector Code

- `src/skyward.ts`: Skyward compatibility wrappers, timezone/date windows,
	student names/IDs, and browse-registration parsing.
- `src/portal-collection.ts`: portal-specific saved-session validation and shared
	one-browser lifecycle, using the storage package's private database/key preflight.
- `src/portal-session.ts`: login settings, bounded browser lifecycle, safe
	diagnostics, fresh-context reuse checks, and atomic private session saving.
- `src/skyward-login.ts` and `src/canvas-login.ts`: portal-specific form and
	authenticated-page checks; Canvas and Skyward states are never interchanged.
- `src/skyward-messages.ts`, `src/skyward-assignments.ts`, and
	`src/skyward-grades.ts`: section-specific extraction and command options.
- `src/canvas-assignments.ts`: bounded Canvas API pagination and assignment normalization.

Existing command names and helper exports remain available. All Skyward commands
require an existing private database and original key before opening a browser.
The refactor does not change deduplication, observation history, unread selection,
assignment lookback, or the pending live compatibility verification for grades.
In particular, short lookbacks can still miss corrections to older past work;
use a wider explicit window for recovery. Canvas login is not a new scheduler or
collector, and it has no database dependency.

### Best-Effort Collection and Persistent Logs

Collectors isolate recoverable parsing failures to the affected record or scope
and continue with the remaining verified data. A malformed row, an unknown
optional field, or one unbound student response must not discard independent
valid observations. Identity and scope are never guessed to make a run pass.
Incomplete scopes remain partial/failed, and the command still exits nonzero
when expected coverage could not be verified. Authentication, unsafe navigation,
resource limits, and storage failures remain explicit stopping conditions.

Each command prints the path of its private `logs/<date>-<operation-id>.jsonl`
diagnostic file. It records processing stages, run IDs, fixed rejection codes,
record/student/course ordinals, and structural counts without storing school
content, credentials, raw responses, or raw exception dumps. Warnings/errors
are flushed as they occur, so a later failure does not erase the diagnostic
trail. See the root [logging documentation](../../README.md#fault-tolerance-and-local-diagnostics)
for permissions, retention, bounded detail, and programmatic use. These logs
apply to future executions; they cannot reconstruct errors from older runs.

## Collect Messages for N Days

```bash
npm run skyward:messages -- 7 --account lkwash-parent
```

By default, only messages observed as unread in the requested date window are
opened and collected. To include read messages as well:

```bash
npm run skyward:messages -- 7 --account lkwash-parent --all
```

Both modes scan list metadata for date coverage; `--all` does not remove the
date limit. The output summary and stored run include `selection` (`unread`
or `all`). Older saved runs without this field used all-message collection.
A complete unread-only run with zero messages means no matching unread messages
were found, not that the inbox contains no messages.

N is an integer from 1 to 366. It includes today and the preceding N-1 calendar
days in `America/Los_Angeles`, not the previous N times 24 hours. For example,
on September 13, 2026, N=7 covers September 7 through September 13 inclusive.
The run records its start time; messages arriving after collection starts are
not guaranteed to be included until the next run.

This collector opens messages, with the parent's explicit approval that doing so
may mark them read or send receipts. Desktop preview behavior may also change
read status. It does not reply, delete, submit forms, or download attachments.
Use only with accounts where those read side effects are approved.

Unread-only selection does not preserve unread status: opening an unread message
can mark it read. Automatic previews may also change status before it is observed.
Messages read manually are skipped, and if a run fails after opening a message
but before saving, an unread-only retry may miss it. Use `--all` to recover such
messages. Unread status is not a durable ingestion checkpoint; future reliable
scheduled ingestion should track collected message IDs independently in SQLite.

The browser has its own 1440x1000 viewport, independent of your display. The
collector selects each matching message and waits for the preview's record ID
to match before reading its body. It collects portal ID, sender, subject,
displayed date, normalized local date, read status observed before selection,
body text, and source metadata. It does not infer a child from message text.

The tested Skyward list is newest-first, with DD/MM/YYYY dates and time-only
labels for today. The collector verifies descending dates in loaded rows,
deduplicates by portal message ID, and scrolls as necessary until it crosses the
requested date boundary. It stops after at most 50 batches. Unknown dates,
out-of-order records, mismatched previews, or stalled pagination produce a
failed/partial result and nonzero exit status, not an all-clear report.

There is not yet a verified end-of-inbox or explicit-empty selector. Consequently,
a genuinely empty inbox, or a date range reaching beyond the oldest message,
can be reported as incomplete. This is intentional until that UI state is
verified. Portal layout changes may require updated selectors.

Results are written directly through the storage layer to repository-root
`data/database/schoolhawk.sqlite`. Run `bash scripts/setup-database.sh` from the
repository root before first collection. The required `--account` value is a
stable, non-sensitive alias, not a username; keep using the same alias for the
same portal account. Use `lkwash-parent` to match the existing imported data.

The database and original 32-byte `playwright/.auth/messages.key` are checked
before browser launch. The collector never generates or replaces a key. Message
payloads are AES-256-GCM encrypted; query metadata remains plaintext. Files are
mode `0600`; private directories are mode `0700`. Both locations are ignored by
Git. Keep a separately protected recovery copy of the key.

The storage layer deduplicates current messages by account and Skyward message
ID, while preserving each run's observations as history. Complete, partial, and
failed results returned by collection are saved transactionally before reporting
their status. Partial/failed observations do not overwrite the complete-message
view. Errors before inbox collection starts do not create a run. A database write
failure exits unsuccessfully, without a fallback file; after fixing storage use
`--all` to recover messages that may already have been marked read.

No `data/messages/` folder or per-run file is created by collection anymore.
Existing encrypted files remain untouched and can still be imported with the
root command `npm run data -- import --account lkwash-parent`.

The key is readable by your Linux account, so encryption here does not protect
against a compromised account or theft of an unencrypted disk containing both
key and ciphertext. Deployment still requires the planned encrypted volume.

Only counts, date range, status, safe warning codes, run ID, and database path are printed.
Session lifetimes are controlled by Skyward. If `INBOX_NAVIGATION` fails because
the session expired, renew locally with `npm run skyward:login` and retry; the
collector does not repeatedly submit credentials. An old state file without
`entryUrl` also requires renewal.

## Collect Assignments for All Students

From the repository root:

```bash
npm run skyward:assignments -- 7 --account lkwash-parent
```

The same N-day convention as messages applies to the past-assignment lookback:
today and the preceding N-1 calendar days in `America/Los_Angeles`, with N from
1 to 366. All Upcoming and Missing assignments are included without a date
cutoff; undated assignments are retained with an unknown date. Dates are based
on the assignment's due date, not collection time or the date it was assigned.

The collector uses the saved session, verifies the authenticated dashboard,
enumerates the student selector, cross-checks the student assignment widgets,
and opens the all-students Assignments view. It selects All Year rather than
Current Term so older missing work within the exposed school year is included.
This changes the page's window/filter state using Skyward's existing UI. It does
not edit assignments, grades, submissions, or forms, and it does not open messages
or attachments. Previous school-year archives are not traversed.

Student details are stored with each snapshot and assignment observation:
Skyward `id`, `firstName`, `lastName`, and the combined display `name`. The name
parser reads all `familyAccessStudentNameText` elements, recognizing an explicit
`Last, First` label rather than retaining only the first fragment. Multi-word
and hyphenated name parts are preserved; incomplete or ambiguous labels fail
student discovery instead of being guessed. Student identity remains scoped by
account and Skyward ID, not by name.

This uses assignment parser version 2 without new database tables or a separate
initialization command. Version-1 snapshots remain readable and are not backfilled
with inferred names; their separate name fields are absent. A later successful
collection updates the latest observations with newly captured names while
preserving history. Name-parser regression tests use synthetic markup. Live
student-name capture and encrypted database read-back were verified on
September 27, 2026.

The verified source is the `FamilyAccessAssignmentList` page and its normal
`Gradebook/Assignment/GetBrowse` responses. The collector parses the JSON argument
of Skyward's `registerBrowse` response without executing the returned script, and
parses the matching HTML in an inert document. It validates the source field names,
stable assignment IDs, student scopes, reported record count, and absence of a
row cap. An empty list also requires the portal's `noRecordsInBrowse` marker.
Skyward counts that placeholder as one row; it is accepted as empty only when no
assignment rows are present. A missing marker is never treated as an empty list.
Unrecognized or truncated responses fail closed instead of claiming full coverage.

Collected fields include title, class/section, teacher, due date, category, grade,
score and score status, maximum score, weight, attempts, attachment count, and
source/capture metadata. Assigned dates and descriptions are stored as unknown
because the verified lists do not provide those fields. Missing status comes
from the Missing list; no missing status is inferred merely from a past due date.
The original text of scores and grade scales is preserved.

Runs are written transactionally to the same database and encryption key as
messages. Database setup and valid private paths are required before browser
launch. The existing message API and collection behavior are unchanged.
Student and assignment identities are account-scoped; the account alias is still
manually assigned, not verified against the authenticated account.

The summary shows anonymous student ordinals, counts, section status, and safe
warning codes, never names or assignment content. A missing student or failed
section makes the overall result incomplete and exits nonzero. Expired sessions
are saved as `auth-required` when detected during collection; renew locally using
`npm run skyward:login`. Last-known records are retained, and a successful student
section is usable even when another section fails.

`AssignmentStore` supports run reconstruction and bounded current-observation
queries. There is not yet a user-facing `Assignments` query command, change
detection, automatic scheduling, or assignment retention policy. Consult run
health and observation age before interpreting stored missing/upcoming status.

## Collect Grades for All Students

From the repository root:

```bash
npm run skyward:grades -- --account lkwash-parent
```

No day count is needed: grades are snapshots of the course/period cells exposed
by the current Grading view. The collector verifies login and the student roster,
opens the all-students Grading widget, and observes the normal
`Grading/StudentSection/GetBrowse` responses. It does not open grade-detail
popups, GPA, earned-credit, or prior-year archive workflows. The portal may load
other summary tabs itself; those responses are not retained.

The response's matching HTML and JSON browse registration are parsed without
executing the embedded script. Student IDs in course rows and available request
metadata bind each matrix to its student; conflicting or absent identity evidence
fails closed. Course rows, period headings, grade-bucket IDs, row counts, and row
caps are checked. Empty results require a positively bound student and the
explicit `noRecordsInBrowse` marker. Unsupported layouts, missing students, or
incomplete matrices produce a nonzero exit status and retained failure coverage.

Each grade record contains:

- Student grade-bucket ID and student-section ID, separate from mutable marks.
- Course description/code and unparsed class-detail text when supplied.
- Displayed grading-period label and the source's open/closed indicator.
- Original grade-mark text, or null when the source provides no mark.
- Source URL and capture time.

Student IDs, first names, last names, and display names are stored with each run
and observation. The parser does not assume numeric marks are percentages, infer
zeros from blanks, or interpret a closed period as a completed submission.
Separate teacher/section fields, school-year labels, term IDs, numeric scores,
denominators, scale definitions, and effective dates remain null when not
independently exposed; class-detail and mark text are preserved rather than guessed.

Results go directly to the existing encrypted SQLite payload storage using the
original key. No raw portal files or screenshots are saved. Import is transactional
and idempotent by account/run ID; queries deduplicate by account/student/grade-bucket
ID using complete student observations. A failed student cannot overwrite good
data, and a complete student can advance during an otherwise partial run.
Empty or missing cells do not delete historical records. Consult coverage and
capture time when using stored grades.

Use `GradeStore` for local grade/run queries. A user-facing grade query command,
grade-change notifications, and scheduling are not part of this collector slice.