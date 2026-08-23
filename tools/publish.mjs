// 公開用リポジトリへ、公開してよいファイルだけを写す。
//
//   node tools/publish.mjs [出力先]     既定は ../daifuku-public
//
// 方針は2つ。どちらも「うっかり漏れる」側に倒れないための形。
//
//   1. **許可リスト方式。** 下の FILES / DIRS に書いたものだけが行く。
//      新しく足したファイルは既定で公開されない。notes/ が落ちるのもこれ。
//      除外リスト方式にすると、書き忘れたものが黙って公開される。
//
//   2. **写す前に中身を検査する。** 許可リストに載っているファイルの中に
//      実額や口座名が紛れ込んだら、1行も書かずに止める。
//      意図して置いてある例外は tools/publish-allow.txt に完全一致で書く。
//
// このスクリプトは git を触らない。写すだけ。コミットは目で差分を見てから。

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';

const OUT = process.argv[2] ?? '../daifuku-public';
const MARKER = '.publish-target';

/* ---------- 何を公開するか ---------- */

const FILES = [
  'README.md',
  'DESIGN.md',
  'LICENSE',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'wrangler.jsonc',
  'wrangler.demo.jsonc',
  'worker-configuration.d.ts',
  '.claude/launch.json',
  'tools/import.mjs',
  'tools/og.mjs',
  'tools/og.svg',
  'tools/publish.mjs',
  'tools/publish-allow.txt',
];

// [ディレクトリ, 拡張子の絞り込み（null なら全部）]
const DIRS = [
  ['src', ['.ts']],
  ['public', null],
  ['migrations', ['.sql']],
];

/* ---------- 検査 ---------- */

// 生成物。中身は自分で書いたものではないので検査から外す
// （npm と wrangler が吐く。MDN の文面や sponsor の URL で誤検知する）。
// 例外リストは、引っかかる行をそのまま書いてあるので必ず当たる。
const NO_SCAN = new Set([
  'package-lock.json',
  'worker-configuration.d.ts',
  'tools/publish-allow.txt',
]);
const TEXT = new Set(['.md', '.ts', '.js', '.css', '.html', '.json', '.jsonc', '.sql', '.mjs', '.svg', '.webmanifest', '.txt', '']);

// 禁止パターンは notes/ に置いてある。**禁止語の一覧は「何を消したか」の一覧**
// でもあるので、機関名や銘柄名をここに書いたまま公開すると目録が出ていく。
// 無ければ止まる。検査なしで写すことはしない。
const RULES_PATH = '../notes/publish-rules.mjs';
let RULES;
try {
  ({ RULES } = await import(RULES_PATH));
} catch {
  console.error(`検査ルールが読めない（${RULES_PATH}）。公開版のチェックアウトからは実行できない。`);
  process.exit(1);
}

const allowPath = 'tools/publish-allow.txt';
const allow = new Set(
  existsSync(allowPath)
    ? readFileSync(allowPath, 'utf8').split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim() && !l.startsWith('# '))
    : [],
);

/* ---------- 収集 ---------- */

function walk(dir, exts, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (!exts || exts.includes(extname(p))) acc.push(p);
  }
  return acc;
}

const targets = [];
for (const f of FILES) {
  if (existsSync(f)) targets.push(f);
  else console.error(`（許可リストにあるが手元に無い: ${f}）`);
}
for (const [d, exts] of DIRS) targets.push(...walk(d, exts));
targets.sort();

/* ---------- 検査して、通ってから書く ---------- */

const hits = [];
for (const f of targets) {
  if (NO_SCAN.has(f) || !TEXT.has(extname(f))) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (allow.has(line)) return;
    for (const [name, re] of RULES) {
      if (re.test(line)) hits.push({ f, n: i + 1, name, line: line.trim() });
    }
  });
}

if (hits.length) {
  console.error(`\n公開を中止した。${hits.length}行が検査に引っかかっている。\n`);
  for (const h of hits) console.error(`  ${h.f}:${h.n}  [${h.name}]\n    ${h.line}`);
  console.error(`\n直すか、意図した例外なら次の行を ${allowPath} に足す（完全一致）:\n`);
  for (const h of new Set(hits.map((h) => h.line))) console.error(h);
  console.error('');
  process.exit(1);
}

if (existsSync(OUT)) {
  if (!existsSync(join(OUT, MARKER))) {
    console.error(`${OUT} に ${MARKER} が無い。公開用リポジトリではない場所を指している可能性がある。`);
    console.error(`意図した先なら空のファイルを置く: touch ${join(OUT, MARKER)}`);
    process.exit(1);
  }
  // 消したファイルを公開版にも反映する。.git と目印は触らない。
  const keep = new Set(targets.map((f) => f.split('/').join('/')));
  for (const p of walk(OUT, null)) {
    const rel = relative(OUT, p);
    if (rel === MARKER || rel.startsWith('.git/')) continue;
    if (!keep.has(rel)) { rmSync(p); console.log(`- ${rel}`); }
  }
} else {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, MARKER), '');
}

let written = 0;
for (const f of targets) {
  const dst = join(OUT, f);
  const body = readFileSync(f);
  if (existsSync(dst) && readFileSync(dst).equals(body)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, body);
  console.log(`  ${f}`);
  written++;
}

console.log(`\n検査 ${targets.length} ファイル、更新 ${written} ファイル → ${OUT}`);
console.log(`差分を目で見てからコミットする: git -C ${OUT} status`);
