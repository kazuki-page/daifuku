// 段階2：移行結果を目で確かめるための読み取り専用画面。
// 入力画面（段階4）はここから作り直す。

const $ = (s, r = document) => r.querySelector(s);
const yen = (n) => '¥' + Number(n ?? 0).toLocaleString('ja-JP');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 圏外（fetch 自体の失敗）とサーバの拒否を見分けられるようにして投げる。 */
const offlineError = () => Object.assign(new Error('つながらない'), { offline: true });

const get = async (path) => {
  const r = await fetch(path).catch(() => { throw offlineError(); });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

/* --- 入力 ---------------------------------------------------------------
   このアプリの本体。開いた瞬間に金額へフォーカスが当たり、テンキーが出る。
   定期支出は候補のタップ2回で終わり、単発の買い物は「金額→カテゴリ→保存」の
   3操作より短くならないので、そこを削り切ることに集中する。 */

const post = async (path, body, method = 'POST') => {
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw offlineError(); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? r.statusText);
  return d;
};

const today = () => new Date().toLocaleDateString('sv-SE');   // sv-SE は YYYY-MM-DD
const shiftDay = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
};

const state = { kind: '支出', accounts: [] };
const digits = (v) => String(v).replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
const amountValue = () => Number(digits($('#amount').value) || 0);

/* 金額は打ちながら桁区切りを入れる。¥12,000 と ¥1,200 の見間違いは
   そのまま入力ミスになるので、確認のコストを下げておく。 */
$('#amount').addEventListener('input', () => {
  const el = $('#amount');
  const n = digits(el.value);
  el.value = n ? Number(n).toLocaleString('ja-JP') : '';
  refreshCandidates();
});

/* 種別。既定は支出（一番よく使うので、選び直さずに済むところから始める）。 */
$('#kinds').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  for (const x of $('#kinds').children) x.classList.remove('on');
  b.classList.add('on');
  state.kind = b.dataset.kind;

  const isTransfer = state.kind === '振替';
  $('#transfer').hidden = !isTransfer;
  $('#catsWrap').hidden = isTransfer;
  $('#budgetWrap').hidden = state.kind !== '支出';
  if (!isTransfer) loadCategories();
  refreshCandidates();
  $('#amount').focus({ preventScroll: true });
});

/* 日付。既定は今日。「昨日」だけボタンにして、それ以外は日付入力へ。 */
$('.when').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  for (const x of document.querySelectorAll('.when button')) x.classList.remove('on');
  b.classList.add('on');
  $('#date').value = shiftDay(Number(b.dataset.days));
});
$('#date').addEventListener('change', () => {
  for (const x of document.querySelectorAll('.when button')) x.classList.remove('on');
});

/* --- 候補 --- */

let candTimer;
let candidates = [];

function refreshCandidates() {
  clearTimeout(candTimer);
  candTimer = setTimeout(loadCandidates, 160);
}

async function loadCandidates() {
  const a = amountValue();
  // 金額を打つ前は何も出さない。
  // 「よく使うもの」を出していたが、過去データの金額が今の実態と合っておらず、
  // 汎用の入力の邪魔になっていた（2026-08-20 に本人の指摘で外した）。
  // 金額で引く候補は、打った額に一致するものだけなので邪魔にならない。
  if (state.kind === '振替' || !a) { $('#cands').innerHTML = ''; return; }
  // 候補は金額ごとに変わるので端末に控えない。圏外なら黙って引っ込める。
  const d = await get(`/api/candidates?limit=6&kind=${encodeURIComponent(state.kind)}&amount=${a}`)
    .catch(() => []);
  candidates = d;
  $('#cands').innerHTML = d.length
    ? `<p class="hint">この金額で過去に入れたもの</p>` +
      d.map((c, i) => `
        <button class="cand" data-i="${i}">
          <span class="cand-item">${esc(c.item)}</span>
          <span class="cand-sub">${esc(c.category)}${c.cnt > 1 ? ` · ${c.cnt}回` : ''}</span>
          <span class="cand-amt">${yen(c.amount)}</span>
        </button>`).join('')
    : '';
}

/* 候補をタップしたらそのまま保存する。「金額を打つ→候補をタップ」の2操作で
   終わらせるのが狙いなので、ここで確認を挟まない。誤りは取り消しで戻す。 */
$('#cands').addEventListener('click', (e) => {
  const b = e.target.closest('.cand');
  if (!b) return;
  const c = candidates[Number(b.dataset.i)];
  submit({
    kind: c.kind,
    category: c.category,
    item: c.item,
    amount: amountValue(),
    account_id: c.account_id ?? '',
  });
});

/* --- カテゴリ --- */

let category = '';

async function loadCategories() {
  const d = await keep('cats:' + state.kind,
    () => get('/api/categories?kind=' + encodeURIComponent(state.kind)));
  category = '';
  $('#cats').innerHTML = d.map((c) =>
    `<button class="cat" data-cat="${esc(c.category)}">${esc(c.category)}</button>`).join('');
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  const already = b.classList.contains('on');
  for (const x of $('#cats').children) x.classList.remove('on');
  if (already) { category = ''; return; }
  b.classList.add('on');
  category = b.dataset.cat;
});

/* --- 口座 --- */

async function loadAccounts() {
  state.accounts = await keep('accounts', () => get('/api/accounts'));
  const live = state.accounts.filter((a) => !a.archived);
  const opts = live.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  $('#account').innerHTML = `<option value="">口座（任意）</option>` + opts;
  $('#from').innerHTML = opts;
  $('#to').innerHTML = opts;
}

/* --- 保存 --- */

$('#save').addEventListener('click', () => submit());

async function submit(over = {}) {
  const amount = over.amount ?? amountValue();
  const body = {
    date: $('#date').value || today(),
    kind: over.kind ?? state.kind,
    category: over.category ?? category,
    item: over.item ?? $('#item').value,
    amount,
    account_id: over.account_id ?? $('#account').value,
    memo: $('#memo').value,
    budget_pair: $('#budget').checked && (over.kind ?? state.kind) === '支出',
  };
  if (body.kind === '振替') {
    body.account_id = $('#from').value;
    body.to_account_id = $('#to').value;
  }

  $('#err').hidden = true;
  try {
    const { ids } = await post('/api/transactions', body);
    afterSave(ids, body);
  } catch (err) {
    // 圏外（fetch そのものが失敗）だけキューに回す。
    // 400 は入力が間違っているので、送り直しても直らない。出して直してもらう。
    if (err.offline) { enqueue(body); afterSave(null, body); return; }
    $('#err').textContent = err.message;
    $('#err').hidden = false;
  }
}

