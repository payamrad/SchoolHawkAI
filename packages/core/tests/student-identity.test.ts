import assert from "node:assert/strict";
import { test } from "node:test";
import { withDiagnosticSink, type DiagnosticEvent } from "../diagnostics";
import { childFor, reviewConfigSchema, reviewResultSchema } from "../review";
import { normalizeStudentFullName, resolveReviewStudents } from "../student-identity";
import { buildStudentSnapshot } from "../student-snapshot";
import { config, ids, instant, namedFamilyFixture, snapshotReview } from "./review-fixtures";

function resolve(...args: Parameters<typeof resolveReviewStudents>) {
  const events: DiagnosticEvent[] = [];
  const result = withDiagnosticSink(event => events.push(event), () => resolveReviewStudents(...args));
  return { ...result, events };
}

test("full names normalize case, whitespace, Unicode and comma order without fuzzy or first-name matching", () => {
  assert.equal(normalizeStudentFullName({ name: "  QUINN,   Avery " }), "avery quinn");
  assert.equal(normalizeStudentFullName({ name: "Avery Quinn" }), "avery quinn");
  assert.equal(normalizeStudentFullName({ name: "QUINN,", firstName: "Avery", lastName: "Quinn" }), "avery quinn");
  assert.equal(normalizeStudentFullName({ name: "Avery Quinn", sortableName: "Quinn, Avery" }), "avery quinn");
  assert.equal(normalizeStudentFullName({ name: "Zo\u00eb O\u2019Neil" }), "zo\u00eb o'neil");
  for (const name of ["QUINN,", "Avery", "A. Quinn", "Quinn, Avery, Jr."]) {
    assert.equal(normalizeStudentFullName({ name }), null);
  }
  assert.notEqual(normalizeStudentFullName({ name: "Avery Quinn" }), normalizeStudentFullName({ name: "Avery Rowan" }));
  assert.notEqual(normalizeStudentFullName({ name: "Avery Quinn" }), normalizeStudentFullName({ name: "Avery Quinne" }));
});

test("binding-only mode preserves existing behavior and does not read student history", () => {
  const { settings } = namedFamilyFixture();
  settings.studentMatching = "bindings";
  const history = { *[Symbol.iterator](): Generator<never> { throw new Error("History must not be read."); } };
  assert.deepEqual(resolve(settings, history), { config: settings, notices: [], events: [] });
  assert.equal(config().studentMatching, "bindings");
  assert.throws(() => reviewConfigSchema.parse({ ...settings, studentMatching: "fuzzy" }));
  assert.throws(() => reviewConfigSchema.parse({ ...settings, studentMatching: "unique-full-name", children: [] }));
});

test("matching full names reconcile three portal aliases into two children without changing input or source records", () => {
  const fixture = namedFamilyFixture();
  const before = JSON.stringify(fixture);
  const result = resolve(fixture.settings, fixture.history);
  assert.deepEqual(result.config.children.map(child => child.id), ["avery", "casey"]);
  assert.equal(childFor(result.config, { portal: "canvas", accountId: "canvas-parent", studentId: "10" }), "avery");
  assert.equal(childFor(result.config, { portal: "skyward", accountId: "parent", studentId: "student-1" }), "avery");
  assert.equal(childFor(result.config, { portal: "skyward", accountId: "parent", studentId: "student-2" }), "casey");
  assert.equal(result.config.children[0].bindings.length, 2);
  assert.deepEqual(result.notices, []);
  assert.equal(JSON.stringify(fixture), before);
  assert.deepEqual(resolve(fixture.settings, fixture.history.slice().reverse()).config, result.config);
});

test("a newly observed portal ID can join an anchored child by name without an explicit second binding", () => {
  const { settings, history } = namedFamilyFixture();
  settings.children = settings.children.filter(child => child.id !== "canvas-avery");
  const result = resolve(settings, history);
  assert.equal(result.config.children.length, 2);
  assert.equal(childFor(result.config, { portal: "canvas", accountId: "canvas-parent", studentId: "10" }), "avery");
});

test("matching is limited to authorized sources and unrelated names remain unmapped", () => {
  const { settings, history, canvas } = namedFamilyFixture();
  settings.children = settings.children.filter(child => child.id !== "canvas-avery");
  Object.assign(canvas.students[0], { name: "Morgan Lane", sortableName: null });
  const result = resolve(settings, history);
  assert.equal(childFor(result.config, { portal: "canvas", accountId: "canvas-parent", studentId: "10" }), null);
  assert.throws(() => resolve(settings, [...history, { ...history[1], accountId: "outside-family" }]), /outside the configured sources/);
});

