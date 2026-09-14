import type { CollectedMessage, MessageRun, MessageSelection } from "@schoolhawk/core/messages";

export interface RunSummary {
  runId: string;
  capturedAt: string;
  status: MessageRun["status"];
  selection: MessageSelection;
  startDate: string;
  endDate: string;
  messageCount: number;
  removedMessageCount: number;
  scannedCount: number;
}

export interface TruncateOptions {
  target: "LoginNotification";
  dryRun?: boolean;
}

export interface TruncateResult {
  target: "LoginNotification";
  dryRun: boolean;
  messages: number;
  observations: number;
  runs: number;
}

export interface StoredMessage {
  message: CollectedMessage;
  runId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MessageStore {
  importRun(accountId: string, input: unknown): "imported" | "already-imported";
  truncateMessages(accountId: string, options: TruncateOptions): TruncateResult;
  getRun(accountId: string, runId: string): MessageRun | undefined;
  listRuns(accountId: string, limit?: number): RunSummary[];
  listMessages(accountId: string, options?: { since?: string; limit?: number }): StoredMessage[];
  close(): void;
}