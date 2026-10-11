import assert from "node:assert/strict";
import { test } from "node:test";
import { detectReviewChanges, compareReviewFields } from "../change-detection";
import { prioritizeReview, reviewHealth } from "../prioritization";
import { ReviewError, reviewConfigSchema, reviewDate, rulesFor } from "../review";
import { assignment, assignmentRun, canvasRun, config, gradeRun, ids, instant, messageRun, observation } from "./review-fixtures";

const later = "2026-10-10T17:00:00.000Z";
const skyward = (run = assignmentRun()) => observation({ portal: "skyward", section: "assignments", run });
const canvas = (run = canvasRun()) => observation({ portal: "canvas", section: "assignments", run }, "canvas-parent");
const canvasConfig = () => config({
  sources: [{ portal: "canvas", accountId: "canvas-parent", sections: ["assignments"] }],
  children: [{ id: "child-a", bindings: [{ portal: "canvas", accountId: "canvas-parent", studentId: "10" }] }],
});

test("review configuration rejects ambiguity and child overrides preserve global settings", () => {
  const settings = config({ rules: { staleAfterHours: 72 }, children: [{
    id: "child-a", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-1" }], rules: { upcomingDays: 10 },
  }] });
  assert.equal(settings.rules.dueSoonHours, 24);
  assert.equal(rulesFor(settings, "child-a").staleAfterHours, 72);
  assert.equal(rulesFor(settings, "child-a").upcomingDays, 10);
  assert.equal(rulesFor(settings, "child-a").immediateDeadlineAlerts, false);
  assert.throws(() => reviewConfigSchema.parse({ ...settings, timeZone: "not/a-zone" }));
  assert.throws(() => reviewConfigSchema.parse({ ...settings, sources: [settings.sources[0], settings.sources[0]] }));
  assert.throws(() => reviewConfigSchema.parse({ ...settings, children: [settings.children[0], { ...settings.children[0], id: "other" }] }));
  assert.throws(() => reviewConfigSchema.parse({ ...settings, extraCredential: "SECRET" }));
});

test("bootstrap uses historical observations without inventing historical new/change alerts", () => {
  const first = skyward();
  const second = skyward(assignmentRun(later, [assignment(later, { dueDate: "2026-10-14" })]));
  const initial = detectReviewChanges(undefined, [second, first], config(), later, ids);
  assert.equal(initial.bootstrap, true);
  assert.equal(initial.changes.length, 1);
  assert.equal(initial.changes[0].kind, "first-observed");
  assert.equal(initial.state.records[0].fields.dueDate, "2026-10-14");
  assert.equal(initial.state.records[0].firstSeenAt, instant);
  const repeat = detectReviewChanges(initial.state, [first, second], config(), later, ids);
  assert.equal(repeat.changes.length, 0);
  assert.deepEqual(repeat.state, initial.state);
});

test("semantic changes preserve identity, ignore presentation and distinguish unknown from zero", () => {
  const baseline = detectReviewChanges(undefined, [skyward()], config(), instant, ids);
  const unchanged = skyward(assignmentRun(later, [assignment(later, { title: "  PRIVATE_TITLE \n" })]));
  const noChange = detectReviewChanges(baseline.state, [unchanged], config(), later, ids);
  assert.equal(noChange.changes.length, 0);
  const newest = "2026-10-10T18:00:00.000Z";
  const changed = skyward(assignmentRun(newest, [assignment(newest, { title: "Different title", dueDate: "2026-10-15", missing: true, score: "0" })]));
  const result = detectReviewChanges(noChange.state, [changed], config(), newest, ids);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "updated");
  assert.equal(result.state.records[0].id, baseline.state.records[0].id);
  assert(result.changes[0].fields.some(field => field.field === "score" && field.before === null && field.after === "0"));
  assert(result.changes[0].fields.some(field => field.field === "missing" && field.after === true));
  assert.equal(compareReviewFields(result.state.records[0].fields, result.state.records[0].fields).length, 0);
});

