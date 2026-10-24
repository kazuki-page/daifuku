// 非公開ルールと検査出力を公開Actionsログへ出さずに既存の検査を実行する。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.DAIFUKU_PRIVATE_RULES_SOURCE;
if (!source?.trim()) {
  console.error('Privacy check stopped: configure DAIFUKU_PRIVATE_RULES_SOURCE secret.');
  process.exit(1);
}

let directory;
try {
  directory = mkdtempSync(join(tmpdir(), 'daifuku-privacy-'));
  const rulesPath = join(directory, 'rules.mjs');
  writeFileSync(rulesPath, source, { mode: 0o600 });
  const env = { ...process.env, DAIFUKU_PRIVATE_RULES: rulesPath };
  delete env.DAIFUKU_PRIVATE_RULES_SOURCE;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./privacy-check.mjs', import.meta.url))], {
    env,
    stdio: 'ignore',
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    console.error('Privacy check failed. Run npm run check:privacy locally for details.');
    process.exitCode = 1;
  } else {
    console.log('Privacy check passed.');
  }
} catch {
  console.error('Privacy check could not run. Check the private rules secret.');
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
