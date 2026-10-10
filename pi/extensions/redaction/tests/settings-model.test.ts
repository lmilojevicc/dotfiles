import assert from "node:assert/strict";
import { test } from "node:test";
import { offConfig } from "../src/config.ts";
import { cloneDraft, deleteLiteral, needsEscaped, reducedProtection, replaceLiteral, safeAlias, sameConfig } from "../src/settings-model.ts";

test("settings-model: exact replacements preserve whitespace/multiline and prototype keys", () => {
  const config = offConfig();
  replaceLiteral(config, undefined, " \tfirst\r\nsecond\n ", "PRIVATE_MULTILINE");
  replaceLiteral(config, undefined, "__proto__", "PRIVATE_PROTO");
  assert.deepEqual(Object.keys(config.literals), [" \tfirst\r\nsecond\n ", "__proto__"]);
  assert.equal(config.literals.__proto__, "PRIVATE_PROTO");
  assert.equal(Object.getPrototypeOf(config.literals), Object.prototype);
  const copy = cloneDraft(config);
  assert.equal(sameConfig(config, copy), true);
  replaceLiteral(copy, 0, " replacement ", "PRIVATE_REPLACEMENT");
  assert.equal(sameConfig(config, copy), false);
  assert.equal(Object.keys(config.literals)[0], " \tfirst\r\nsecond\n ");
  deleteLiteral(copy, 1);
  assert.equal(Object.hasOwn(copy.literals, "__proto__"), false);
});
test("settings-model: duplicates/overlaps fail without mutating draft", () => {
  const draft = offConfig();
  replaceLiteral(draft, undefined, "one-secret", "PRIVATE_ONE");
  const before = cloneDraft(draft);
  for (const [raw, alias] of [["", "A"], ["one-secret", "B"], ["two-secret", "PRIVATE_ONE"], ["private", "private-alias"]]) {
    assert.throws(() => replaceLiteral(draft, undefined, raw, alias), /Invalid/);
    assert.equal(sameConfig(before, draft), true);
  }
});
test("settings-model: reduction is source/rule-aware; alias-only edits are not reductions", () => {
  const before = offConfig();
  before.sources.toolResults = true;
  before.detectors.email = true;
  replaceLiteral(before, undefined, "secret-one", "PRIVATE_ONE");
  const after = cloneDraft(before);
  after.literals["secret-one"] = "PRIVATE_TWO";
  assert.equal(reducedProtection(before, after), false);
  for (const reduce of [(c: typeof after) => { c.sources.toolResults = false; }, (c: typeof after) => { c.detectors.email = false; }, (c: typeof after) => { delete c.literals["secret-one"]; }]) {
    const draft = cloneDraft(before); reduce(draft);
    assert.equal(reducedProtection(before, draft), true);
  }
  assert.equal(reducedProtection(offConfig(), before), false);
});
test("settings-model: aliases lose terminal controls/bidi while ordinary Unicode survives", () => {
  assert.equal(safeAlias("名🙂é\x1b]52;c;fake\x07\u202e\n"), "名🙂é�]52;c;fake���");
  assert.equal(needsEscaped("  ordinary \"quote\" \\slash  "), false);
  for (const text of ["\t", "\r\n", "\u202e", "\x1b", "\u0085"]) assert.equal(needsEscaped(text), true);
});
