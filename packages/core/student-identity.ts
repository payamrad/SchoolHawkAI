import { reportDiagnostic } from "./diagnostics";
import {
  ReviewError, reviewConfigSchema, rulesFor, type HealthIssue, type ReviewConfig,
} from "./review";
import type { ReviewSourceRun } from "./review-observations";

type Binding = ReviewConfig["children"][number]["bindings"][number];
interface StudentIdentity {
  binding: Binding;
  names: Set<string>;
}

export function normalizeStudentFullName(student: {
  name: string; firstName?: string; lastName?: string; sortableName?: string | null;
}): string | null {
  let name: string;
  if (student.firstName?.trim() && student.lastName?.trim()) {
    name = `${student.firstName} ${student.lastName}`;
  } else {
    name = student.sortableName?.includes(",") ? student.sortableName : student.name;
    if (name.includes(",")) {
      const parts = name.split(",").map(part => part.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      name = `${parts[1]} ${parts[0]}`;
    }
  }
  name = name.normalize("NFKC").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
  const parts = name.split(" ");
  if (name.length > 300 || parts.length < 2 ||
      [parts[0], parts.at(-1)!].some(part => (part.match(/\p{L}/gu)?.length ?? 0) < 2)) return null;
  return name;
}

export function resolveReviewStudents(
  input: ReviewConfig, history: Iterable<ReviewSourceRun & { accountId: string }>,
): { config: ReviewConfig; notices: HealthIssue[] } {
  const config = reviewConfigSchema.parse(input);
  if (config.studentMatching === "bindings") return { config, notices: [] };
  const key = (binding: Binding) => JSON.stringify([binding.portal, binding.accountId, binding.studentId]);
  const identities = new Map<string, StudentIdentity>();
  let observations = 0;
  for (const source of history) {
    if (!config.sources.some(allowed => allowed.portal === source.portal && allowed.accountId === source.accountId &&
        allowed.sections.includes(source.section))) throw new ReviewError("Student identity history is outside the configured sources.");
    if (source.section === "messages") continue;
    for (const student of source.run.students) {
      if (++observations > 200000) throw new ReviewError("Student name matching exceeds 200,000 identity observations. Narrow or archive source history.");
      const binding: Binding = { portal: source.portal, accountId: source.accountId, studentId: student.id };
      const id = key(binding);
      if (!identities.has(id)) identities.set(id, { binding, names: new Set() });
      const identity = identities.get(id)!;
      const name = normalizeStudentFullName(student);
      if (name && identity.names.size < 2) identity.names.add(name);
      if (identities.size > 100000) throw new ReviewError("Student name matching exceeds 100,000 source identities.");
    }
  }

  const owners = new Map(config.children.flatMap(child => child.bindings.map(binding => [key(binding), child.id] as const)));
  const parents = new Map(config.children.map(child => [child.id, child.id]));
  const root = (id: string): string => {
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const result = root(parent);
    parents.set(id, result);
    return result;
  };
  const childNames = new Map<string, Set<string>>();
  const names = new Map<string, string[]>();
  const ambiguous = new Set<string>();
  const unverified = new Set<string>();
  for (const [id, identity] of identities) {
    const owner = owners.get(id);
    if (owner) {
      const values = childNames.get(owner) ?? new Set<string>();
      for (const name of identity.names) values.add(name);
      childNames.set(owner, values);
    }
    if (!identity.names.size) unverified.add(id);
    else if (identity.names.size > 1) ambiguous.add(id);
    else {
      const name = [...identity.names][0];
      names.set(name, [...(names.get(name) ?? []), id]);
    }
  }

  const inferred = new Map<string, string>();
  for (const members of names.values()) {
    const children = [...new Set(members.flatMap(id => owners.has(id) ? [owners.get(id)!] : []))].sort();
    const scopes = new Map<string, Set<string>>();
    for (const id of members) {
      const binding = identities.get(id)!.binding;
      const scope = JSON.stringify([binding.portal, binding.accountId]);
      const identitiesInScope = scopes.get(scope) ?? new Set<string>();
      identitiesInScope.add(owners.get(id) ?? id);
      scopes.set(scope, identitiesInScope);
    }
    const conflicting = [...scopes.values()].some(scope => scope.size > 1) ||
      children.some(child => (childNames.get(child)?.size ?? 0) > 1) ||
      new Set(children.map(child => JSON.stringify(rulesFor(config, child)))).size > 1;
    if (conflicting) {
      for (const id of members) ambiguous.add(id);
      continue;
    }
    if (!children.length) continue;
    const roots = [...new Set(children.map(root))].sort();
    for (const child of roots) parents.set(child, roots[0]);
    for (const id of members) inferred.set(id, roots[0]);
  }

  const children = new Map<string, ReviewConfig["children"][number]>();
  for (const child of config.children.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    const id = root(child.id);
    if (!children.has(id)) children.set(id, { ...config.children.find(child => child.id === id)!, bindings: [] });
    children.get(id)!.bindings.push(...child.bindings);
  }
  for (const [id, owner] of inferred) {
    if (!owners.has(id)) children.get(root(owner))!.bindings.push(identities.get(id)!.binding);
  }
  for (const child of children.values()) child.bindings.sort((left, right) => key(left).localeCompare(key(right)));
  const notices: HealthIssue[] = [];
  if (ambiguous.size) {
    notices.push("student-name-ambiguous");
    reportDiagnostic({ code: "STUDENT_NAME_AMBIGUOUS", stage: "REVIEW_PROCESS", field: "name", counts: { students: ambiguous.size } });
  }
  if (unverified.size) {
    notices.push("student-name-unverified");
    reportDiagnostic({ code: "STUDENT_NAME_UNVERIFIED", stage: "REVIEW_PROCESS", field: "name", counts: { students: unverified.size } });
  }
  return { config: reviewConfigSchema.parse({ ...config, children: [...children.values()] }), notices };
}
