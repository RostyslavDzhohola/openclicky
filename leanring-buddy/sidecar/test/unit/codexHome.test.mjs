import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const originalApplicationSupportDirectory = process.env.CLICKY_APP_SUPPORT;
const sandboxApplicationSupportDirectory = mkdtempSync(
  join(tmpdir(), "clicky-codex-home-test-")
);
const expectedIsolatedCodexHomeDirectory = join(
  sandboxApplicationSupportDirectory,
  "codex-home"
);
const expectedSharedAuthPath = join(homedir(), ".codex", "auth.json");

before(() => {
  process.env.CLICKY_APP_SUPPORT = sandboxApplicationSupportDirectory;
});

after(() => {
  if (originalApplicationSupportDirectory === undefined) {
    delete process.env.CLICKY_APP_SUPPORT;
  } else {
    process.env.CLICKY_APP_SUPPORT = originalApplicationSupportDirectory;
  }
});

const { buildCodexChildEnvironment, ensureIsolatedCodexHome } = await import(
  "../../src/codexHome.mjs"
);

test("ensureIsolatedCodexHome creates its directory and shared auth symlink", () => {
  const isolatedCodexHomeDirectory = ensureIsolatedCodexHome();
  const authSymlinkPath = join(isolatedCodexHomeDirectory, "auth.json");

  assert.equal(isolatedCodexHomeDirectory, expectedIsolatedCodexHomeDirectory);
  assert.equal(lstatSync(isolatedCodexHomeDirectory).isDirectory(), true);
  assert.equal(lstatSync(authSymlinkPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(authSymlinkPath), expectedSharedAuthPath);
});

test("ensureIsolatedCodexHome heals a regular auth file into the shared auth symlink", () => {
  const authSymlinkPath = join(expectedIsolatedCodexHomeDirectory, "auth.json");
  mkdirSync(expectedIsolatedCodexHomeDirectory, { recursive: true });
  rmSync(authSymlinkPath, { force: true });
  writeFileSync(authSymlinkPath, "stale copied credentials");

  ensureIsolatedCodexHome();

  assert.equal(lstatSync(authSymlinkPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(authSymlinkPath), expectedSharedAuthPath);
});

test("ensureIsolatedCodexHome leaves an existing correct auth symlink untouched", () => {
  ensureIsolatedCodexHome();
  const authSymlinkPath = join(expectedIsolatedCodexHomeDirectory, "auth.json");
  const firstSymlinkInode = lstatSync(authSymlinkPath).ino;

  ensureIsolatedCodexHome();

  assert.equal(lstatSync(authSymlinkPath).ino, firstSymlinkInode);
  assert.equal(readlinkSync(authSymlinkPath), expectedSharedAuthPath);
});

test("buildCodexChildEnvironment preserves process values and sets isolated CODEX_HOME", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "test-path-value";

  try {
    const codexChildEnvironment = buildCodexChildEnvironment();

    assert.equal(codexChildEnvironment.CODEX_HOME, expectedIsolatedCodexHomeDirectory);
    assert.equal(codexChildEnvironment.PATH, "test-path-value");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