function afterSave(ids, body) {
  const queued = ids === null;
  // 保存しても画面は閉じない。フォーカスは金額に戻す（連続入力のため）。
  $('#amount').value = '';
  $('#item').value = '';
  $('#memo').value = '';
  $('#budget').checked = false;
  for (const x of $('#cats').children) x.classList.remove('on');
  category = '';
  for (const t of ['summary', 'tx', 'bal', 'settings']) loaded.delete(t);
  refreshCandidates();
  $('#amount').focus({ preventScroll: true });

  const what = `${body.kind} ${yen(body.amount)}${body.item ? ' / ' + body.item : ''}`;
  if (queued) return toast(`圏外なので未送信にした ／ ${what}`);
  toast(`${what}${ids.length > 1 ? '（予算とセットで2件）' : ''}`, async () => {
    await post('/api/transactions/' + encodeURIComponent(ids[0]), null, 'DELETE');
    toast('取り消した');
    refreshCandidates();
  });
}

/* 雑に入れて後で直せることが、入力のハードルを下げる。取り消しは必ず出す。 */
let toastTimer;
function toast(text, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>` + (undo ? `<button id="undo">取り消す</button>` : '');
  el.hidden = false;
  if (undo) $('#undo').onclick = () => { el.hidden = true; undo().catch((e) => toast(e.message)); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 8000 : 2500);
}

/* --- 起動 --- */

$('#date').value = today();
loadAccounts().then(loadCategories).then(loadCandidates).catch((e) => {
  $('#err').textContent = e.message; $('#err').hidden = false;
});
// スマホで開いた瞬間にテンキーが出る。ここが1操作めなので、タップを1回減らす。
// preventScroll を付けないと、フォーカスに引きずられて種別と金額が画面の外へ出る。
$('#amount').focus({ preventScroll: true });

/* --- タブ --------------------------------------------------------------- */

const loaded = new Set();
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const el of document.querySelectorAll('nav button, .tab')) el.classList.remove('on');
  b.classList.add('on');
  $('#' + b.dataset.tab).classList.add('on');
  load(b.dataset.tab);
});

function load(tab) {
  if (loaded.has(tab)) return;
  loaded.add(tab);
  const fn = { summary: showSummary, tx: showTx, bal: showBalances, settings: showSettings }[tab];
  fn().catch((err) => {
    loaded.delete(tab);
    $('#' + tab).innerHTML = `<p class="loading">読めなかった: ${esc(err.message)}</p>`;
  });
}

/* --- 概要 ---------------------------------------------------------------
   出発点は「辛いのは入力だけ」なので、ここの仕事は分析ではなく
   **また入力したくなること**。だから重い集計を並べず、
   知らせ（乖離）→ いまの状態（あと何か月・今月のペース）→ 積み上げ（推移）
   の順に置き、それより下は畳んでおく。 */

/** 折りたたみの開閉を覚える。閉じたものが毎回開いて出るのは、それ自体が邪魔。 */
const OPEN = 'daifuku_open:';
const isOpen = (id, dflt) => {
  const v = localStorage.getItem(OPEN + id);
  return v === null ? dflt : v === '1';
};

const section = (id, title, body, dflt) =>
  `<details class="sec" data-sec="${id}"${isOpen(id, dflt) ? ' open' : ''}>
     <summary>${title}</summary>${body}</details>`;

/* toggle は伝播しないので捕捉フェーズで拾う。 */
$('#summary').addEventListener('toggle', (e) => {
  const el = e.target.closest?.('details[data-sec]');
  if (el) localStorage.setItem(OPEN + el.dataset.sec, el.open ? '1' : '0');
}, true);

async function showSummary() {
  const [d, recon, ins] = await Promise.all([
    get('/api/summary'),
    get('/api/reconcile?limit=12'),
    get('/api/insights?today=' + today()),
  ]);

  // 年 × 種別 を1行1年に組み替える。
  const years = new Map();
  for (const r of d.yearly) {
    if (!years.has(r.year)) years.set(r.year, {});
    years.get(r.year)[r.kind] = r.total;
  }

  nw = pivot(ins.netWorth);

  $('#summary').innerHTML =
    reconcileCard(recon) +
    runwayCard(ins) +
    paceCard(ins) +
    section('nw', '総資産の推移', netWorthBody(), true) +
    section('fixed', `毎月出ている支出<span class="count">${ins.recurring.length}件</span>`, recurringBody(ins), false) +
    section('yearly', '年ごとの収支', yearlyBody(years), false) +
    section('review', `目で確認が要る行<span class="count">${d.review.length}件</span>`, reviewBody(d.review), false);

  review = d.review;
}

let review = [];

/* --- あと何か月 ---------------------------------------------------------
   「資産が減った」は行動につながらないが、「10か月が9か月になった」はなる。
   使いすぎると分子が減って分母が増えるので、両側から効く。 */

function runwayCard(ins) {
  const cash = latest(nw, ins.cashClass);
  const burn = ins.spending.monthly;
  if (!burn || cash === null)
    return '<div class="stat"><p class="stat-label">あと何か月</p>' +
           '<p class="memo">支出か残高の記録がまだ足りない。</p></div>';

  const months = cash / burn;
  return `
    <div class="stat">
      <p class="stat-label">あと何か月</p>
      <p class="stat-value">${months.toFixed(1)}<span>か月</span></p>
      <p class="memo">${esc(ins.cashClass)} ${yen(cash)} ÷ 月 ${yen(burn)}
         （直近${ins.spending.months}か月の平均）。収入がゼロになった場合の目安で、予測ではない。</p>
    </div>`;
}

/* --- 今月のペース -------------------------------------------------------
   月末に締めた数字はその月にはもう間に合わない。
   途中で比べられる形にしておくことに意味がある。 */

function paceCard(ins) {
  const { thisMonth, prevSameDay, prevFull } = ins.pace;
  const diff = thisMonth - prevSameDay;
  const cmp = prevSameDay
    ? `<span class="${diff > 0 ? 'minus' : 'plus'}">${diff > 0 ? '＋' : '−'}${yen(Math.abs(diff))}</span>`
    : '<span class="chip">比べる先がない</span>';

  return `
    <div class="stat">
      <p class="stat-label">今月ここまで</p>
      <p class="stat-value">${yen(thisMonth)}</p>
      <p class="memo">先月の同じ日まで ${yen(prevSameDay)} → ${cmp}
         ${prevFull ? `／先月ぜんぶで ${yen(prevFull)}` : ''}</p>
    </div>`;
}

/* --- 総資産の推移 -------------------------------------------------------
   **クラス別の積み上げが既定。** 1本の線にすると事実を読み違える。
   実データでは直近半年の総額が減っていたが、クラス別に割ると現金も投資も
   増えていて、減っているのは自分では動かせない口座だけだった。
   自分の家計の成績ではない。

   色は識別のためでなく意味で割り当てる。自分で動かす現金＝青、
   増える前提の投資＝緑、手の届かない共有管理＝灰。灰は彩度を落として
   「これは自分の成績ではない」と読めるようにしてある。 */

let nw = null;
const RANGES = [['1y', '1年', 12], ['2y', '2年', 24], ['all', '全期間', 0]];
const RANGE_KEY = 'daifuku_nw_range';

function pivot(rows) {
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const order = (c) => (c === '現金' ? 0 : c === '投資' ? 1 : 2);
  const names = [...new Set(rows.map((r) => r.class))]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'ja'));
  const at = new Map(dates.map((d, i) => [d, i]));
  const series = names.map((name) => ({ name, values: dates.map(() => 0) }));
  const byName = new Map(series.map((s) => [s.name, s]));
  for (const r of rows) byName.get(r.class).values[at.get(r.date)] = r.total;
  return { dates, series };
}

/** 最新スナップショットでの、そのクラスの残高。 */
function latest(p, name) {
  if (!p || !p.dates.length) return null;
  const s = p.series.find((x) => x.name === name);
  return s ? s.values[s.values.length - 1] : null;
}

function sliceRange(p, months) {
  if (!months || !p.dates.length) return p;
  const last = p.dates[p.dates.length - 1];
  const [y, m, d] = last.split('-').map(Number);
  const cut = new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
  const i = p.dates.findIndex((x) => x >= cut);
  if (i <= 0) return p;
  return { dates: p.dates.slice(i), series: p.series.map((s) => ({ ...s, values: s.values.slice(i) })) };
}

function netWorthBody() {
  const saved = localStorage.getItem(RANGE_KEY);
  const cur = RANGES.some((r) => r[0] === saved) ? saved : '2y';
  return `
    <div class="nw">
      <div class="nw-range">${RANGES.map(([k, label]) =>
        `<button data-range="${k}" class="${k === cur ? 'on' : ''}">${label}</button>`).join('')}</div>
      <div class="nw-body">${netWorthChart(cur)}</div>
    </div>`;
}

const man = (v) => (Math.round(v / 1000) / 10).toLocaleString('ja-JP') + '万';

function netWorthChart(rangeKey) {
  const months = (RANGES.find((r) => r[0] === rangeKey) ?? RANGES[1])[2];
  const p = sliceRange(nw, months);
  const n = p.dates.length;
  if (n < 2) return '<p class="memo">推移を描くには残高の記録が2回ぶん要る。</p>';

  const W = 640, H = 240, PT = 16, PB = 24, PX = 6;
  const totals = p.dates.map((_, i) => p.series.reduce((s, ser) => s + ser.values[i], 0));
  const step = [100000, 200000, 500000, 1000000, 2000000, 5000000]
    .find((s) => Math.max(...totals) / s <= 4) ?? 10000000;
  const top = Math.max(step, Math.ceil(Math.max(...totals) / step) * step);
  const x = (i) => PX + (i * (W - PX * 2)) / (n - 1);
  const y = (v) => PT + (1 - v / top) * (H - PT - PB);

  let below = p.dates.map(() => 0);
  const bands = p.series.map((ser) => {
    const upper = below.map((b, i) => b + ser.values[i]);
    const up = upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const dn = below.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
    below = upper;
    return { fill: `M${up.join(' L')} L${dn.join(' L')} Z`, edge: `M${up.join(' L')}` };
  });

  const grid = [];
  for (let v = step; v <= top; v += step) {
    grid.push(`<line class="nw-grid" x1="${PX}" x2="${W - PX}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    grid.push(`<text class="nw-tick" x="${PX + 2}" y="${(y(v) - 4).toFixed(1)}">${man(v)}</text>`);
  }

  const ticks = n > 6 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
  const xlabels = ticks.map((i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text class="nw-tick" text-anchor="${anchor}" x="${x(i).toFixed(1)}" y="${H - 6}">${p.dates[i].slice(0, 7).replace('-', '/')}</text>`;
  }).join('');

  const first = totals[0], last = totals[n - 1];
  const change = last - first;

  return `
    <p class="nw-change">${esc(p.dates[0].slice(0, 7).replace('-', '/'))} から
      <b class="${change < 0 ? 'minus' : 'plus'}">${change < 0 ? '−' : '＋'}${yen(Math.abs(change))}</b></p>
    <svg class="nw-svg" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="資産クラス別の総資産推移。${esc(p.dates[0])} の ${yen(first)} から ${esc(p.dates[n - 1])} の ${yen(last)}。">
      ${grid.join('')}
      ${bands.map((b, i) => `<path class="nw-band s${i + 1}" d="${b.fill}"/>`).join('')}
      ${bands.map((b) => `<path class="nw-edge" d="${b.edge}"/>`).join('')}
      <line class="nw-guide" x1="0" x2="0" y1="${PT}" y2="${H - PB}" hidden/>
      ${xlabels}
    </svg>
    <div class="nw-read" data-i="${n - 1}">${readout(p, n - 1)}</div>`;
}

function readout(p, i) {
  const total = p.series.reduce((s, ser) => s + ser.values[i], 0);
  return `
    <p class="nw-date">${esc(p.dates[i])}　<b>${yen(total)}</b></p>
    <ul class="nw-legend">${p.series.map((ser, si) =>
      `<li><i class="s${si + 1}"></i>${esc(ser.name)}<b>${yen(ser.values[i])}</b></li>`).join('')}</ul>`;
}

/* 触ったところの数字を出す。狭い画面で軸の目盛りを読むより速い。 */
function nwTouch(e) {
  const svg = e.target.closest('.nw-svg');
  if (!svg) return;
  const wrap = svg.closest('.nw-body');
  const cur = localStorage.getItem(RANGE_KEY);
  const months = (RANGES.find((r) => r[0] === cur) ?? RANGES[1])[2];
  const p = sliceRange(nw, months);
  const n = p.dates.length;
  if (n < 2) return;

  const box = svg.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  const i = Math.round(((t * 640 - 6) / (640 - 12)) * (n - 1));
  const idx = Math.min(n - 1, Math.max(0, i));

  const read = wrap.querySelector('.nw-read');
  if (read.dataset.i === String(idx)) return;
  read.dataset.i = String(idx);
  read.innerHTML = readout(p, idx);

  const guide = svg.querySelector('.nw-guide');
  const gx = (6 + (idx * (640 - 12)) / (n - 1)).toFixed(1);
  guide.setAttribute('x1', gx);
  guide.setAttribute('x2', gx);
  guide.hidden = false;
}

$('#summary').addEventListener('pointerdown', nwTouch);
$('#summary').addEventListener('pointermove', (e) => { if (e.buttons) nwTouch(e); });

/* --- 毎月出ている支出 ---------------------------------------------------
   固定費は1回見直せば毎月効く。ただし「固定費」という列は無いので、
   直近12か月のうち何か月に出たかで当てる。 */

function recurringBody(ins) {
  if (!ins.recurring.length)
    return `<p class="memo">直近12か月で${ins.minMonths}か月以上に出ている品目はまだ無い。</p>`;

  const monthly = ins.recurring.reduce((s, r) => s + Math.round(r.total / r.months), 0);
  return `
    <p class="memo">直近12か月のうち${ins.minMonths}か月以上に出たもの。
       ならすと月あたり <b>${yen(monthly)}</b>。</p>
    <div class="card"><table class="plain">
      <thead><tr><th>品目</th><th class="num">1回あたり</th><th class="num">月数</th></tr></thead>
      <tbody>${ins.recurring.map((r) => `
        <tr><td class="item">${esc(r.item)}<span class="chip"> ${esc(r.category)}</span></td>
            <td class="num">${yen(r.avg)}</td>
            <td class="num">${r.months}/12</td></tr>`).join('')}</tbody>
    </table></div>`;
}

/* --- 年ごとの収支 ------------------------------------------------------- */

function yearlyBody(years) {
  return `
    <div class="card scroll"><table>
      <thead><tr><th>年</th><th class="num">収入</th><th class="num">支出</th><th class="num">投資</th><th class="num">差引</th></tr></thead>
      <tbody>${[...years].map(([y, v]) => {
        const diff = (v['収入'] ?? 0) - (v['支出'] ?? 0) - (v['投資'] ?? 0);
        return `<tr><td>${y}</td>
          <td class="num plus">${yen(v['収入'])}</td>
          <td class="num">${yen(v['支出'])}</td>
          <td class="num">${yen(v['投資'])}</td>
          <td class="num ${diff < 0 ? 'minus' : 'plus'}">${yen(diff)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

/* --- 目で確認が要る行 --------------------------------------------------- */

function reviewBody(rows) {
  return `
    <p class="memo">移行時に移動元・移動先を埋められなかった資金移動と、金額の無い覚書。
       呼び名（「貯蓄」「普段使い」など）は推測せずに空のままにしてある。</p>
    <div class="review">${rows.map((r, i) => `
      <button class="rev" data-i="${i}">
        <span class="rev-head"><span class="date">${esc(r.date)}</span>
          <span class="kind">${esc(r.kind)}</span>
          <span class="rev-amt">${r.amount ? yen(r.amount) : '—'}</span></span>
        <span class="rev-item">${esc(r.item) || '<span class="chip">（品目なし）</span>'}</span>
        ${r.memo ? `<span class="memo">${esc(r.memo)}</span>` : ''}
        ${r.kind === '振替' && !r.to_account_id ? '<span class="rev-todo">移動元・移動先が未設定</span>' : ''}
      </button>`).join('')}</div>`;
}

/* --- 乖離の知らせ -------------------------------------------------------
   入出金と残高を切り離した代償として、両者は必ずズレる。
   ズレていること自体は正常なので、大きいときだけ言う。直せとは言わない。 */

function reconcileCard(d) {
  // 切ってあるときは一行も出さない。切った意味が無くなる。
  if (d.off) return '';
  const rows = d.rows;
  if (!rows.length) return '<p class="memo">照合できる区間がまだ無い。</p>';

  const [now] = rows;
  const sign = (n) => (n > 0 ? '＋' : n < 0 ? '−' : '') + yen(Math.abs(n));
  const others = rows.filter((r) => r.over).length - (now.over ? 1 : 0);

  const head = now.over
    ? `<p class="recon-msg"><strong>${yen(Math.abs(now.gap))}</strong> の説明がついていません。</p>`
    : `<p class="recon-msg">ズレは <strong>${yen(Math.abs(now.gap))}</strong>。気にしなくていい範囲。</p>`;

  return `
    <div class="recon ${now.over ? 'over' : ''}">
      <div class="recon-head">${esc(now.from)} → ${esc(now.to)}（${now.days}日）</div>
      ${head}
      <div class="recon-nums">
        <span>実測 <b>${sign(now.actual)}</b></span>
        <span>帳簿 <b>${sign(now.book)}</b></span>
      </div>
      ${others > 0 ? `<p class="memo">ほかに ${others} 区間でも閾値を超えている。</p>` : ''}
      <details data-sec="recon"${isOpen('recon', false) ? ' open' : ''}>
        <summary>これまでの照合</summary>
        <div class="scroll"><table class="plain">
          <thead><tr><th>区間</th><th class="num">実測</th><th class="num">帳簿</th><th class="num">ズレ</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="${r.over ? 'over' : ''}">
              <td class="date">${esc(r.from)}→${esc(r.to)}</td>
              <td class="num">${sign(r.actual)}</td>
              <td class="num">${sign(r.book)}</td>
              <td class="num">${sign(r.gap)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </details>
    </div>`;
}

$('#summary').addEventListener('click', (e) => {
  const b = e.target.closest('.rev');
  if (b) { openEditor(review[Number(b.dataset.i)]); return; }

  const r = e.target.closest('[data-range]');
  if (r) {
    localStorage.setItem(RANGE_KEY, r.dataset.range);
    for (const x of r.parentElement.children) x.classList.toggle('on', x === r);
    r.closest('.nw').querySelector('.nw-body').innerHTML = netWorthChart(r.dataset.range);
  }
});

/* --- 設定 ---------------------------------------------------------------
   毎回見るものではないが、無いと困るもの。入力の邪魔にならない場所へ置く。 */

async function showSettings() {
  const [d, accounts, backup, settings] = await Promise.all([
    get('/api/summary'),
    get('/api/accounts?usage=1'),
    get('/api/backup'),
    get('/api/settings'),
  ]);
  const s = d.span ?? {};
  acctList = accounts;
  $('#settings').innerHTML = `
    <h2>書き出し</h2>
    <p class="memo">保管用と、AI に読ませる用。<code>data</code> 列まで含めて欠損なく出るので、
       これがあればアプリを作り直しても中身は失わない。</p>
    <div class="card">
      <div class="dl">
        <a href="/api/export/transactions.csv" download>入出金</a>
        <a href="/api/export/balances.csv" download>資産残高</a>
        <a href="/api/export/accounts.csv" download>口座</a>
      </div>
      <label class="bom"><input type="checkbox" id="bom"> Excel で開く（BOM・数式対策）</label>
    </div>

    <h2>自動バックアップ</h2>
    <p class="memo">毎時、${esc(backup.target.owner)}/${esc(backup.target.repo)} に同じCSVを書き出す。
       手で押し忘れた期間が、そのまま失う可能性のある期間になるのを避けるため。</p>
    <div class="card">
      <p class="backup-state">${backupState(backup)}</p>
      <div class="dl"><button id="runExport">いま書き出す</button></div>
    </div>

    <h2>取り込み</h2>
    <p class="memo">書き出したCSVをそのまま読み戻せる。
       <code>id</code> が既にある行は飛ばすので、同じCSVを2回入れても何も起きない。</p>
    <div class="card">
      <div class="dl"><label class="pick">CSVを選ぶ<input type="file" id="csv" accept=".csv,text/csv" hidden></label></div>
      ${backup.batches.length ? `
        <p class="hint" style="margin-top:.8rem">取り消せる取り込み</p>
        ${backup.batches.map((b) => `
          <div class="pending-row">
            <span>${esc(b.batch_id)} · ${esc(b.kind)} ${b.n}件</span>
            <button data-undo="${esc(b.batch_id)}">取り消す</button>
          </div>`).join('')}` : ''}
    </div>

    <h2>口座</h2>
    <p class="memo">名前を変えても過去の記録はそのまま残る。銀行の改称や用途の付け替えはここで。
       <strong>ここの並びが、残高の一括入力と資産タブの並びになる。</strong></p>
    <div class="bal-head">
      <button id="acctGroup">クラスと機関でまとめる</button>
      <button id="acctNew" class="save">口座を追加</button>
    </div>
    <div class="review" id="acctRows">${acctRows(accounts)}</div>

    <h2>乖離検知</h2>
    <p class="memo">入出金の合計と、残高の変化を突き合わせる。大きく食い違ったときだけ概要の一番上で知らせる。
       <strong>帳簿に載っていないお金の出入りがあるうちは必ず食い違う</strong>ので、
       意味を持つのは家計が自分の記録だけで閉じてから。</p>
    <div class="card">
      <label class="toggle">
        <input type="checkbox" id="reconOn"${settings.reconcile ? ' checked' : ''}>
        概要に出す
      </label>
      <p class="memo">切っても記録には何も起きない。<strong>戻せば過去の区間もそのまま出る。</strong></p>
    </div>

    <h2>中身</h2>
    <div class="card"><table class="plain"><tbody>
      <tr><td>入出金</td><td class="num">${s.transactions?.toLocaleString()} 件</td></tr>
      <tr><td>資産残高</td><td class="num">${s.balances?.toLocaleString()} 件 / ${s.snapshots} 回</td></tr>
      <tr><td>期間</td><td class="num">${esc(s.first)} 〜 ${esc(s.last)}</td></tr>
    </tbody></table></div>`;

  // BOM の有無はリンク先の ?bom=1 で切り替える。
  $('#bom').addEventListener('change', (e) => {
    for (const a of document.querySelectorAll('.dl a')) {
      const u = new URL(a.href);
      if (e.target.checked) u.searchParams.set('bom', '1');
      else u.searchParams.delete('bom');
      a.href = u.pathname + u.search;
    }
  });
}

/* --- 記録を直す ---------------------------------------------------------
   要確認の行から開く。見えているのに直せないと、一覧が「読むだけの負債」になる。 */

let editing = null;

function openEditor(row) {
  editing = row;
  $('#eDate').value = row.date;
  $('#eAmount').value = row.amount ? Number(row.amount).toLocaleString('ja-JP') : '';
  $('#eCategory').value = row.category ?? '';
  $('#eItem').value = row.item ?? '';
  $('#eMemo').value = row.memo ?? '';
  $('#eErr').hidden = true;

  const opts = state.accounts.filter((a) => !a.archived)
    .map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  $('#eAccount').innerHTML = `<option value="">（なし）</option>` + opts;
  $('#eFrom').innerHTML = `<option value="">（選ぶ）</option>` + opts;
  $('#eTo').innerHTML = `<option value="">（選ぶ）</option>` + opts;
  $('#eAccount').value = row.account_id ?? '';
  $('#eFrom').value = row.account_id ?? '';
  $('#eTo').value = row.to_account_id ?? '';

  setEditKind(row.kind);
  $('#sheet').hidden = false;
}

function setEditKind(kind) {
  for (const b of $('#eKinds').children) b.classList.toggle('on', b.dataset.kind === kind);
  const t = kind === '振替';
  $('#eTransfer').hidden = !t;
  $('#eAccountWrap').hidden = t;
}
const editKind = () => $('#eKinds .on')?.dataset.kind ?? '支出';

$('#eKinds').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (b) setEditKind(b.dataset.kind);
});

const closeSheet = () => { $('#sheet').hidden = true; editing = null; };
$('#sheetClose').addEventListener('click', closeSheet);
$('.sheet-bg').addEventListener('click', closeSheet);

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = editKind();
  const body = {
    date: $('#eDate').value,
    kind,
    category: $('#eCategory').value,
    item: $('#eItem').value,
    amount: Number(digits($('#eAmount').value) || 0),
    account_id: kind === '振替' ? $('#eFrom').value : $('#eAccount').value,
    to_account_id: kind === '振替' ? $('#eTo').value : '',
    memo: $('#eMemo').value,
  };
  try {
    await post('/api/transactions/' + encodeURIComponent(editing.id), body, 'PATCH');
    closeSheet();
    reloadViews();
    toast('直した');
  } catch (err) {
    $('#eErr').textContent = err.message;
    $('#eErr').hidden = false;
  }
});

$('#eDelete').addEventListener('click', async () => {
  if (!confirm('この記録を削除します。よろしいですか。')) return;
  try {
    await post('/api/transactions/' + encodeURIComponent(editing.id), null, 'DELETE');
    closeSheet();
    reloadViews();
    toast('削除した');
  } catch (err) {
    $('#eErr').textContent = err.message;
    $('#eErr').hidden = false;
  }
});

/** 中身が変わったので、開き直したときに古い表が出ないようにする。 */
function reloadViews() {
  for (const t of ['summary', 'tx', 'bal', 'settings']) loaded.delete(t);
  const open = $('nav button.on')?.dataset.tab;
  if (open && open !== 'add') { loaded.add(open); ({ summary: showSummary, tx: showTx, bal: showBalances, settings: showSettings })[open](); }
}

/* --- 入出金 ------------------------------------------------------------- */

const SIGN = { 支出: '−', 投資: '−', 収入: '＋' };
let offset = 0;
const LIMIT = 100;

async function showTx() {
  const params = new URLSearchParams({ limit: LIMIT, offset });
  if ($('#q').value.trim()) params.set('q', $('#q').value.trim());
  if ($('#kind').value) params.set('kind', $('#kind').value);
  const { rows, total } = await get('/api/transactions?' + params);
  txRows = rows;

  const body = rows.map((t, i) => {
    const sign = SIGN[t.kind] ?? '';
    // 支出には色を付けない。実データは支出838件・収入385件で、赤を付けると
    // 一覧がほぼ全部赤になる。家計簿の既定は支出で、色を付ける価値があるのは
    // 例外のほう（収入）。
    const cls = t.kind === '収入' ? 'plus' : '';
    const acct = t.acct_institution
      ? (t.acct_name ? `${t.acct_name}:${t.acct_institution}` : t.acct_institution)
      : '';
    // 並びは確認したくなる順。品目が分かればカテゴリはたいてい頭で分かるし、
    // カテゴリが分かれば種別も分かる。だから左から 日付・品目・金額 を先に置き、
    // 補助のカテゴリ・種別・口座は右へ送る（狭い画面では右が隠れる）。
    // 並びは確認したくなる順。品目が分かればカテゴリはたいてい頭で分かるし、
    // カテゴリが分かれば種別も分かる。だから 日付・品目・金額 を先に置く。
    //
    // 狭い画面では横スクロールになってしまうので、右の3列（カテゴリ・種別・口座）は
    // 隠して品目の下に畳む。同じ中身を2通りで書いているのはそのため。
    const sub = [t.category, t.kind, acct].filter(Boolean).map(esc).join(' · ');
    return `<tr data-i="${i}">
      <td class="date">${esc(t.date)}</td>
      <td class="item">${esc(t.item) || '<span class="chip">（品目なし）</span>'}
        ${t.memo ? `<br><span class="memo">${esc(t.memo)}</span>` : ''}
        <span class="sub">${sub}</span></td>
      <td class="num ${cls}">${sign}${yen(t.amount)}</td>
      <td>${esc(t.category)}</td>
      <td><span class="kind">${esc(t.kind)}</span></td>
      <td>${acct ? `<span class="chip">${esc(acct)}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + LIMIT, total);
  const html = `
    <div class="card scroll"><table class="tx">
      <thead><tr><th>日付</th><th>品目</th><th class="num">金額</th><th>カテゴリ</th><th>種別</th><th>口座</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="loading">見つからない</td></tr>'}</tbody>
    </table></div>
    <div class="pager">
      <button id="prev" ${offset === 0 ? 'disabled' : ''}>← 前</button>
      <span>${from}–${to} / ${total.toLocaleString()} 件</span>
      <button id="next" ${to >= total ? 'disabled' : ''}>次 →</button>
    </div>`;

  // 先頭のフィルタ行は作り直さない（入力中にフォーカスが飛ぶため）。
  for (const el of [...$('#tx').children].slice(1)) el.remove();
  $('#tx').insertAdjacentHTML('beforeend', html);
  $('#prev').onclick = () => { offset = Math.max(0, offset - LIMIT); showTx(); };
  $('#next').onclick = () => { offset += LIMIT; showTx(); };
}

/* 行をタップすると直すシートが開く。過去の記録は必ず直したくなる
   （打ち間違い、カテゴリの付け替え、後から分かる支払元）。 */
let txRows = [];
$('#tx').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr) openEditor(txRows[Number(tr.dataset.i)]);
});

let timer;
const refilter = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; showTx(); }, 200); };
$('#q').addEventListener('input', refilter);
$('#kind').addEventListener('change', refilter);

/* --- 資産 --------------------------------------------------------------- */

async function showBalances() {
  const rows = await get('/api/balances?dates=24');

  // 日付ごとにまとめる。全口座が同じ日に揃うとは限らないので、
  // ここでは持ち越しをせず「その日に記録された分」だけを出す。
  //
  // メモ（`予備+財布+未処理` など）は表に出さない。行が2段になって数字が読みにくく、
  // 内訳の覚書なので一覧で毎回見るものではない。CSV には出ているので失ってはいない。
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.date)) days.set(r.date, []);
    days.get(r.date).push(r);
  }

  const head = `<div class="bal-head">
      <button id="balOpen" class="ghost">残高を記録</button>
    </div>`;

  $('#bal').innerHTML = head + [...days].map(([date, list]) => {
    const total = list.reduce((s, r) => s + r.amount, 0);
    return `
      <h2>${esc(date)} <span class="chip">${list.length}口座 / 計 ${yen(total)}</span></h2>
      <div class="card scroll"><table class="plain">
        <thead><tr><th>口座</th><th class="num">残高</th><th>クラス</th></tr></thead>
        <tbody>${list.map((r) => `
          <tr>
            <td>${esc(r.name ? `${r.name}:${r.institution}` : r.institution)}
                ${r.in_reconciliation ? '' : '<span class="chip">照合外</span>'}</td>
            <td class="num">${yen(r.amount)}</td>
            <td><span class="kind">${esc(r.class)}</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  }).join('');
}


/* --- 資産残高を記録する -------------------------------------------------
   直近8回すべてが「月1回・10口座まとめて」だった。1件ずつ入れる画面では苦痛なので、
   前回値を入れた全口座を並べて、変わったところだけ書き換えて一度に保存する。 */

let draft = [];
let common = null;   // 前回の記録日のうち、いちばん多いもの

$('#bal').addEventListener('click', (e) => {
  if (e.target.closest('#balOpen')) openBalances(today());
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close="bal"]')) $('#balSheet').hidden = true;
});

async function openBalances(date) {
  $('#balDate').value = date;
  $('#balErr').hidden = true;
  $('#balSheet').hidden = false;
  await loadDraft();
}

$('#balDate').addEventListener('change', loadDraft);

async function loadDraft() {
  const date = $('#balDate').value;
  if (!date) return;
  draft = await get('/api/balances/draft?date=' + encodeURIComponent(date));

  // 前回の日付はほとんどの口座で同じなので、上に1回だけ出す。
  // 行ごとに書くと1行が3段になって、10口座を見渡せなくなる。
  const dates = draft.map((d) => d.carry_date).filter(Boolean);
  common = dates.sort((a, b) =>
    dates.filter((x) => x === b).length - dates.filter((x) => x === a).length)[0] ?? null;

  const already = draft.some((d) => d.current !== null);
  $('#balNote').textContent = already
    ? 'この日には既に記録がある。保存すると上書きになる。'
    : common
      ? `前回（${common}）の残高を入れてある。変わったところだけ直せばいい。`
      : '前回の残高を入れてある。変わったところだけ直せばいい。';

  // クラスのバッジはここには出さない（資産一覧で見られる）。
  // 入れると長い口座名が3段に折れて、10口座を見渡せなくなる。
  $('#balRows').innerHTML = draft.map((d, i) => {
    const label = d.name ? `${d.name}:${d.institution}` : d.institution;
    const value = d.current !== null ? d.current : d.carry;
    return `<div class="bal-row">
      <div class="bal-name">${esc(label)}</div>
      <input class="bal-amt" data-i="${i}" inputmode="numeric" autocomplete="off"
             value="${value === null ? '' : Number(value).toLocaleString('ja-JP')}">
      <div class="bal-diff" data-diff="${i}"></div>
    </div>`;
  }).join('');

  for (const el of document.querySelectorAll('.bal-amt')) refreshDiff(el);
  refreshTotal();
}

/** 「¥-12,000」も受ける（負債はマイナスで持つ）。空欄は null＝今回は数えなかった。 */
function balValue(el) {
  const raw = el.value.replace(/[^\d-]/g, '');
  if (raw === '' || raw === '-') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

$('#balRows').addEventListener('input', (e) => {
  const el = e.target.closest('.bal-amt');
  if (!el) return;
  const n = balValue(el);
  el.value = n === null ? el.value.replace(/[^\d-]/g, '') : n.toLocaleString('ja-JP');
  refreshDiff(el);
  refreshTotal();
});

/* 前回からいくら動いたかを出す。金額そのものより、この差のほうが
   「入れ間違えた」に気づきやすい（桁を1つ間違えると差が跳ねる）。 */
function refreshDiff(el) {
  const i = Number(el.dataset.i);
  const d = draft[i];
  const now = balValue(el);
  const box = $(`[data-diff="${i}"]`);
  if (now === null) { box.textContent = '記録しない'; box.className = 'bal-diff muted'; return; }
  if (d.carry === null) { box.textContent = '初めての記録'; box.className = 'bal-diff muted'; return; }
  // 日付は上に出してあるので、そこと違う口座のときだけ添える。
  const when = d.carry_date === common ? '' : `（${d.carry_date} から）`;
  const diff = now - d.carry;
  box.textContent = diff === 0 ? `変わらず${when}`
    : `${diff > 0 ? '＋' : '−'}${yen(Math.abs(diff))}${when}`;
  box.className = 'bal-diff' + (diff === 0 ? ' muted' : diff > 0 ? ' plus' : ' minus');
}

function refreshTotal() {
  let sum = 0;
  for (const el of document.querySelectorAll('.bal-amt')) sum += balValue(el) ?? 0;
  $('#balTotal').textContent = yen(sum);
}

$('#balForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const entries = [...document.querySelectorAll('.bal-amt')].map((el) => ({
    account_id: draft[Number(el.dataset.i)].id,
    amount: balValue(el),
    memo: '',
  }));
  try {
    const { saved } = await post('/api/balances', { date: $('#balDate').value, entries });
    $('#balSheet').hidden = true;
    reloadViews();
    toast(`${$('#balDate').value} の残高を ${saved}口座ぶん記録した`);
  } catch (err) {
    $('#balErr').textContent = err.message;
    $('#balErr').hidden = false;
  }
});

/* --- 口座の設定 ---------------------------------------------------------
   銀行の合併・改称や、用途の付け替え（「普段使い」→「生活防衛」）は普通に起きる。
   口座としては同じものなので、名前を変えても過去の記録は id で結ばれたまま残る。 */

let acctList = [];
let editingAcct = null;

/* 並びの決定点は口座一覧ひとつだけ。ここを直すと一括入力も資産タブも一緒に動く。 */
function acctRows(list) {
  return list.map((a, i) => `
    <div class="acct-row">
      <button class="rev" data-acct="${i}">
        <span class="rev-head">
          <span class="rev-item">${esc(a.label)}</span>
          <span class="kind">${esc(a.class)}</span></span>
        <span class="memo">
          ${a.in_reconciliation ? '照合の対象' : '照合の対象外'}
          ${a.archived ? ' · 使っていない' : ''}
          ${a.last_balance ? ` · 最後の記録 ${esc(a.last_balance)}` : ''}
        </span>
      </button>
      <span class="acct-move">
        <button data-move="-1" data-i="${i}" aria-label="上へ"${i === 0 ? ' disabled' : ''}>▲</button>
        <button data-move="1" data-i="${i}" aria-label="下へ"${i === list.length - 1 ? ' disabled' : ''}>▼</button>
      </span>
    </div>`).join('');
}

/* まとめ方。クラスは使用頻度の順に決め打ちし、それ以外は名前順で後ろへ。
   機関はクラスの中で最初に出てきた順を保つ（勝手に五十音で並べ替えない）。 */
const CLASS_ORDER = ['現金', '投資', '共有管理'];

function groupedOrder(list) {
  const ck = (c) => { const i = CLASS_ORDER.indexOf(c); return i < 0 ? CLASS_ORDER.length : i; };
  const key = (a) => a.class + '\u0000' + a.institution;
  const seen = new Map();
  list.forEach((a, i) => { if (!seen.has(key(a))) seen.set(key(a), i); });
  // Array.prototype.sort は安定なので、ここまで同点なら今の並びが残る。
  return [...list].sort((a, b) =>
    (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
    ck(a.class) - ck(b.class) ||
    a.class.localeCompare(b.class, 'ja') ||
    seen.get(key(a)) - seen.get(key(b)));
}

async function saveOrder(list) {
  acctList = list;
  $('#acctRows').innerHTML = acctRows(list);
  try {
    await post('/api/accounts/order', { ids: list.map((a) => a.id) }, 'PATCH');
    await loadAccounts();
    for (const t of ['bal', 'settings']) loaded.delete(t);
  } catch (err) {
    toast('並び替えられなかった: ' + err.message);
    reloadViews();
  }
}

$('#settings').addEventListener('click', (e) => {
  if (e.target.closest('#acctNew')) return openAccount(null);
  if (e.target.closest('#acctGroup')) return saveOrder(groupedOrder(acctList));

  const mv = e.target.closest('[data-move]');
  if (mv) {
    const i = Number(mv.dataset.i), j = i + Number(mv.dataset.move);
    const list = [...acctList];
    // 使っていない口座は一覧でも一括入力でも下にまとまる。境目はまたがせない。
    if (!list[j] || !list[i] || Boolean(list[i].archived) !== Boolean(list[j].archived)) return;
    [list[i], list[j]] = [list[j], list[i]];
    return saveOrder(list);
  }

  const b = e.target.closest('[data-acct]');
  if (b) openAccount(acctList[Number(b.dataset.acct)]);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close="acct"]')) $('#acctSheet').hidden = true;
});

/** a が null なら新しい口座。同じシートを使う（項目がまったく同じなので）。 */
function openAccount(a) {
  editingAcct = a;
  const isNew = a === null;

  $('#aTitle').textContent = isNew ? '口座を追加' : '口座の設定';
  $('#aInst').value = isNew ? '' : a.institution;
  $('#aName').value = isNew ? '' : (a.name ?? '');
  // 新しい口座はたいてい現金で、照合に入れたいもの。よくある方を初期値にする。
  $('#aClass').value = isNew ? '現金' : (a.class ?? '');
  $('#aRecon').checked = isNew ? true : !!a.in_reconciliation;
  $('#aArchived').checked = isNew ? false : !!a.archived;
  $('#aErr').hidden = true;

  // 既にあるクラスを候補に出す。一覧は設定ではなく中身から出す（他の分類と同じ）。
  $('#classList').innerHTML = [...new Set(acctList.map((x) => x.class))]
    .filter(Boolean).map((c) => `<option value="${esc(c)}">`).join('');

  $('#aUsage').textContent = isNew
    ? '足したあと、資産タブの「残高を記録」で残高を入れる。'
    : `残高 ${a.balances ?? 0} 件 / 入出金 ${a.transactions ?? 0} 件がこの口座に紐づいている。`;

  previewLabel();
  $('#acctSheet').hidden = false;
  $('#aInst').focus({ preventScroll: true });
}

/* 「用途:機関」で表示されるので、打っている途中でも結果が見えるようにする。 */
function previewLabel() {
  const inst = $('#aInst').value.trim(), name = $('#aName').value.trim();
  $('#aPreview').textContent = inst ? `表示は「${name ? name + ':' + inst : inst}」になる` : '';
}
$('#aInst').addEventListener('input', previewLabel);
$('#aName').addEventListener('input', previewLabel);

$('#acctForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    institution: $('#aInst').value,
    name: $('#aName').value,
    class: $('#aClass').value,
    in_reconciliation: $('#aRecon').checked,
    archived: $('#aArchived').checked,
  };
  try {
    if (editingAcct) await post('/api/accounts/' + encodeURIComponent(editingAcct.id), body, 'PATCH');
    else await post('/api/accounts', body);
    $('#acctSheet').hidden = true;
    // 口座名は入力画面のセレクトにも出るので、そちらも読み直す。
    await loadAccounts();
    reloadViews();
    toast(editingAcct ? '口座を直した' : '口座を足した');
  } catch (err) {
    $('#aErr').textContent = err.message;
    $('#aErr').hidden = false;
  }
});

/* --- 圏外 ---------------------------------------------------------------
   買った直後にその場で入れる道具なので、電波の弱い店内で落ちては困る。

   **透明な自動キューにしない。** 家計簿で一番痛い壊れ方は
   「入れたつもりで消えていた」なので、送れていない分は必ず目に見える場所に出し、
   自分の手でも送れるようにする（leaves と同じ方針）。 */

const PENDING = 'daifuku_pending';

const readPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING) ?? '[]'); } catch { return []; }
};
const writePending = (list) => localStorage.setItem(PENDING, JSON.stringify(list));

function enqueue(body) {
  writePending([...readPending(), { at: Date.now(), body }]);
  renderPending();
}

function renderPending() {
  const list = readPending();
  const box = $('#pending');
  box.hidden = list.length === 0;
  if (!list.length) return;

  box.innerHTML = `
    <div class="pending-head">
      <strong>未送信 ${list.length}件</strong>
      <button id="flush">いま送る</button>
    </div>
    ${list.map((p, i) => `
      <div class="pending-row">
        <span>${esc(p.body.date)} ${esc(p.body.kind)}
          ${esc(p.body.item) || esc(p.body.category) || ''}</span>
        <b>${yen(p.body.amount)}</b>
        <button data-drop="${i}" aria-label="消す">✕</button>
      </div>`).join('')}`;
}

$('#pending').addEventListener('click', (e) => {
  if (e.target.closest('#flush')) return flush(true);
  const drop = e.target.closest('[data-drop]');
  if (drop) {
    const list = readPending();
    list.splice(Number(drop.dataset.drop), 1);
    writePending(list);
    renderPending();
  }
});

/**
 * 溜まった分を古い順に送る。圏外なら1件目で止める
 * （続けても全部落ちるだけで、順番も崩れる）。
 */
async function flush(loud = false) {
  let list = readPending();
  if (!list.length) return;

  let sent = 0;
  while (list.length) {
    try {
      await post('/api/transactions', list[0].body);
    } catch (err) {
      if (!err.offline) {
        // サーバに拒否された分は送り直しても直らない。外して先へ進む。
        list.shift();
        writePending(list);
        toast(`1件送れなかった: ${err.message}`);
        continue;
      }
      break;
    }
    list.shift();
    writePending(list);
    sent++;
  }

  renderPending();
  if (sent) {
    for (const t of ['summary', 'tx', 'bal', 'settings']) loaded.delete(t);
    toast(`未送信 ${sent}件を送った`);
  } else if (loud) {
    toast('まだつながらない');
  }
}

/** 圏外でも入力欄が使えるように、口座とカテゴリは端末に控える。 */
async function keep(key, load) {
  try {
    const v = await load();
    localStorage.setItem('daifuku_keep:' + key, JSON.stringify(v));
    return v;
  } catch (err) {
    const cached = localStorage.getItem('daifuku_keep:' + key);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

window.addEventListener('online', () => flush());
renderPending();
flush();

/* 殻をキャッシュしておく。殻が開かないと未送信キューに書き込むこともできない。 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* --- バックアップと取り込み ---------------------------------------------
   書き出しは「静かに止まる」のが一番まずい壊れ方なので、
   最後に成功した日時と、失敗したときの理由を必ず出す。 */

function backupState(b) {
  if (b.error) {
    return `<span class="minus">書き出せていない（${esc(b.error.at.slice(0, 16).replace('T', ' '))}）<br>
            ${esc(b.error.message)}</span>`;
  }
  if (!b.last) return '<span class="muted">まだ一度も書き出していない。</span>';
  const when = b.last.at.slice(0, 16).replace('T', ' ');
  return `最後の書き出し ${esc(when)} UTC · ${b.last.rows} 行`;
}

$('#settings').addEventListener('click', async (e) => {
  if (e.target.closest('#runExport')) {
    const b = e.target.closest('#runExport');
    b.disabled = true;
    try {
      const r = await post('/api/export/run', {});
      toast(r.changed ? `書き出した（${r.rows} 行）` : '変わっていないので書き出さなかった');
    } catch (err) {
      toast('書き出せなかった: ' + err.message);
    }
    b.disabled = false;
    loaded.delete('settings');
    reloadViews();
    return;
  }

  const undo = e.target.closest('[data-undo]');
  if (undo) {
    if (!confirm(`この取り込みを取り消します（${undo.dataset.undo}）。よろしいですか。`)) return;
    try {
      const r = await post('/api/import/' + encodeURIComponent(undo.dataset.undo), null, 'DELETE');
      toast(`${r.removed}件を取り消した`);
      for (const t of ['summary', 'tx', 'bal', 'settings']) loaded.delete(t);
      await loadAccounts();
      reloadViews();
    } catch (err) {
      toast('取り消せなかった: ' + err.message);
    }
  }
});

/* ファイルを選んだ時点で取り込む。種類は見出しから当てるので選ばせない。 */
$('#settings').addEventListener('change', async (e) => {
  const recon = e.target.closest('#reconOn');
  if (recon) {
    try {
      await post('/api/settings', { reconcile: recon.checked }, 'PATCH');
      reloadViews();
      toast(recon.checked ? '乖離検知を概要に出す' : '乖離検知を切った');
    } catch (err) {
      recon.checked = !recon.checked;   // 通らなかったら見た目も戻す
      toast('切り替えられなかった: ' + err.message);
    }
    return;
  }

  const input = e.target.closest('#csv');
  if (!input?.files?.length) return;
  const file = input.files[0];
  input.value = '';
  try {
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: await file.text(),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? r.statusText);
    toast(`${d.kind} を ${d.added}件 取り込んだ${d.skipped ? `（${d.skipped}件は既にあった）` : ''}`);
    for (const t of ['summary', 'tx', 'bal', 'settings']) loaded.delete(t);
    await loadAccounts();
    reloadViews();
  } catch (err) {
    toast('取り込めなかった: ' + err.message);
  }
});
