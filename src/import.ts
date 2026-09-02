// CSV の取り込み。書き出したものをそのまま読み戻せることを第一にする
// （バックアップは「戻せて初めてバックアップ」なので）。
//
// 同じCSVを2回入れる事故は必ず起きる。`id` が既にあれば飛ばすので、
// 2回目は全件が「重複」として何も起きない。それでも取り消せるように、
// 1回の取り込みには `batch_id` を振る。

import { HttpError } from './store';

export type Kind = 'accounts' | 'transactions' | 'balances';

export interface ImportResult {
  kind: Kind;
  batch_id: string;
  added: number;
  skipped: number;
}

const MAX_IMPORT_ROWS = 20_000;

/** RFC 4180。引用符の中の区切り・改行を正しく通す。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  // BOM 付きで書き出したものを読み戻せるように落とす。
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

/**
 * 見出しから種類を当てる。どのファイルかを人に選ばせない
 * （3枚まとめて落としたものを、順に放り込めば済むようにする）。
 */
export function detectKind(header: string[]): Kind {
  const has = (c: string) => header.includes(c);
  if (has('institution')) return 'accounts';
  if (has('kind')) return 'transactions';
  if (has('account_id') && has('amount')) return 'balances';
  throw new HttpError(400, '見出しから種類が分からない');
}

const int = (v: string | undefined) => {
  const n = Math.trunc(Number((v ?? '').replace(/[,¥\s]/g, '')));
  return Number.isFinite(n) ? n : 0;
};
const iso = (v: string | undefined) => {
  const s = (v ?? '').trim().replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `日付が読めない: ${s || '(空)'}`);
  return s;
};

export async function importCsv(db: D1Database, text: string): Promise<ImportResult> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, '中身が無い');
  if (rows.length - 1 > MAX_IMPORT_ROWS)
    throw new HttpError(413, `一度に取り込めるのは ${MAX_IMPORT_ROWS} 行までです`);

  const header = rows[0]!.map((h) => h.trim());
  const kind = detectKind(header);
  const at = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? undefined : r[i];
  };

  // 秒までだと、続けて2枚入れたときに同じ id になって、取り消しが両方を巻き込む。
  const batch_id =
    `csv-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}-${crypto.randomUUID().slice(0, 4)}`;
  const now = new Date().toISOString();

  // 既にある id は飛ばす。同じCSVを2回入れても何も起きないようにするため。
  const table = kind;
  const existing = new Set(
    (await db.prepare(`SELECT id FROM ${table}`).all<{ id: string }>()).results.map((r) => r.id),
  );

  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;

  for (const r of rows.slice(1)) {
    const given = (at(r, 'id') ?? '').trim();
    if (given && existing.has(given)) { skipped++; continue; }
    const id = given || crypto.randomUUID();
    existing.add(id);
    const data = (at(r, 'data') ?? '').trim() || '{}';

    if (kind === 'accounts') {
      stmts.push(db.prepare(
        `INSERT INTO accounts (id,institution,name,class,in_reconciliation,archived,sort,batch_id,data,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id, (at(r, 'institution') ?? '').trim(), (at(r, 'name') ?? '').trim(),
        (at(r, 'class') ?? '現金').trim(), int(at(r, 'in_reconciliation')) ? 1 : 0,
        int(at(r, 'archived')) ? 1 : 0, int(at(r, 'sort')),
        batch_id, data, at(r, 'created_at') || now, now,
      ));
    } else if (kind === 'transactions') {
      stmts.push(db.prepare(
        `INSERT INTO transactions (id,date,kind,category,item,amount,account_id,to_account_id,
           counterparty,memo,pair_id,batch_id,data,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id, iso(at(r, 'date')), (at(r, 'kind') ?? '').trim(), (at(r, 'category') ?? '').trim(),
        (at(r, 'item') ?? '').trim(), Math.abs(int(at(r, 'amount'))),
        (at(r, 'account_id') ?? '').trim() || null, (at(r, 'to_account_id') ?? '').trim() || null,
        (at(r, 'counterparty') ?? '').trim(), (at(r, 'memo') ?? '').trim(),
        (at(r, 'pair_id') ?? '').trim() || null,
        batch_id, data, at(r, 'created_at') || now, now,
      ));
    } else {
      stmts.push(db.prepare(
        `INSERT INTO balances (id,date,account_id,amount,memo,batch_id,data,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(date, account_id) DO NOTHING`,
      ).bind(
        id, iso(at(r, 'date')), (at(r, 'account_id') ?? '').trim(),
        int(at(r, 'amount')), (at(r, 'memo') ?? '').trim(),
        batch_id, data, at(r, 'created_at') || now, now,
      ));
    }
  }

  // D1 の batch は一度に投げられる数に限りがあるので、小分けにする。
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));

  return { kind, batch_id, added: stmts.length, skipped };
}

/**
 * この接頭辞が付いた取り込みだけ、画面から取り消せる。
 *
 * スプレッドシートからの移行（`import-sheet-…`）も batch_id を持っているが、
 * **あれは取り消してよいものではない**（押した瞬間に1303件が消える）。
 * 一覧にも出さないし、ここも通さない。
 */
const UNDOABLE = 'csv-';

/** 取り込みをまとめて取り消す。参照の向きに合わせて残高・入出金を先に消す。 */
export async function undoBatch(db: D1Database, batch: string): Promise<number> {
  if (!batch.startsWith(UNDOABLE)) throw new HttpError(400, 'この取り込みは取り消せない');
  let removed = 0;
  for (const table of ['balances', 'transactions', 'accounts']) {
    const r = await db.prepare(`DELETE FROM ${table} WHERE batch_id = ?`).bind(batch).run();
    removed += r.meta.changes ?? 0;
  }
  return removed;
}

/** 取り込みの履歴。**取り消してよいものだけ**を一覧に出す。 */
export async function batches(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT batch_id, kind, n, at FROM (
                SELECT batch_id, 'accounts' AS kind, COUNT(*) AS n, MIN(created_at) AS at
                  FROM accounts WHERE batch_id LIKE 'csv-%' GROUP BY batch_id
                UNION ALL
                SELECT batch_id, 'transactions', COUNT(*), MIN(created_at)
                  FROM transactions WHERE batch_id LIKE 'csv-%' GROUP BY batch_id
                UNION ALL
                SELECT batch_id, 'balances', COUNT(*), MIN(created_at)
                  FROM balances WHERE batch_id LIKE 'csv-%' GROUP BY batch_id
              ) ORDER BY at DESC, kind`)
    .all();
  return results;
}
