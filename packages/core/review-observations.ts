import type { AssignmentRun } from "./schemas/assignments";
import type { GradeRun } from "./schemas/grades";
import type { MessageRun } from "./schemas/messages";
import type { CanvasAssignmentRun } from "./schemas/canvas-assignments";
import {
  semanticText, type ReviewCoverage, type ReviewEvidence, type ReviewFields, type ReviewIdFactory,
  type ReviewObservation, type ReviewPortal, type ReviewRecord, type ReviewScopeObservation, type ReviewSection,
} from "./review";

export type ReviewSourceRun =
  { portal: "skyward"; section: "assignments"; run: AssignmentRun } |
  { portal: "skyward"; section: "grades"; run: GradeRun } |
  { portal: "skyward"; section: "messages"; run: MessageRun } |
  { portal: "canvas"; section: "assignments"; run: CanvasAssignmentRun };

export function reviewStreamId(ids: ReviewIdFactory, portal: ReviewPortal, accountId: string, section: ReviewSection): string {
  return ids("stream", [portal, accountId, section]);
}

export function reviewRecordId(ids: ReviewIdFactory, portal: ReviewPortal, accountId: string, section: ReviewSection,
  studentId: string | null, courseId: string | null, recordId: string): string {
  return ids("record", [portal, accountId, section, studentId, courseId, recordId]);
}

function fields(values: Partial<ReviewFields> & Pick<ReviewFields, "title">): ReviewFields {
  return {
    course: null, dueDate: null, dueAt: null, missing: null, grade: null, score: null, maxScore: null, status: null,
    term: null, gradingScale: null, sentDate: null, unread: null, contentHash: null, ...values,
  };
}

export function normalizeReviewObservation(source: ReviewSourceRun, accountId: string, fingerprint: string,
  ids: ReviewIdFactory): ReviewObservation {
  const { portal, section, run } = source;
  const streamId = reviewStreamId(ids, portal, accountId, section);
  const evidence = (studentId: string | null, courseId: string | null, recordId: string | null,
    capturedAt = run.capturedAt, url: string | null = null): ReviewEvidence => ({
    id: ids("source", [portal, accountId, section, studentId, courseId, recordId, run.runId, capturedAt]),
    portal, accountId, section, studentId, courseId, recordId, runId: run.runId, capturedAt, parserVersion: run.parserVersion, url,
  });
  const record = (entity: ReviewRecord["entity"], studentId: string | null, courseId: string | null,
    id: string, values: ReviewFields, source: { capturedAt: string; url: string }): ReviewRecord => ({
    id: reviewRecordId(ids, portal, accountId, section, studentId, courseId, id),
    entity, fields: values, evidence: evidence(studentId, courseId, id, source.capturedAt, source.url),
  });
  const full = (marker: string): ReviewCoverage => ({ kind: "full", startDate: null, endDate: null, marker });
  const scope = (studentId: string | null, courseId: string | null, part: string,
    status: ReviewScopeObservation["status"], coverage: ReviewCoverage, records: ReviewRecord[]): ReviewScopeObservation => ({
    id: ids("scope", [portal, accountId, section, studentId, courseId, part]), streamId,
    studentId, courseId, part, status, coverage, records, evidence: evidence(studentId, courseId, null),
  });
  const contentHash = (value: string | null) => value === null ? null : ids("content", [semanticText(value)]);
  const scopes: ReviewScopeObservation[] = [];
  if (source.portal === "skyward" && source.section === "assignments") {
    for (const student of source.run.students) for (const section of student.sections) {
      scopes.push(scope(student.id, null, section.kind, section.status, section.kind === "past" ? {
        kind: "window", startDate: source.run.window.startDate, endDate: null, marker: "all-year-past",
      } : full(`all-year-${section.kind}`), section.assignments.map(assignment => record("assignment", student.id, null,
        assignment.id, fields({
          title: assignment.title, course: assignment.course, dueDate: assignment.dueDate, missing: assignment.missing,
          grade: assignment.grade, score: assignment.score, maxScore: assignment.maxScore, status: assignment.scoreStatus,
          contentHash: contentHash(assignment.description),
        }), assignment.source))));
    }
  } else if (source.portal === "skyward" && source.section === "grades") {
    for (const student of source.run.students) {
      const marker = JSON.stringify([student.periods.slice().sort(),
        [...new Set(student.grades.flatMap(grade => grade.schoolYear === null ? [] : [grade.schoolYear]))].sort()]);
      scopes.push(scope(student.id, null, "grades", student.status, full(marker), student.grades.map(grade =>
        record("grade", student.id, null, grade.id, fields({
          title: grade.term, course: grade.course, grade: grade.grade, score: grade.score, maxScore: grade.maxScore,
          status: grade.periodStatus, term: grade.term, gradingScale: grade.gradingScale,
        }), grade.source))));
    }
  } else if (source.portal === "skyward" && source.section === "messages") {
    const run = source.run;
    scopes.push(scope(null, null, "messages", run.status, {
      kind: run.selection === "unread" ? "unread" : "window", startDate: run.window.startDate,
      endDate: run.window.endDate, marker: run.selection ?? "all",
    }, run.messages.map(message => record("message", null, null, message.id, fields({
      title: message.subject, sentDate: message.sentDate, unread: message.unreadBeforeOpen,
      contentHash: contentHash(message.bodyText),
    }), message.source))));
  } else if (source.portal === "canvas") {
    for (const student of source.run.students) {
      scopes.push(scope(student.id, null, "courses", student.discoveryComplete ? "complete" : student.status === "auth-required" ?
        "auth-required" : "partial", { ...full("active-courses"), kind: "discovery" }, []));
      for (const course of student.courses) {
        scopes.push(scope(student.id, course.id, "assignments", course.status, full(`term:${course.termId ?? "unknown"}`),
          course.assignments.map(assignment => record("assignment", student.id, course.id, assignment.id, fields({
            title: assignment.title, course: course.name, dueDate: assignment.dueDate, dueAt: assignment.dueAt,
            maxScore: assignment.pointsPossible === null ? null : String(assignment.pointsPossible),
            gradingScale: assignment.gradingType, contentHash: contentHash(assignment.description),
          }), assignment.source))));
      }
    }
  }
  return {
    streamId, runId: run.runId, capturedAt: run.capturedAt, fingerprint, status: run.status,
    discoveryComplete: "discoveryComplete" in run ? run.discoveryComplete : true,
    evidence: evidence(null, null, null), scopes,
  };
}
