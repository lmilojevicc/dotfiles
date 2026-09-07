import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
// Resolve this public subpath ONLY in tests, never through the production alias.
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { transformMessagesPi0851 } from "../src/pi-0851-transform-messages.ts";
import { assistant, call, handoff, nextUser, result, sameTarget, target } from "./history-fixtures.ts";
import "./protocol.test.ts";

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const blocks: AssistantMessage["content"] = [
  { type: "thinking", thinking: "visible reasoning", thinkingSignature: "SIGNATURE" },
  { type: "thinking", thinking: "", thinkingSignature: "ENCRYPTED" },
  { type: "thinking", thinking: "  " },
  { type: "thinking", thinking: "REDACTED", redacted: true, thinkingSignature: "OPAQUE" },
  { type: "text", text: "answer", textSignature: "TEXT_SIGNATURE" }, call(),
];
const cases: [string, Context["messages"]][] = [
  ["foreign handoff", handoff().messages],
  ["foreign signatures", [assistant(blocks), result()]],
  ["same target signatures", [sameTarget(blocks), result()]],
  ...(["provider", "api", "model"] as const).map((field): [string, Context["messages"]] => [
    `identity ${field}`, [{ ...sameTarget(blocks), [field]: "different" }, result()],
  ]),
  ["unsafe distinct IDs", [assistant(["|", "!", "x".repeat(501), "x".repeat(500) + "y"].map((id) => call(id)))]],
  ["missing EOF", [assistant([call("a"), call("b")]), result("b")]],
  ["missing before user", [assistant([call("a"), call("b")]), result("b"), nextUser]],
  ["missing before assistant", [assistant([call("a")]), assistant(blocks)]],
  ["failed and aborted", [assistant([call("a")], { stopReason: "error" }), result("a"), assistant(blocks, { stopReason: "aborted" }), result()]],
  ["orphan duplicate late", [result("orphan"), assistant([call("a")]), result("a"), result("a"), nextUser, result("a")]],
  ["images and adjacent placeholders", [
    { role: "user", timestamp: 1, content: [image, image, { type: "text", text: "break" }, image] },
    { role: "user", timestamp: 1, content: [{ type: "text", text: "(image omitted: model does not support images)" }, image] },
    sameTarget([call("a")]), { ...result("a"), content: [image, image, { type: "text", text: "break" }, image] },
  ]],
  ["untyped null/undefined content", [
    { ...nextUser, content: null }, { ...assistant([]), content: undefined }, { ...result("orphan"), content: null },
  ] as unknown as Context["messages"]],
];

for (const [name, messages] of cases) {
  test(`Pi 0.85.1 adapter equals actual public transformMessages: ${name}`, (t) => {
    t.mock.method(Date, "now", () => 123456789); // Synthetic result timestamps are compared too.
    const snapshot = structuredClone(messages);
    freeze(messages);
    for (const model of [target, { ...target, input: ["text", "image"] } as Model<string>]) {
      const normalize = (id: string, actualModel: Model<string>, source: AssistantMessage) => {
        assert.strictEqual(actualModel, model);
        assert.ok(messages.includes(source));
        return `call_${createHash("sha256").update(id).digest("hex").slice(0, 48)}`;
      };
      assert.deepEqual(transformMessagesPi0851(messages, model, normalize), transformMessages(messages, model, normalize));
      assert.deepEqual(messages, snapshot);
    }
  });
}
