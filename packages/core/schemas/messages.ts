import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const text = z.string().min(1).max(1_000_000);

export const collectedMessageSchema = z.object({
  id: z.string().min(1).max(200),
  sender: text,
  subject: text,
  sentDate: z.iso.date(),
  displayedDate: z.string().min(1).max(100),
  unreadBeforeOpen: z.boolean(),
  bodyText: text,
  source: z.object({
    portal: z.literal("skyward"),
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }),
    capturedAt: timestamp,
  }),
});

export const messageRunSchema = z.object({
  runId: z.uuid(),
  capturedAt: timestamp,
  window: z.object({
    days: z.number().int().min(1).max(366),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timeZone: z.literal("America/Los_Angeles"),
  }),
  status: z.enum(["complete", "partial", "failed"]),
  warning: z.string().max(200).optional(),
  messages: z.array(collectedMessageSchema).max(100_000),
  scannedCount: z.number().int().nonnegative(),
  parserVersion: z.literal(1),
  selection: z.enum(["unread", "all"]).optional(),
}).superRefine((run, context) => {
  const expectedDays = (Date.parse(run.window.endDate) - Date.parse(run.window.startDate)) / 86_400_000 + 1;
  if (expectedDays !== run.window.days || run.scannedCount < run.messages.length ||
      new Set(run.messages.map(message => message.id)).size !== run.messages.length ||
      run.messages.some(message => message.sentDate < run.window.startDate || message.sentDate > run.window.endDate)) {
    context.addIssue({ code: "custom", message: "Inconsistent collection window, count, or message identity." });
  }
});

export type CollectedMessage = z.infer<typeof collectedMessageSchema>;
export type MessageRun = z.infer<typeof messageRunSchema>;
export type MessageSelection = "unread" | "all";