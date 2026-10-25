#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash scripts/run-pipeline.sh [options]

  --phase <phases>    all (default), login, collection, change-detection, or reporting.
                     Combine phases with commas; "review" aliases change-detection.
                     Order: login -> collection -> change-detection -> reporting.
                     all and collection always log in first.
  --login            Also log in for local-only phases; collection already requires login.
  --config <path>     Private review JSON (default: config/review.local.json).
                     Relative paths are resolved from the repository root.
  --env-file <path>   Private dotenv settings (default: repository-root .env if present).
                     Existing exported variables win. An explicitly selected file is required.
  --days <N>          Override both Skyward collection lookbacks, 1-366 (default: 7;
                     student-snapshot uses its assignment/message windows instead).
                     Upcoming/missing work, grades, and Canvas retain their full scope.
  --messages <mode>   unread (default) or all messages within the lookback.
  --format <format>   Reporting output: text (default) or json.
  --report-type <type>
                     briefing (default) or student-snapshot (all grades + recent work).
  --assignment-days <N>
                     Snapshot past-assignment window, 1-366 (default: 60).
  --message-days <N>  Snapshot recent-message window, 1-366 (default: 14).
  --dry-run          Validate configuration and print commands without executing them.
  --help, -h         Show this help without reading configuration.

Accounts/sections come from the review configuration; both Skyward and Canvas are
supported. Login/collection runs sequentially with one account per portal.
Every collection run requires a successful fresh login for that portal. Existing
session files do not bypass login. Local-only review/reporting does not log in
unless --login or the login phase is explicitly selected.
Non-dry runs load private .env settings before login, without executing shell code.
Only supported application variables are loaded; help/dry-run never read the file.
Login reuses exported or file-loaded credentials, or prompts for missing values on
your terminal. Password input is hidden. The runner exports the matching variables
only for that login process; nothing is saved to a credential file.
Without a terminal, provide SKYWARD_USERNAME/SKYWARD_PASSWORD and/or
CANVAS_USERNAME/CANVAS_PASSWORD through .env or the environment. No credentials are read
from piped stdin, command arguments, or review configuration.
Canvas also supports CANVAS_HEADED=1 with both credential variables unset for manual
browser login. SKYWARD_HEADED=1 opens a visible browser but still requires credentials.
Keep saved sessions and account aliases aligned. MFA/CAPTCHA are never bypassed.
Opening Skyward messages may mark them read or send receipts in either mode.
Use --messages all for fuller reporting/recovery only when those side effects are approved.

Change detection runs "Review run". Reporting runs "Review briefing", which also
reevaluates local changes/priorities and saves a review; it does not collect.
With --report-type student-snapshot, reporting runs "Review snapshot" instead.
It includes all retained grades, selected assignments, and new/recent messages.
Without explicit --days/--messages overrides, snapshot pipelines collect assignments
for --assignment-days and all messages for --message-days to populate the report.
No school-year start date is needed. --days affects collection, not report filtering.
Reporting is the current deterministic local summary/input, NOT a hosted AI report.
No setup, matching approvals, scheduler, email, or SMS is performed.

Failed login skips that portal's collections, without falling back to old sessions
or retrying. Independent login/collection failures do not prevent other portals or review.
Any failed/unsupported command makes the runner exit nonzero. Review failure skips
reporting. Inspect coverage even after exit zero; it is not an all-clear.
Output may contain private data. Do not overlap this runner with another collection.
HELP
}

fail() {
  printf 'PIPELINE: %s\n' "$1" >&2
  exit 1
}

phase_list=all
config=config/review.local.json
env_file=.env
days=7
messages=unread
format=text
report_type=briefing
assignment_days=60
message_days=14
dry_run=false
login=false
declare -A provided=()
while (( $# )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) dry_run=true; shift; continue ;;
    --login) login=true; shift; continue ;;
    --phase|--config|--env-file|--days|--messages|--format|--report-type|--assignment-days|--message-days)
      (( $# >= 2 )) || fail "Missing option value. Use --help."
      option=$1
      value=$2
      shift 2
      ;;
    --phase=*|--config=*|--env-file=*|--days=*|--messages=*|--format=*|--report-type=*|--assignment-days=*|--message-days=*)
      option=${1%%=*}
      value=${1#*=}
      shift
      ;;
    *) fail "Unknown argument. Use --help." ;;
  esac
  [[ -n "$value" ]] || fail "Empty option value. Use --help."
  [[ -z "${provided[$option]:-}" ]] || fail "Specify each option at most once."
  provided[$option]=1
  case "$option" in
    --phase) phase_list=$value ;;
    --config) config=$value ;;
    --env-file) env_file=$value ;;
    --days) days=$value ;;
    --messages) messages=$value ;;
    --format) format=$value ;;
    --report-type) report_type=$value ;;
    --assignment-days) assignment_days=$value ;;
    --message-days) message_days=$value ;;
  esac
