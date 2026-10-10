// Fixed generation, no PRNG or ambient files. All identities are fictional/reserved.
export const detectorsOff = { email: false, phone: false, apiToken: false, privateKey: false, credentialUrl: false };
export const localPii = { literals: {}, detectors: { ...detectorsOff, email: true, phone: true } };
export const warmup = 5;
export const samples = 21;
export const batch = 3;

export function workloads() {
  const rows = [];
  function make(scope, pattern, size, ruleCount = 0) {
    const literals = Object.fromEntries(Array.from({ length: ruleCount }, (_, i) => [
      `synthetic-secret-${String(i).padStart(6, "0")}-end`, `MASK${String(i).padStart(6, "0")}Z`,
    ]));
    const targets = scope === "pii" ? ["bench@example.com", "+14155550132"] : [Object.keys(literals)[0], Object.keys(literals).at(-1)];
    const clean = pattern === "unicode" ? "🙂 名 café ordinary clean log line\n" : "ordinary clean log line\n";
    const secretLine = `${targets[0]} | ${targets[1]}\n`;
    const chunk = pattern === "clean" ? clean : pattern === "dense" ? secretLine : clean.repeat(40) + secretLine;
    // Sizes are minimum UTF-8 bytes; complete chunks avoid clipped sensitive values/surrogates.
    const repeats = Math.ceil(size / Buffer.byteLength(chunk));
    const text = chunk.repeat(repeats);
    const secrets = pattern === "clean" ? [] : [...new Set(targets)];
    rows.push({ id: `${scope}-${pattern}-${size}-rules${ruleCount}`, scope, pattern, requestedBytes: size,
      bytes: Buffer.byteLength(text), utf16Units: text.length, ruleCount,
      config: scope === "pii" ? localPii : { literals, detectors: detectorsOff }, text, secrets,
      expectedMatches: pattern === "clean" ? 0 : repeats * 2 });
  }
  for (const size of [1024, 16384, 131072]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("pii", pattern, size);
  for (const ruleCount of [1, 100, 1000]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("literal", pattern, 16384, ruleCount);
  for (const size of [1024, 131072]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("literal", pattern, size, 100);
  return rows;
}
