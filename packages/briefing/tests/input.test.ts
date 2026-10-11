import assert from "node:assert/strict";
import { test } from "node:test";
import { detectReviewChanges } from "@schoolhawk/core/change-detection";
import { prioritizeReview } from "@schoolhawk/core/prioritization";
import { reviewResultSchema, type ReviewConfig, type ReviewResult } from "@schoolhawk/core/review";
import { assignment, assignmentRun, config, ids, instant, messageRun, observation } from "../../core/tests/review-fixtures";
import { briefingInputSchema, buildBriefingInput, renderDeterministicBriefing, serializeBriefingInput } from "../index";

function sample(settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "messages"] }] }),
  recordCount = 1): ReviewResult {
  const run = assignmentRun(instant, Array.from({ length: recordCount }, (_, index) =>
    assignment(instant, { id: `assignment-${index}`, missing: true, title: "Synthetic deadline" })));
  const detected = detectReviewChanges(undefined, [
    observation({ portal: "skyward", section: "assignments", run }),
    ...(settings.sources.some(source => source.sections.includes("messages"))
      ? [observation({ portal: "skyward", section: "messages", run: messageRun() })] : []),
  ], settings, instant, ids);
  return result(detected, settings);
}

function result(detected: ReturnType<typeof detectReviewChanges>, settings: ReviewConfig): ReviewResult {
  return reviewResultSchema.parse({
    version: 1, engineVersion: 1, id: ids("review", ["fixture"]), profileId: settings.profileId,
    evaluatedAt: instant, recentSince: "2026-10-09T16:00:00.000Z", timeZone: settings.timeZone,
    rules: settings.rules, childRules: settings.children.map(child => ({ childId: child.id, rules: settings.rules })),
    briefingOptions: settings.briefing, bootstrap: detected.bootstrap, changes: detected.changes,
    ...prioritizeReview(detected.state, detected.changes, [], settings, new Date(instant), ids),
    notices: detected.notices,
  });
}

test("briefing JSON is provider-neutral, pseudonymous, grounded and free of identity/body fields", () => {
  const review = sample();
  const input = buildBriefingInput(review);
  const encoded = serializeBriefingInput(input);
  assert(encoded.length > 0);
  assert(Buffer.byteLength(encoded) <= 32768);
  assert.doesNotMatch(encoded, /PRIVATE_|private-child-alias|student-1|accountId|studentId|recordId|https?:|bodyText|contentHash.*content_/);
  assert.deepEqual(input.children, ["child-1"]);
  assert.equal(input.contentTrust, "untrusted-source-data");
  assert.equal(input.privacy, "minimized-not-anonymized");
  assert(input.items.some(item => item.childRef === "child-1"));
  assert(input.items.every(item => item.sourceRefs.every(id => input.sources.some(source => source.id === id))));
  assert(input.items.every(item => item.delivery === "daily"));
  assert.deepEqual(briefingInputSchema.parse(JSON.parse(encoded)), input);
  assert.equal(input.coverage.limited, true);
});

test("UTF-8 bytes and item limits are enforced with explicit high-priority omissions", () => {
  for (const maxBytes of [4096, 8192, 32768]) {
    const review = sample(config({ briefing: { maxItems: 4, maxBytes } }), 20);
    for (const action of review.actions) {
      action.title = "\u00e9".repeat(500);
      if (action.facts) action.facts.title = action.title;
    }
    const input = buildBriefingInput(review);
    const json = serializeBriefingInput(input);
    assert(Buffer.byteLength(json, "utf8") <= maxBytes);
    assert(input.items.length <= 4);
    assert.equal(input.items.length + input.omitted.items, review.actions.length);
    assert(input.omitted.highPriority > 0);
    assert.equal(input.conclusion, "incomplete");
    assert(input.items.every(item => item.title.length <= 240 && item.textTruncated));
  }
});

test("malformed/dangling references, unknown fields and misleading all-clears fail validation", () => {
  const input = buildBriefingInput(sample());
  assert.throws(() => briefingInputSchema.parse({ ...input, credentials: "PRIVATE_SECRET" }));
  assert.throws(() => briefingInputSchema.parse({ ...input, sources: [] }));
  assert.throws(() => briefingInputSchema.parse({ ...input, children: [] }));
  assert.throws(() => briefingInputSchema.parse({ ...input, conclusion: "no-material-changes-within-checked-scope" }));
  const missing = sample();
  missing.evidence = [];
  assert.throws(() => buildBriefingInput(missing), /evidence is missing/);
});

test("uncollected scope and operational failures remain visible even when detailed health is bounded", () => {
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "grades", "attendance"] }] });
  const review = sample(settings, 2);
  const input = buildBriefingInput(review);
  assert.equal(input.coverage.complete, false);
  assert(input.coverage.problems > 0);
  assert.equal(input.conclusion, "incomplete");
  assert(input.items.some(item => item.entity === "collection"));
  const text = renderDeterministicBriefing(input);
  assert.match(text, /not an unqualified all-clear/);
  assert.match(text, /problem scope/);
  assert.match(text, /Evidence:/);
});

test("known grade/status facts and source conflicts survive minimization without raw content", () => {
  const review = sample();
  const action = review.actions.find(action => action.entity === "assignment")!;
  action.facts!.grade = "A";
  action.uncertainty.push("source-conflict");
  action.reasons.push("source-conflict");
  action.relatedFacts = [{ sourceId: action.evidenceIds[0], fields: { ...action.facts!, dueDate: "2026-10-13" } }];
  const input = buildBriefingInput(review);
  const item = input.items.find(item => item.id === action.id)!;
  assert.equal(item.facts!.grade, "A");
  assert.equal(item.relatedFacts[0].facts.dueDate, "2026-10-13");
  assert(item.uncertainty.includes("source-conflict"));
  assert.equal("contentHash" in item.facts!, false);
  assert.match(renderDeterministicBriefing(input), /Observed grade: A/);
});
