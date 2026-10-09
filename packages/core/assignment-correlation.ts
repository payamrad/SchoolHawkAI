import { pacificDate } from "./schemas/canvas-assignments";

export interface AssignmentMatchInput {
  id: string;
  title: string;
  dueDate: string | null;
}

export type AssignmentMatchMethod = "title-date" | "lesson-date";

export interface AssignmentMatch {
  canvasAssignmentId: string;
  status: "candidate" | "ambiguous" | "unmatched";
  candidates: { skywardAssignmentId: string; method: AssignmentMatchMethod }[];
}

function normalizedTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\bunit\s*(\d+)/g, "u$1")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function lessonCode(title: string): string | undefined {
  const normalized = title.normalize("NFKC");
  const codes = new Set<string>();
  for (const match of normalized.matchAll(/\b(?:unit|u)\s*(\d+)\s*(?:lesson|l)\s*(\d+)(?=\s|$|[-:).])/gi)) {
    codes.add(`unit:${Number(match[1])}:lesson:${Number(match[2])}`);
  }
  for (const match of normalized.matchAll(/\b(TLAS|I2C)\s*(\d+)(?=\s|$|[-:).])/gi)) {
    codes.add(`${match[1].toUpperCase()}:${Number(match[2])}`);
  }
  return codes.size === 1 ? [...codes][0] : undefined;
}

export function assignmentTitleMatch(left: string, right: string): "title" | "lesson" | undefined {
  if (normalizedTitle(left) && normalizedTitle(left) === normalizedTitle(right)) return "title";
  const code = lessonCode(left);
  return code && code === lessonCode(right) ? "lesson" : undefined;
}

export function proposeAssignmentMatches(skyward: AssignmentMatchInput[], canvas: AssignmentMatchInput[]): AssignmentMatch[] {
  const matches: AssignmentMatch[] = canvas.map(assignment => {
    const candidates: AssignmentMatch["candidates"] = [];
    if (assignment.dueDate) for (const source of skyward) {
      if (source.dueDate !== assignment.dueDate) continue;
      const match = assignmentTitleMatch(source.title, assignment.title);
      if (match) candidates.push({ skywardAssignmentId: source.id, method: `${match}-date` });
    }
    return { canvasAssignmentId: assignment.id, status: candidates.length === 1 ? "candidate" : candidates.length ? "ambiguous" : "unmatched", candidates };
  });
  const uses = new Map<string, number>();
  for (const match of matches) for (const candidate of match.candidates) {
    uses.set(candidate.skywardAssignmentId, (uses.get(candidate.skywardAssignmentId) ?? 0) + 1);
  }
  for (const match of matches) if (match.candidates.some(candidate => uses.get(candidate.skywardAssignmentId)! > 1)) match.status = "ambiguous";
  return matches;
}

export function assignmentMatchWindow(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 366 || !Number.isFinite(now.getTime())) {
    throw new Error("Matching lookback must be 1-366 calendar days with a valid clock.");
  }
  const endDate = pacificDate(now.toISOString());
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { days, startDate: start.toISOString().slice(0, 10), endDate, timeZone: "America/Los_Angeles" as const };
}

export interface AssignmentLinkAssessment {
  skywardAssignmentId: string;
  status: "candidate" | "unmatched" | "review-required";
  reason: "ambiguous" | "date-conflict" | "undated" | null;
  candidates: { canvasAssignmentId: string; method: AssignmentMatchMethod; dueDate: string | null; title: string }[];
}

export function assessAssignmentLinks(skyward: AssignmentMatchInput[], canvas: AssignmentMatchInput[]): AssignmentLinkAssessment[] {
  const uses = new Map<string, number>();
  const assessments: AssignmentLinkAssessment[] = skyward.map(source => {
    const candidates: AssignmentLinkAssessment["candidates"] = [];
    for (const assignment of canvas) {
      const match = assignmentTitleMatch(source.title, assignment.title);
      if (!match) continue;
      candidates.push({ canvasAssignmentId: assignment.id, method: `${match}-date`, dueDate: assignment.dueDate, title: assignment.title });
      uses.set(assignment.id, (uses.get(assignment.id) ?? 0) + 1);
    }
    if (!candidates.length) return { skywardAssignmentId: source.id, status: "unmatched", reason: null, candidates };
    const reason = candidates.length !== 1 ? "ambiguous" : !source.dueDate || !candidates[0].dueDate ? "undated" :
      source.dueDate !== candidates[0].dueDate ? "date-conflict" : null;
    return { skywardAssignmentId: source.id, status: reason ? "review-required" : "candidate", reason, candidates };
  });
  for (const assessment of assessments) {
    if (assessment.candidates.some(candidate => uses.get(candidate.canvasAssignmentId)! > 1)) {
      assessment.status = "review-required";
      assessment.reason = "ambiguous";
    }
  }
  return assessments;
}