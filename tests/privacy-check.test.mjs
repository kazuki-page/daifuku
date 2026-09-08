import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('改名後の非公開ルールを読み、未配置なら停止する', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daifuku-privacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'daifuku');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  copyFileSync(new URL('../tools/privacy-check.mjs', import.meta.url), join(repo, 'tools/privacy-check.mjs'));
  writeFileSync(join(repo, 'tools/publish-allow.txt'), '');
  writeFileSync(join(repo, 'sample.txt'), 'safe sample\n');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['add', '.'], { cwd: repo });
  const env = { ...process.env };
  delete env.DAIFUKU_PRIVATE_RULES;
  const run = (override = {}) => spawnSync(process.execPath, ['tools/privacy-check.mjs'], {
    cwd: repo, env: { ...env, ...override }, encoding: 'utf8',
  });

  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /非公開の検査ルールが見つからない/);

  const notes = join(root, 'daifuku-private', 'notes');
  mkdirSync(notes, { recursive: true });
  const rulesPath = join(notes, 'publish-rules.mjs');
  writeFileSync(rulesPath, "export const RULES = [['fixture', /PRIVATE_FIXTURE/]];\n");
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(join(repo, 'untracked.txt'), 'PRIVATE_FIXTURE\n');
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /untracked\.txt:1/);
  assert.doesNotMatch(rejected.stderr, /PRIVATE_FIXTURE/);

  const missingOverride = run({ DAIFUKU_PRIVATE_RULES: join(root, 'missing.mjs') });
  assert.equal(missingOverride.status, 1);
  assert.match(missingOverride.stderr, /非公開の検査ルールが見つからない/);

  rmSync(join(repo, 'untracked.txt'));
  const overridePath = join(root, 'custom-rules.mjs');
  writeFileSync(overridePath, "export const RULES = [['fixture', /PRIVATE_FIXTURE/]];\n");
  rmSync(rulesPath);
  const overridden = run({ DAIFUKU_PRIVATE_RULES: overridePath });
  assert.equal(overridden.status, 0, overridden.stderr);
});
