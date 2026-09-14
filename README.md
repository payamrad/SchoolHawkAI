# SchoolHawkAI

Read-only family school collection and local storage. See [ProjectPlan.md](ProjectPlan.md)
for the architecture and staged delivery plan.

## Workspace Layout

- `apps/collector`: Skyward browser login and message collection.
- `apps/cli`: local storage import, status, and backup commands.
- `packages/core/schemas`: Zod schemas and shared TypeScript message/run types.
- `packages/storage`: persistence interfaces, SQLite implementation, migrations,
  encryption helpers, and Vitest tests.
- `config`: public portal URLs.
- `data`: ignored encrypted collection results and private SQLite data.
- `playwright/.auth`: ignored browser state and encryption key.

Only currently needed parts of the planned structure exist. Additional portal,
briefing, and dashboard packages will be created when implemented.

## Setup and Commands

Use Node 20.19 or newer compatible with the installed dependencies. npm 10 was
verified on the Pi; npm 9.2 encountered a peer-dependency resolver error. To use
npm 10 without replacing the system installation:

```bash
npx --yes npm@10 ci
```

Install from the repository root. The root `package-lock.json` is the single
lockfile for all npm workspaces. The private workspace packages currently expose
TypeScript source and are executed with `tsx`; a compiled deployment build is a
later milestone.

```bash
npm run typecheck
npm test
npm run skyward:login
npm run skyward:messages -- 7
npm run skyward:messages -- 7 --all
```

Login requires locally supplied credentials. See
[apps/collector/README.md](apps/collector/README.md) for login and collection details.
Tests use synthetic data and do not contact school portals.

## SQLite Storage

After collecting messages, import the existing encrypted files:

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

**Source files are never deleted or modified.** Importing is an explicit step;
the collector continues to write encrypted files and does not automatically
write SQLite yet. Retention and automatic import scheduling are not implemented.

### Data Interface

`MessageStore` exposes `importRun`, `getRun`, `listRuns`, `listMessages`, and
`close`. `SqliteMessageStore` also exposes an online `backup` method. Callers
must close stores. Queries are account-scoped with bounded limits (100 by default,
maximum 1000). `listMessages` accepts a date-only `since` filter.

`getRun` reconstructs the complete validated observation, including messages,
source timestamps/URLs, window, status, warnings, parser version, and selection.
Older files without `selection` are normalized to `all`.

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
- `storage_settings`: encryption-key check; schema version uses `PRAGMA user_version`.

Migration 001 runs transactionally. Unknown future schema versions are rejected.
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