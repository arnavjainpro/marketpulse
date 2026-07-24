import { expect, test } from "bun:test";
import { parseJsonResponse } from "./queue";

const ok = { content: [{ type: "thinking", thinking: "…" }, { type: "text", text: '{"a":1}' }], stop_reason: "end_turn" };

test("parses the text block past any thinking blocks", () => {
  expect(parseJsonResponse<{ a: number }>(ok, "t").a).toBe(1);
});

// The two ways an over-budget response used to crash the analyzers.
test("truncated JSON and a missing text block both name the token limit", () => {
  const truncated = { content: [{ type: "text", text: '{"a":"unter' }], stop_reason: "max_tokens" };
  const noText = { content: [{ type: "thinking", thinking: "…" }], stop_reason: "max_tokens" };
  for (const r of [truncated, noText]) expect(() => parseJsonResponse(r, "t")).toThrow(/token limit/);
});

test("malformed JSON that was not truncated reports as invalid", () => {
  const bad = { content: [{ type: "text", text: "not json" }], stop_reason: "end_turn" };
  expect(() => parseJsonResponse(bad, "t")).toThrow(/invalid JSON/);
});
