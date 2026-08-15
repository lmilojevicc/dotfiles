import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CODE_API,
  COMMAND_CODE_MODELS,
  GATEWAY_DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  validateCatalogue,
} from "../src/catalogue.ts";

test("bundled catalogue projects the audited model set", () => {
  assert.equal(COMMAND_CODE_MODELS.length, 53);
  assert.equal(new Set(COMMAND_CODE_MODELS.map((model) => model.id)).size, 53);
  assert.ok(COMMAND_CODE_MODELS.every((model) =>
    model.provider === PROVIDER_ID
    && model.api === COMMAND_CODE_API
    && model.contextWindow > 0
    && model.maxTokens > 0));
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "deepseek/deepseek-v4-flash")?.maxTokens, GATEWAY_DEFAULT_MAX_TOKENS);
  assert.equal(COMMAND_CODE_MODELS.find((model) => model.id === "zai-org/GLM-5.1")?.maxTokens, 131_072);
  validateCatalogue();
});

test("catalogue validation rejects duplicate IDs", () => {
  const duplicate = COMMAND_CODE_MODELS.map((model, index) => index === 1 ? { ...model, id: COMMAND_CODE_MODELS[0]!.id } : model);
  assert.throws(() => validateCatalogue(duplicate), /duplicate model IDs/);
});
