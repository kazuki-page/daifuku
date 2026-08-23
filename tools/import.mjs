// 既存スプレッドシート（Money - 収支データ.csv / Money - 資産データ.csv）を
// daifuku のスキーマに移すための、この移行だけのためのスクリプト。
//
// 汎用のマッピングUIは作らない（DESIGN.md「既存スプレッドシートからの移行」）。
// 一度きりなので、判断はすべてここに直書きして、根拠をコメントに残す。
//
//   node tools/import.mjs <csvディレクトリ> > tools/import.sql

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SRC = process.argv[2] ?? './daifuku-import';
const BATCH = 'import-sheet-2026-08-19';
const NOW = new Date().toISOString();
const log = (...a) => console.error(...a);

/* ---------- CSV ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const q = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

/* ---------- 値の正規化 ---------- */

/** 2020/12/1 も 2020/12/01 も 2020-12-01 にする。読めなければ null。 */
function toIso(s) {
  const m = String(s).trim().replace(/-/g, '/').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}

/**
 * 「¥1,080」「-¥875」→ 1080 / -875。金額でなければ null。
 * 通貨記号も桁区切りも無い、生の数字だけの行があるので、どちらも任意にする。
 */
function toAmount(s) {
  const m = String(s).trim().match(/^(-?)¥?([\d,]+)$/);
  if (!m) return null;
  return Number(m[2].replace(/,/g, '')) * (m[1] ? -1 : 1);
}

/**
 * 資金移動メモから金額を拾う。
 *   「100000を貯蓄→普段使い（貸出）」      → 100000
 *   「3000(3250円の四捨五入)をA銀行→B証券に」→ 3000   ← 先頭の数字を採る
 *   「50000円をPC用予算として貯金から小遣いへ」→ 50000
 *   「45000通常から生活防衛へ」            → 45000
 * 「6、7月分」「10~12月分」のような月の数字を拾わないよう、4桁以上に限る。
 * 3桁以下の資金移動は実データに無く、月の数字は最大2桁なので、ここで分かれる。
 */
function amountFromText(s) {
  const m = String(s).match(/(\d{4,})\s*円?\s*(?:を|[^\d])/);
  return m ? Number(m[1]) : null;
}

/* ---------- 資産データ → accounts + balances ---------- */

const assetRows = parseCsv(readFileSync(join(SRC, 'Money - 資産データ.csv'), 'utf8')).slice(1);

// 「総合:A銀行」は サブ口座:機関。「A銀行」だけの行は機関のみ。
function splitAccount(label) {
  const i = label.indexOf(':');
  return i < 0
    ? { institution: label.trim(), name: '' }
    : { name: label.slice(0, i).trim(), institution: label.slice(i + 1).trim() };
}

// 乖離検知の対象は現金クラスだけ（DESIGN.md「対象口座を選べることが前提」）。
// 共有管理（自分では動かせない）と投資（時価が動く）は帳簿に載らない変動源なので外す。
const RECONCILE = { '現金(預金を含む)': 1, '投資': 0, '共有管理': 0 };
const CLASS = { '現金(預金を含む)': '現金', '投資': '投資', '共有管理': '共有管理' };

const accounts = new Map(); // 元ラベル -> row
const balances = [];
let assetSkipped = 0;

for (const r of assetRows) {
  const date = toIso(r[0]);
  const amount = toAmount(r[4]);
  if (!date || amount === null) { assetSkipped++; continue; }
  const cls = r[1].trim(), label = r[2].trim();
  if (!accounts.has(label)) {
    const { institution, name } = splitAccount(label);
    accounts.set(label, {
      id: randomUUID(), institution, name,
      class: CLASS[cls] ?? cls,
      in_reconciliation: RECONCILE[cls] ?? 1,
      sort: accounts.size,
      data: { legacy_label: label, legacy_class: cls },
    });
  }
  balances.push({
    id: randomUUID(), date, account_id: accounts.get(label).id,
    amount, memo: (r[5] ?? '').trim(),
  });
}

/* ---------- 収支データ → transactions ---------- */

const txRows = parseCsv(readFileSync(join(SRC, 'Money - 収支データ.csv'), 'utf8')).slice(1);

// 「方法」列（2022年に記入をやめている）。口座マスタと名前が一致するものだけ結ぶ。
// プリペイドやクレジットカードは残高を記録していない決済手段なので口座にはしない。
// 捨てずに data.legacy_method に残す（「知らないフィールドを消さない」）。
const methodToAccount = new Map();
for (const [label, a] of accounts) if (!label.includes(':')) methodToAccount.set(label, a.id);

