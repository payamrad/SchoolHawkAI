import type { CanvasAssignment, CanvasAssignmentLink, CanvasAssignmentRun, CanvasCourse, CanvasCourseMapping,
  CanvasStudent, StoredCanvasCourseMapping } from "@schoolhawk/core/canvas-assignments";
import type { AssignmentMatchMethod, assignmentMatchWindow } from "@schoolhawk/core/assignment-correlation";
import type { AssignmentRunSummary, CanvasMatchReason, StoredAssignment } from "./assignments";

export class CanvasMappingError extends Error {
  constructor(readonly code: "NO_COURSE_MAPPINGS" | "COURSE_MAPPING_NOT_FOUND") {
    super(code === "NO_COURSE_MAPPINGS"
      ? "No confirmed course mapping. Review and confirm student/course identities before matching."
      : "The selected course mapping was not found for this Canvas account.");
  }
}

export interface StoredCanvasAssignment {
  student: Pick<CanvasStudent, "id" | "name" | "sortableName">;
  course: Pick<CanvasCourse, "id" | "name" | "code" | "termId">;
  assignment: CanvasAssignment;
  runId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CanvasRunSummary {
  runId: string;
  capturedAt: string;
  status: CanvasAssignmentRun["status"];
  studentCount: number;
}

export interface CanvasCorrelationProposal {
  canvasAssignmentId: string;
  title: string;
  dueDate: string | null;
  canvasRunId: string;
  status: "candidate" | "ambiguous" | "unmatched" | "linked";
  linkId?: string;
  candidates: { skywardAssignmentId: string; title: string; dueDate: string | null; skywardRunId: string;
    method: AssignmentMatchMethod; confirmationKey?: string }[];
}

export interface EnrichedAssignment extends StoredAssignment {
  skyward: { latestCollection: AssignmentRunSummary | undefined; scopeStatus: "complete" | "partial" | "failed" | "auth-required" | "not-observed";
    observedInLatestCollection: boolean };
  canvas: { record: StoredCanvasAssignment; link: CanvasAssignmentLink; latestCollection: CanvasRunSummary | undefined;
    scopeStatus: CanvasCourse["status"] | "not-observed"; observedInLatestCollection: boolean;
    conflicts: ("due-date" | "possible-points")[] } | null;
}

export interface CanvasMatchOptions {
  lookbackDays: number;
  mappingId?: string;
  dryRun?: boolean;
  maxSourceAgeHours?: number;
  now?: Date;
}

export interface CanvasMatchItem {
  mappingId: string;
  skywardAccountId: string;
  skywardStudentId: string;
  skywardAssignmentId: string;
  skywardObservationRunId: string;
  latestSkywardRunId: string | null;
  latestCanvasRunId: string | null;
  dueDate: string;
  status: "would-link" | "linked" | "already-linked" | "unmatched" | "review-required";
  reason: CanvasMatchReason | null;
  canvasAssignmentId?: string;
  linkId?: string;
  candidateIds: string[];
}

export interface CanvasMatchRun {
  runId: string;
  matcherVersion: 1;
  accountId: string;
  attemptedAt: string;
  window: ReturnType<typeof assignmentMatchWindow>;
  dryRun: boolean;
  maxSourceAgeHours: number;
  mappingCount: number;
  outsideWindow: number;
  undated: number;
  linked: number;
  wouldLink: number;
  alreadyLinked: number;
  unmatched: number;
  reviewRequired: number;
  items: CanvasMatchItem[];
}

export interface CanvasAssignmentStore {
  importCanvasAssignmentRun(accountId: string, input: unknown): "imported" | "already-imported";
  getCanvasAssignmentRun(accountId: string, runId: string): CanvasAssignmentRun | undefined;
  listCanvasAssignmentRuns(accountId: string, limit?: number): CanvasRunSummary[];
  listCanvasAssignments(accountId: string, options?: { studentId?: string; courseId?: string; limit?: number; offset?: number }): StoredCanvasAssignment[];
  saveCanvasCourseMapping(accountId: string, input: CanvasCourseMapping): StoredCanvasCourseMapping;
  listCanvasCourseMappings(accountId: string): StoredCanvasCourseMapping[];
  proposeCanvasAssignmentLinks(accountId: string, mappingId: string): CanvasCorrelationProposal[];
  confirmCanvasAssignmentLink(accountId: string, mappingId: string, confirmationKey: string): CanvasAssignmentLink;
  listCanvasAssignmentLinks(accountId: string): CanvasAssignmentLink[];
  matchCanvasAssignments(accountId: string, options: CanvasMatchOptions): CanvasMatchRun;
  getCanvasMatchRun(accountId: string, runId: string): CanvasMatchRun | undefined;
  listEnrichedAssignments(accountId: string, options?: { studentId?: string; limit?: number; offset?: number }): EnrichedAssignment[];
  close(): void;
}