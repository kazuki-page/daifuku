// 公開リポジトリへコミットする前に、口座名・実額・取引明細が混ざっていないか調べる。
// tracked と、gitignore されていない untracked の両方を見る。
// 個人用の禁止語は、それ自体が情報になるのでこの公開リポジトリには置かない。

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES = resolve(ROOT, '../daifuku-private/notes/publish-rules.mjs');
const RULES_PATH = resolve(process.env.DAIFUKU_PRIVATE_RULES ?? DEFAULT_RULES);
const ALLOW_PATH = resolve(ROOT, 'tools/publish-allow.txt');

// 生成物と例外リストは、誤検知または必然的な一致が多いので本文検査から外す。
const NO_SCAN = new Set([
  'package-lock.json',
  'worker-configuration.d.ts',
  'tools/publish-allow.txt',
]);

// 内容を目視済みの画像だけ許す。新しいバイナリは、意図せず写真や書類を置く事故を
// 防ぐため、ここへ明示的に足すまで失敗させる。
const ALLOWED_BINARY = new Set([
  'public/icon-180.png',
  'public/og.png',
]);

const TEXT = new Set([
  '', '.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.sql', '.svg',
  '.ts', '.txt', '.webmanifest', '.yaml', '.yml',
]);

if (!existsSync(RULES_PATH)) {
  console.error('非公開の検査ルールが見つからないため、検査を中止した。');
  console.error('DAIFUKU_PRIVATE_RULES に publish-rules.mjs のパスを指定する。');
  process.exit(1);
}

let rules;
try {
  ({ RULES: rules } = await import(pathToFileURL(RULES_PATH).href));
  if (!Array.isArray(rules)) throw new Error('RULES が配列ではない');
} catch (err) {
  console.error(`非公開の検査ルールが読めないため、検査を中止した: ${err.message}`);
  process.exit(1);
}

const allow = new Set(
  readFileSync(ALLOW_PATH, 'utf8').split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() && !line.startsWith('# ')),
);

const gitFiles = (...args) => execFileSync('git', ['ls-files', ...args, '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const tracked = gitFiles('--cached');
const untracked = gitFiles('--others', '--exclude-standard');
const files = [...new Set([...tracked, ...untracked])].sort();

const stagedModes = new Map(gitFiles('--stage').map((entry) => {
  const tab = entry.indexOf('\t');
  const meta = entry.slice(0, tab).split(' ');
  return [entry.slice(tab + 1), meta[0]];
}));

const hits = [];
function inspect(file, source, body, symbolic = false) {
  const label = source === 'index' ? `${file} (staged)` : file;
  if (symbolic) {
    hits.push({ file: label, line: 0, rule: 'シンボリックリンクは許可していない' });
    return;
  }
  if (NO_SCAN.has(file)) return;
  const ext = extname(file).toLowerCase();
  if (!TEXT.has(ext)) {
    if (!ALLOWED_BINARY.has(file)) hits.push({ file: label, line: 0, rule: '未承認のバイナリ' });
    return;
  }

  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (allow.has(line)) return;
    for (const [name, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) hits.push({ file: label, line: index + 1, rule: name });
    }
  });
}

// 作業ツリーを見る。未追跡ファイルと、まだstageしていない変更もここで止める。
for (const file of files) {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) continue;
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) continue;
  inspect(file, 'worktree', stat.isSymbolicLink() ? '' : readFileSync(path, 'utf8'), stat.isSymbolicLink());
}

// 次のコミットに実際に入るindexも別に見る。stage後に作業ツリーだけ直しても素通りしない。
for (const file of tracked) {
  const symbolic = stagedModes.get(file) === '120000';
  const body = symbolic ? '' : execFileSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: 'utf8' });
  inspect(file, 'index', body, symbolic);
}

if (hits.length) {
  console.error(`公開前検査に失敗した（${hits.length}件）。該当行の内容はログへ再掲しない。`);
  for (const hit of hits)
    console.error(`  ${hit.file}${hit.line ? `:${hit.line}` : ''} [${hit.rule}]`);
  console.error('内容を直すか、公開してよい行だけ tools/publish-allow.txt に完全一致で追加する。');
  process.exit(1);
}

console.log(`公開前検査: 作業ツリー ${files.length}ファイル + Git index ${tracked.length}ファイル、問題なし`);
