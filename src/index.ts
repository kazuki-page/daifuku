// Worker 本体。
//
// 静的ファイルは Workers の Static Assets が配るが、wrangler.jsonc の
// run_worker_first によって必ずここを先に通る。合鍵の判定を index.html にも
// 効かせるため（leaves と同じ）。
//
// 段階2の時点では読み取りだけ。書き込みは段階4以降で足す。

import { Store, HttpError, accountLabel } from './store';
import type { NewTransaction } from './store';
import {
  toCsv, csvResponse, TRANSACTION_COLUMNS, BALANCE_COLUMNS, ACCOUNT_COLUMNS,
} from './csv';
import { exportToGitHub } from './export';
import type { ExportResult } from './export';
import { importCsv, undoBatch, batches } from './import';
import { CONFIG } from './config';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** `wrangler secret put AUTH_TOKEN` で入れる。未設定なら認証なし（ローカル開発用）。 */
  AUTH_TOKEN?: string;
  /** `wrangler secret put GITHUB_TOKEN` で入れる。daifuku-content への Contents 書き込み権限。 */
  GITHUB_TOKEN?: string;
  /**
   * デモ版でだけ "1"。wrangler.demo.jsonc の vars で入る。
   *
   * デモ用の Worker には D1 も合鍵も GitHub の鍵も紐付けていない。中身は
   * ブラウザの中（public/demo.js）で完結するので、ここは殻を配るだけ。
   * バインドを持たせないのは、設定の段階で本番の家計データへの道を塞ぐため。
   */
  DEMO?: string;
}

const COOKIE = 'daifuku_key';
const JSON_TYPE = 'application/json; charset=utf-8';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: (err as Error).message }, status);
    }
  },

  // 手動ボタンだけだと、押し忘れた期間がそのまま「失う可能性のある期間」になる。
  // 定期実行も置いて、放っておいても手元にコピーが残るようにする。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runExport(env).then(
        (r) => console.log(r.changed ? `書き出し: ${r.rows} 行` : '書き出し: 変更なし'),
        // ここで投げ直しても誰も見ないので握る。失敗は meta に残り、⚙️ に出る。
        (err) => console.error('書き出しに失敗:', (err as Error).message),
      ),
    );
  },
};

/**
 * 書き出しを実行し、結果を meta に記録する。
 *
 * トークンの期限切れなどで静かに止まるのが一番まずい壊れ方なので、
 * 成功した日時と、失敗したときの理由の両方を残す。
 */
