import { createHash } from "node:crypto";
import { ReviewError } from "./review";
import { studentSnapshotSchema, type SnapshotRecord, type StudentSnapshot } from "./schemas/student-snapshot";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new ReviewError("Report comparison received an unsupported value.");
}

function ordered(values: unknown[]): string[] {
  return values.map(canonical).sort();
}

function recordInput(record: SnapshotRecord) {
  const encode = (data: SnapshotRecord["history"][number]["data"]) => canonical("submissionTypes" in data
    ? { ...data, submissionTypes: data.submissionTypes.slice().sort(), allowedExtensions: data.allowedExtensions.slice().sort() } : data);
  const history: string[] = [];
  // Preserve reversals (A -> B -> A), but not repeat observations of the same facts.
  for (const version of record.history) {
    const data = encode(version.data);
    if (history.at(-1) !== data) history.push(data);
  }
  const current = record.history.find(version => version.id === record.currentVersionRef);
  return {
    id: record.id, kind: record.kind, portal: record.portal, accountRef: record.accountRef, studentRef: record.studentRef,
    history, observedInLatestCollection: record.observedInLatestCollection, currentSelection: record.currentSelection,
    current: current ? encode(current.data) : null,
    latest: [...new Set(record.history.filter(version => record.latestVersionRefs.includes(version.id))
      .map(version => encode(version.data)))].sort(),
    ...(record.kind === "message" ? { studentRefs: record.studentRefs.slice().sort(), association: record.association } : {}),
  };
}

export function fingerprintReportInput(input: StudentSnapshot, perStudent = false): { scopeHash: string; inputHash: string } {
  const snapshot = studentSnapshotSchema.parse(input);
  const accounts = [...new Set([...snapshot.students.flatMap(student => student.accountRefs),
    ...snapshot.sources.map(source => source.accountRef)])].sort();
  const sections = ordered(snapshot.collectionHealth.map(scope => ({
    id: scope.id, portal: scope.portal, section: scope.section, studentRef: scope.studentRef, part: scope.part,
  })));
  const scope = {
    version: 1, perStudent, accounts, sections, students: snapshot.students.map(student => student.id).sort(),
  };
  const content = {
    version: 1, timeZone: snapshot.timeZone, schoolYearPolicy: snapshot.schoolYearPolicy,
    assignmentDays: snapshot.selection.assignments.days, messageDays: snapshot.selection.messages.days,
    rules: snapshot.rules, childRules: ordered(snapshot.childRules),
    students: ordered(snapshot.students.map(student => ({
      id: student.id, label: student.label, configuredIdentity: student.configuredIdentity,
      accountRefs: student.accountRefs.slice().sort(),
      courses: ordered(student.courses.map(course => ({
        id: course.id, name: course.name, sources: ordered(course.sources),
        assignments: ordered(course.assignments.map(recordInput)),
        grades: ordered(course.grades.map(recordInput)),
        earlierAssignmentGrades: ordered(course.earlierAssignmentGrades.map(recordInput)),
      }))),
    }))),
    messages: ordered(snapshot.messages.map(recordInput)),
    confirmedLinks: {
      courses: ordered(snapshot.confirmedLinks.courses.map(link => ({ ...link, sourceCourseRefs: link.sourceCourseRefs.slice().sort() }))),
      assignments: ordered(snapshot.confirmedLinks.assignments.map(link => ({ ...link, recordRefs: link.recordRefs.slice().sort() }))),
    },
  };
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  return { scopeHash: hash(scope), inputHash: hash(content) };
}
