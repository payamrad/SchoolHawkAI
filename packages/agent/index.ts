import type { StudentSnapshot } from "@schoolhawk/core/student-snapshot";
import type { AgentConnectionTest, PreviousCommunication, StudentReportAnalysis } from "@schoolhawk/core/agent-reports";
export type { AgentReply, AgentConnectionTest, StudentReportAnalysis } from "@schoolhawk/core/agent-reports";

export interface StudentReportAgent {
  testConnection(): Promise<AgentConnectionTest>;
  analyzeStudentReport(report: StudentSnapshot, previousCommunication?: PreviousCommunication): Promise<StudentReportAnalysis>;
}

const errors = {
  CONFIGURATION: "Invalid agent configuration. Check the endpoint, API key, API version, timeout, and request limit. Values were withheld.",
  INVALID_REPORT: "The agent requires a valid, complete student snapshot and any previous email context must match its student scope and size limits. No request was sent.",
  REQUEST_TOO_LARGE: "The serialized agent request exceeds its configured byte limit. No records were truncated and no request was sent.",
  TIMEOUT: "The agent request timed out. Its remote outcome may be uncertain; no automatic retry was attempted.",
  NETWORK: "Communication with the configured agent failed. Check connectivity and the approved endpoint; private error details were withheld.",
  AUTHENTICATION: "The agent rejected the credential or access policy. Check the key and endpoint; some Foundry application endpoints require Microsoft Entra authentication.",
  RATE_LIMITED: "The agent rate limit was reached. Retry later; no automatic retry was attempted.",
  HTTP_ERROR: "The agent returned an unsuccessful HTTP response. Private response details were withheld.",
  RESPONSE_TOO_LARGE: "The agent response exceeds the supported response size. No truncated analysis was accepted.",
  INVALID_RESPONSE: "The agent returned an invalid or empty Responses API result. No analysis was accepted.",
  INCOMPLETE_RESPONSE: "The agent response did not complete successfully. No partial analysis was accepted.",
  REFUSAL: "The agent declined the request. No analysis was accepted.",
  TOOL_REQUEST: "The agent returned an unsupported tool operation. This connector does not execute tools.",
} as const;

export type AgentErrorCode = keyof typeof errors;

export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, readonly httpStatus?: number) {
    super(`${errors[code]}${httpStatus === undefined ? "" : ` HTTP ${httpStatus}.`}`);
    this.name = "AgentError";
  }
}