async function runExport(env: Env): Promise<ExportResult> {
  const store = new Store(env.DB);
  try {
    // トークンが無いのも「書き出せていない理由」なので、記録の対象に含める。
    // try の外で投げると UI に出ず、まさに気づきたい状態が見えなくなる。
    if (!env.GITHUB_TOKEN) throw new HttpError(503, 'GITHUB_TOKEN が設定されていません');
    const result = await exportToGitHub(store, env.GITHUB_TOKEN, CONFIG.exportTo);
    await store.setMeta('last_export', {
      at: new Date().toISOString(),
      rows: result.rows,
      commit: result.changed ? result.commit : null,
    });
    await store.clearMeta('last_export_error');
    return result;
  } catch (err) {
    await store
      .setMeta('last_export_error', {
        at: new Date().toISOString(),
        message: (err as Error).message.slice(0, 300),
      })
      .catch(() => {});
    throw err;
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = (env.AUTH_TOKEN ?? '').trim();
  const isApi = url.pathname.startsWith('/api/');

  // デモは合鍵も /unlock も通らない。誰でも入れるのが目的なので、いちばん外で分ける。
  if (env.DEMO === '1') return demo(request, env, isApi);

  // 鍵の受け取り口だけは認証の前に置く。ここが認証の内側にあると入れなくなる。
  // URL ではなく本文で受けるので、鍵がアドレスバーにも履歴にも残らない。
  //
  // 総当たりの制限は付けていない。鍵は256bitあり、その前段に Cloudflare Access が
  // 立っているので、ここへ到達すること自体が認証済みを意味する。
  // Access を外すなら、ここに回数制限が要る。
  if (request.method === 'POST' && url.pathname === '/unlock') {
    const body = (await request.json().catch(() => ({}))) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!auth || (key && (await safeEqual(key, auth)))) {
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': keyCookie(url, auth) },
      });
    }
    return json({ error: '鍵が違います' }, 401);
  }

  if (!(await authorized(request, url, auth))) {
    if (isApi) throw new HttpError(401, '合鍵が必要です');
    return new Response(LOCKED_PAGE, {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // 鍵が URL で来たら Cookie に移し、アドレスバーと履歴から消す。
  if (auth && url.searchParams.get('key') && !isApi) {
    url.searchParams.delete('key');
    return new Response(null, {
      status: 302,
      headers: {
        location: url.pathname + (url.search || ''),
        'set-cookie': keyCookie(url, auth),
      },
    });
  }

  if (isApi) return api(request, env, url);
  return env.ASSETS.fetch(request);
}

/* --- API ---------------------------------------------------------------- */

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const store = new Store(env.DB);
  const p = url.pathname;

  if (request.method === 'POST' && p === '/api/transactions')
    return json(await create(await request.json(), store), 201);

  // 口座を足す。新しく銀行口座を開いたとき。
  if (request.method === 'POST' && p === '/api/accounts')
    return json({ id: await store.insertAccount(parseAccount(await request.json())) }, 201);

  // 並び替え。**個別の口座より先に置く。** 下の分岐は '/api/accounts/' で始まるものを
  // すべて id とみなすので、後ろに置くと 'order' という id を書き換えにいく。
  if (request.method === 'PATCH' && p === '/api/accounts/order') {
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) throw new HttpError(400, '並びが空');
    if (new Set(ids).size !== ids.length) throw new HttpError(400, '同じ口座が二度ある');
    return json({ sorted: await store.reorderAccounts(ids) });
  }

  // 口座の設定。名前を変えても過去の記録は id で結ばれたまま残る。
  if (request.method === 'PATCH' && p.startsWith('/api/accounts/')) {
    const id = decodeURIComponent(p.slice('/api/accounts/'.length));
    await store.updateAccount(id, parseAccount(await request.json()));
    return json({ updated: 1 });
  }

  // 設定。いまは乖離検知の入切だけ。端末ではなくサーバに置く（見る画面が変わっても同じ状態でいたい）。
  if (request.method === 'PATCH' && p === '/api/settings') {
    const body = (await request.json().catch(() => ({}))) as { reconcile?: unknown };
    if (typeof body.reconcile !== 'boolean') throw new HttpError(400, '値がおかしい');
    if (body.reconcile) await store.clearMeta(RECONCILE_OFF);
    else await store.setMeta(RECONCILE_OFF, true);
    return json({ reconcile: body.reconcile });
  }

  // 書き出しを手で走らせる。Cron を待たずに確かめられるように。
  if (request.method === 'POST' && p === '/api/export/run')
    return json(await runExport(env));

  // CSV の取り込み。本文がそのまま CSV。
  if (request.method === 'POST' && p === '/api/import')
    return json(await importCsv(env.DB, await request.text()), 201);

  // 取り込みをまとめて取り消す。同じCSVを2回入れる事故のため。
  if (request.method === 'DELETE' && p.startsWith('/api/import/')) {
    const batch = decodeURIComponent(p.slice('/api/import/'.length));
    return json({ removed: await undoBatch(env.DB, batch) });
  }

  // 資産残高の一括保存。月1回、全口座をまとめて記録する。
  if (request.method === 'POST' && p === '/api/balances')
    return json(await saveBalances(await request.json(), store), 201);

  // 書き換え。移行した資金移動の移動元・移動先を後から埋めるのが主な用途。
  if (request.method === 'PATCH' && p.startsWith('/api/transactions/')) {
    const id = decodeURIComponent(p.slice('/api/transactions/'.length));
    await store.update(id, parse(await request.json()));
    return json({ updated: 1 });
  }

  // 取り消し。入力を雑にできることが「入れるのが楽」の一部なので、
  // 消す側は素直に消えるようにしておく。
  if (request.method === 'DELETE' && p.startsWith('/api/transactions/')) {
    const removed = await store.remove(decodeURIComponent(p.slice('/api/transactions/'.length)));
    return json({ removed });
  }

  if (request.method !== 'GET') throw new HttpError(405, 'その操作はできない');

  if (p === '/api/candidates') {
    const raw = url.searchParams.get('amount');
    const amount = raw === null || raw === '' ? null : Number(raw);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      throw new HttpError(400, '金額がおかしい');
    const kind = url.searchParams.get('kind') ?? '支出';
    if (!KINDS.includes(kind)) throw new HttpError(400, '種別がおかしい');
    return json(await store.candidates(amount, kind, clamp(Number(url.searchParams.get('limit') ?? 6), 1, 20)));
  }

  if (p === '/api/categories')
    return json(await store.categories(url.searchParams.get('kind') ?? '支出', 12));

  if (p === '/api/accounts') {
    const [accounts, usage] = await Promise.all([
      store.accounts(),
      // 設定画面でだけ要る数字なので、頼まれたときだけ数える。
      url.searchParams.get('usage') === '1' ? store.accountUsage() : Promise.resolve([]),
    ]);
    const byId = new Map((usage as { id: string }[]).map((u) => [u.id, u]));
    return json(accounts.map((a) => ({ ...a, label: accountLabel(a), ...byId.get(a.id) })));
  }

  if (p === '/api/transactions') {
    // 上限を決めておかないと、URL 一本で全件を引けてしまう。
    const limit = clamp(Number(url.searchParams.get('limit') ?? 100), 1, 500);
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    return json(
      await store.transactions({
        limit,
        offset,
        kind: url.searchParams.get('kind') ?? undefined,
        q: (url.searchParams.get('q') ?? '').trim() || undefined,
      }),
    );
  }

  if (p === '/api/balances') {
    return json(await store.balances(clamp(Number(url.searchParams.get('dates') ?? 12), 1, 64)));
  }

  // その日付の下書き（既にあればその値、無ければ前回値）。
  if (p === '/api/balances/draft') {
    const date = url.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日付がおかしい');
    return json(await store.balanceDraft(date));
  }

  // 書き出し。画面のボタンからも、URL を直に叩いても同じものが落ちる。
  // AI に投げるときは URL の方が扱いやすいので、画面だけの機能にしない。
  if (p.startsWith('/api/export/')) {
    const bom = url.searchParams.get('bom') === '1';
    const name = p.slice('/api/export/'.length);
    const stamp = new Date().toISOString().slice(0, 10);

    if (name === 'transactions.csv')
      return csvResponse(`daifuku-transactions-${stamp}.csv`,
        toCsv(TRANSACTION_COLUMNS, await store.exportTransactions()), bom);
    if (name === 'balances.csv')
      return csvResponse(`daifuku-balances-${stamp}.csv`,
        toCsv(BALANCE_COLUMNS, await store.exportBalances()), bom);
    if (name === 'accounts.csv')
      return csvResponse(`daifuku-accounts-${stamp}.csv`,
        toCsv(ACCOUNT_COLUMNS, await store.exportAccounts()), bom);

    throw new HttpError(404, 'その書き出しは無い');
  }

  // 乖離検知。閾値は30日あたりの額として渡す（区間の長さがばらつくため）。
  if (p === '/api/reconcile') {
    // 切ってあるなら数えない。全件を走査するので、出さないものを計算する意味がない。
    if (await store.getMeta<boolean>(RECONCILE_OFF)) return json({ off: true, rows: [] });
    const threshold = clamp(Number(url.searchParams.get('threshold') ?? RECONCILE_THRESHOLD), 1000, 10_000_000);
    const rows = await store.reconcile(threshold, clamp(Number(url.searchParams.get('limit') ?? 12), 1, 64));
    return json({ off: false, rows });
  }

  if (p === '/api/settings')
    return json({ reconcile: !(await store.getMeta<boolean>(RECONCILE_OFF)) });

  // 書き出しの状態と、取り消せる取り込みの一覧。⚙️ に出す。
  if (p === '/api/backup') {
    const [last, error, list] = await Promise.all([
      store.getMeta('last_export'), store.getMeta('last_export_error'), batches(env.DB),
    ]);
    return json({ last, error, batches: list, target: CONFIG.exportTo });
  }

  // 概要の集計。総資産推移・あと何か月・今月のペース・毎月出ている支出。
  //
  // 「今日」は端末から受け取る。Workers は UTC で動くので、ここで new Date() を
  // 使うと日本時間の午前中は前日として集計され、月初に1日ぶん先月が混ざる。
  if (p === '/api/insights') {
    const today = url.searchParams.get('today') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new HttpError(400, '日付がおかしい');

    const monthStart = today.slice(0, 8) + '01';
    const prevStart = shiftMonths(monthStart, -1);
    const prevEnd = shiftDays(monthStart, -1);
    const prevSameDay = shiftMonths(today, -1);
    const from = shiftMonths(monthStart, -BURN_MONTHS);

    const [netWorth, spending, pace, recurring] = await Promise.all([
      store.netWorth(),
      store.spending(from, monthStart, BURN_MONTHS),
      store.pace(monthStart, today, prevStart, prevSameDay, prevEnd),
      store.recurring(from, monthStart, RECURRING_MIN_MONTHS),
    ]);
    return json({
      netWorth, spending, pace, recurring,
      cashClass: CASH_CLASS,
      minMonths: RECURRING_MIN_MONTHS,
      window: { from, to: monthStart, prevStart, prevSameDay },
    });
  }

  if (p === '/api/summary') {
    const [span, yearly, review] = await Promise.all([
      store.summary(), store.yearly(), store.needsReview(),
    ]);
    return json({ span, yearly, review });
  }

  throw new HttpError(404, 'そのエンドポイントは無い');
}

