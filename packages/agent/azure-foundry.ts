import { z } from "zod";
import {
  SNAPSHOT_MAX_BYTES, serializeStudentSnapshot, studentSnapshotSchema, type StudentSnapshot,
} from "@schoolhawk/core/student-snapshot";
import { DiagnosticLogError, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { agentReplySchema, MAX_AGENT_RESPONSE_BYTES } from "@schoolhawk/core/agent-reports";
import {
  AgentError, type AgentConnectionTest, type AgentReply, type StudentReportAgent, type StudentReportAnalysis,
} from "./index";

export const DEFAULT_FOUNDRY_API_VERSION = "2025-11-15-preview";
export { MAX_AGENT_RESPONSE_BYTES } from "@schoolhawk/core/agent-reports";
const apiVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:-preview)?$/);
const optionsSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
  apiVersion: apiVersionSchema.optional(),
  timeoutMs: z.number().int().min(1).max(300000).default(120000),
  maxRequestBytes: z.number().int().min(1024).max(SNAPSHOT_MAX_BYTES).default(SNAPSHOT_MAX_BYTES),
}).strict();
export type AzureFoundryAgentOptions = z.input<typeof optionsSchema>;

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const responseSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.string(),
  error: z.unknown().nullish(),
  output: z.array(z.unknown()).max(1000),
  usage: z.object({
    input_tokens: tokenCount, output_tokens: tokenCount, total_tokens: tokenCount,
  }).nullish(),
});
const outputTypeSchema = z.object({ type: z.string() });
const messageSchema = z.object({
  type: z.literal("message"), role: z.literal("assistant"),
  status: z.literal("completed").optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("output_text"), text: z.string() }),
    z.object({ type: z.literal("refusal"), refusal: z.string() }),
  ])).min(1),
});

