import type { AssignmentRun, AssignmentSection, AssignmentStudentIdentity, CollectedAssignment } from "@schoolhawk/core/assignments";

export interface AssignmentRunSummary {
  runId: string;
  capturedAt: string;
  status: AssignmentRun["status"];
  studentCount: number;
}

export type CanvasMatchStatus = "pending" | "unmatched" | "review-required" | "linked";
export type CanvasMatchReason = "ambiguous" | "date-conflict" | "undated" | "already-linked" | "source-incomplete" | "source-stale" | "not-observed" | "scope-conflict";

export interface StoredAssignment {
  student: AssignmentStudentIdentity;
  assignment: CollectedAssignment;
  section: AssignmentSection["kind"];
  runId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  canvasStatus: CanvasMatchStatus;
  canvasAccountId: string | null;
  canvasRecordId: string | null;
  canvasLinkId: string | null;
  canvasMatchReason: CanvasMatchReason | null;
  lastMatchAttemptAt: string | null;
  matchAttempts: number;
}

export interface AssignmentStore {
  importAssignmentRun(accountId: string, input: unknown): "imported" | "already-imported";
  getAssignmentRun(accountId: string, runId: string): AssignmentRun | undefined;
  listAssignmentRuns(accountId: string, limit?: number): AssignmentRunSummary[];
  listAssignments(accountId: string, options?: { studentId?: string; limit?: number; offset?: number }): StoredAssignment[];
  close(): void;
}