test("partial sections retain complete baselines while independent complete sections advance", () => {
  const baseline = detectReviewChanges(undefined, [skyward()], config(), instant, ids);
  const run = assignmentRun(later, [assignment(later, { title: "UNTRUSTWORTHY" }), assignment(later, { id: "missing-2", missing: true })]);
  run.status = "partial";
  run.students[0].sections[0].status = "partial";
  const result = detectReviewChanges(baseline.state, [skyward(run)], config(), later, ids);
  assert.equal(result.state.records.find(record => record.fields.missing === false)!.fields.title, "PRIVATE_TITLE");
  assert.equal(result.state.records.find(record => record.fields.missing === false)!.lastSeenAt, instant);
  assert(result.changes.some(change => change.kind === "newly-observed"));
  assert.equal(result.state.records.length, 2);
  assert(result.state.scopes.some(scope => scope.part === "upcoming" && scope.lastCompleteAt === instant));
});

test("same portal record ID is isolated by account and student, not names", () => {
  const run = assignmentRun();
  run.students.push({ ...structuredClone(run.students[0]), id: "student-2" });
  const settings = config({ sources: [
    { portal: "skyward", accountId: "parent", sections: ["assignments"] },
    { portal: "skyward", accountId: "other", sections: ["assignments"] },
  ] });
  const result = detectReviewChanges(undefined, [skyward(run),
    observation({ portal: "skyward", section: "assignments", run }, "other")], settings, instant, ids);
  assert.equal(result.state.records.length, 4);
  assert.equal(new Set(result.state.records.map(record => record.id)).size, 4);
  assert.throws(() => detectReviewChanges(undefined, [observation({ portal: "skyward", section: "assignments", run }, "other")],
    config(), instant, ids), /outside the configured/);
});

test("expanded past windows yield first-observed records rather than newly posted claims", () => {
  const initialRun = assignmentRun(instant, []);
  const initial = detectReviewChanges(undefined, [skyward(initialRun)], config(), instant, ids);
  const expanded = assignmentRun(later, [assignment(later, { id: "old-work", dueDate: "2026-10-01" })]);
  expanded.window.startDate = "2026-09-11";
  expanded.window.days = 30;
  const result = detectReviewChanges(initial.state, [skyward(expanded)], config(), later, ids);
  assert.equal(result.changes[0].kind, "first-observed");
});

test("removal needs two comparable complete absences; failures interrupt the streak", () => {
  const settings = canvasConfig();
  let current = detectReviewChanges(undefined, [canvas()], settings, instant, ids);
  const runAt = (hour: number, failed = false) => {
    const timestamp = `2026-10-10T${hour}:00:00.000Z`;
    const run = canvasRun(timestamp, true);
    if (failed) {
      run.status = "partial"; run.students[0].status = "failed";
      run.students[0].courses[0].status = "failed"; run.students[0].courses[0].verifiedEmpty = false;
    }
    current = detectReviewChanges(current.state, [canvas(run)], settings, timestamp, ids);
  };
  runAt(17);
  assert.equal(current.state.records[0].absences, 1);
  assert.equal(current.changes.length, 0);
  runAt(18, true);
  assert.equal(current.state.records[0].absences, 0);
  runAt(19);
  assert.equal(current.state.records[0].active, true);
  runAt(20);
  assert(current.changes.some(change => change.kind === "no-longer-observed"));
  assert.equal(current.state.records[0].active, false);
  const restored = detectReviewChanges(current.state, [canvas(canvasRun("2026-10-10T21:00:00.000Z"))], settings, "2026-10-10T21:00:00.000Z", ids);
  assert.equal(restored.changes[0].kind, "reappeared");
  assert.equal(restored.state.records[0].active, true);
});