const KIND = { '収入': '収入', '支出': '支出', '投資': '投資' };
const transactions = [];
const review = [];
let txSkipped = 0;

for (const r of txRows) {
  const date = toIso(r[1]);
  if (!date) { txSkipped++; continue; }          // 末尾の空行と区切りの「ーーーー」

  const rawKind = r[2].trim();
  const item = r[0].trim();
  const memo = (r[5] ?? '').trim();
  const colAmount = toAmount(r[4]);

  let kind, amount, needsReview = false;

  if (KIND[rawKind]) {
    kind = KIND[rawKind];
    amount = Math.abs(colAmount ?? 0);
  } else {
    // rawKind が「メモ」または空の19件。すべて資金移動の書き置きだった。
    // 金額が拾えるものは振替に、拾えないものは日付つきの覚書として メモ で残す。
    // 移動元・移動先は「貯蓄」「普段使い」「通常」など本人にしか解けない呼び名なので、
    // ここでは推測せず NULL のままにして、目視で埋めてもらう。
    amount = colAmount !== null ? Math.abs(colAmount) : (amountFromText(`${item} ${memo}`) ?? 0);
    kind = amount > 0 ? '振替' : 'メモ';
    needsReview = amount > 0;
    review.push({ date, kind, amount, item, memo });
  }

  const method = (r[12] ?? '').trim();
  const data = {};
  if (method) {
    data.legacy_method = method;
    if (!methodToAccount.has(method)) data.legacy_method_unmapped = true;
  }
  if (rawKind && !KIND[rawKind]) data.legacy_kind = rawKind;
  if (needsReview) data.needs_review = '移動元・移動先が未設定';

  transactions.push({
    id: randomUUID(), date, kind,
    category: r[3].trim(), item, amount,
    account_id: method ? (methodToAccount.get(method) ?? null) : null,
    to_account_id: null,
    counterparty: (r[11] ?? '').trim(),
    memo, data,
  });
}

/* ---------- SQL ---------- */

const out = [];
out.push('-- tools/import.mjs が生成。手で編集しない。');
// BEGIN TRANSACTION は書かない。D1 が受け付けない
// （`wrangler d1 execute --file` 自体が失敗時にロールバックする）。

for (const a of accounts.values()) {
  out.push(
    `INSERT INTO accounts (id,institution,name,class,in_reconciliation,archived,sort,data,created_at,updated_at) VALUES (` +
    [q(a.id), q(a.institution), q(a.name), q(a.class), a.in_reconciliation, 0, a.sort,
     q(JSON.stringify(a.data)), q(NOW), q(NOW)].join(',') + ');'
  );
}
for (const b of balances) {
  out.push(
    `INSERT INTO balances (id,date,account_id,amount,memo,batch_id,data,created_at,updated_at) VALUES (` +
    [q(b.id), q(b.date), q(b.account_id), b.amount, q(b.memo), q(BATCH), q('{}'), q(NOW), q(NOW)].join(',') + ');'
  );
}
for (const t of transactions) {
  out.push(
    `INSERT INTO transactions (id,date,kind,category,item,amount,account_id,to_account_id,counterparty,memo,pair_id,batch_id,data,created_at,updated_at) VALUES (` +
    [q(t.id), q(t.date), q(t.kind), q(t.category), q(t.item), t.amount,
     q(t.account_id), q(t.to_account_id), q(t.counterparty), q(t.memo),
     'NULL', q(BATCH), q(JSON.stringify(t.data)), q(NOW), q(NOW)].join(',') + ');'
  );
}
console.log(out.join('\n'));

/* ---------- 移行の要約（stderr） ---------- */

const by = (arr, f) => arr.reduce((m, x) => (m[f(x)] = (m[f(x)] ?? 0) + 1, m), {});
log('口座        :', accounts.size, '件');
for (const [label, a] of accounts) log(`   ${a.in_reconciliation ? '照合✓' : '照合−'} ${a.class.padEnd(5)} ${label}`);
log('残高        :', balances.length, '件  （読めずに落とした行', assetSkipped, '）');
log('入出金      :', transactions.length, '件  （読めずに落とした行', txSkipped, '）');
log('  種別内訳  :', JSON.stringify(by(transactions, (t) => t.kind)));
log('  口座が付いた行:', transactions.filter((t) => t.account_id).length);
log('');
log(`▼ 目視で確認が要る${review.length}件（移動元・移動先が未設定）`);
for (const v of review) log(`   ${v.date}  ${v.kind}  ${String(v.amount).padStart(7)}  ${v.item} ${v.memo && '／ ' + v.memo}`);