/* --- デモ版 --------------------------------------------------------------- */

/**
 * デモは**扉を開けたまま、奥に何も置かない**という作りにする。
 *
 * 合鍵も Access も無いので誰でも入れるが、`/api/*` は何も返さない。
 * 記録の読み書きは public/demo.js がブラウザの中で引き受ける。
 *
 * 共有の D1 に書かせる案は採らなかった。kazuki.page の配下に誰でも書ける
 * 家計簿ができてしまい、定期的に消しても消すまでの間は他人の入れた金額が
 * 他の来訪者に見える。デモのために引き受ける筋の話ではない。
 * localStorage なら来訪者ごとに完全に隔離される。
 *
 * leaves には `/api/config` だけ本物を返す穴があるが、こちらには要らない。
 * daifuku の src/config.ts が持っているのは CSV の書き出し先だけで、
 * それはデモに出す情報ではない（自分のリポジトリ名になる）。
 */
async function demo(request: Request, env: Env, isApi: boolean): Promise<Response> {
  if (isApi) {
    // ここに来るのは demo.js が読み込まれていないときだけ（差し込みに失敗した、
    // 圏外で古い殻が出た、など）。黙って空を返すと「保存できたように見えて
    // 消える」ので、はっきり断る。金額を扱う画面でそれをやると質が悪い。
    //
    // **止める場所を2つ置いている。** デモ用の Worker には D1 も GitHub の鍵も
    // 紐付けていないので、仮にここを通っても書き込む先が無い。
    // 2つあるのは、将来どちらか片方をいじったときに黙って開かないため。
    throw new HttpError(503, 'デモはブラウザの中だけで動きます');
  }
  return demoShell(await env.ASSETS.fetch(request));
}