test("window shrinkage, course disappearance and period rollover never imply deletion", () => {
  const original = assignmentRun(instant, [assignment(instant, { dueDate: "2026-10-05" })]);
  let current = detectReviewChanges(undefined, [skyward(original)], config(), instant, ids);
  for (const timestamp of [later, "2026-10-10T18:00:00.000Z"]) {
    const run = assignmentRun(timestamp, []);
    run.window.days = 1; run.window.startDate = "2026-10-10";
    current = detectReviewChanges(current.state, [skyward(run)], config(), timestamp, ids);
    assert.equal(current.changes.filter(change => change.entity !== "collection").length, 0);
    assert.equal(current.state.records[0].active, true);
  }
  let canvasState = detectReviewChanges(undefined, [canvas()], canvasConfig(), instant, ids);
  const changedTerm = canvasRun(later, true);
  changedTerm.students[0].courses[0].termId = "2";
  canvasState = detectReviewChanges(canvasState.state, [canvas(changedTerm)], canvasConfig(), later, ids);
  assert.equal(canvasState.state.records[0].absences, 0);
  for (const timestamp of ["2026-10-10T17:10:00.000Z", "2026-10-10T17:20:00.000Z"]) {
    const rollover = canvasRun(timestamp, true);
    rollover.students[0].courses[0].termId = "2";
    canvasState = detectReviewChanges(canvasState.state, [canvas(rollover)], canvasConfig(), timestamp, ids);
    assert.equal(canvasState.state.records[0].active, true);
    assert.equal(canvasState.state.records[0].absences, 0);
  }
  const noCourse = canvasRun("2026-10-10T18:00:00.000Z", true);
  noCourse.students[0].courses = [];
  canvasState = detectReviewChanges(canvasState.state, [canvas(noCourse)], canvasConfig(), noCourse.capturedAt, ids);
  assert.equal(canvasState.state.records[0].active, true);
  assert(canvasState.state.scopes.some(scope => scope.courseId === "20" && scope.status === "not-observed"));
});

test("late observations cannot rewind state and changed source history is rejected explicitly", () => {
  const current = detectReviewChanges(undefined, [skyward(assignmentRun(later))], config(), later, ids);
  const late = skyward(assignmentRun(instant, [assignment(instant, { title: "OLD" })]));
  const result = detectReviewChanges(current.state, [late], config(), later, ids);
  assert.equal(result.state.records[0].fields.title, "PRIVATE_TITLE");
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.notices, ["late-observations-ignored"]);
  assert.throws(() => detectReviewChanges(result.state, [{ ...late, fingerprint: "different" }], config(), later, ids), ReviewError);
  assert.throws(() => detectReviewChanges(result.state, [], config({ children: [] }), later, ids), /bindings changed/);
  assert.throws(() => detectReviewChanges(result.state, [], config(), instant, ids), /before its retained observations/);
});

test("unknown and textual grade scales are compared without percentage or zero assumptions", () => {
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["grades"] }] });
  const initial = detectReviewChanges(undefined, [observation({ portal: "skyward", section: "grades", run: gradeRun(instant, null) })], settings, instant, ids);
  const changed = detectReviewChanges(initial.state, [observation({ portal: "skyward", section: "grades", run: gradeRun(later, "0") })], settings, later, ids);
  assert.deepEqual(changed.changes[0].fields, [{ field: "grade", before: null, after: "0" }]);
  const priorities = prioritizeReview(changed.state, changed.changes, [], settings, new Date(later), ids);
  assert.equal(priorities.actions[0].priority, "normal");
  assert.equal(priorities.actions[0].delivery, "daily");
});

test("grade disappearance is confirmed only inside the original complete period scope", () => {
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["grades"] }] });
  let current = detectReviewChanges(undefined, [observation({ portal: "skyward", section: "grades", run: gradeRun() })], settings, instant, ids);
  for (const timestamp of [later, "2026-10-10T18:00:00.000Z"]) {
    const empty = gradeRun(timestamp);
    empty.students[0].grades = []; empty.students[0].scannedCount = 0; empty.students[0].verifiedEmpty = true;
    current = detectReviewChanges(current.state, [observation({ portal: "skyward", section: "grades", run: empty })], settings, timestamp, ids);
  }
  assert.equal(current.state.records[0].active, false);
  assert(current.changes.some(change => change.entity === "grade" && change.kind === "no-longer-observed"));
});

test("message selection never infers removals and read-state changes do not assert an actor", () => {
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["messages"] }] });
  let current = detectReviewChanges(undefined, [observation({ portal: "skyward", section: "messages", run: messageRun() })], settings, instant, ids);
  const read = messageRun(later, false);
  current = detectReviewChanges(current.state, [observation({ portal: "skyward", section: "messages", run: read })], settings, later, ids);
  assert.deepEqual(current.changes[0].fields, [{ field: "unread", before: true, after: false }]);
  for (const hour of [18, 19, 20]) {
    const run = messageRun(`2026-10-10T${hour}:00:00.000Z`);
    run.messages = []; run.selection = "unread";
    current = detectReviewChanges(current.state, [observation({ portal: "skyward", section: "messages", run })], settings, run.capturedAt, ids);
  }
  assert.equal(current.state.records[0].active, true);
  assert.equal(current.changes.length, 0);
});

