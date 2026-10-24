import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'daifuku-ci-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'temp'));
  writeFileSync(join(root, '.gitignore'), 'temp/\n');
  for (const name of ['ci-privacy-check.mjs', 'privacy-check.mjs']) {
    copyFileSync(new URL(`../tools/${name}`, import.meta.url), join(root, 'tools', name));
  }
  writeFileSync(join(root, 'tools', 'publish-allow.txt'), '');
  execFileSync('git', ['init', '--quiet', root]);
  return {
    root,
    run(source) {
      const env = { ...process.env, TMPDIR: join(root, 'temp'), TMP: join(root, 'temp'), TEMP: join(root, 'temp') };
      delete env.DAIFUKU_PRIVATE_RULES_SOURCE;
      if (source !== undefined) env.DAIFUKU_PRIVATE_RULES_SOURCE = source;
      const result = spawnSync(process.execPath, [join(root, 'tools', 'ci-privacy-check.mjs')], { env, encoding: 'utf8' });
      assert.deepEqual(readdirSync(join(root, 'temp')), [], 'temporary private rules must be removed');
      return { ...result, output: result.stdout + result.stderr };
    },
  };
}

test('CI privacy check rejects missing and empty secrets', (t) => {
  const f = fixture(t);
  for (const source of [undefined, '', '  ']) {
    const result = f.run(source);
    assert.equal(result.status, 1);
    assert.match(result.output, /configure DAIFUKU_PRIVATE_RULES_SOURCE/);
  }
});

test('CI privacy check accepts valid rules and cleans up the private file', (t) => {
  const f = fixture(t);
  const result = f.run('export const RULES = [["private-label", /PRIVATE_FIXTURE_VALUE/]];');
  assert.equal(result.status, 0);
  assert.match(result.output, /Privacy check passed/);
  assert.doesNotMatch(result.output, /private-label|PRIVATE_FIXTURE_VALUE/);
});

test('CI privacy check blocks a matching file without exposing rule names or child output', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'example.md'), 'PRIVATE_FIXTURE_VALUE');
  const result = f.run('console.log("SECRET_CHILD_OUTPUT"); export const RULES = [["private-label", /PRIVATE_FIXTURE_VALUE/]];');
  assert.equal(result.status, 1);
  assert.match(result.output, /Privacy check failed/);
  assert.doesNotMatch(result.output, /private-label|PRIVATE_FIXTURE_VALUE|SECRET_CHILD_OUTPUT|example.md/);
});

test('CI privacy check fails closed on malformed rules without printing their source', (t) => {
  const f = fixture(t);
  for (const source of ['export const RULES = "PRIVATE_BAD_RULES";', 'throw new Error("PRIVATE_IMPORT_ERROR");']) {
    const result = f.run(source);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.output, /PRIVATE_BAD_RULES|PRIVATE_IMPORT_ERROR/);
  }
});
