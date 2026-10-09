import type { CollectedGrade, GradeRun, GradeStudent } from "@schoolhawk/core/grades";

export interface GradeRunSummary {
  runId: string;
  capturedAt: string;
  status: GradeRun["status"];
  studentCount: number;
}

export interface StoredGrade {
  student: Pick<GradeStudent, "id" | "name" | "firstName" | "lastName">;
  grade: CollectedGrade;
  runId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface GradeStore {
  importGradeRun(accountId: string, input: unknown): "imported" | "already-imported";
  getGradeRun(accountId: string, runId: string): GradeRun | undefined;
  listGradeRuns(accountId: string, limit?: number): GradeRunSummary[];
  listGrades(accountId: string, options?: { studentId?: string; limit?: number }): StoredGrade[];
  close(): void;
}