/** デモの殻。OGP と、中身を引き受ける demo.js を head に差し込む。 */
function demoShell(res: Response): Response {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;

  // **本番（daifuku.kazuki.page）には差し込まない。** あちらは Access の内側に
  // あってクローラが届かないうえ、og:url が2つに割れる。og.png も同じ理由で
  // ここから指す（public/ に置いてあるので両方から配られてはいる）。
  const site = 'https://daifuku-demo.kazuki.page';
  const meta = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="daifuku">',
    '<meta property="og:title" content="daifuku — 帳尻は合わせない。だから続く。">',
    '<meta property="og:description" content="入出金と資産残高を切り離して記録する家計簿のデモ。入れた数字はこの端末の中だけに残ります。">',
    `<meta property="og:url" content="${site}/">`,
    `<meta property="og:image" content="${site}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    // **app.js より先に走る必要がある。** app.js は body の末尾にある素の script
    // なので、head に足せば fetch の差し替えが必ず間に合う。
    '<script src="/demo.js"></script>',
  ].join('');

  return new HTMLRewriter()
    .on('head', { element(el) { el.append(meta, { html: true }); } })
    .transform(res);
}

/* --- 認証 --------------------------------------------------------------- */

async function authorized(request: Request, url: URL, auth: string): Promise<boolean> {
  if (!auth) return true;
  const key = url.searchParams.get('key') ?? cookie(request, COOKIE);
  return Boolean(key) && (await safeEqual(key as string, auth));
}

/**
 * 合鍵を入れる Cookie。**Strict ではなく Lax。**
 *
 * Strict だと、Access のセッションが切れて `<team>.cloudflareaccess.com` に
 * 飛ばされ、戻ってきた最初の1回でこの Cookie が送られない（サイトをまたぐ
 * 遷移だから）。Worker からは合鍵が無いように見えるので 401 の合鍵ページが出る。
 * Cookie 自体は1年もつのに、**Access に入り直すたびに合鍵まで必ず聞かれていた。**
 * iPhone は Access のセッションが短命なので（ホーム画面のアプリは Safari と
 * Cookie の入れ物が別、かつ ITP が cloudflareaccess.com の Cookie を7日で消す）、
 * この二重取りがそこで集中して出る。
 *
 * Lax にしても守りは落ちない。書き換えは全部 POST/PATCH/DELETE で、Lax は
 * サイトをまたいだそれらに Cookie を付けない。GET は読むだけで、CORS を
 * 一切返していないので他所のスクリプトからは中身が読めない。
 * Strict が余分に止めていたのは「他所からの GET 遷移」だけで、それは
 * 止めたい相手ではなく自分だった。
 */
function keyCookie(url: URL, auth: string): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${auth}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax;${secure}`;
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// Workers に timingSafeEqual は無い。使い捨ての鍵で両者を HMAC にかけ、
// 長さの揃ったダイジェスト同士を比べる（応答時間から鍵を絞り込ませないため）。
async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const dx = new Uint8Array(x);
  const dy = new Uint8Array(y);
  let diff = dx.length ^ dy.length;
  for (let i = 0; i < dx.length; i += 1) diff |= (dx[i] ?? 0) ^ (dy[i] ?? 0);
  return diff === 0;
}