test("new unread messages after a baseline are normal priority, including a newly started day", () => {
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["messages"] }] });
  const first = messageRun();
  first.selection = "unread";
  const initial = detectReviewChanges(undefined, [observation({ portal: "skyward", section: "messages", run: first })], settings, instant, ids);
  const next = messageRun("2026-10-11T16:00:00.000Z");
  next.selection = "unread"; next.messages[0].id = "new-message"; next.messages[0].sentDate = "2026-10-11";
  const detected = detectReviewChanges(initial.state, [observation({ portal: "skyward", section: "messages", run: next })],
    settings, next.capturedAt, ids);
  assert.equal(detected.changes[0].kind, "newly-observed");
  const prioritized = prioritizeReview(detected.state, detected.changes, [], settings, new Date(next.capturedAt), ids);
  assert(prioritized.actions.some(action => action.reasons.includes("new-unread-message") && action.priority === "normal"));
});

test("unknown missing status cannot clear a previously verified missing-work priority", () => {
  const initial = detectReviewChanges(undefined, [skyward(assignmentRun(instant, [assignment(instant, { missing: true })]))], config(), instant, ids);
  const next = assignmentRun(later, [assignment(later, { missing: null })]);
  next.status = "partial"; next.students[0].sections[1].status = "failed";
  const detected = detectReviewChanges(initial.state, [skyward(next)], config(), later, ids);
  const actions = prioritizeReview(detected.state, [], [], config(), new Date("2026-10-12T16:00:00Z"), ids).actions;
  const item = actions.find(action => action.entity === "assignment")!;
  assert.equal(item.priority, "high");
  assert(item.reasons.includes("missing-status-unverified"));
  assert.equal(item.facts!.missing, null);
  assert.equal(item.lastKnownMissing!.value, true);
  assert.equal(item.lastKnownMissing!.evidence.capturedAt, instant);
  assert.equal(item.delivery, "daily");
});

test("priorities change with the clock, preserve date-only deadlines and stay nonurgent by default", () => {
  const current = detectReviewChanges(undefined, [skyward()], config(), instant, ids);
  const initial = prioritizeReview(current.state, [], [], config(), new Date(instant), ids).actions.find(action => action.entity === "assignment")!;
  assert.equal(initial.priority, "normal");
  assert(initial.reasons.includes("upcoming"));
  const tomorrow = prioritizeReview(current.state, [], [], config(), new Date("2026-10-11T16:00:00Z"), ids).actions.find(action => action.entity === "assignment")!;
  assert.equal(tomorrow.priority, "high");
  assert(tomorrow.reasons.includes("due-tomorrow"));
  assert.equal(tomorrow.dueAt, null);
  assert.equal(tomorrow.delivery, "daily");
  assert.equal(reviewDate(new Date("2026-03-09T06:59:00Z"), "America/Los_Angeles"), "2026-03-08");
  assert.equal(reviewDate(new Date("2026-11-01T08:30:00Z"), "America/Los_Angeles"), "2026-11-01");
  const stale = prioritizeReview(current.state, [], [], config(), new Date("2026-10-12T16:00:00Z"), ids);
  assert(stale.actions.some(action => action.uncertainty.includes("collection-stale")));
});

test("24-hour urgent eligibility requires explicit approval, fresh evidence and discovery inside the window", () => {
  const settings = canvasConfig();
  settings.rules.immediateDeadlineAlerts = true;
  const run = canvasRun();
  const assignment = run.students[0].courses[0].assignments[0];
  assignment.dueAt = "2026-10-11T16:00:00.000Z"; assignment.dueDate = "2026-10-11";
  const current = detectReviewChanges(undefined, [canvas(run)], settings, instant, ids);
  const actions = prioritizeReview(current.state, current.changes, [], settings, new Date(instant), ids).actions;
  assert.equal(actions[0].delivery, "immediate-eligible");
  const beforeWindow = prioritizeReview(current.state, current.changes, [], settings, new Date("2026-10-10T15:59:59Z"), ids);
  assert(beforeWindow.actions.every(action => action.delivery === "daily"));
  const disabled = prioritizeReview(current.state, current.changes, [], canvasConfig(), new Date(instant), ids);
  assert(disabled.actions.every(action => action.delivery === "daily"));
});

