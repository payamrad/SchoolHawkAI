import type { ReviewChange, ReviewConfig, ReviewEvidence, ReviewResult } from "@schoolhawk/core/review";

export interface ReviewStore {
  processReview(config: ReviewConfig, now?: Date): ReviewResult;
  getReview(profileId: string, evaluationId?: string): ReviewResult | undefined;
  listReviewChanges(profileId: string, options?: { since?: string; limit?: number; offset?: number }): ReviewChange[];
  explainReviewSource(profileId: string, evaluationId: string, sourceId: string): ReviewEvidence;
}