/* --- 小物 --------------------------------------------------------------- */

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : lo;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE } });
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>daifuku</title>
<style>
 /* 本体と同じ3色。紺 #003156・薄水 #e8f1ff・黄 #FFB94D。 */
 :root { --bg:#e8f1ff; --panel:#fff; --ink:#003156; --muted:#4a6b85;
         --line:#cfe0f2; --accent:#003156; --on-accent:#fff; --minus:#b4463c; }
 @media (prefers-color-scheme: dark) {
   :root { --bg:#15181b; --panel:#1e2226; --ink:#e8f1ff; --muted:#93a4b5;
           --line:#2c3238; --accent:#7fb6e8; --on-accent:#003156; --minus:#e07a6e; }
 }
 * { box-sizing: border-box; }
 body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif;
        display: grid; place-items: center; min-height: 100dvh; margin: 0;
        background: var(--bg); color: var(--ink); padding: 1.5rem; }
 form { width: 100%; max-width: 20rem; text-align: center; }
 h1 { font-size: 1.4rem; margin: 0 0 .3rem; letter-spacing: .04em; }
 form > svg { display: block; margin: 0 auto .5rem; }
 p  { color: var(--muted); font-size: .85rem; margin: 0 0 1.4rem; }
 input { width: 100%; font: inherit; padding: .7rem .8rem; text-align: center;
         border: 1px solid var(--line); border-radius: 10px;
         background: var(--panel); color: var(--ink); }
 input:focus { outline: none; border-color: var(--accent); }
 button { width: 100%; font: inherit; margin-top: .6rem; padding: .75rem;
          border: 0; border-radius: 10px; background: var(--accent);
          color: var(--on-accent); cursor: pointer; }
 button:disabled { opacity: .5; cursor: default; }
 .err { color: var(--minus); font-size: .82rem; margin: .7rem 0 0; min-height: 1.2em; }
</style>
<form id="f">
  <!-- アイコンを大福の断面に描き直したとき、ここだけ団子（🍡）が残っていた。
       /icon.svg は参照できない（run_worker_first でこの画面が返るため）ので、
       同じ形を直に書く。
       **見出しの隣に置くのは無理だった。** 文字の高さ（34px 前後）に縮めると
       餅の壁が 2px を切り、輪郭が潰れて豆にしか見えない。
       DESIGN.md「アイコン」の「小さくすると輪郭の作りは死ぬ」がここでも出る。
       64px で上に積む。 -->
  <svg viewBox="0 0 512 512" width="64" height="64" aria-hidden="true">
    <path d="M80 296 C80 216 159 152 256 152 C353 152 432 216 432 296
             A64 64 0 0 1 368 360 L144 360 A64 64 0 0 1 80 296 Z"
          fill="none" stroke="currentColor" stroke-width="36" stroke-linejoin="round"/>
    <ellipse cx="256" cy="264" rx="98" ry="48" fill="currentColor"/>
  </svg>
  <h1>daifuku</h1>
  <p>合鍵を入れてください。</p>
  <input id="k" type="password" autocomplete="current-password"
         placeholder="合鍵" autofocus enterkeyhint="go">
  <button id="b" type="submit">開く</button>
  <p class="err" id="e"></p>
</form>
<script>
 var f = document.getElementById('f'), k = document.getElementById('k'),
     b = document.getElementById('b'), e = document.getElementById('e');
 f.addEventListener('submit', function (ev) {
   ev.preventDefault();
   e.textContent = ''; b.disabled = true;
   fetch('/unlock', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ key: k.value })
   }).then(function (r) {
     // 合っていれば Cookie が入っているので、そのまま読み直せば中に入れる。
     if (r.ok) { location.replace(location.pathname + location.search); return; }
     b.disabled = false;
     e.textContent = '鍵が違います';
     k.select();
   }).catch(function () {
     b.disabled = false;
     e.textContent = 'つながりませんでした';
   });
 });
