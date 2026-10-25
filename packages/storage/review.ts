import type { ReviewChange, ReviewConfig, ReviewEvidence, ReviewResult } from "@schoolhawk/core/review";
import type { StudentSnapshot, StudentSnapshotOptions } from "@schoolhawk/core/student-snapshot";

export interface ReviewStore {
  processReview(config: ReviewConfig, now?: Date): ReviewResult;
  createStudentSnapshot(config: ReviewConfig, now?: Date, options?: StudentSnapshotOptions): StudentSnapshot;
  getReview(profileId: string, evaluationId?: string): ReviewResult | undefined;
  listReviewChanges(profileId: string, options?: { since?: string; limit?: number; offset?: number }): ReviewChange[];
  explainReviewSource(profileId: string, evaluationId: string, sourceId: string): ReviewEvidence;
}
