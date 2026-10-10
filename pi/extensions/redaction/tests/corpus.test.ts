import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { createNativeRedactor } from "../src/native.ts";
import type { Detector } from "../src/contracts.ts";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/corpus.json", import.meta.url), "utf8"));
const off = { email: false, phone: false, apiToken: false, privateKey: false, credentialUrl: false };
const categories = Object.keys(off) as Detector[];

test("corpus provenance IDs and distributed license hashes", () => {
  assert.equal(new Set(corpus.cases.map((fixture: { id: string }) => fixture.id)).size, corpus.cases.length);
  for (const project of Object.values(corpus.projects) as Array<{ licenseFile: string; licenseSha256: string }>) {
    const license = readFileSync(new URL(`../fixtures/${project.licenseFile}`, import.meta.url));
    assert.equal(createHash("sha256").update(license).digest("hex"), project.licenseSha256);
  }
});

for (const fixture of corpus.cases) {
  test(`corpus ${fixture.id}: individual ${fixture.category} opt-in and original spans`, () => {
    assert.ok(categories.includes(fixture.category));
    assert.ok(fixture.provenance.path && fixture.provenance.sample && fixture.provenance.adaptation);
    if (fixture.provenance.project !== "original") {
      const project = corpus.projects[fixture.provenance.project];
      assert.match(project.revision, /^[a-f0-9]{40}$/);
      assert.ok(project.repository && project.license && project.licenseFile);
    }
    const inactive = createNativeRedactor({ literals: {}, detectors: off });
    assert.deepEqual(inactive.redact(fixture.text), { text: fixture.text, matches: [] });
    for (const category of categories) {
      const redactor = createNativeRedactor({ literals: {}, detectors: { ...off, [category]: true } });
      const result = redactor.redact(fixture.text);
      if (category !== fixture.category) {
        // Categories can intentionally overlap (e.g. userinfo and hostname resemble email),
        // but must never emit another disabled category.
        assert.ok(result.matches.every(match => match.kind === category));
        continue;
      }
      assert.deepEqual(result.matches.map(match => fixture.text.slice(match.start, match.end)), fixture.secrets);
      assert.ok(result.matches.every(match => match.kind === category));
      for (const secret of fixture.secrets) assert.ok(!result.text.includes(secret), fixture.id);
      if (fixture.secrets.length === 0) assert.equal(result.text, fixture.text);
      assert.equal(redactor.redact(result.text).text, result.text);
    }
  });
}

test("corpus mixed categories remain separately selectable with UTF-16 offsets", () => {
  const values: Record<Detector, string> = {
    email: "synthetic@example.com", phone: "+14155550132",
    apiToken: "sk-syntheticNeverIssuedTokenAlphabetOnly",
    privateKey: "-----BEGIN PRIVATE KEY-----\nanything\n-----END PRIVATE KEY-----",
    credentialUrl: "https://synthetic:unusable@example.com/path",
  };
  const text = "🙂 名 " + categories.map(category => values[category]).join("\n");
  for (const category of categories) {
    const result = createNativeRedactor({ literals: {}, detectors: { ...off, [category]: true } }).redact(text);
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.every(match => match.kind === category));
    assert.ok(!result.text.includes(values[category]));
    if (category === "email") assert.equal(result.matches[0].start, "🙂 名 ".length);
  }
});
