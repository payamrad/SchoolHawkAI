# Skyward Login

Install dependencies from the repository root using the workspace lockfile (see
the root README). From this directory, install the browser with
`npx playwright install chromium`.

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

The authenticated dashboard has not yet been inspected with a real account. If its
sign-out control is hidden or named differently, set `SKYWARD_SUCCESS_SELECTOR` to
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

## Collect Messages for N Days

```bash
npm run skyward:messages -- 7
```

By default, only messages observed as unread in the requested date window are
opened and collected. To include read messages as well:

```bash
npm run skyward:messages -- 7 --all
```

Both modes scan list metadata for date coverage; `--all` does not remove the
date limit. The output summary and encrypted run include `selection` (`unread`
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

Results are AES-256-GCM encrypted under repository-root `data/messages/`, with
one unique `*.json.enc` file per run. The separate 32-byte encryption key is
`playwright/.auth/messages.key`. Files are mode `0600`; private directories are
mode `0700`. Both locations are ignored by Git. Do not lose the key, and do not
back it up alongside ciphertext without separate protection. The exported
`decryptRun` function supports local downstream processing without storing
plaintext files. To import results into SQLite, run the root command
`npm run data -- import --account lkwash-parent`. The collector does not import
automatically. Original files are retained; automatic retention is not implemented.

The key is readable by your Linux account, so encryption here does not protect
against a compromised account or theft of an unencrypted disk containing both
key and ciphertext. Deployment still requires the planned encrypted volume.

Only counts, date range, status, safe warning codes, and output path are printed.
Session lifetimes are controlled by Skyward. If `INBOX_NAVIGATION` fails because
the session expired, renew locally with `npm run skyward:login` and retry; the
collector does not repeatedly submit credentials. An old state file without
`entryUrl` also requires renewal.