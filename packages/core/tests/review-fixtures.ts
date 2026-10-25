import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AssignmentRun, CollectedAssignment } from "../schemas/assignments";
import type { GradeRun } from "../schemas/grades";
import type { MessageRun } from "../schemas/messages";
import type { CanvasAssignmentRun } from "../schemas/canvas-assignments";
import { assignmentMatchWindow } from "../assignment-correlation";
import { reviewConfigSchema, reviewResultSchema, rulesFor, type ReviewIdFactory, type ReviewConfig } from "../review";
import { normalizeReviewObservation, type ReviewSourceRun } from "../review-observations";
import { detectReviewChanges } from "../change-detection";
import { prioritizeReview } from "../prioritization";
import { resolveReviewStudents } from "../student-identity";
import type { SnapshotHistoryRun } from "../student-snapshot";

export const instant = "2026-10-10T16:00:00.000Z";
export const ids: ReviewIdFactory = (kind, parts) => `${kind}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

export function config(overrides: Partial<z.input<typeof reviewConfigSchema>> = {}) {
  return reviewConfigSchema.parse({
    version: 1, profileId: "family",
    sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments"] }],
    children: [{ id: "private-child-alias", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-1" }] }],
    ...overrides,
  });
}

export function assignment(capturedAt = instant, overrides: Partial<CollectedAssignment> = {}): CollectedAssignment {
  return {
    id: "assignment-1", title: "PRIVATE_TITLE", course: "Synthetic Course", section: null, teacher: "PRIVATE_TEACHER",
    dueDate: "2026-10-12", assignedDate: null, description: "PRIVATE_DESCRIPTION", category: null,
    grade: null, score: null, scoreStatus: null, maxScore: "10", weight: null, attempts: null, attachmentCount: null, missing: false,
    source: { portal: "skyward", url: "https://example.test/assignments", capturedAt }, ...overrides,
  };
}

export function assignmentRun(capturedAt = instant, assignments = [assignment(capturedAt)]): AssignmentRun {
  return {
    runId: randomUUID(), capturedAt, parserVersion: 1, discoveryComplete: true, status: "complete",
    window: assignmentMatchWindow(7, new Date(capturedAt)),
    students: [{
      id: "student-1", name: "PRIVATE_STUDENT_NAME", firstName: "PRIVATE_FIRST", lastName: "PRIVATE_LAST",
      sections: (["upcoming", "missing", "past"] as const).map(kind => {
        const records = assignments.filter(assignment => assignment.missing ? kind === "missing" :
          kind === (assignment.dueDate && assignment.dueDate < "2026-10-10" ? "past" : "upcoming"));
        return { kind, status: "complete", assignments: records, scannedCount: records.length, pages: 1, verifiedEmpty: !records.length };
      }),
    }],
  };
}

export function gradeRun(capturedAt = instant, grade: string | null = "B"): GradeRun {
  return {
    runId: randomUUID(), capturedAt, parserVersion: 1, discoveryComplete: true, status: "complete",
    students: [{ id: "student-1", name: "PRIVATE_STUDENT_NAME", firstName: "PRIVATE_FIRST", lastName: "PRIVATE_LAST",
      status: "complete", periods: ["T1"], scannedCount: 1, pages: 1, verifiedEmpty: false,
      grades: [{ id: "bucket-1", studentSectionId: "section-1", courseCode: "SYNTH", course: "Synthetic Course",
        classDetails: null, section: null, teacher: null, termId: "term-1", term: "T1", periodStatus: "open", schoolYear: null,
        grade, score: null, maxScore: null, gradingScale: null, effectiveDate: null,
        source: { portal: "skyward", url: "https://example.test/grades", capturedAt } }],
    }],
  };
}

export function canvasRun(capturedAt = instant, empty = false): CanvasAssignmentRun {
  return {
    runId: randomUUID(), capturedAt, parserVersion: 1, status: "complete", discoveryComplete: true,
    students: [{ id: "10", name: "PRIVATE_CANVAS_STUDENT", sortableName: null, status: "complete", discoveryComplete: true,
      courses: [{ id: "20", name: "Synthetic Course", code: "SYNTH", termId: "1",
        status: "complete", pages: 1, scannedCount: empty ? 0 : 1, verifiedEmpty: empty,
        assignments: empty ? [] : [{
          id: "40", courseId: "20", title: "PRIVATE_TITLE", description: "PRIVATE_CANVAS_INSTRUCTIONS",
          dueAt: "2026-10-13T06:59:00.000Z", dueDate: "2026-10-12", unlockAt: null, lockAt: null,
          createdAt: null, updatedAt: null, pointsPossible: 10, gradingType: "points",
          submissionTypes: ["on_paper"], allowedExtensions: [], externalTool: false, lockedForUser: null, hasOverrides: null,
          source: { portal: "canvas", url: "https://example.test/courses/20/assignments/40", capturedAt, dateScope: "student" },
        }],
      }],
    }],
  };
}

export function namedFamilyFixture(capturedAt = instant) {
  const skyward = assignmentRun(capturedAt);
  Object.assign(skyward.students[0], { name: "QUINN, AVERY", firstName: "Avery", lastName: "Quinn" });
  skyward.students.push({ ...structuredClone(skyward.students[0]),
    id: "student-2", name: "ROWAN, CASEY", firstName: "Casey", lastName: "Rowan" });
  const canvas = canvasRun(capturedAt);
  Object.assign(canvas.students[0], { name: "  avery   QUINN  ", sortableName: "Quinn, Avery" });
  const settings = config({
    studentMatching: "unique-full-name",
    sources: [
      { portal: "skyward", accountId: "parent", sections: ["assignments"] },
      { portal: "canvas", accountId: "canvas-parent", sections: ["assignments"] },
    ],
    children: [
      { id: "avery", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-1" }] },
      { id: "casey", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-2" }] },
      { id: "canvas-avery", bindings: [{ portal: "canvas", accountId: "canvas-parent", studentId: "10" }] },
    ],
  });
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "assignments", accountId: "parent", run: skyward },
    { portal: "canvas", section: "assignments", accountId: "canvas-parent", run: canvas },
  ];
  return { skyward, canvas, settings, history };
}

export function messageRun(capturedAt = instant, unread = true): MessageRun {
  return {
    runId: randomUUID(), capturedAt, parserVersion: 1, status: "complete",
    window: assignmentMatchWindow(7, new Date(capturedAt)), selection: "all", scannedCount: 2,
    messages: [{ id: "message-1", sender: "PRIVATE_SENDER", subject: "Synthetic message", sentDate: "2026-10-10",
      displayedDate: "Today", unreadBeforeOpen: unread, bodyText: "PRIVATE_MESSAGE_BODY",
      source: { portal: "skyward", url: "https://example.test/messages", capturedAt } }],
  };
}

export function observation(source: ReviewSourceRun, accountId = "parent") {
  return normalizeReviewObservation(source, accountId, ids("fingerprint", [source.run]), ids);
}

export function snapshotReview(history: SnapshotHistoryRun[], settings: ReviewConfig, now = new Date(instant)) {
  const resolution = resolveReviewStudents(settings, history);
  const resolved = resolution.config;
  const observations = history.map(source => normalizeReviewObservation(source, source.accountId, ids("fingerprint", [source.run]), ids));
  const detected = detectReviewChanges(undefined, observations, resolved, now.toISOString(), ids, settings);
  return reviewResultSchema.parse({
    version: 1, engineVersion: 1, id: ids("review", [observations.map(source => source.runId), now.toISOString()]),
    profileId: settings.profileId, evaluatedAt: now.toISOString(),
    recentSince: new Date(now.getTime() - settings.briefing.recentHours * 3600000).toISOString(),
    timeZone: settings.timeZone, rules: settings.rules,
    childRules: resolved.children.map(child => ({ childId: child.id, rules: rulesFor(resolved, child.id) })),
    ...(settings.studentMatching === "unique-full-name" ? { resolvedChildren: resolved.children } : {}),
    briefingOptions: settings.briefing, bootstrap: true, changes: detected.changes,
    ...prioritizeReview(detected.state, detected.changes, [], resolved, now, ids),
    notices: [...new Set([...detected.notices, ...resolution.notices])],
  });
}
