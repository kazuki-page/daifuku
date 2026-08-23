// CSV の書き出し。
//
// 用途が2つある（DESIGN.md「CSV」）。
//   1. 保管用のバックアップ … 欠損なく出て、そのまま読み戻せること
//   2. AI に投げる材料      … 1ファイルで文脈が閉じていること
//
// この2つから、列の決め方が決まる。
//   * 内部の値（data の JSON、id、batch_id）も落とさずに出す → 1
//   * account_id だけでなく口座名も併記する → 2（id だけでは人にも AI にも読めない）
//   * 金額は区切りも通貨記号も付けない整数。符号も付けない（kind から導く）
//   * 日付は ISO

export type Row = Record<string, unknown>;

/**
 * RFC 4180。区切り・引用符・改行を含む値だけ引用符で囲む。
 * 改行は CRLF。Excel と Numbers の両方でそのまま開くため。
 */
function field(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => field(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Excel は BOM が無いと UTF-8 を Shift_JIS と解釈して日本語が化ける。
 * 一方 BOM が付いていると素直に読めないツールもあるので、既定は付けず、
 * ?bom=1 で選べるようにする。
 */
export function csvResponse(filename: string, body: string, bom: boolean): Response {
  return new Response((bom ? '﻿' : '') + body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // 古い書き出しがブラウザに残ると、消したはずのレコードが復活して見える。
      'cache-control': 'no-store',
    },
  });
}

export const TRANSACTION_COLUMNS = [
  'id', 'date', 'kind', 'category', 'item', 'amount',
  'account_id', 'account', 'to_account_id', 'to_account',
  'counterparty', 'memo', 'pair_id', 'batch_id', 'data',
  'created_at', 'updated_at',
];

export const BALANCE_COLUMNS = [
  'id', 'date', 'account_id', 'account', 'class', 'amount', 'memo',
  'batch_id', 'data', 'created_at', 'updated_at',
];

export const ACCOUNT_COLUMNS = [
  'id', 'institution', 'name', 'account', 'class',
  'in_reconciliation', 'archived', 'sort', 'data', 'created_at', 'updated_at',
];
