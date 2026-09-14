# SchoolHawkAI

Read-only family school collection and local storage. See [ProjectPlan.md](ProjectPlan.md)
for the architecture and staged delivery plan.

## Workspace Layout

- `apps/collector`: Skyward browser login and message collection.
- `apps/cli`: user-facing `Messages` and `Truncate` commands; provisional storage utilities also remain here.
- `packages/core/schemas`: Zod schemas and shared TypeScript message/run types.
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
```

Login requires locally supplied credentials. See
[apps/collector/README.md](apps/collector/README.md) for login and collection details.
Tests use synthetic data and do not contact school portals.

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

The initial schema supports Skyward messages only. Student mapping, grades,
assignments, change events, and prioritization are not implemented by this slice.

### Persistence and Protection

- `collection_runs`: run scope/status and encrypted run metadata.
- `message_observations`: indexed message history and encrypted message payloads.
- `audit_events`: append-only import audit protected by application API and triggers.
- `cleanup_events`: append-only, account-scoped truncation audit with counts, target, and time.
- `storage_settings`: encryption-key check; schema version uses `PRAGMA user_version`.

Migrations 001 and 002 run transactionally. Existing version-1 databases upgrade
on open after key verification. Unknown future schema versions are rejected.
Each run and its observations/audit event commit together. Foreign keys, WAL,
a 5-second busy timeout, and full synchronous durability are enabled.

SQLite is **not whole-database encrypted**. Sender, subject, body, displayed/read
status, source details, and other payload fields use AES-256-GCM with row identity
bound as authenticated data. Dates, IDs, run status, selection, and counts remain
plaintext for querying. The existing `playwright/.auth/messages.key` encrypts
payloads; no new key is silently generated by the storage layer. Losing it makes
both collected files and stored payloads unreadable. Wrong keys are rejected on open.

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