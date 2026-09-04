import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { favoriteKey, readFavorites, toggleFavorite } from "../favorites.ts";

const chosen = { provider: "beta", id: "vendor/model" };
function fixture(t: test.TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "picker-favorites-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, path: join(root, "model-favorites.json") };
}

test("absent store is empty without creating files; toggles append/remove/readd legacy slash IDs", (t) => {
	const { root, path } = fixture(t);
	assert.deepEqual(readFavorites(root), { data: {}, favorites: [] });
	assert.deepEqual(fs.readdirSync(root), []);
	assert.equal(favoriteKey(chosen), "beta/vendor/model");
	assert.deepEqual(toggleFavorite(chosen, root), ["beta/vendor/model"]);
	toggleFavorite({ provider: "alpha", id: "shared" }, root);
	assert.deepEqual(toggleFavorite(chosen, root), ["alpha/shared"]);
	assert.deepEqual(toggleFavorite(chosen, root), ["alpha/shared", "beta/vendor/model"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).favorites, readFavorites(root).favorites);
});

test("missing favorites is valid; unrelated data, unavailable IDs and existing mode survive fresh toggles", (t) => {
	const { root, path } = fixture(t);
	fs.writeFileSync(path, '{"other":{"nested":[1]}}');
	assert.deepEqual(readFavorites(root).favorites, []);
	toggleFavorite(chosen, root);
	// A writer changes the file after the picker read: never overwrite that fresh content from a cache.
	fs.writeFileSync(path, '{"favorites":["missing/unavailable","alpha/shared"],"other":{"nested":[2]},"__proto__":{"safe":true}}');
	fs.chmodSync(path, 0o640);
	const oldUmask = process.umask(0o077);
	try { assert.deepEqual(toggleFavorite(chosen, root), ["missing/unavailable", "alpha/shared", "beta/vendor/model"]); }
	finally { process.umask(oldUmask); }
	assert.equal(fs.statSync(path).mode & 0o777, 0o640);
	const stored = JSON.parse(fs.readFileSync(path, "utf8"));
	assert.deepEqual(stored.other, { nested: [2] });
	assert.deepEqual(stored.__proto__, { safe: true });
	assert.deepEqual(fs.readdirSync(root), ["model-favorites.json"]);
});

for (const bytes of ["", " ", "{bad", "[]", "null", "true", "2", '"text"', '{"favorites":null}', '{"favorites":"p/m"}', '{"favorites":[""]}', '{"favorites":["p/m",2]}', '{"favorites":[{}]}']) {
	test(`invalid favorites preserve exact bytes: ${JSON.stringify(bytes)}`, (t) => {
		const { root, path } = fixture(t);
		fs.writeFileSync(path, bytes);
		assert.throws(() => readFavorites(root));
		assert.throws(() => toggleFavorite(chosen, root));
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
		assert.deepEqual(fs.readdirSync(root), ["model-favorites.json"]);
	});
}

test("read-only favorites load but cannot be replaced; unreadable file remains intact", (t) => {
	const { root, path } = fixture(t);
	const bytes = '{"favorites":["beta/vendor/model"]}\n';
	fs.writeFileSync(path, bytes);
	fs.chmodSync(path, 0o444);
	assert.deepEqual(readFavorites(root).favorites, [favoriteKey(chosen)]);
	assert.throws(() => toggleFavorite(chosen, root), /read-only/);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	if (process.getuid?.() !== 0) {
		fs.chmodSync(path, 0o000);
		try { assert.throws(() => readFavorites(root), /EACCES/); assert.throws(() => toggleFavorite(chosen, root), /EACCES/); }
		finally { fs.chmodSync(path, 0o600); }
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
	}
});

test("directories and symlinks are refused without changing the entry or target", (t) => {
	const { root, path } = fixture(t);
	fs.mkdirSync(path);
	assert.throws(() => readFavorites(root), /regular/);
	assert.throws(() => toggleFavorite(chosen, root), /regular/);
	fs.rmdirSync(path);
	const target = join(root, "target.json"), bytes = '{"favorites":[]}';
	fs.writeFileSync(target, bytes); fs.symlinkSync(target, path);
	assert.throws(() => readFavorites(root), /regular/);
	assert.throws(() => toggleFavorite(chosen, root), /regular/);
	assert.ok(fs.lstatSync(path).isSymbolicLink());
	assert.equal(fs.readFileSync(target, "utf8"), bytes);
});

for (const operation of ["writeFileSync", "chmodSync", "renameSync"] as const) test(`${operation} failure preserves old bytes and removes temporary files`, (t) => {
	const { root, path } = fixture(t);
	const bytes = '{ "favorites": ["unavailable/model"], "other": true }\n';
	fs.writeFileSync(path, bytes);
	const originalWrite = fs.writeFileSync;
	const mock = t.mock.method(fs, operation, (...args: unknown[]) => {
		if (operation === "writeFileSync") originalWrite(args[0] as string, "partial write");
		throw new Error(`injected ${operation} failure`);
	});
	syncBuiltinESMExports();
	try { assert.throws(() => toggleFavorite(chosen, root), /injected/); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	assert.deepEqual(fs.readdirSync(root), ["model-favorites.json"]);
});

test("unwritable directory fails a new toggle without creating a store", (t) => {
	if (process.getuid?.() === 0) return t.skip("root bypasses directory permissions");
	const { root } = fixture(t);
	fs.chmodSync(root, 0o500);
	try { assert.throws(() => toggleFavorite(chosen, root), /EACCES/); assert.deepEqual(fs.readdirSync(root), []); }
	finally { fs.chmodSync(root, 0o700); }
});
