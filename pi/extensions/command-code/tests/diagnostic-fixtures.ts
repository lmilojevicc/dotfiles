// Synthetic category tokens in non-allowlisted fields must never affect Pi.
export const forbiddenFieldErrors: unknown[] = [
  ...["context_length_exceeded", "invalid_tool_call_id", "invalid_reasoning", "invalid_parameter", "insufficient_quota"].flatMap((token) => [
    { code: "unknown", path: token },
    { code: "unknown", requestId: token },
    { code: "unknown", detail: { path: token } },
    { code: "unknown", detail: { requestId: token } },
    { code: "unknown", detail: { unrelated: token } },
  ]),
];

// Malformed or budget-truncated embedded candidates must not become plain text.
export const opaqueEmbeddedErrors: [string, unknown][] = [
  ...["context_length_exceeded", "insufficient_quota", "invalid_tool_call_id"].flatMap((token): [string, unknown][] => [
    [`full text budget truncation: ${token}`, {
      message: `Upstream: ${JSON.stringify({ code: "unknown", path: token, padding: "x".repeat(17000) })}`,
    }],
    [`remaining text budget truncation: ${token}`, {
      code: "x".repeat(16000),
      message: `Upstream: ${JSON.stringify({ code: "unknown", path: token, padding: "x".repeat(1000) })}`,
    }],
    // The opening brace can also fall outside the remaining budget. Do not
    // mistake the truncated wrapper's recognized token for a plain diagnostic.
    [`opening brace beyond remaining text budget: ${token}`, {
      code: "x".repeat(16000),
      message: `${token} ${"x".repeat(400)} Upstream: {"code":"unknown"}`,
    }],
    [`incomplete object: ${token}`, { message: `Upstream: {"code":"unknown","path":"${token}"` }],
    [`incomplete outer object: ${token}`, { message: `Upstream: {"code":"unknown","detail":{"path":"${token}"}` }],
    [`invalid object: ${token}`, { message: `Upstream: {"code":"unknown","path":"${token}",}` }],
    [`invalid object with recognized wrapper: ${token}`, { message: `${token} Upstream: {"code":}` }],
  ]),
];

export const recognizedEmbeddedErrors: [unknown, string][] = [
  [{ code: "context_length_exceeded" }, "context_length_exceeded"],
  [{ message: "Your input exceeds the context window of this model" }, "context_length_exceeded"],
  [{ code: "invalid_tool_call_id" }, "tool_pairing_or_id"],
  [{ message: "tool_use ids were found without tool_result blocks" }, "tool_pairing_or_id"],
  [{ code: "invalid_reasoning" }, "invalid_reasoning"],
  [{ message: "thinking signature verification failed" }, "invalid_reasoning"],
  [{ code: "invalid_parameter" }, "invalid_parameter"],
  [{ message: "temperature must be between zero and one" }, "invalid_parameter"],
  [{ detail: "context_length_exceeded" }, "context_length_exceeded"],
  [{ code: "insufficient_quota" }, "quota"],
  [{ message: "quota exceeded" }, "quota"],
];

export function embeddedError(error: unknown): { message: string } {
  return { message: `Upstream: ${JSON.stringify({ error })}` };
}