done

[[ "$days" =~ ^[0-9]{1,3}$ ]] || fail "--days must be an integer from 1 to 366."
days=$((10#$days))
(( days >= 1 && days <= 366 )) || fail "--days must be an integer from 1 to 366."
[[ "$assignment_days" =~ ^[0-9]{1,3}$ ]] || fail "--assignment-days must be an integer from 1 to 366."
assignment_days=$((10#$assignment_days))
(( assignment_days >= 1 && assignment_days <= 366 )) || fail "--assignment-days must be an integer from 1 to 366."
[[ "$message_days" =~ ^[0-9]{1,3}$ ]] || fail "--message-days must be an integer from 1 to 366."
message_days=$((10#$message_days))
(( message_days >= 1 && message_days <= 366 )) || fail "--message-days must be an integer from 1 to 366."
[[ "$messages" == unread || "$messages" == all ]] || fail "--messages must be unread or all."
[[ "$format" == text || "$format" == json ]] || fail "--format must be text or json."
[[ "$report_type" == briefing || "$report_type" == student-snapshot ]] ||
  fail "--report-type must be briefing or student-snapshot."
[[ "$phase_list" != ,* && "$phase_list" != *, && "$phase_list" != *,,* ]] ||
  fail "Phase lists must not contain empty entries."

collection=false
review=false
reporting=false
IFS=, read -r -a phases <<< "$phase_list"
for phase in "${phases[@]}"; do
  case "$phase" in
    all)
      (( ${#phases[@]} == 1 )) || fail "Use all alone, or list individual phases."
      collection=true; review=true; reporting=true
      ;;
    login) login=true ;;
    collection) collection=true ;;
    change-detection|review) review=true ;;
    reporting) reporting=true ;;
    *) fail "Unknown phase. Use login, collection, change-detection, reporting, or all." ;;
  esac
done

if [[ -n "${provided[--report-type]:-}" && "$reporting" != true ]]; then
  fail "--report-type requires the reporting phase (or all)."
fi
if [[ ( -n "${provided[--assignment-days]:-}" || -n "${provided[--message-days]:-}" ) && "$report_type" != student-snapshot ]]; then
  fail "--assignment-days and --message-days require --report-type student-snapshot."
fi
assignment_collection_days=$days
message_collection_days=$days
if [[ "$report_type" == student-snapshot && "$collection" == true ]]; then
  if [[ -z "${provided[--days]:-}" ]]; then
    assignment_collection_days=$assignment_days
    message_collection_days=$message_days
  else
    printf 'PIPELINE: Explicit --days controls collection; snapshot windows may need older retained observations.\n' >&2
  fi
  if [[ -z "${provided[--messages]:-}" ]]; then messages=all; fi
fi
if [[ "$collection" == true ]]; then login=true; fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$root"
[[ "$config" == /* ]] || config="$root/$config"
[[ "$env_file" == /* ]] || env_file="$root/$env_file"
command -v node >/dev/null || fail "Node.js is required. Install the project's supported runtime and dependencies first."
if [[ "$dry_run" == false ]]; then
  (( EUID != 0 )) || fail "Run as the app user, not root or sudo."
  command -v npm >/dev/null || fail "npm is required."
fi

portal_access=$collection
[[ "$login" != true ]] || portal_access=true
if ! plan=$(
unset SKYWARD_USERNAME SKYWARD_PASSWORD CANVAS_USERNAME CANVAS_PASSWORD AZURE_FOUNDRY_API_KEY
node --import tsx - "$config" "$portal_access" <<'NODE'
let ReviewUsageError;
try {
  const review = require("./apps/cli/src/review.ts");
  ReviewUsageError = review.ReviewUsageError;
  const config = review.readReviewConfig(process.argv[2]);
  const portalAccess = process.argv[3] === "true";
  const lines = [];
  for (const portal of ["skyward", "canvas"]) {
    const sources = config.sources.filter(source => source.portal === portal);
    if (portalAccess && sources.length > 1) {
      throw new ReviewUsageError(
        "Login/collection supports only one configured account per portal because saved sessions are portal-wide. " +
        "Use a single-account configuration matching the intended login/session; review/reporting may still include multiple accounts.",
      );
    }
    for (const source of sources) {
      const ordered = ["assignments", "grades", "messages", "attendance", "calendar", "announcements", "forms"];
      for (const section of ordered) if (source.sections.includes(section)) {
        lines.push([portal, source.accountId, section].join("\t"));
      }
    }
  }
  process.stdout.write(lines.join("\n"));
} catch (error) {
  console.error("PIPELINE: " + (ReviewUsageError && error instanceof ReviewUsageError ? error.message :
    "Cannot prepare pipeline configuration. Check the installed workspace dependencies. Private details withheld."));
  process.exitCode = 1;
}
NODE
); then
  fail "Preflight failed. No login, collection, or review commands were executed."
fi

trap 'printf "\nPIPELINE: Interrupted; remaining phases were not run.\n" >&2; exit 130' INT
trap 'printf "\nPIPELINE: Terminated; remaining phases were not run.\n" >&2; exit 143' TERM
failures=()
collection_failed=false
review_failed=false
declare -A login_seen=()
declare -A login_failed=()

load_environment() {
  local descriptor loader name value status=0 broken=false tracing=false mode=optional
  [[ -z "${provided[--env-file]:-}" ]] || mode=required
  if [[ $- == *x* ]]; then tracing=true; set +x; fi
  if ! exec {descriptor}< <(node --import tsx "$root/scripts/pipeline-env.ts" "$env_file" "$mode"); then
    return 1
  fi
  loader=$!
  while IFS= read -r -d '' name <&"$descriptor"; do
    if ! IFS= read -r -d '' value <&"$descriptor" || ! export "$name=$value"; then
      broken=true
      break
    fi
  done
  exec {descriptor}<&-
  if wait "$loader"; then :; else status=$?; fi
  unset name value
  if [[ "$tracing" == true ]]; then set -x; fi
  if [[ "$broken" == true ]]; then return 1; fi
  return "$status"
}

prepare_login_credentials() {
  local portal=$1 display prefix username password
  case "$portal" in
    skyward)
      display=Skyward; prefix=SKYWARD
      username=${SKYWARD_USERNAME:-}
      password=${SKYWARD_PASSWORD:-}
      ;;
    canvas)
      display=Canvas; prefix=CANVAS
      username=${CANVAS_USERNAME:-}
      password=${CANVAS_PASSWORD:-}
      if [[ "${CANVAS_HEADED:-}" == 1 && -z "$username" && -z "$password" ]]; then
        printf 'PIPELINE: Complete Canvas credentials and verification in the browser.\n' >&2
        return 0
      fi
      ;;
    *) printf 'PIPELINE: Unsupported login portal.\n' >&2; return 1 ;;
  esac

  if [[ -z "$username" || -z "$password" ]]; then
    local terminal input_ok=true
    # The collection-plan loop owns stdin; credentials must come from the terminal.
    if ! { exec {terminal}<>/dev/tty; } 2>/dev/null; then
      printf 'PIPELINE: %s credentials are missing and no interactive terminal is available. Export %s_USERNAME and %s_PASSWORD before running login. No login was attempted.\n' \
        "$display" "$prefix" "$prefix" >&2
      return 1
    fi
    if [[ -z "$username" ]]; then
      printf '%s username: ' "$display" >&"$terminal"
      if ! IFS= read -r username <&"$terminal"; then input_ok=false; fi
    fi
    if [[ "$input_ok" == true && -n "$username" && -z "$password" ]]; then
      printf '%s password: ' "$display" >&"$terminal"
      if ! IFS= read -r -s password <&"$terminal"; then input_ok=false; fi
      printf '\n' >&"$terminal"
    fi
    exec {terminal}>&-
    if [[ "$input_ok" != true || -z "$username" || -z "$password" ]]; then
      printf 'PIPELINE: Empty or cancelled credential input for %s. No login was attempted.\n' "$display" >&2
      return 1
    fi
  fi

  case "$portal" in
    skyward) export SKYWARD_USERNAME="$username" SKYWARD_PASSWORD="$password" ;;
    canvas) export CANVAS_USERNAME="$username" CANVAS_PASSWORD="$password" ;;
  esac
}

run_command() {
  local label=$1
  shift
  printf '\n[%s]' "$label" >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
  if [[ "$dry_run" == true ]]; then return 0; fi
  local status
  if (
    # Never trace credential expansion, including when invoked with bash -x.
    set +x
    unset AZURE_FOUNDRY_API_KEY
    case "$label" in
      login/skyward)
        unset CANVAS_USERNAME CANVAS_PASSWORD
        prepare_login_credentials skyward || exit 1
        ;;
      login/canvas)
        unset SKYWARD_USERNAME SKYWARD_PASSWORD
        prepare_login_credentials canvas || exit 1
        ;;
      *) unset SKYWARD_USERNAME SKYWARD_PASSWORD CANVAS_USERNAME CANVAS_PASSWORD ;;
    esac
    "$@"
  ); then
    return 0
  else
    status=$?
    printf 'PIPELINE: %s failed (exit %s).\n' "$label" "$status" >&2
    if (( status == 130 || status == 143 )); then exit "$status"; fi
    failures+=("$label (exit $status)")
    return 1
  fi
}

if [[ "$dry_run" == false ]]; then
  if ! load_environment; then
    fail "Environment loading failed. No login, collection, or review commands were executed."
  fi
fi

if [[ "$login" == true ]]; then
  printf 'PIPELINE: One login attempt per configured portal. Credentials stay in the relevant login process environment.\n' >&2
  while IFS=$'\t' read -r portal account section; do
    [[ -n "$portal" ]] || continue
    [[ -z "${login_seen[$portal]:-}" ]] || continue
    login_seen[$portal]=true
    if ! run_command "login/$portal" npm run "$portal:login"; then
      login_failed[$portal]=true
      collection_failed=true
    fi
  done <<< "$plan"
fi

if [[ "$collection" == true ]]; then
  printf 'PIPELINE: Collecting configured sections sequentially; existing sessions must match account aliases.\n' >&2
  while IFS=$'\t' read -r portal account section; do
    [[ -n "$portal" ]] || continue
    if [[ "${login_failed[$portal]:-false}" == true ]]; then
    printf 'PIPELINE: Skipping %s/%s because its login failed; no old-session fallback or retry.\n' "$portal" "$section" >&2
    continue
    fi
    command=(npm run "$portal:$section" --)
    case "$portal:$section" in
      skyward:assignments) command+=("$assignment_collection_days" --account "$account") ;;
      skyward:messages)
        command+=("$message_collection_days" --account "$account")
        [[ "$messages" != all ]] || command+=(--all)
        printf 'PIPELINE: Skyward message selection is %s; opening messages may mark them read or send receipts.\n' "$messages" >&2
        ;;
      skyward:grades|canvas:assignments) command+=(--account "$account") ;;
      *)
        printf 'PIPELINE: No collector for configured %s/%s; this coverage remains unsupported.\n' "$portal" "$section" >&2
        failures+=("$portal:$section (unsupported)")
        collection_failed=true
        continue
        ;;
    esac
    if ! run_command "collection/$portal:$section" "${command[@]}"; then collection_failed=true; fi
  done <<< "$plan"
fi

if [[ "$collection_failed" == true && ( "$review" == true || "$reporting" == true ) ]]; then
  printf '\nPIPELINE: Login or collection was incomplete. Review/reporting uses retained local observations and may be stale.\n' >&2
  printf 'Preflight failures may not create stored collection runs; do not treat the resulting report as an all-clear.\n' >&2
fi
if [[ "$review" == true ]]; then
  if ! run_command change-detection npm run cli -- Review run --config "$config"; then review_failed=true; fi
fi
if [[ "$reporting" == true ]]; then
  if [[ "$review_failed" == true ]]; then
    printf 'PIPELINE: Reporting skipped because change detection failed.\n' >&2
  else
    report_command=briefing
    [[ "$report_type" != student-snapshot ]] || report_command=snapshot
    command=(npm run cli -- Review "$report_command" --config "$config")
    if [[ "$report_type" == student-snapshot ]]; then
      command+=(--assignment-days "$assignment_days" --message-days "$message_days")
    fi
    [[ "$format" != text ]] || command+=(--text)
    if ! run_command reporting "${command[@]}"; then :; fi
  fi
fi

if (( ${#failures[@]} )); then
  printf '\nPIPELINE: %s step(s) failed or are unsupported:\n' "${#failures[@]}" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi
if [[ "$dry_run" == true ]]; then
  printf '\nPIPELINE: Dry run complete. No npm commands, database operations, or portal requests were executed.\n' >&2
else
  printf '\nPIPELINE: Selected phases completed. Check coverage, freshness, and omissions; exit zero is not an all-clear.\n' >&2
fi
