import assert from 'node:assert/strict';
import test from 'node:test';

import { toCsv } from '../src/csv.ts';

test('通常のCSVは復元できるよう原文を保つ', () => {
  assert.equal(
    toCsv(['memo'], [{ memo: '=1+1' }, { memo: '@SUM(A1)' }]),
    'memo\r\n=1+1\r\n@SUM(A1)\r\n',
  );
});

test('Excel向けCSVは数式として解釈される文字列を無害化する', () => {
  assert.equal(
    toCsv(
      ['memo', 'amount'],
      [
        { memo: '=1+1', amount: -100 },
        { memo: '  @SUM(A1)', amount: 200 },
        { memo: '普通のメモ', amount: 300 },
      ],
      true,
    ),
    "memo,amount\r\n'=1+1,-100\r\n'  @SUM(A1),200\r\n普通のメモ,300\r\n",
  );
});

test('Excel向けでも引用符や改行をRFC 4180形式でエスケープする', () => {
  assert.equal(
    toCsv(['memo'], [{ memo: '=HYPERLINK("https://example.test")\n次' }], true),
    'memo\r\n"\'=HYPERLINK(""https://example.test"")\n次"\r\n',
  );
});