test("siblings sharing a given name but not a full name stay separate", () => {
  const { settings, history, skyward } = namedFamilyFixture();
  Object.assign(skyward.students[1], { name: "ROWAN, AVERY", firstName: "Avery", lastName: "Rowan" });
  const result = resolve(settings, history);
  assert.equal(result.config.children.length, 2);
  assert.equal(childFor(result.config, { portal: "skyward", accountId: "parent", studentId: "student-2" }), "casey");
  assert.equal(childFor(result.config, { portal: "canvas", accountId: "canvas-parent", studentId: "10" }), "avery");
});

test("incomplete names are not matched and diagnostics do not contain names or source IDs", () => {
  const { settings, history, canvas } = namedFamilyFixture();
  Object.assign(canvas.students[0], { name: "Avery", sortableName: null });
  const result = resolve(settings, history);
  assert.equal(result.config.children.length, 3);
  assert.deepEqual(result.notices, ["student-name-unverified"]);
  assert.equal(result.events[0].code, "STUDENT_NAME_UNVERIFIED");
  assert.doesNotMatch(JSON.stringify(result.events), /Avery|Quinn|student-1|canvas-parent/);
});

test("same full names on two identities in one account are ambiguous, not automatically merged", () => {
  const { settings, history, skyward } = namedFamilyFixture();
  Object.assign(skyward.students[1], { name: "QUINN, AVERY", firstName: "Avery", lastName: "Quinn" });
  const result = resolve(settings, history);
  assert.equal(result.config.children.length, 3);
  assert.deepEqual(result.notices, ["student-name-ambiguous"]);
  assert.equal(result.events[0].code, "STUDENT_NAME_AMBIGUOUS");
  assert.doesNotMatch(JSON.stringify(result.events), /Avery|Quinn|student-1|canvas-parent/);
});

test("conflicting child rules prevent automatic merging rather than silently choosing a policy", () => {
  const { settings, history } = namedFamilyFixture();
  settings.children[2].rules = { upcomingDays: 14 };
  const result = resolve(settings, history);
  assert.equal(result.config.children.length, 3);
  assert.deepEqual(result.notices, ["student-name-ambiguous"]);
  settings.children[0].rules = { upcomingDays: 14 };
  assert.equal(resolve(settings, history).config.children.length, 2);
});

test("retained incomplete display names do not override complete names for the same source identity", () => {
  const { settings, history, skyward } = namedFamilyFixture();
  const old = structuredClone(skyward);
  for (const student of old.students) {
    student.name = `${student.lastName},`;
    delete student.firstName;
    delete student.lastName;
  }
  const result = resolve(settings, [{ portal: "skyward", section: "assignments", accountId: "parent", run: old }, ...history]);
  assert.equal(result.config.children.length, 2);
  assert.deepEqual(result.notices, []);
});

test("contradictory full-name history keeps the identity separate and warns instead of changing its owner", () => {
  const { settings, history, skyward } = namedFamilyFixture();
  const other = structuredClone(skyward);
  Object.assign(other.students[0], { name: "QUINN, MORGAN", firstName: "Morgan", lastName: "Quinn" });
  const result = resolve(settings, [...history, { portal: "skyward", section: "assignments", accountId: "parent", run: other }]);
  assert.equal(result.config.children.length, 3);
  assert.deepEqual(result.notices, ["student-name-ambiguous"]);
});

test("pure snapshot construction uses the review's resolved identities and validates matching metadata", () => {
  const { settings, history } = namedFamilyFixture();
  const review = snapshotReview(history, settings);
  const snapshot = buildStudentSnapshot(history, settings, review, { courses: [], assignments: [] }, ids);
  assert.equal(snapshot.totals.students, 2);
  assert.deepEqual(snapshot.students.map(student => student.label), ["avery", "casey"]);
  assert.equal(snapshot.totals.assignmentSourceRecords, 3);
  assert.equal(snapshot.generatedAt, instant);
  assert.throws(() => buildStudentSnapshot(history, settings, { ...review, resolvedChildren: undefined },
    { courses: [], assignments: [] }, ids), /student matching does not match/);
  assert.throws(() => reviewResultSchema.parse({ ...review, resolvedChildren: review.resolvedChildren!.slice(0, 1) }));
  const duplicate = structuredClone(review);
  duplicate.resolvedChildren![1].bindings.push(duplicate.resolvedChildren![0].bindings[0]);
  assert.throws(() => reviewResultSchema.parse(duplicate));
});
