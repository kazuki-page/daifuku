import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function editor(load) {
  const select = { value: '旧カテゴリ', innerHTML: '' };
  const error = { hidden: true, textContent: '' };
  const context = vm.createContext({
    $: (id) => id === '#eCategory' ? select : error,
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    keep: (_key, fetch) => fetch(), get: load,
  });
  vm.runInContext(source.slice(source.indexOf('let editing = null;'), source.indexOf('function openEditor(row)')) + '\nediting = {};', context);
  return { select, error, load: (kind) => context.loadEditCategories(kind) };
}

test('カテゴリは選択欄になり、既存値・空欄・種別の候補を保持する', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label>カテゴリ<select id="eCategory">/);
  const e = editor(async (path) => {
    assert.match(decodeURIComponent(path), /kind=収入$/);
    return [{ category: '給与' }, { category: '給与' }, { category: '<臨時>' }];
  });
  await e.load('収入');
  assert.equal(e.select.value, '旧カテゴリ');
  assert.match(e.select.innerHTML, /value=""/);
  assert.match(e.select.innerHTML, /旧カテゴリ/);
  assert.equal(e.select.innerHTML.match(/value="給与"/g).length, 1);
  assert.match(e.select.innerHTML, /&lt;臨時&gt;/);
});

test('取得失敗時も現在値を保持し、エラーを表示する', async () => {
  const e = editor(async () => { throw new Error('offline'); });
  await e.load('支出');
  assert.equal(e.select.value, '旧カテゴリ');
  assert.equal(e.error.hidden, false);
});

test('種別切替後に古いリクエストが届いても候補を上書きしない', async () => {
  const pending = [];
  const e = editor(() => new Promise((resolve) => pending.push(resolve)));
  const first = e.load('支出');
  const second = e.load('収入');
  pending[1]([{ category: '給与' }]);
  await second;
  pending[0]([{ category: '食費' }]);
  await first;
  assert.match(e.select.innerHTML, /給与/);
  assert.doesNotMatch(e.select.innerHTML, /食費/);
});
