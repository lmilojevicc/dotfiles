import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const benchmarkFiles = [
  "benchmarks/run.sh", "benchmarks/run.mjs", "benchmarks/workloads.mjs",
  "benchmarks/core/Cargo.toml", "benchmarks/core/Cargo.lock", "benchmarks/core/src/main.rs",
  "benchmarks/results/latest.json",
];
const contamination = [
  "native/target/debug/synthetic-artifact", "native/target/release/libsynthetic.dylib",
  "benchmarks/core/target/debug/synthetic-artifact", "benchmarks/core/target/release/libsynthetic.so",
  "native/redaction.node", "synthetic.node", "benchmarks/redaction.node",
  "benchmarks/core/src/synthetic.node", "benchmarks/core/src/unintended.rs",
  "benchmarks/comparator/src/index.js", "benchmarks/upstream/package.json",
  "benchmarks/logs/raw.log", "benchmarks/results/raw.log", "synthetic.log",
  "config.json", "benchmarks/config.json", "benchmarks/core/config.json",
  "benchmarks/private/config.json", "benchmarks/results/unintended.json",
];

test("corpus packaging: contaminated local builds cannot ship generated or private artifacts", { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-redaction-packaging-"));
  try {
    const source = join(temp, "source");
    // Do not copy/read existing compiled artifacts, dependencies or private local config.
    // The dummy contamination below is added only to this isolated synthetic package.
    await cp(root, source, { recursive: true, filter(path) {
      const name = basename(path);
      return !["target", "node_modules", "config.json", ".npmrc", "comparator", "upstream", "logs"].includes(name)
        && !/\.(?:node|log|tgz)$/.test(name);
    } });
    for (const path of contamination) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), "synthetic packaging regression artifact\n");
    }
    const userConfig = join(temp, "empty-user.npmrc"), globalConfig = join(temp, "empty-global.npmrc");
    await writeFile(userConfig, "");
    await writeFile(globalConfig, "");
    await mkdir(join(temp, "home"));
    const output = execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json"], {
      cwd: source, encoding: "utf8", timeout: 45_000,
      env: { ...process.env, HOME: join(temp, "home"),
        NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_CACHE: join(temp, "cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    });
    // npm 12 can key JSON by package name; earlier versions return an array.
    const parsed = JSON.parse(output);
    const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as { filename: string; files: Array<{ path: string }> };
    const paths = packed.files.map((file: { path: string }) => file.path).sort();
    assert.deepEqual(paths.filter((path: string) => path.startsWith("benchmarks/")), [...benchmarkFiles].sort());
    for (const path of contamination) assert.ok(!paths.includes(path), `must not ship ${path}`);
    for (const path of paths) {
      assert.ok(!/(?:^|\/)(?:target|node_modules|comparator|upstream|logs)\//.test(path), path);
      assert.ok(!/\.(?:node|log)$/.test(path), path);
      assert.notEqual(basename(path), "config.json", path);
    }
    const required = ["fixtures/corpus.json", "fixtures/README.md", "THIRD_PARTY_NOTICES.md",
      "tests/corpus.test.ts", "tests/corpus-packaging.test.ts", "native/build.rs", "native/Cargo.lock",
      "native/src/lib.rs", "scripts/build-native.mjs", "config.example.json"];
    const corpus = JSON.parse(await readFile(join(source, "fixtures/corpus.json"), "utf8"));
    for (const project of Object.values(corpus.projects) as Array<{ licenseFile: string }>) {
      required.push(`fixtures/${project.licenseFile}`);
    }
    for (const path of required) assert.ok(paths.includes(path), `required source ${path}`);
    const unpacked = join(temp, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar", ["-xzf", join(source, packed.filename), "-C", unpacked]);
    const distributed = join(unpacked, "package");
    const actual = execFileSync("tar", ["-tzf", join(source, packed.filename)], { encoding: "utf8" })
      .trim().split("\n").map(path => path.replace(/^package\//, "")).filter(path => !path.endsWith("/")).sort();
    assert.deepEqual(actual, paths);
    for (const project of Object.values(corpus.projects) as Array<{ licenseFile: string; licenseSha256: string }>) {
      const license = await readFile(join(distributed, "fixtures", project.licenseFile));
      assert.equal(createHash("sha256").update(license).digest("hex"), project.licenseSha256);
    }
    for (const path of [...required, ...benchmarkFiles]) {
      assert.deepEqual(await readFile(join(distributed, path)), await readFile(join(source, path)), path);
    }
    console.log(`Contaminated pack: ${paths.length} source files; ${contamination.length} dummy artifacts excluded; seven intended benchmark files and full fixture licenses preserved.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
