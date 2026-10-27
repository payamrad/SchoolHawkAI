import { buildStudentSnapshot } from "@schoolhawk/core/student-snapshot";
import { gradeRun, ids, messageRun, namedFamilyFixture, snapshotReview } from "../../core/tests/review-fixtures";

export const endpoint = "https://fixture.services.ai.azure.com/api/projects/test/agents/student-consultant/endpoint/protocols/openai/responses";
export const apiKey = "PRIVATE_AGENT_KEY_FOR_FIXTURES";
export const environment = { AZURE_FOUNDRY_AGENT_ENDPOINT: endpoint, AZURE_FOUNDRY_API_KEY: apiKey };

export function studentReportHistoryFixture() {
  const { settings, history, skyward } = namedFamilyFixture();
  settings.sources[0].sections.push("grades", "messages");
  const grades = gradeRun();
  const template = grades.students[0];
  grades.students = skyward.students.map((student, index) => ({
    ...structuredClone(template), id: student.id, name: student.name,
    firstName: student.firstName!, lastName: student.lastName!,
    grades: template.grades.map(grade => ({ ...grade, grade: index ? "B" : "C", score: index ? "88" : "75", maxScore: "100" })),
  }));
  history.push({ portal: "skyward", section: "grades", accountId: "parent", run: grades },
    { portal: "skyward", section: "messages", accountId: "parent", run: messageRun() });
  return { settings, history, skyward, grades };
}

export function studentReportFixture() {
  const { settings, history } = studentReportHistoryFixture();
  return buildStudentSnapshot(history, settings, snapshotReview(history, settings), { courses: [], assignments: [] }, ids);
}

export function foundryResponse(text = "Synthetic parent-attention analysis.") {
  return {
    id: "resp_fixture", status: "completed", error: null,
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
    ],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  };
}