</script>`;

/* --- 記録する ------------------------------------------------------------ */

const KINDS = ['支出', '収入', '投資', '振替', 'メモ'];

/**
 * 高額のレコードだけ口座を必須にする（DESIGN.md「口座は任意。ただし高額は必須」）。
 *
 * 実データで乖離の原因はほぼ全部「金額の大きいレコードの行き先が分からない」ことだった。
 * 一方で全件必須にすると重くて続かない（2022年に「方法」列の記入が止まったのがその証拠）。
 * 該当するのは5.7年で数十件しかないので、これで負担をほとんど増やさずに検知精度が上がる。
 */
const ACCOUNT_REQUIRED_FROM = 50000;

/**
 * 乖離の警告を出す線（30日あたり）。
 *
 * 実データ63区間で閾値ごとの発火率を測って選んでいる。
 * ここまで下げると半分の区間で鳴って無視するようになり、倍に上げても
 * 発火率はほとんど変わらない。下げても上げても損をする折れ目がここにある。
 * 月1回の記録なら年2回くらい。
 */
const RECONCILE_THRESHOLD = 50000;

/**
 * 乖離検知を止めてあるか（meta のキー）。
 *
 * この道具は**帳簿に載っていないお金の出入りがあると必ず食い違う**。
 * 家計が自分の記録だけで閉じるまでは、鳴っても直しようがない。
 * 消さずに切れるようにしてあるのは、閉じたときにそのまま意味を持つため。
 * 切っている間も過去の区間は残るので、戻せば全部そのまま出る。
 */
const RECONCILE_OFF = 'reconcile_off';

/* --- 概要の集計 ---------------------------------------------------------- */

/** 「あと何か月」の分母を取る期間。生活の形が変わっている時期なら 6 に落とす。 */
const BURN_MONTHS = 12;

/** 固定費とみなす下限。12か月のうち半分に出ていれば毎月のものとして扱う。 */
const RECURRING_MIN_MONTHS = 6;

/**
 * 「あと何か月」の分子に数える資産クラス。
 *
 * 投資は売る手間があり、そのときの値段も分からない。共有管理は自分では
 * 動かせない。**いますぐ生活費にできる分だけ**を数える。
 */
const CASH_CLASS = '現金';

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-');
  return [Number(y), Number(m), Number(d)];
}

/** 月をずらす。日は移動先の月末を超えないように丸める（3/31 → 2/28）。 */
function shiftMonths(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

function shiftDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** POST と PATCH で同じ規則を使う。片方だけ緩いと、直したときに壊せてしまう。 */
function parse(body: unknown): NewTransaction {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const kind = str(b.kind);
  if (!KINDS.includes(kind)) throw new HttpError(400, '種別がおかしい');

  const date = str(b.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日付がおかしい');

  const amount = Math.trunc(Number(b.amount ?? 0));
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, '金額がおかしい');
  if (amount === 0 && kind !== 'メモ') throw new HttpError(400, '金額が要る');

  const account_id = str(b.account_id) || null;
  const to_account_id = kind === '振替' ? str(b.to_account_id) || null : null;

  if (kind === '振替') {
    if (!account_id || !to_account_id) throw new HttpError(400, '振替は移動元と移動先が要る');
    if (account_id === to_account_id) throw new HttpError(400, '移動元と移動先が同じ');
  }
  if (amount >= ACCOUNT_REQUIRED_FROM && kind !== 'メモ' && kind !== '振替' && !account_id)
    throw new HttpError(400, `¥${ACCOUNT_REQUIRED_FROM.toLocaleString()}以上は口座が要る`);

  return {
    date, kind,
    category: str(b.category),
    item: str(b.item),
    amount,
    account_id, to_account_id,
    counterparty: str(b.counterparty),
    memo: str(b.memo),
  };
}

async function create(body: unknown, store: Store): Promise<{ ids: string[] }> {
  const base = parse(body);
  const id = await store.insert(base);

  // 「予算として計上」。立て替えて後で同額を受け取る運用が収入の57%を占めるので、
  // 1操作で2レコード作る。片方だけ残らないよう pair_id で結ぶ。
  if ((body as Record<string, unknown>).budget_pair === true && base.kind === '支出') {
    const pairId = await store.insert({
      ...base,
      kind: '収入',
      category: '予算',
      item: base.item ? `${base.item}予算` : '予算',
      account_id: null,
    });
    await store.link(id, pairId);
    return { ids: [id, pairId] };
  }

  return { ids: [id] };
}

/* --- 資産残高を記録する -------------------------------------------------- */

async function saveBalances(body: unknown, store: Store): Promise<{ saved: number }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const date = typeof b.date === 'string' ? b.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日付がおかしい');
  if (!Array.isArray(b.entries)) throw new HttpError(400, '中身が無い');

  const entries = b.entries.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const account_id = typeof e.account_id === 'string' ? e.account_id.trim() : '';
    if (!account_id) throw new HttpError(400, '口座が指定されていない');

    // 空欄は「今回は数えなかった」。0 と区別する必要があるので null で通す。
    // 負債はマイナスで持つので、下限は設けない。
    const blank = e.amount === null || e.amount === undefined || e.amount === '';
    const amount = blank ? null : Math.trunc(Number(e.amount));
    if (amount !== null && !Number.isFinite(amount)) throw new HttpError(400, '金額がおかしい');

    return { account_id, amount, memo: typeof e.memo === 'string' ? e.memo.trim() : '' };
  });

  return { saved: await store.saveBalances(date, entries) };
}

/* --- 口座の設定 ---------------------------------------------------------- */

function parseAccount(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const institution = str(b.institution);
  if (!institution) throw new HttpError(400, '機関名が要る');

  return {
    institution,
    // サブ口座名は任意。機関だけで、サブ口座を持たない口座がある。
    name: str(b.name),
    class: str(b.class) || '現金',
    in_reconciliation: b.in_reconciliation ? 1 : 0,
    archived: b.archived ? 1 : 0,
  };
}
