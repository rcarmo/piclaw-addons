import { createHash } from "node:crypto";
import { LIMITS, ReviewError, type ReviewIdentity, type LocalTarget } from "./contracts.js";
export const hashText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function boundedText(value: unknown, name: string, max = LIMITS.commentBytes, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > max || value.includes("\0")) throw new ReviewError("invalid_input", `${name} must be ${allowEmpty ? "" : "non-empty "}text of at most ${max} UTF-8 bytes.`);
  return value;
}
export function validId(value: unknown, name = "id"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_./@-]{1,256}$/.test(value)) throw new ReviewError("invalid_input", `Invalid ${name}.`);
  return value;
}
export function identity(value: ReviewIdentity): ReviewIdentity {
  if (!value || !["operator", "agent"].includes(value.kind)) throw new ReviewError("forbidden", "Trusted review identity required.", 403);
  validId(value.ownerId, "owner"); validId(value.actorId, "actor");
  if (value.kind === "agent") { validId(value.chatId, "agent chat"); validId(value.chatIncarnation, "agent incarnation"); }
  return value;
}
export function operator(value: ReviewIdentity): void { identity(value); if (value.kind !== "operator") throw new ReviewError("forbidden", "Operator action required.", 403); }
export function target(value: LocalTarget): LocalTarget {
  if (!value || typeof value !== "object") throw new ReviewError("invalid_input", "A verified local target is required.");
  validId(value.chatId, "target chat"); validId(value.incarnation, "target incarnation"); boundedText(value.label, "target label", 200);
  if (!value.chatId.startsWith("web:")) throw new ReviewError("invalid_input", "Only local web chats are supported.");
  return value;
}
export function version(actual: number, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || expected !== actual) throw new ReviewError("conflict", "The record changed; reload before retrying.", 409);
}
export function pageSize(limit: unknown, max: number): number {
  if (limit === undefined) return max;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > max) throw new ReviewError("invalid_input", `Page size must be 1–${max}.`);
  return Number(limit);
}