test("confirmed links yield one candidate while source values and conflicts remain separate", () => {
  const settings = config({
    sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments"] },
      { portal: "canvas", accountId: "canvas-parent", sections: ["assignments"] }],
    children: [{ id: "child-a", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-1" },
      { portal: "canvas", accountId: "canvas-parent", studentId: "10" }] }],
  });
  const current = detectReviewChanges(undefined, [skyward(), canvas()], settings, instant, ids);
  const sky = current.state.records.find(record => record.evidence.portal === "skyward")!;
  const can = current.state.records.find(record => record.evidence.portal === "canvas")!;
  const links = [{ id: "confirmed", skywardRecordId: sky.id, canvasRecordId: can.id }];
  const matched = prioritizeReview(current.state, current.changes, links, settings, new Date(instant), ids);
  assert.equal(matched.actions.filter(action => action.entity === "assignment").length, 1);
  assert.equal(matched.actions[0].relatedFacts[0].fields.dueAt, can.fields.dueAt);
  can.fields.dueDate = "2026-10-13";
  const conflict = prioritizeReview(current.state, [], links, settings, new Date(instant), ids).actions[0];
  assert(conflict.uncertainty.includes("source-conflict"));
  assert.equal(conflict.dueAt, null);
  assert.equal(conflict.facts?.dueDate, "2026-10-12");
  assert.equal(conflict.relatedFacts[0].fields.dueDate, "2026-10-13");
});

test("missing expected students and unsupported sections are explicit collection-health problems", () => {
  const settings = config({
    sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "attendance"] }],
    children: [{ id: "child-a", bindings: [{ portal: "skyward", accountId: "parent", studentId: "not-discovered" }] }],
  });
  const current = detectReviewChanges(undefined, [skyward()], settings, instant, ids);
  const health = reviewHealth(current.state, settings, new Date(instant), ids);
  assert(health.some(entry => entry.issues.includes("unsupported-section")));
  assert(health.some(entry => entry.childId === "child-a" && entry.issues.includes("scope-not-observed")));
  assert(health.some(entry => entry.issues.includes("unmapped-student")));
});

test("repeated missing-child coverage escalates and recovery removes the placeholder", () => {
  const settings = config({ rules: { immediateOperationalAlerts: true } });
  let current = detectReviewChanges(undefined, [], settings, instant, ids);
  for (const timestamp of [instant, later, "2026-10-10T18:00:00.000Z"]) {
    const run = assignmentRun(timestamp);
    run.students = []; run.discoveryComplete = false; run.status = "failed";
    current = detectReviewChanges(current.state, [skyward(run)], settings, timestamp, ids);
  }
  const health = prioritizeReview(current.state, [], [], settings, new Date("2026-10-10T18:00:00Z"), ids);
  assert(health.actions.some(action => action.childId !== null && action.delivery === "immediate-eligible"));
  current = detectReviewChanges(current.state, [skyward(assignmentRun("2026-10-10T19:00:00.000Z"))], settings, "2026-10-10T19:00:00.000Z", ids);
  assert(current.state.scopes.every(scope => scope.part !== "expected-student"));
  assert(current.changes.some(change => change.entity === "collection" &&
    change.fields.some(field => field.before === "failed" && field.after === "complete")));
});

test("collection failure and recovery are persisted once as deterministic health transitions", () => {
  const initial = detectReviewChanges(undefined, [skyward()], config(), instant, ids);
  const failed = assignmentRun(later);
  failed.status = "auth-required";
  failed.students[0].sections.forEach(section => { section.status = "auth-required"; section.verifiedEmpty = false; });
  const failure = detectReviewChanges(initial.state, [skyward(failed)], config(), later, ids);
  assert.equal(failure.changes.filter(change => change.entity === "collection").length, 4);
  assert.equal(detectReviewChanges(failure.state, [skyward(failed)], config(), later, ids).changes.length, 0);
  const restoredAt = "2026-10-10T18:00:00.000Z";
  const restored = detectReviewChanges(failure.state, [skyward(assignmentRun(restoredAt))], config(), restoredAt, ids);
  const review = prioritizeReview(restored.state, restored.changes, [], config(), new Date(restoredAt), ids);
  assert(review.actions.some(action => action.reasons.includes("collection-recovered") && action.priority === "normal"));
  assert(restored.changes.some(change => change.fields.some(field => field.before === "auth-required" && field.after === "complete")));
});
