// デモ版の裏側。**サーバには一切行かない。**
//
// daifuku-demo.kazuki.page でだけ、Worker がこの1行を index.html に差し込む
// （src/index.ts の demoShell）。本番の daifuku.kazuki.page には入らない。
//
// なぜブラウザの中で完結させるか:
//   共有の D1 に書かせると、kazuki.page の配下に**誰でも書ける家計簿**が
//   できてしまう。定期的に消す手もあるが、消すまでの間は他人の入れた金額が
//   他の来訪者にも見える。デモのために引き受ける筋の話ではない。
//   localStorage なら来訪者ごとに完全に隔離され、荒らされる面がゼロになる。
//
// 代償は、**サーバの実装をここでもう一度書いていること**。src/store.ts と
// src/import.ts と、この中の二重管理になる。デモが担うのは「触った感じが
// 分かる」ところまでで、本番の正しさを保証する場所ではない、と割り切る。
// 食い違いが出たら、直すのは本番が先。
//
// app.js には手を入れない。get()/post() が素の fetch を呼ぶので、ここで
// fetch を差し替えれば /api/* が丸ごとこちらに来る。CSV の書き出しリンクだけは
// fetch を通らないので、クリックを拾って別に受ける（いちばん下）。

(() => {
  'use strict';

  const KEY = 'daifuku.demo.v1';

  /* --- 保存 --------------------------------------------------------------- */
  // 1つのキーに全部入れる。デモの件数は知れているので、部分更新の速さより
  // 「読んで、いじって、書き戻す」が1か所で済むことを取る。

  let db = null;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (raw && raw.v === 1 && Array.isArray(raw.transactions)) return raw;
    } catch { /* 壊れていたら種から作り直す */ }
    return null;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch {
      // 容量が尽きた。**黙って落とさない。** 金額を扱う画面で
      // 「保存できたように見えて消える」のが一番たちが悪い。
      alert('この端末の保存容量が足りず、続きを覚えられませんでした。');
    }
  }

  /* --- 小物（store.ts / index.ts と同じ規則に揃える） ----------------------- */

  const uuid = () => crypto.randomUUID();
  const nowIso = () => new Date().toISOString();

  // app.js の「今日」は端末のローカル時刻。本番の Workers は UTC で動くので
  // サーバ側は端末から today を受け取っているが、こちらは最初から端末の中に
  // いるので素直にローカルで揃える。
  const todayStr = () => new Date().toLocaleDateString('sv-SE');

  const ymd = (s) => s.split('-').map(Number);

  /** 月をずらす。日は移動先の月末を超えないように丸める（3/31 → 2/28）。 */
  function shiftMonths(date, n) {
    const [y, m, d] = ymd(date);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
  }

  function shiftDays(date, n) {
    const [y, m, d] = ymd(date);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  /**
   * 表記ゆれを潰す鍵。store.ts の SQL
   *   replace(replace(replace(lower(item),' ',''),'　',''),'・','')
   * と同じもの。候補と「毎月出ている支出」の両方がこれで束ねる。
   */
  const normKey = (s) => String(s ?? '').toLowerCase().replaceAll(' ', '').replaceAll('　', '').replaceAll('・', '');

  const accountLabel = (a) => (a.name ? `${a.name}:${a.institution}` : a.institution);

  const acct = (id) => db.accounts.find((a) => a.id === id) ?? null;

  class Fail extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  /* --- 種 -----------------------------------------------------------------
     **固定の日付で焼き込めない。** 概要は「今月のペース」「あと何か月」を出すので、
     日付を焼いたダミーを入れると半年後に開いた人には今月が空っぽに見える。
     today から遡って組み立てる。

     乱数は固定の種から回す。毎回同じ絵が出ないと、同じ画面を見て話ができない。 */

  /** mulberry32。短くて、種を決めれば毎回同じ列が出る。暗号用途ではない。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const MONTHS_BACK = 25;   // 今月を入れて26か月。概要の12か月窓が埋まり、年次が3年ぶん出る
  const CARD_KEY = 'card';

  const SEED_ACCOUNTS = [
    // in_reconciliation は「収支帳簿に載る口座か」。時価が動く投資と、
    // 引き落としが翌月にずれるカードは外す（DESIGN.md「乖離検知」）。
    { key: 'salary', institution: 'みなと銀行',   name: '給与',   class: '現金', in_reconciliation: 1, open: 640000 },
    { key: 'living', institution: 'そら銀行',     name: '生活費', class: '現金', in_reconciliation: 1, open: 260000 },
    { key: 'wallet', institution: '財布',         name: '',       class: '現金', in_reconciliation: 1, open: 34000 },
    { key: 'nisa',   institution: 'ひかり証券',   name: 'つみたて', class: '投資', in_reconciliation: 0, open: 620000 },
    { key: 'card',   institution: 'つばめカード', name: '',       class: '負債', in_reconciliation: 0, open: 0 },
  ];

  // 食費まわりは金額の幅を持たせる。全部同じ額だと候補が異様によく当たる
  // デモになり、実際に使ったときとの落差が大きくなる。
  const FOOD = [
    { item: 'スーパー',       category: '食費',   lo: 1200, hi: 4800, pay: 'card',   per: 5 },
    { item: 'コンビニ',       category: '食費',   lo: 320,  hi: 1200, pay: 'wallet', per: 4 },
    { item: 'ランチ',         category: '食費',   lo: 620,  hi: 1300, pay: 'wallet', per: 4 },
    { item: '外食',           category: '食費',   lo: 2200, hi: 6400, pay: 'card',   per: 1 },
    { item: 'ドラッグストア', category: '日用品', lo: 800,  hi: 3900, pay: 'card',   per: 3 },
    { item: '電車',           category: '交通',   lo: 320,  hi: 980,  pay: 'wallet', per: 4 },
    { item: '本',             category: '教養',   lo: 900,  hi: 2800, pay: 'card',   per: 1 },
    { item: '飲み会',         category: '交際',   lo: 3500, hi: 6800, pay: 'card',   per: 1 },
  ];

  // 毎月の固定費。**YouTube Music は綴りを揺らしてある。**
  // 候補と「毎月出ている支出」が表記ゆれを束ねるところを見せたいので、
  // 実データにあったのと同じ壊れ方（YouTube Music / youtubemusic）を再現する。
  const FIXED = [
    { day: 3,  item: 'Netflix',      category: 'サブスク', amount: 1590, pay: 'card' },
    { day: 5,  item: '電気代',       category: '光熱',     amount: null, pay: 'living' },
    { day: 8,  item: 'ガス代',       category: '光熱',     amount: null, pay: 'living' },
    { day: 12, item: '携帯',         category: '通信',     amount: 2970, pay: 'living' },
    { day: 12, item: '光回線',       category: '通信',     amount: 4730, pay: 'living' },
    { day: 15, item: 'Spotify',      category: 'サブスク', amount: 980,  pay: 'card' },
    { day: 20, item: 'YouTube Music', category: 'サブスク', amount: 1280, pay: 'card',
      // 綴りは3種類だが**同数にはしない**。同数だと代表が最終日で決まり、
      // 「一番よく使われている綴りを代表にする」という規則が働いて見えない。
      spellings: ['YouTube Music', 'YouTube Music', 'youtubemusic', 'YouTube Music', 'Youtube Music'] },
    { day: 27, item: '家賃',         category: '住居',     amount: 72000, pay: 'living' },
  ];

  const MEMOS = [
    '車検、そろそろ。前回12万くらいだった',
    '定期便の米代、来月まとめて',
    '健康診断のオプション、次は胃カメラにする',
  ];

  function seed() {
    const rnd = mulberry32(20260822);
    const pick = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const now = nowIso();
    const today = todayStr();

    const accounts = SEED_ACCOUNTS.map((a, i) => ({
      id: uuid(), institution: a.institution, name: a.name, class: a.class,
      in_reconciliation: a.in_reconciliation, archived: 0, sort: i,
      batch_id: null, data: '{}', created_at: now, updated_at: now,
    }));
    const id = {};
    SEED_ACCOUNTS.forEach((a, i) => { id[a.key] = accounts[i].id; });

    const ledger = {};
    SEED_ACCOUNTS.forEach((a) => { ledger[a.key] = a.open; });

    const transactions = [];
    const balances = [];

    // 帳簿に載らない出費が起きる月。乖離検知が鳴るところを見せるために置く。
    // 起きない月ばかりだと、あの機能が何なのか分からないまま終わる。
    const LEAK_MONTHS = new Set([MONTHS_BACK - 19, MONTHS_BACK - 7]);

    const firstOfMonth = (back) => {
      const t = new Date();
      return new Date(t.getFullYear(), t.getMonth() - back, 1).toLocaleDateString('sv-SE');
    };

    /** その月の day 日。月末を超えたら丸める。未来なら null（今月は今日まで）。 */
    const dayOf = (monthStart, day) => {
      const d = shiftDays(shiftMonths(monthStart, 1), -1);
      const date = `${monthStart.slice(0, 8)}${String(Math.min(day, Number(d.slice(8)))).padStart(2, '0')}`;
      return date > today ? null : date;
    };

    const push = (t) => {
      transactions.push({
        id: uuid(), date: t.date, kind: t.kind, category: t.category ?? '',
        item: t.item ?? '', amount: t.amount,
        account_id: t.account_id ?? null, to_account_id: t.to_account_id ?? null,
        counterparty: t.counterparty ?? '', memo: t.memo ?? '',
        pair_id: t.pair_id ?? null, batch_id: null, data: t.data ?? '{}',
        created_at: `${t.date}T12:00:00.000Z`, updated_at: `${t.date}T12:00:00.000Z`,
      });
      return transactions[transactions.length - 1];
    };

    // 口座を書かなかった記録も、現金は実際に減っている。
    // 帳簿（reconcile）は account_id が空のものを対象内とみなすので、
    // こちらの残高も財布から引いておかないと、種の時点で辻褄が合わなくなる。
    const move = (key, delta) => { if (key) ledger[key] += delta; };

    // カードは**利用した月と落ちる月がずれる**。owed が先月ぶん（今月27日に落ちる）、
    // charged が今月ぶん（来月に回る）。ここを同じ月で相殺すると負債がいつも0になり、
    // 「入出金と残高の辻褄が合わないいちばん普通の理由」が絵に出ない。
    let owed = 0, charged = 0;

    for (let back = MONTHS_BACK; back >= 0; back--) {
      const ms = firstOfMonth(back);

      /* 残高のスナップショット。月初に全口座ぶん記録する。
         月1回・全口座まとめてが実際の使われ方だった（DESIGN.md「資産は一括編集」）。 */
      if (ms <= today) {
        // 数え漏れと、帳簿に載らない出費。**残高側に残す**（次の月で戻さない）。
        // 戻してしまうと乖離が毎回打ち消し合って、検知が一度も鳴らない。
        move('wallet', -pick(400, 3800));
        move('living', -pick(0, 2600));
        if (LEAK_MONTHS.has(back)) move('living', -pick(62000, 96000));
        // 投資は時価で動く。ここは乖離の対象外なので帳簿と合わなくてよい。
        ledger.nisa = Math.round(ledger.nisa * (1 + (rnd() * 0.075 - 0.03)));

        for (const a of SEED_ACCOUNTS) {
          balances.push({
            id: uuid(), date: ms, account_id: id[a.key],
            amount: Math.round(ledger[a.key]), memo: '',
            batch_id: null, data: '{}', created_at: now, updated_at: now,
          });
        }
      }

      /* 収入 */
      const [, mm] = ymd(ms);
      if (mm === 6 || mm === 12) {
        const d = dayOf(ms, 10);
        if (d) {
          push({ date: d, kind: '収入', category: '賞与', item: '賞与', amount: 290000, account_id: id.salary });
          move('salary', 290000);
          // 賞与の月はまとめて積み立てる。**毎月出ていない投資**が混ざっていないと、
          // 「毎月出ている支出」がつみたての定額しか知らないままになる。
          const lump = dayOf(ms, 12);
          if (lump) {
            push({ date: lump, kind: '投資', category: 'つみたて', item: 'スポット買付', amount: 250000, account_id: id.salary });
            move('salary', -250000); move('nisa', 250000);
          }
        }
      }
      const payday = dayOf(ms, 25);
      if (payday) {
        const pay = 232000 + pick(-3, 3) * 1000;
        push({ date: payday, kind: '収入', category: '給与', item: '給与', amount: pay, account_id: id.salary });
        move('salary', pay);
        // 生活費へ移す。**振替は収支ではない**ので、どちらの口座も動くだけ。
        push({ date: payday, kind: '振替', category: '', item: '生活費へ', amount: 145000, account_id: id.salary, to_account_id: id.living });
        move('salary', -145000); move('living', 145000);
      }

      /* 投資。account_id は**お金が出ていった口座**を書く（積立先ではない）。
         積立先の増減は残高の側で追う。ここを取り違えると毎月大きく乖離する。 */
      const nisaDay = dayOf(ms, 26);
      if (nisaDay) {
        push({ date: nisaDay, kind: '投資', category: 'つみたて', item: 'つみたてNISA', amount: 50000, account_id: id.salary });
        move('salary', -50000); move('nisa', 50000);
      }

      /* 現金の補充 */
      const atm = dayOf(ms, 6);
      if (atm) {
        push({ date: atm, kind: '振替', category: '', item: 'ATM', amount: 12000, account_id: id.living, to_account_id: id.wallet });
        move('living', -12000); move('wallet', 12000);
      }

      /* 固定費 */
      for (const f of FIXED) {
        const d = dayOf(ms, f.day);
        if (!d) continue;
        // 光熱費は季節で動く。年間ずっと同じ額だと、折れ線が定規になる。
        const seasonal = f.item === '電気代' ? [9200, 9800, 7600, 5400, 4200, 3900, 5100, 7300, 6200, 4600, 4900, 7100][mm - 1]
          : f.item === 'ガス代' ? [5400, 5600, 4700, 3600, 2900, 2500, 2400, 2400, 2500, 3000, 3800, 4900][mm - 1]
          : null;
        const amount = f.amount ?? seasonal + pick(-300, 300);
        // 綴りを月ごとに変える。正規化した鍵で1つに束ねられるところを見せるため。
        const item = f.spellings ? f.spellings[back % f.spellings.length] : f.item;
        push({ date: d, kind: '支出', category: f.category, item, amount, account_id: id[f.pay] });
        move(f.pay, -amount);
        if (f.pay === CARD_KEY) charged += amount;
      }
      // 水道は隔月。**毎月出ていないものが混ざっていないと**、
      // 「毎月出ている支出」がただの全品目一覧になってしまう。
      if (mm % 2 === 1) {
        const d = dayOf(ms, 8);
        if (d) {
          const amount = 4180 + pick(-200, 400);
          push({ date: d, kind: '支出', category: '光熱', item: '水道代', amount, account_id: id.living });
          move('living', -amount);
        }
      }

      /* 変動費 */
      for (const f of FOOD) {
        const n = Math.max(0, f.per + pick(-1, 1));
        for (let i = 0; i < n; i++) {
          const d = dayOf(ms, pick(1, 28));
          if (!d) continue;
          const amount = pick(f.lo, f.hi);
          // 少額は口座を書かない。実際そうなる（入力が楽であることが先）。
          const tagged = f.pay === 'card' || rnd() < 0.25;
          push({ date: d, kind: '支出', category: f.category, item: f.item, amount, account_id: tagged ? id[f.pay] : null });
          move(f.pay, -amount);
          if (f.pay === CARD_KEY) charged += amount;
        }
      }

      /* カードの引き落とし。先月ぶんが翌月に出ていく。
         **これが「入出金と残高の辻褄が合わない」いちばん普通の理由。** */
      const due = dayOf(ms, 27);
      if (due && owed > 0) {
        push({ date: due, kind: '振替', category: '', item: 'カード引き落とし', amount: owed, account_id: id.living, to_account_id: id.card });
        move('living', -owed); move('card', owed);
      }
      owed = charged;
      charged = 0;

      /* 予算ペア。立て替えて後で同額を受け取る運用。1操作で2レコード作る。 */
      if (back === MONTHS_BACK - 11 || back === MONTHS_BACK - 3) {
        const d = dayOf(ms, 18);
        if (d) {
          const amount = pick(6, 12) * 1000;
          const a = push({ date: d, kind: '支出', category: '交際', item: '歓送迎会', amount, account_id: id.wallet });
          const b = push({ date: d, kind: '収入', category: '予算', item: '歓送迎会予算', amount });
          a.pair_id = b.id; b.pair_id = a.id;
          move('wallet', -amount);
        }
      }
    }

    /* 要確認。金額を持たない覚書と、移動先が抜けた振替。
       **開いた人が最初に触る場所**になるので、種に入れておく。 */
    MEMOS.forEach((text, i) => {
      const d = shiftDays(todayStr(), -(3 + i * 9));
      push({ date: d, kind: 'メモ', category: '', item: text, amount: 0 });
    });
    push({
      date: shiftDays(todayStr(), -21), kind: '振替', category: '', item: '証券口座へ',
      amount: 120000, account_id: id.salary, to_account_id: null,
      data: JSON.stringify({ needs_review: '移動先が分からない' }),
    });

    // 一覧は date DESC, rowid DESC。rowid の代わりに入れた順を持つので、
    // 日付順に並べてから配列に置く（後で足した分は末尾に付く＝新しい rowid）。
    transactions.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

    return { v: 1, accounts, transactions, balances, meta: {} };
  }

  /* ======================================================================
     ここから下は src/store.ts の写し。SQL でやっていることを JS で書き直す。
     関数の並びと名前は store.ts に合わせてある（照らし合わせやすさを優先）。
     ====================================================================== */

  /** 配列を左から順に比べる。SQL の ORDER BY a, b, c と同じ効き方をさせる。 */
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  const parseData = (s) => { try { return JSON.parse(s || '{}') ?? {}; } catch { return {}; } };

  function qTransactions({ limit, offset, kind, q }) {
    let rows = db.transactions.map((t, rid) => ({ t, rid }));
    if (kind) rows = rows.filter(({ t }) => t.kind === kind);
    if (q) {
      const needle = q.toLowerCase();
      const hit = (v) => String(v ?? '').toLowerCase().includes(needle);
      rows = rows.filter(({ t }) => hit(t.item) || hit(t.category) || hit(t.memo) || hit(t.counterparty));
    }
    // 一覧は date DESC, rowid DESC。rowid の代わりに配列の位置を使う。
    rows.sort((a, b) => cmp([b.t.date, b.rid], [a.t.date, a.rid]));
    return {
      rows: rows.slice(offset, offset + limit).map(({ t }) => {
        const a = acct(t.account_id);
        return { ...t, acct_institution: a ? a.institution : null, acct_name: a ? a.name : null };
      }),
      total: rows.length,
    };
  }

  function qBalances(limitDates) {
    const dates = [...new Set(db.balances.map((b) => b.date))].sort().reverse().slice(0, limitDates);
    const keep = new Set(dates);
    return db.balances
      .filter((b) => keep.has(b.date))
      .map((b) => {
        const a = acct(b.account_id);
        return {
          date: b.date, amount: b.amount, memo: b.memo, account_id: a.id,
          institution: a.institution, name: a.name, class: a.class,
          in_reconciliation: a.in_reconciliation, sort: a.sort,
        };
      })
      .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.sort - y.sort));
  }

  function qSummary() {
    const dates = db.transactions.map((t) => t.date).sort();
    return {
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
      transactions: db.transactions.length,
      balances: db.balances.length,
      snapshots: new Set(db.balances.map((b) => b.date)).size,
    };
  }

  function qYearly() {
    const m = new Map();
    for (const t of db.transactions) {
      const k = t.date.slice(0, 4) + ' ' + t.kind;
      const cur = m.get(k) ?? { year: t.date.slice(0, 4), kind: t.kind, n: 0, total: 0 };
      cur.n++; cur.total += t.amount;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => cmp([b.year], [a.year]));
  }

  function qAccountUsage() {
    return db.accounts.map((a) => {
      const bal = db.balances.filter((b) => b.account_id === a.id);
      return {
        id: a.id,
        balances: bal.length,
        transactions: db.transactions.filter((t) => t.account_id === a.id || t.to_account_id === a.id).length,
        last_balance: bal.length ? bal.map((b) => b.date).sort().pop() : null,
      };
    });
  }

  /**
   * 候補。**入力を楽にする本体**なので、窓関数まで含めてそのまま写す。
   *   * 綴りは正規化した鍵で束ね、一番よく使われている綴りを代表にする
   *   * 金額は「最後に使った額」ではなく「一番多い額」を採る
   *     （最後の1回がたまたま日割りだと、毎回それが出てきて外れ続ける）
   */
  function qCandidates(amount, kind, limit) {
    const src = db.transactions
      .map((t, rid) => ({ ...t, rid, key: normKey(t.item) }))
      .filter((t) => t.item !== '' && t.kind === kind && (amount === null || t.amount === amount));

    const cnt = new Map(), spell = new Map(), amt = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const t of src) {
      bump(cnt, t.key);
      bump(spell, t.key + ' ' + t.item);
      bump(amt, t.key + ' ' + t.amount);
    }

    const best = new Map();
    for (const t of src) {
      const score = [spell.get(t.key + ' ' + t.item), amt.get(t.key + ' ' + t.amount), t.date, t.rid];
      const cur = best.get(t.key);
      if (!cur || cmp(score, cur.score) > 0) best.set(t.key, { t, score });
    }

    const rows = [...best.values()].map(({ t }) => ({
      item: t.item, category: t.category, kind: t.kind,
      account_id: t.account_id, amount: t.amount, cnt: cnt.get(t.key), date: t.date,
    }));
    // 金額を打っていないときは「よく使う順」、打った後は「最近使った順」。
    rows.sort((a, b) => (amount === null
      ? cmp([b.cnt, b.date], [a.cnt, a.date])
      : cmp([b.date, b.cnt], [a.date, a.cnt])));
    return rows.slice(0, limit).map(({ date, ...r }) => r);
  }

  function qCategories(kind, limit) {
    const m = new Map();
    for (const t of db.transactions) {
      if (t.kind !== kind || !t.category) continue;
      m.set(t.category, (m.get(t.category) ?? 0) + 1);
    }
    return [...m.entries()].map(([category, n]) => ({ category, n }))
      .sort((a, b) => b.n - a.n).slice(0, limit);
  }

  /* --- 乖離検知 ----------------------------------------------------------- */

  function qReconcile(threshold, limit) {
    // 日数で割るだけだと、短い区間がわずかにズレただけで鳴る。
    // 額そのものが小さいうちは気にしなくていいので、下限を置く。
    const FLOOR = 20000;

    const balRows = db.balances
      .filter((b) => acct(b.account_id) && acct(b.account_id).in_reconciliation === 1)
      .sort((x, y) => cmp([x.date, acct(x.account_id).sort], [y.date, acct(y.account_id).sort]));

    // 各レコードが「対象口座の現金をいくら動かしたか」に換算して日ごとに合計する。
    // **口座が未記入のものは対象内とみなす**（SQL の COALESCE の 1）。
    // そうしないと、口座を書いていない大多数のレコードが帳簿から消える。
    const inScope = (id) => {
      if (id === null) return 1;
      const a = acct(id);
      return a ? a.in_reconciliation : 1;
    };
    const effects = new Map();
    for (const t of db.transactions) {
      const a = inScope(t.account_id), b = inScope(t.to_account_id);
      let e = 0;
      if (t.kind === '収入') e = a === 1 ? t.amount : 0;
      else if (t.kind === '支出' || t.kind === '投資') e = a === 1 ? -t.amount : 0;
      else if (t.kind === '振替') {
        if (a === 1 && b === 0) e = -t.amount;
        else if (a === 0 && b === 1) e = t.amount;
      }
      effects.set(t.date, (effects.get(t.date) ?? 0) + e);
    }

    // 全口座が同じ日に揃うとは限らないので、直近の既知残高を持ち越して合計する。
    const held = new Map();
    const totals = [];
    for (const r of balRows) {
      held.set(r.account_id, r.amount);
      const sum = [...held.values()].reduce((x, y) => x + y, 0);
      const last = totals[totals.length - 1];
      if (last && last.date === r.date) last.total = sum;
      else totals.push({ date: r.date, total: sum });
    }

    const dates = [...effects.keys()].sort();
    const rows = [];
    for (let i = 1; i < totals.length; i++) {
      const a = totals[i - 1], b = totals[i];
      let book = 0;
      for (const d of dates) if (d > a.date && d <= b.date) book += effects.get(d) ?? 0;
      const days = Math.max(1, Math.round((Date.parse(b.date) - Date.parse(a.date)) / 86400000));
      const gap = (b.total - a.total) - book;
      rows.push({
        from: a.date, to: b.date, days,
        actual: b.total - a.total, book, gap,
        // 区間の長さがばらつくので、1日あたりに直して比べる。
        over: Math.abs(gap) >= FLOOR && Math.abs(gap) / days > threshold / 30,
      });
    }
    return rows.slice(-limit).reverse();
  }

  /* --- 資産の記録 --------------------------------------------------------- */

  function qBalanceDraft(date) {
    return db.accounts
      .filter((a) => !a.archived)
      .sort((x, y) => x.sort - y.sort)
      .map((a) => {
        // 全口座が同じ日に揃うとは限らないので、持ち越しは口座ごとに引く。
        const mine = db.balances
          .filter((b) => b.account_id === a.id && b.date <= date)
          .sort((x, y) => cmp([x.date], [y.date]));
        const carried = mine.length ? mine[mine.length - 1] : null;
        const same = db.balances.find((b) => b.account_id === a.id && b.date === date) ?? null;
        return {
          id: a.id, institution: a.institution, name: a.name, class: a.class, sort: a.sort,
          carry: carried ? carried.amount : null,
          carry_date: carried ? carried.date : null,
          current: same ? same.amount : null,
          memo: same ? same.memo : null,
        };
      });
  }

  /** 同じ日に同じ口座を2回持たない。空欄は「今回は数えなかった」＝その日の記録から外す。 */
  function wSaveBalances(date, entries) {
    const now = nowIso();
    for (const e of entries) {
      const i = db.balances.findIndex((b) => b.date === date && b.account_id === e.account_id);
      if (e.amount === null) { if (i >= 0) db.balances.splice(i, 1); continue; }
      if (i >= 0) Object.assign(db.balances[i], { amount: e.amount, memo: e.memo, updated_at: now });
      else db.balances.push({
        id: uuid(), date, account_id: e.account_id, amount: e.amount, memo: e.memo,
        batch_id: null, data: '{}', created_at: now, updated_at: now,
      });
    }
    return entries.filter((e) => e.amount !== null).length;
  }

  /* --- 概要の集計 --------------------------------------------------------- */

  /**
   * 資産クラスごとの総資産推移。
   * **その日に記録が無い口座は、直前に分かっている残高を持ち越す。**
   * 素直に日付で束ねると、1口座しか記録しなかった日がそのまま崖として出る。
   * 資産が10分の1になった日など無い。
   */
  function qNetWorth() {
    const dates = [...new Set(db.balances.map((b) => b.date))].sort();
    const out = [];
    for (const asof of dates) {
      const byClass = new Map();
      for (const a of db.accounts) {
        const mine = db.balances
          .filter((b) => b.account_id === a.id && b.date <= asof)
          .sort((x, y) => cmp([x.date], [y.date]));
        const amount = mine.length ? mine[mine.length - 1].amount : 0;
        byClass.set(a.class, (byClass.get(a.class) ?? 0) + amount);
      }
      for (const [cls, total] of byClass) out.push({ date: asof, class: cls, total });
    }
    return out;
  }

  /** 割る数は数えた月数ではなく months で固定する（store.ts と同じ理由）。 */
  function qSpending(from, to, months) {
    const total = db.transactions
      .filter((t) => t.kind === '支出' && t.date >= from && t.date < to)
      .reduce((s, t) => s + t.amount, 0);
    return { total, months, monthly: Math.round(total / months) };
  }

  function qPace(monthStart, today, prevStart, prevSameDay, prevEnd) {
    const sum = (a, b) => db.transactions
      .filter((t) => t.kind === '支出' && t.date >= a && t.date <= b)
      .reduce((s, t) => s + t.amount, 0);
    return {
      thisMonth: sum(monthStart, today),
      prevSameDay: sum(prevStart, prevSameDay),
      prevFull: sum(prevStart, prevEnd),
    };
  }

  /** 毎月出ている品目。表記ゆれは候補と同じ鍵で潰す。 */
  function qRecurring(from, to, minMonths) {
    const norm = db.transactions
      .filter((t) => t.item !== '' && (t.kind === '支出' || t.kind === '投資') && t.date >= from && t.date < to)
      .map((t) => ({ ...t, key: normKey(t.item) }));

    const counted = new Map();
    for (const t of norm) {
      const k = [t.key, t.item, t.category, t.kind].join(' ');
      const cur = counted.get(k)
        ?? { key: t.key, item: t.item, category: t.category, kind: t.kind, spell_n: 0, last_date: '' };
      cur.spell_n++;
      if (t.date > cur.last_date) cur.last_date = t.date;
      counted.set(k, cur);
    }
    const rep = new Map();
    for (const c of counted.values()) {
      const cur = rep.get(c.key);
      if (!cur || cmp([c.spell_n, c.last_date], [cur.spell_n, cur.last_date]) > 0) rep.set(c.key, c);
    }

    const agg = new Map();
    for (const t of norm) {
      const cur = agg.get(t.key) ?? { months: new Set(), n: 0, total: 0 };
      cur.months.add(t.date.slice(0, 7)); cur.n++; cur.total += t.amount;
      agg.set(t.key, cur);
    }

    return [...agg.entries()]
      .filter(([, a]) => a.months.size >= minMonths)
      .map(([key, a]) => {
        const r = rep.get(key);
        // SQLite の整数どうしの割り算は切り捨て。合わせておく。
        return {
          item: r.item, category: r.category, kind: r.kind,
          months: a.months.size, n: a.n, avg: Math.trunc(a.total / a.n), total: a.total,
        };
      })
      .sort((x, y) => cmp([y.months, y.avg], [x.months, x.avg]));
  }

  /** 目視で確認が要る行。移行しきれなかった振替と、金額を持たない覚書。 */
  function qNeedsReview() {
    return db.transactions
      .filter((t) => {
        const d = parseData(t.data);
        return (d.needs_review !== undefined || t.kind === 'メモ') && d.reviewed === undefined;
      })
      .sort((a, b) => cmp([a.date], [b.date]));
  }

  /* --- 書き込み ----------------------------------------------------------- */

  const KINDS = ['支出', '収入', '投資', '振替', 'メモ'];
  const ACCOUNT_REQUIRED_FROM = 50000;
  const RECONCILE_THRESHOLD = 50000;
  const RECONCILE_OFF = 'reconcile_off';
  const BURN_MONTHS = 12;
  const RECURRING_MIN_MONTHS = 6;
  const CASH_CLASS = '現金';

  /** POST と PATCH で同じ規則を使う。片方だけ緩いと、直したときに壊せてしまう。 */
  function parse(body) {
    const b = body ?? {};
    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    const kind = str(b.kind);
    if (!KINDS.includes(kind)) throw new Fail(400, '種別がおかしい');

    const date = str(b.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Fail(400, '日付がおかしい');

    const amount = Math.trunc(Number(b.amount ?? 0));
    if (!Number.isFinite(amount) || amount < 0) throw new Fail(400, '金額がおかしい');
    if (amount === 0 && kind !== 'メモ') throw new Fail(400, '金額が要る');

    const account_id = str(b.account_id) || null;
    const to_account_id = kind === '振替' ? str(b.to_account_id) || null : null;

    if (kind === '振替') {
      if (!account_id || !to_account_id) throw new Fail(400, '振替は移動元と移動先が要る');
      if (account_id === to_account_id) throw new Fail(400, '移動元と移動先が同じ');
    }
    if (amount >= ACCOUNT_REQUIRED_FROM && kind !== 'メモ' && kind !== '振替' && !account_id)
      throw new Fail(400, '¥' + ACCOUNT_REQUIRED_FROM.toLocaleString() + '以上は口座が要る');

    return {
      date, kind,
      category: str(b.category), item: str(b.item), amount,
      account_id, to_account_id,
      counterparty: str(b.counterparty), memo: str(b.memo),
    };
  }

  function wInsert(t) {
    const now = nowIso();
    const row = {
      id: uuid(), date: t.date, kind: t.kind, category: t.category, item: t.item,
      amount: t.amount, account_id: t.account_id, to_account_id: t.to_account_id,
      counterparty: t.counterparty, memo: t.memo, pair_id: t.pair_id ?? null,
      batch_id: null, data: '{}', created_at: now, updated_at: now,
    };
    db.transactions.push(row);
    return row.id;
  }

  /** 「予算として計上」。1操作で2レコード作り、片方だけ残らないよう pair_id で結ぶ。 */
  function wCreate(body) {
    const base = parse(body);
    const id = wInsert(base);
    if (body && body.budget_pair === true && base.kind === '支出') {
      const pairId = wInsert({
        ...base, kind: '収入', category: '予算',
        item: base.item ? base.item + '予算' : '予算', account_id: null,
      });
      const a = db.transactions.find((t) => t.id === id);
      const b = db.transactions.find((t) => t.id === pairId);
      a.pair_id = pairId; b.pair_id = id;
      return { ids: [id, pairId] };
    }
    return { ids: [id] };
  }

  function wUpdate(id, t) {
    const row = db.transactions.find((x) => x.id === id);
    if (!row) throw new Fail(404, 'その記録は無い');
    const now = nowIso();
    const d = parseData(row.data);
    // 開いて保存した＝目を通したということなので、要確認の印を外す。
    // 印を触るのは、いま要確認に入っている行だけ。ふつうの記録を直しただけで
    // data が増えるのは、後から読むときに邪魔になる。
    if (d.needs_review !== undefined || row.kind === 'メモ') {
      delete d.needs_review;
      d.reviewed = now;
      row.data = JSON.stringify(d);
    }
    Object.assign(row, {
      date: t.date, kind: t.kind, category: t.category, item: t.item, amount: t.amount,
      account_id: t.account_id, to_account_id: t.to_account_id,
      counterparty: t.counterparty, memo: t.memo, updated_at: now,
    });
  }

  /** 取り消し。ペアがあれば一緒に消す。片方だけ残るのが一番わかりにくい壊れ方なので。 */
  function wRemove(id) {
    const row = db.transactions.find((x) => x.id === id);
    if (!row) throw new Fail(404, 'その記録は無い');
    const ids = row.pair_id ? [id, row.pair_id] : [id];
    db.transactions = db.transactions.filter((t) => !ids.includes(t.id));
    return ids.length;
  }

  function parseAccount(body) {
    const b = body ?? {};
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const institution = str(b.institution);
    if (!institution) throw new Fail(400, '機関名が要る');
    return {
      institution,
      name: str(b.name),
      class: str(b.class) || '現金',
      in_reconciliation: b.in_reconciliation ? 1 : 0,
      archived: b.archived ? 1 : 0,
    };
  }

  /* --- CSV --------------------------------------------------------------
     src/csv.ts と src/import.ts の写し。
     **デモでも書き出しと読み戻しを通す。** ここが通らないと
     「これがあればアプリを作り直しても中身は失わない」が口約束になる。 */

  const field = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const toCsv = (columns, rows) =>
    [columns.join(','), ...rows.map((r) => columns.map((c) => field(r[c])).join(','))].join('\r\n') + '\r\n';

  const TRANSACTION_COLUMNS = [
    'id', 'date', 'kind', 'category', 'item', 'amount',
    'account_id', 'account', 'to_account_id', 'to_account',
    'counterparty', 'memo', 'pair_id', 'batch_id', 'data', 'created_at', 'updated_at',
  ];
  const BALANCE_COLUMNS = [
    'id', 'date', 'account_id', 'account', 'class', 'amount', 'memo',
    'batch_id', 'data', 'created_at', 'updated_at',
  ];
  const ACCOUNT_COLUMNS = [
    'id', 'institution', 'name', 'account', 'class',
    'in_reconciliation', 'archived', 'sort', 'data', 'created_at', 'updated_at',
  ];

  const labelOf = (id) => { const a = acct(id); return a ? accountLabel(a) : ''; };

  function exportRows(name) {
    if (name === 'transactions.csv') {
      return [TRANSACTION_COLUMNS, db.transactions
        .map((t, rid) => ({ t, rid }))
        .sort((a, b) => cmp([a.t.date, a.rid], [b.t.date, b.rid]))
        .map(({ t }) => ({ ...t, account: labelOf(t.account_id), to_account: labelOf(t.to_account_id) }))];
    }
    if (name === 'balances.csv') {
      return [BALANCE_COLUMNS, db.balances
        .map((b) => ({ ...b, account: labelOf(b.account_id), class: acct(b.account_id).class, sort: acct(b.account_id).sort }))
        .sort((x, y) => cmp([x.date, x.sort], [y.date, y.sort]))];
    }
    if (name === 'accounts.csv') {
      return [ACCOUNT_COLUMNS, [...db.accounts]
        .sort((x, y) => x.sort - y.sort)
        .map((a) => ({ ...a, account: accountLabel(a) }))];
    }
    throw new Fail(404, 'その書き出しは無い');
  }

  /** RFC 4180。引用符の中の区切り・改行を正しく通す。 */
  function parseCsv(text) {
    const rows = [];
    let row = [], f = '', quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else quoted = false; }
        else f += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((v) => v !== ''));
  }

  /** 見出しから種類を当てる。3枚まとめて落としたものを順に放り込めば済むように。 */
  function detectKind(header) {
    if (header.includes('institution')) return 'accounts';
    if (header.includes('kind')) return 'transactions';
    if (header.includes('account_id') && header.includes('amount')) return 'balances';
    throw new Fail(400, '見出しから種類が分からない');
  }

  function importCsv(text) {
    const int = (v) => {
      const n = Math.trunc(Number(String(v ?? '').replace(/[,¥\s]/g, '')));
      return Number.isFinite(n) ? n : 0;
    };
    const iso = (v) => {
      const s = String(v ?? '').trim().replaceAll('/', '-');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Fail(400, '日付が読めない: ' + (s || '(空)'));
      return s;
    };

    const rows = parseCsv(text);
    if (rows.length < 2) throw new Fail(400, '中身が無い');
    const header = rows[0].map((h) => h.trim());
    const kind = detectKind(header);
    const at = (r, name) => { const i = header.indexOf(name); return i < 0 ? undefined : r[i]; };

    const batch_id = 'csv-' + nowIso().slice(0, 19).replace(/[:T-]/g, '') + '-' + uuid().slice(0, 4);
    const now = nowIso();
    const table = db[kind];
    // 既にある id は飛ばす。同じCSVを2回入れても何も起きないようにするため。
    const existing = new Set(table.map((r) => r.id));

    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      const given = String(at(r, 'id') ?? '').trim();
      if (given && existing.has(given)) { skipped++; continue; }
      const id = given || uuid();
      existing.add(id);
      const data = String(at(r, 'data') ?? '').trim() || '{}';

      if (kind === 'accounts') {
        db.accounts.push({
          id, institution: String(at(r, 'institution') ?? '').trim(), name: String(at(r, 'name') ?? '').trim(),
          class: String(at(r, 'class') ?? '現金').trim(),
          in_reconciliation: int(at(r, 'in_reconciliation')) ? 1 : 0,
          archived: int(at(r, 'archived')) ? 1 : 0, sort: int(at(r, 'sort')),
          batch_id, data, created_at: at(r, 'created_at') || now, updated_at: now,
        });
      } else if (kind === 'transactions') {
        db.transactions.push({
          id, date: iso(at(r, 'date')), kind: String(at(r, 'kind') ?? '').trim(),
          category: String(at(r, 'category') ?? '').trim(), item: String(at(r, 'item') ?? '').trim(),
          amount: Math.abs(int(at(r, 'amount'))),
          account_id: String(at(r, 'account_id') ?? '').trim() || null,
          to_account_id: String(at(r, 'to_account_id') ?? '').trim() || null,
          counterparty: String(at(r, 'counterparty') ?? '').trim(),
          memo: String(at(r, 'memo') ?? '').trim(),
          pair_id: String(at(r, 'pair_id') ?? '').trim() || null,
          batch_id, data, created_at: at(r, 'created_at') || now, updated_at: now,
        });
      } else {
        const date = iso(at(r, 'date'));
        const account_id = String(at(r, 'account_id') ?? '').trim();
        // 同じ日・同じ口座は 1 つだけ（本番の UNIQUE 制約に相当）。
        if (db.balances.some((b) => b.date === date && b.account_id === account_id)) { skipped++; continue; }
        db.balances.push({
          id, date, account_id, amount: int(at(r, 'amount')),
          memo: String(at(r, 'memo') ?? '').trim(),
          batch_id, data, created_at: at(r, 'created_at') || now, updated_at: now,
        });
      }
      added++;
    }
    return { kind, batch_id, added, skipped };
  }

  const UNDOABLE = 'csv-';

  function undoBatch(batch) {
    if (!batch.startsWith(UNDOABLE)) throw new Fail(400, 'この取り込みは取り消せない');
    let removed = 0;
    for (const table of ['balances', 'transactions', 'accounts']) {
      const before = db[table].length;
      db[table] = db[table].filter((r) => r.batch_id !== batch);
      removed += before - db[table].length;
    }
    return removed;
  }

  /** 取り込みの履歴。**取り消してよいものだけ**を一覧に出す。 */
  function batchList() {
    const out = [];
    for (const kind of ['accounts', 'transactions', 'balances']) {
      const m = new Map();
      for (const r of db[kind]) {
        if (!r.batch_id || !r.batch_id.startsWith(UNDOABLE)) continue;
        const cur = m.get(r.batch_id) ?? { batch_id: r.batch_id, kind, n: 0, at: r.created_at };
        cur.n++;
        if (r.created_at < cur.at) cur.at = r.created_at;
        m.set(r.batch_id, cur);
      }
      out.push(...m.values());
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : cmp([a.kind], [b.kind])));
  }

  /* --- ルータ -------------------------------------------------------------
     src/index.ts の api() と同じ順で並べる。並びが同じなら、片方を直したときに
     もう片方の同じ位置を見ればいい。 */

  const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : lo);

  function route(method, url, body) {
    const p = url.pathname;
    const qs = url.searchParams;

    if (method === 'POST' && p === '/api/transactions') return [201, wCreate(body)];

    if (method === 'POST' && p === '/api/accounts') {
      const a = parseAccount(body);
      const now = nowIso();
      const id = uuid();
      // 並びは末尾。既存の並び順を勝手に動かさない。
      const last = db.accounts.reduce((m, x) => Math.max(m, x.sort), -1);
      db.accounts.push({ id, ...a, sort: last + 1, batch_id: null, data: '{}', created_at: now, updated_at: now });
      return [201, { id }];
    }

    // 並び替えは個別の口座より先に置く（下は '/api/accounts/' を全部 id とみなす）。
    if (method === 'PATCH' && p === '/api/accounts/order') {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) throw new Fail(400, '並びが空');
      if (new Set(ids).size !== ids.length) throw new Fail(400, '同じ口座が二度ある');
      ids.forEach((id, i) => { const a = acct(id); if (a) { a.sort = i; a.updated_at = nowIso(); } });
      return [200, { sorted: ids.length }];
    }

    if (method === 'PATCH' && p.startsWith('/api/accounts/')) {
      const a = acct(decodeURIComponent(p.slice('/api/accounts/'.length)));
      if (!a) throw new Fail(404, 'その口座は無い');
      Object.assign(a, parseAccount(body), { updated_at: nowIso() });
      return [200, { updated: 1 }];
    }

    if (method === 'PATCH' && p === '/api/settings') {
      if (typeof body?.reconcile !== 'boolean') throw new Fail(400, '値がおかしい');
      if (body.reconcile) delete db.meta[RECONCILE_OFF];
      else db.meta[RECONCILE_OFF] = true;
      return [200, { reconcile: body.reconcile }];
    }

    // **ここだけは断る。** デモの Worker に GitHub の鍵を置いていないので、
    // 書き出す先が無い。黙って成功を返すと、バックアップがあると思わせてしまう。
    if (method === 'POST' && p === '/api/export/run')
      throw new Fail(503, 'デモでは GitHub へ書き出しません。上の3つのCSVは落とせます');

    if (method === 'POST' && p === '/api/import') return [201, importCsv(body)];

    if (method === 'DELETE' && p.startsWith('/api/import/'))
      return [200, { removed: undoBatch(decodeURIComponent(p.slice('/api/import/'.length))) }];

    if (method === 'POST' && p === '/api/balances') {
      const date = typeof body?.date === 'string' ? body.date.trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Fail(400, '日付がおかしい');
      if (!Array.isArray(body.entries)) throw new Fail(400, '中身が無い');
      const entries = body.entries.map((raw) => {
        const e = raw ?? {};
        const account_id = typeof e.account_id === 'string' ? e.account_id.trim() : '';
        if (!account_id) throw new Fail(400, '口座が指定されていない');
        // 空欄は「今回は数えなかった」。0 と区別する必要があるので null で通す。
        const blank = e.amount === null || e.amount === undefined || e.amount === '';
        const amount = blank ? null : Math.trunc(Number(e.amount));
        if (amount !== null && !Number.isFinite(amount)) throw new Fail(400, '金額がおかしい');
        return { account_id, amount, memo: typeof e.memo === 'string' ? e.memo.trim() : '' };
      });
      return [201, { saved: wSaveBalances(date, entries) }];
    }

    if (method === 'PATCH' && p.startsWith('/api/transactions/')) {
      wUpdate(decodeURIComponent(p.slice('/api/transactions/'.length)), parse(body));
      return [200, { updated: 1 }];
    }

    if (method === 'DELETE' && p.startsWith('/api/transactions/'))
      return [200, { removed: wRemove(decodeURIComponent(p.slice('/api/transactions/'.length))) }];

    if (method !== 'GET') throw new Fail(405, 'その操作はできない');

    if (p === '/api/candidates') {
      const raw = qs.get('amount');
      const amount = raw === null || raw === '' ? null : Number(raw);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Fail(400, '金額がおかしい');
      const kind = qs.get('kind') ?? '支出';
      if (!KINDS.includes(kind)) throw new Fail(400, '種別がおかしい');
      return [200, qCandidates(amount, kind, clamp(Number(qs.get('limit') ?? 6), 1, 20))];
    }

    if (p === '/api/categories') return [200, qCategories(qs.get('kind') ?? '支出', 12)];

    if (p === '/api/accounts') {
      const usage = qs.get('usage') === '1' ? qAccountUsage() : [];
      const byId = new Map(usage.map((u) => [u.id, u]));
      return [200, [...db.accounts]
        .sort((x, y) => cmp([x.archived, x.sort], [y.archived, y.sort]))
        .map((a) => ({ ...a, label: accountLabel(a), ...byId.get(a.id) }))];
    }

    if (p === '/api/transactions') {
      return [200, qTransactions({
        limit: clamp(Number(qs.get('limit') ?? 100), 1, 500),
        offset: Math.max(0, Number(qs.get('offset') ?? 0) || 0),
        kind: qs.get('kind') ?? undefined,
        q: (qs.get('q') ?? '').trim() || undefined,
      })];
    }

    if (p === '/api/balances') return [200, qBalances(clamp(Number(qs.get('dates') ?? 12), 1, 64))];

    if (p === '/api/balances/draft') {
      const date = qs.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Fail(400, '日付がおかしい');
      return [200, qBalanceDraft(date)];
    }

    if (p.startsWith('/api/export/')) return [200, null, p.slice('/api/export/'.length)];

    if (p === '/api/reconcile') {
      if (db.meta[RECONCILE_OFF]) return [200, { off: true, rows: [] }];
      const threshold = clamp(Number(qs.get('threshold') ?? RECONCILE_THRESHOLD), 1000, 10000000);
      return [200, { off: false, rows: qReconcile(threshold, clamp(Number(qs.get('limit') ?? 12), 1, 64)) }];
    }

    if (p === '/api/settings') return [200, { reconcile: !db.meta[RECONCILE_OFF] }];

    if (p === '/api/backup') {
      // 書き出し先は伏せる。デモから持ち主のリポジトリ名を教える理由がない。
      return [200, {
        last: null, error: null, batches: batchList(),
        target: { owner: 'あなたの GitHub', repo: 'daifuku-content', branch: 'main' },
      }];
    }

    if (p === '/api/insights') {
      const today = qs.get('today') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Fail(400, '日付がおかしい');
      const monthStart = today.slice(0, 8) + '01';
      const prevStart = shiftMonths(monthStart, -1);
      const prevEnd = shiftDays(monthStart, -1);
      const prevSameDay = shiftMonths(today, -1);
      const from = shiftMonths(monthStart, -BURN_MONTHS);
      return [200, {
        netWorth: qNetWorth(),
        spending: qSpending(from, monthStart, BURN_MONTHS),
        pace: qPace(monthStart, today, prevStart, prevSameDay, prevEnd),
        recurring: qRecurring(from, monthStart, RECURRING_MIN_MONTHS),
        cashClass: CASH_CLASS,
        minMonths: RECURRING_MIN_MONTHS,
        window: { from, to: monthStart, prevStart, prevSameDay },
      }];
    }

    if (p === '/api/summary')
      return [200, { span: qSummary(), yearly: qYearly(), review: qNeedsReview() }];

    throw new Fail(404, 'そのエンドポイントは無い');
  }

  /* --- fetch の差し替え ---------------------------------------------------
     app.js には手を入れない。get()/post() が素の fetch を呼ぶので、
     ここで差し替えれば /api/* が丸ごとこちらに来る。 */

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);

    const method = (init.method ?? (typeof input === 'object' ? input.method : 'GET') ?? 'GET').toUpperCase();
    let body = init.body ?? null;
    if (typeof body === 'string' && url.pathname !== '/api/import') {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    try {
      const [status, payload, csvName] = route(method, url, body);
      if (csvName) return csvDownloadResponse(csvName, url.searchParams.get('bom') === '1');
      save();
      return new Response(JSON.stringify(payload), {
        status, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      const status = err instanceof Fail ? err.status : 500;
      if (status === 500) console.error(err);
      return new Response(JSON.stringify({ error: err.message }), {
        status, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  };

  function csvBody(name, bom) {
    const [columns, rows] = exportRows(name);
    return (bom ? '﻿' : '') + toCsv(columns, rows);
  }

  function csvDownloadResponse(name, bom) {
    return new Response(csvBody(name, bom), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /**
   * CSV の書き出しは `<a href download>` なので fetch を通らない。
   * 拾わないと Worker まで飛んで 503 の JSON が落ちてくる。
   * クリックを捕まえて、この場で組み立てたものを渡す。
   */
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="/api/export/"]');
    if (!a) return;
    e.preventDefault();
    const url = new URL(a.href, location.origin);
    const name = url.pathname.slice('/api/export/'.length);
    const stamp = todayStr();
    let blob;
    try {
      blob = new Blob([csvBody(name, url.searchParams.get('bom') === '1')], { type: 'text/csv;charset=utf-8' });
    } catch (err) { alert(err.message); return; }
    const href = URL.createObjectURL(blob);
    const tmp = document.createElement('a');
    tmp.href = href;
    tmp.download = 'daifuku-' + name.replace('.csv', '') + '-' + stamp + '.csv';
    tmp.click();
    URL.revokeObjectURL(href);
  }, true);

  /* --- デモの帯 -----------------------------------------------------------
     **全部の画面に出す。** 入力画面だけに置くと、概要や資産のグラフを見て
     「この人の実際の家計だ」と読まれる。金額が並んでいる画面ほど誤解が重い。

     色は黄を地にして紺を載せる（7.82）。家の決めごとで黄は「目を向ける先」で、
     地としてしか使わない（DESIGN.md の色の節）。明暗どちらのテーマでも
     --mark / --on-mark は同じ値なので、ここは切り替えを持たなくてよい。

     **本番の style.css には足さない。** デモにしか無いものを共有の
     スタイルに置くと、本番を読む人が「これは何のクラスだ」と探すことになる。 */

  const BANNER_CSS = `
    /* 帯とヘッダーをまとめて貼り付ける。ヘッダー単体で sticky させたまま
       上に帯を置くと、スクロールしたときに帯だけ流れて消える。
       高さを数えずに済むよう、包んでから包みごと貼る。 */
    .demo-top { position: sticky; top: 0; z-index: 2; background: var(--bg); }
    .demo-top > header { position: static; z-index: auto; }

    /* flex にすると札が必ず1行を占めて、狭い画面で帯が3行になる。
       ふつうの文として流し、札だけ行内に置く。 */
    .demo-band {
      /* ホーム画面から開くと帯がノッチの下に潜るので、上だけ安全域を足す。
         ブラウザで見ているときは 0 なので見た目は変わらない。 */
      padding: calc(.4rem + env(safe-area-inset-top)) 1rem .45rem;
      background: var(--mark); color: var(--on-mark);
      font-size: .78rem; line-height: 1.5;
    }
    .demo-band b {
      display: inline-block; margin-right: .4rem;
      font-weight: 700; letter-spacing: .08em; font-size: .72rem;
      border: 1px solid currentColor; border-radius: 4px; padding: 0 .3rem;
    }
  `;

  function mountBanner() {
    const header = document.querySelector('header');
    if (!header || document.querySelector('.demo-top')) return;

    const style = document.createElement('style');
    style.textContent = BANNER_CSS;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'demo-top';
    header.parentNode.insertBefore(wrap, header);

    const band = document.createElement('div');
    band.className = 'demo-band';
    // 「保存されない」とは書かない。**残る**（localStorage なので次に開いても
    // ある）。消えると思って触った人が、後で他人の端末に残っていると誤解する。
    band.innerHTML = '<b>デモ</b>入れた数字はこの端末の中だけに残り、サーバには送られません。';

    wrap.append(band, header);
  }

  /* --- 起動 --------------------------------------------------------------- */

  db = load();
  if (!db) { db = seed(); save(); }

  // fetch の差し替えは即座に要るが、帯は header が生まれるまで差せない。
  //
  // **DOMContentLoaded まで待つと、帯の高さぶん画面が一度下に跳ねる。**
  // これは head のスクリプトなので、header が構文解析された瞬間を捕まえれば
  // 最初の描画に間に合う。取りこぼしたときのために読み込み完了でも一度呼ぶ
  // （mountBanner は二度差さない）。
  if (document.querySelector('header')) mountBanner();
  else {
    const watch = new MutationObserver(() => {
      if (!document.querySelector('header')) return;
      watch.disconnect();
      mountBanner();
    });
    watch.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { watch.disconnect(); mountBanner(); });
  }
})();
