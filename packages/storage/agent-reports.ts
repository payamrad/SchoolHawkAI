import type { AgentReportSummary, ReportCheckpoint, StoredAgentReport, StudentReportAnalysis } from "@schoolhawk/core/agent-reports";
import { diagnosticErrorCode } from "@schoolhawk/core/diagnostics";

export interface AgentReportStore {
  saveAgentReport(analysis: StudentReportAnalysis, now?: Date): StoredAgentReport;
  getAgentReport(reportId: string): StoredAgentReport | undefined;
  listAgentReports(options?: { limit?: number; offset?: number }): AgentReportSummary[];
  getReportCheckpoint(scopeHash: string): ReportCheckpoint | undefined;
  saveReportCheckpoint(checkpoint: ReportCheckpoint): void;
}

export class AgentReportStorageError extends Error {
  readonly code: ReturnType<typeof diagnosticErrorCode>;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.code = diagnosticErrorCode(cause);
  }
}
