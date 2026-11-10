import type { PageTaskMessage } from "@alteva/core";

/** Parses and validates a queue payload. Throws on anything that is not a well-formed page task. */
export function parsePageTask(content: Buffer): PageTaskMessage {
  const data: unknown = JSON.parse(content.toString("utf8"));
  if (typeof data !== "object" || data === null) throw new Error("payload is not an object");
  const m = data as Record<string, unknown>;
  const text = (key: string) => {
    if (typeof m[key] !== "string" || m[key] === "") throw new Error(`${key} must be a non-empty string`);
    return m[key] as string;
  };
  const wholeNumber = (key: string) => {
    if (!Number.isInteger(m[key]) || (m[key] as number) < 0) throw new Error(`${key} must be a non-negative integer`);
    return m[key] as number;
  };
  const parentPageId = m.parentPageId === null ? null : wholeNumber("parentPageId");
  return {
    messageId: text("messageId"),
    jobId: text("jobId"),
    url: text("url"),
    depth: wholeNumber("depth"),
    parentPageId,
    correlationId: text("correlationId"),
  };
}