function parseReply(value: unknown): Pick<AgentReply, "responseId" | "text" | "usage"> {
  const response = responseSchema.parse(value);
  if (response.status !== "completed" || response.error != null) throw new AgentError("INCOMPLETE_RESPONSE");
  const texts: string[] = [];
  for (const item of response.output) {
    const { type } = outputTypeSchema.parse(item);
    if (type === "reasoning") continue;
    if (type !== "message") throw new AgentError("TOOL_REQUEST");
    const message = messageSchema.parse(item);
    for (const content of message.content) {
      if (content.type === "refusal") throw new AgentError("REFUSAL");
      texts.push(content.text);
    }
  }
  const text = texts.join("\n");
  if (!text.trim()) throw new AgentError("INVALID_RESPONSE");
  return {
    responseId: response.id, text,
    ...(response.usage ? { usage: {
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
    } } : {}),
  };
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new AgentError("INVALID_RESPONSE");
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_AGENT_RESPONSE_BYTES) throw new AgentError("RESPONSE_TOO_LARGE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AGENT_RESPONSE_BYTES) throw new AgentError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class AzureFoundryAgent implements StudentReportAgent {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AzureFoundryAgentOptions, transport = globalThis.fetch) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) throw new AgentError("CONFIGURATION");
    const settings = parsed.data;
    let endpoint: URL;
    try { endpoint = new URL(settings.endpoint); }
    catch { throw new AgentError("CONFIGURATION"); }
    const versions = endpoint.searchParams.getAll("api-version");
    if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.hash ||
        !endpoint.hostname.endsWith(".services.ai.azure.com") ||
        !/^\/api\/projects\/[^/]+\/(?:agents\/[^/]+\/endpoint|applications\/[^/]+)\/protocols\/openai\/responses$/.test(endpoint.pathname) ||
        [...endpoint.searchParams.keys()].some(key => key !== "api-version") || versions.length > 1 ||
        versions.length === 1 && !apiVersionSchema.safeParse(versions[0]).success ||
        settings.apiVersion && versions.length === 1 && settings.apiVersion !== versions[0]) {
      throw new AgentError("CONFIGURATION");
    }
    endpoint.searchParams.set("api-version", settings.apiVersion ?? versions[0] ?? DEFAULT_FOUNDRY_API_VERSION);
    this.#endpoint = endpoint;
    this.#apiKey = settings.apiKey;
    this.#timeoutMs = settings.timeoutMs;
    this.#maxRequestBytes = settings.maxRequestBytes;
    this.#fetch = transport;
  }

  async testConnection(): Promise<AgentConnectionTest> {
    const reply = await this.#request(
      "SchoolHawkAI connectivity test only. No student records are supplied. Please acknowledge that you received this test.",
    );
    reportDiagnostic({ level: "info", code: "AGENT_TEST_SUMMARY", stage: "AGENT_RESPONSE",
      status: "success", durationMs: reply.durationMs });
    return { ...reply, kind: "connection-test", connected: true };
  }

  async analyzeStudentReport(report: StudentSnapshot): Promise<StudentReportAnalysis> {
    let snapshot: StudentSnapshot;
    let text: string;
    try {
      snapshot = studentSnapshotSchema.parse(report);
      text = serializeStudentSnapshot(snapshot);
    } catch {
      reportDiagnostic({ level: "error", code: "SCHEMA_INVALID", stage: "AGENT_REQUEST", errorType: "validation" });
      throw new AgentError("INVALID_REPORT");
    }
    const reply = await this.#request(text);
    reportDiagnostic({ level: "info", code: "AGENT_ANALYSIS_SUMMARY", stage: "AGENT_RESPONSE",
      status: "success", durationMs: reply.durationMs, counts: { students: snapshot.totals.students } });
    return {
      ...reply, kind: "student-report-analysis", snapshotId: snapshot.id, reviewId: snapshot.reviewId,
      studentRefs: snapshot.students.map(student => student.id),
      sourceStatus: snapshot.status, sourceNotices: [...snapshot.notices], validation: "unverified-ai-analysis",
    };
  }

  async #request(text: string): Promise<AgentReply> {
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "AGENT_REQUEST" });
    const body = JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text }] }],
      stream: false, store: false,
    });
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > this.#maxRequestBytes) {
      reportDiagnostic({ level: "error", code: "REQUEST_FAILED", stage: "AGENT_REQUEST",
        errorType: "validation", expected: this.#maxRequestBytes, actual: bytes });
      throw new AgentError("REQUEST_TOO_LARGE");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const started = Date.now();
    let stage: DiagnosticEvent["stage"] = "AGENT_REQUEST";
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", "api-key": this.#apiKey },
        body,
      });
      if (!response.ok) {
        throw new AgentError(response.status === 401 || response.status === 403 ? "AUTHENTICATION" :
          response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", response.status);
      }
      stage = "AGENT_RESPONSE";
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage });
      const reply = parseReply(await readResponse(response));
      return agentReplySchema.parse({
        ...reply, provider: "azure-foundry", receivedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - started),
      });
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      const failure = error instanceof AgentError ? error : new AgentError(controller.signal.aborted ? "TIMEOUT" :
        error instanceof SyntaxError || error instanceof z.ZodError ? "INVALID_RESPONSE" : "NETWORK");
      reportDiagnostic({
        level: "error", code: failure.httpStatus ? "HTTP_ERROR" : stage === "AGENT_RESPONSE" ? "RESPONSE_INVALID" : "REQUEST_FAILED",
        stage, status: "failed", httpStatus: failure.httpStatus,
        errorType: failure.code === "TIMEOUT" ? "timeout" : failure.code === "AUTHENTICATION" ? "permission" : "other",
        durationMs: Math.max(0, Date.now() - started),
      });
      throw failure;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

export function createAzureFoundryAgentFromEnv(environment: NodeJS.ProcessEnv = process.env): AzureFoundryAgent {
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "CONFIGURATION" });
  return new AzureFoundryAgent({
    endpoint: environment.AZURE_FOUNDRY_AGENT_ENDPOINT ?? "",
    apiKey: environment.AZURE_FOUNDRY_API_KEY ?? "",
    apiVersion: environment.AZURE_FOUNDRY_API_VERSION,
    timeoutMs: environment.AZURE_FOUNDRY_TIMEOUT_MS === undefined ? undefined : Number(environment.AZURE_FOUNDRY_TIMEOUT_MS),
    maxRequestBytes: environment.AZURE_FOUNDRY_MAX_REQUEST_BYTES === undefined ? undefined : Number(environment.AZURE_FOUNDRY_MAX_REQUEST_BYTES),
  });
}
