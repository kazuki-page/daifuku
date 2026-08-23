// D1 への問い合わせをまとめる。SQL はここから外に出さない。

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface NewTransaction {
  date: string;
  kind: string;
  category: string;
  item: string;
  amount: number;
  account_id: string | null;
  to_account_id: string | null;
  counterparty: string;
  memo: string;
  pair_id?: string | null;
}

export interface Account {
  id: string;
  institution: string;
  name: string;
  class: string;
  in_reconciliation: number;
  archived: number;
  sort: number;
}

/** 「総合:A銀行」のように、元データと同じ見え方に戻す。 */
export function accountLabel(a: Pick<Account, 'institution' | 'name'>): string {
  return a.name ? `${a.name}:${a.institution}` : a.institution;
}

export class Store {
  constructor(private db: D1Database) {}

  async accounts(): Promise<Account[]> {
    const { results } = await this.db
      .prepare(`SELECT id, institution, name, class, in_reconciliation, archived, sort
                FROM accounts ORDER BY archived, sort`)
      .all<Account>();
    return results;
  }

  /** 口座を足す。並びは末尾（既存の並び順を勝手に動かさない）。 */
  async insertAccount(a: {
    institution: string; name: string; class: string;
    in_reconciliation: number; archived: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const last = await this.db.prepare(`SELECT MAX(sort) AS n FROM accounts`).first<{ n: number | null }>();
    await this.db
      .prepare(`INSERT INTO accounts
                (id,institution,name,class,in_reconciliation,archived,sort,data,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,'{}',?,?)`)
      .bind(id, a.institution, a.name, a.class, a.in_reconciliation, a.archived,
            (last?.n ?? -1) + 1, now, now)
      .run();
    return id;
  }

  /**
   * 並び替え。渡された順に `sort` を振り直す。
   *
   * 一覧も、残高の一括入力も、資産タブも全部 `sort` 順で出している。
   * ここが唯一の並びの決定点なので、口座を足した順のまま放っておくと
   * 現金の間に証券が挟まるような並びになり、月1回の一括入力で毎回目が滑る。
   */
  async reorderAccounts(ids: string[]): Promise<number> {
    const now = new Date().toISOString();
    await this.db.batch(
      ids.map((id, i) =>
        this.db.prepare('UPDATE accounts SET sort = ?, updated_at = ? WHERE id = ?')
          .bind(i, now, id)),
    );
    return ids.length;
  }

  /**
   * 口座の設定を書き換える。
   *
   * **名前を変えても過去の記録はそのまま**。銀行の合併・改称や、用途の付け替え
   * （「普段使い」→「生活防衛」）は普通に起きるが、口座としては同じものなので、
   * 履歴を書き換えたくない。id を日時や名前と無関係な固定値にしてあるのはこのため。
   */
  async updateAccount(id: string, a: {
    institution: string; name: string; class: string;
    in_reconciliation: number; archived: number;
  }): Promise<void> {
    const r = await this.db
      .prepare(`UPDATE accounts SET
                  institution = ?, name = ?, class = ?,
                  in_reconciliation = ?, archived = ?, updated_at = ?
                WHERE id = ?`)
      .bind(a.institution, a.name, a.class, a.in_reconciliation, a.archived,
            new Date().toISOString(), id)
      .run();
    if (!r.meta.changes) throw new HttpError(404, 'その口座は無い');
  }

  /** 口座ごとの記録数。消していいかの判断材料として設定画面に出す。 */
  async accountUsage() {
    const { results } = await this.db
      .prepare(`SELECT a.id,
                       (SELECT COUNT(*) FROM balances WHERE account_id = a.id) AS balances,
                       (SELECT COUNT(*) FROM transactions
                         WHERE account_id = a.id OR to_account_id = a.id) AS transactions,
                       (SELECT MAX(date) FROM balances WHERE account_id = a.id) AS last_balance
                FROM accounts a`)
      .all();
    return results;
  }

  /**
   * 入出金の一覧。移行の確認が目的なので、絞り込みは最小限。
   * limit は呼び出し側で 1..500 に丸めてから渡す。
   */
  async transactions(opts: { limit: number; offset: number; kind?: string; q?: string }) {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (opts.kind) { where.push('kind = ?'); binds.push(opts.kind); }
    if (opts.q) {
      where.push('(item LIKE ? OR category LIKE ? OR memo LIKE ? OR counterparty LIKE ?)');
      const like = `%${opts.q}%`;
      binds.push(like, like, like, like);
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      this.db
        .prepare(`SELECT t.*, a.institution AS acct_institution, a.name AS acct_name
                  FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
                  ${cond} ORDER BY t.date DESC, t.rowid DESC LIMIT ? OFFSET ?`)
        .bind(...binds, opts.limit, opts.offset)
        .all(),
      this.db.prepare(`SELECT COUNT(*) AS n FROM transactions ${cond}`).bind(...binds).first<{ n: number }>(),
    ]);
    return { rows: rows.results, total: count?.n ?? 0 };
  }

  /** 資産残高。スナップショット日ごとにまとめて返す。 */
  async balances(limitDates: number) {
    const { results } = await this.db
      .prepare(`SELECT b.date, b.amount, b.memo, a.id AS account_id, a.institution, a.name,
                       a.class, a.in_reconciliation
                FROM balances b JOIN accounts a ON a.id = b.account_id
                WHERE b.date IN (SELECT DISTINCT date FROM balances ORDER BY date DESC LIMIT ?)
                ORDER BY b.date DESC, a.sort`)
      .bind(limitDates)
      .all();
    return results;
  }

  /**
   * 中身の件数と期間。設定タブに出す。
   *
   * 種別ごとの合計と支出のカテゴリ内訳もここで出していたが、外した。
   * **期間を切らない集計は読んでも意味が無い**（5.7年分の合計を見ても何も分からない）。
   * 期間つきの集計は「当面やらないこと」に置いてある集計・グラフの側でやる。
   */
  async summary() {
    return this.db
      .prepare(`SELECT MIN(date) AS first, MAX(date) AS last,
                       (SELECT COUNT(*) FROM transactions) AS transactions,
                       (SELECT COUNT(*) FROM balances) AS balances,
                       (SELECT COUNT(DISTINCT date) FROM balances) AS snapshots
                FROM transactions`)
      .first();
  }

  /** 年ごとの収支。移行の突き合わせと、後で作る集計の土台を兼ねる。 */
  async yearly() {
    const { results } = await this.db
      .prepare(`SELECT substr(date, 1, 4) AS year, kind, COUNT(*) AS n, SUM(amount) AS total
                FROM transactions GROUP BY year, kind ORDER BY year DESC`)
      .all();
    return results;
  }

  /* --- 候補 -------------------------------------------------------------
     入力を楽にする本体。実データの反復率は39%しかないので（DESIGN.md）、
     凝った推測はせず、当たる場面がはっきりしている2本だけを出す。
       * 金額を打った   → 同じ金額の過去レコード（サブスク・定番の買い物）
       * まだ打っていない → よく使う品目（金額もそのとき使った額を入れておく）
     効かない方は使ってみてから捨てる。 */

  async candidates(amount: number | null, kind: string, limit: number) {
    // 品目名は表記ゆれる。実データには YouTube Music / youtubeMusic / Youtube Music /
    // youtubemusic が全部あり、素直に品目名で束ねると候補6枠のうち4枠が同じサービスで埋まる。
    // 大文字小文字と空白を落とした鍵でまとめ、一番よく使われている綴りを代表にする。
    //
    // 金額は「最後に使った額」ではなく「一番多い額」を採る。ここが当たってほしいのは
    // 定期支出（サブスク・通信費）で、そこは額が決まっているため。
    // 最後の1回がたまたま日割りや初回割引だと、毎回それが出てきて外れ続ける。
    const sql = `
      WITH norm AS (
        SELECT t.item, t.category, t.kind, t.account_id, t.amount, t.date, t.rowid AS rid,
               replace(replace(replace(lower(t.item), ' ', ''), '　', ''), '・', '') AS key
        FROM transactions t
        -- 種別で絞る。実データには 支出「散髪」と 収入「散髪」（予算の受け取り）が
        -- 両方あり、混ぜるとタップした瞬間に逆の記録ができてしまう。
        WHERE t.item <> '' AND t.kind = ?
              ${amount === null ? '' : 'AND t.amount = ?'}
      ),
      counted AS (
        SELECT key, item, category, kind, account_id, amount, date, rid,
               COUNT(*) OVER (PARTITION BY key)         AS cnt,
               COUNT(*) OVER (PARTITION BY key, item)   AS spell_cnt,
               COUNT(*) OVER (PARTITION BY key, amount) AS amt_cnt
        FROM norm
      ),
      -- 窓関数の結果は同じ階層の ORDER BY では使えないので、数えてから順位を付ける。
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY key
                 ORDER BY spell_cnt DESC, amt_cnt DESC, date DESC, rid DESC) AS rn
        FROM counted
      )
      SELECT item, category, kind, account_id, amount, cnt
      FROM ranked WHERE rn = 1
      ORDER BY ${amount === null ? 'cnt DESC, date DESC' : 'date DESC, cnt DESC'}
      LIMIT ?`;
    const stmt = amount === null
      ? this.db.prepare(sql).bind(kind, limit)
      : this.db.prepare(sql).bind(kind, amount, limit);
    const { results } = await stmt.all();
    return results;
  }

  /** カテゴリのチップ。よく使う順。一覧は設定ではなく中身から出す。 */
  async categories(kind: string, limit: number) {
    const { results } = await this.db
      .prepare(`SELECT category, COUNT(*) AS n FROM transactions
                WHERE kind = ? AND category <> '' GROUP BY category
                ORDER BY n DESC LIMIT ?`)
      .bind(kind, limit)
      .all();
    return results;
  }

  /* --- 書き込み --------------------------------------------------------- */

  async insert(t: NewTransaction): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO transactions
                (id,date,kind,category,item,amount,account_id,to_account_id,
                 counterparty,memo,pair_id,batch_id,data,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,'{}',?,?)`)
      .bind(id, t.date, t.kind, t.category, t.item, t.amount,
            t.account_id, t.to_account_id, t.counterparty, t.memo, t.pair_id ?? null,
            now, now)
      .run();
    return id;
  }

  /**
   * 書き換え。移行した資金移動の移動元・移動先を後から埋めるために要る。
   *
   * 予算ペアの相手は触らない。金額をずらしたいときは片方ずつ直すのが素直で、
   * 「片方を直したらもう片方も動いた」のほうが分かりにくいため。
   */
  async update(id: string, t: NewTransaction): Promise<void> {
    const now = new Date().toISOString();
    // 開いて保存した＝目を通したということなので、要確認の印を外す。
    // これをやらないと、直しても一覧から減らず、何が残っているのか分からなくなる。
    // 「直さなくてよかった」ものも、保存すれば同じように外れる。
    //
    // 印を付けるのは、いま要確認に入っている行だけ。CASE の中の kind と data は
    // 更新前の値なので、これで「元から要確認だったか」を見ている。
    // ふつうの記録を直しただけで data が増えるのは、後から読むときに邪魔になる。
    const r = await this.db
      .prepare(`UPDATE transactions SET
                  date = ?, kind = ?, category = ?, item = ?, amount = ?,
                  account_id = ?, to_account_id = ?, counterparty = ?, memo = ?,
                  data = CASE
                    WHEN json_extract(data, '$.needs_review') IS NOT NULL OR kind = 'メモ'
                      THEN json_set(json_remove(data, '$.needs_review'), '$.reviewed', ?)
                    ELSE data END,
                  updated_at = ?
                WHERE id = ?`)
      .bind(t.date, t.kind, t.category, t.item, t.amount,
            t.account_id, t.to_account_id, t.counterparty, t.memo,
            now, now, id)
      .run();
    if (!r.meta.changes) throw new HttpError(404, 'その記録は無い');
  }

  /** 予算ペアを結ぶ。片方を消すときにもう片方を巻き込めるようにするため。 */
  async link(a: string, b: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE transactions SET pair_id = ? WHERE id = ?`).bind(b, a),
      this.db.prepare(`UPDATE transactions SET pair_id = ? WHERE id = ?`).bind(a, b),
    ]);
  }

  /**
   * 取り消し。ペアがあれば一緒に消す。
   * 「予算として計上」で2件作ったのに片方だけ残る、が一番わかりにくい壊れ方なので。
   */
  async remove(id: string): Promise<number> {
    const row = await this.db.prepare(`SELECT pair_id FROM transactions WHERE id = ?`)
      .bind(id).first<{ pair_id: string | null }>();
    if (!row) throw new HttpError(404, 'その記録は無い');
    const ids = row.pair_id ? [id, row.pair_id] : [id];
    await this.db.batch(ids.map((x) =>
      this.db.prepare(`DELETE FROM transactions WHERE id = ?`).bind(x)));
    return ids.length;
  }

  async byId(id: string) {
    return this.db.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first();
  }

  /* --- 乖離検知 ---------------------------------------------------------
     入出金と残高を切り離した代償として、両者は必ずズレる。
     大きくズレたときだけ知らせる。修正は強制しない。

     対象は `in_reconciliation` の口座だけ。実データで検証したところ、
     含める口座を増やすほど悪化した（対象を広げると乖離の中央値が2〜3倍になる）。
     自分では動かせない口座と、時価が動く資産は、収支帳簿に載らない変動源だから。 */

  /**
   * 連続する2つのスナップショットの間で、実測の増減と帳簿の増減を突き合わせる。
   *
   * 区間の長さが19日〜60日とばらつくので、閾値は日数で正規化して比べる
   * （`乖離 / 日数` を `threshold / 30日` と比べる）。
   */
  async reconcile(threshold: number, limit: number) {
    // 日数で割るだけだと、短い区間がわずかにズレただけで鳴る
    // （10日足らずで2万円弱でも、1日あたりでは閾値を超えてしまう）。
    // 額そのものが小さいうちは気にしなくていいので、下限を置く。
    const FLOOR = 20000;
    const [balRows, txRows] = await Promise.all([
      this.db
        .prepare(`SELECT b.date, b.account_id, b.amount
                  FROM balances b JOIN accounts a ON a.id = b.account_id
                  WHERE a.in_reconciliation = 1
                  ORDER BY b.date`)
        .all<{ date: string; account_id: string; amount: number }>(),
      // 各レコードが「対象口座の現金をいくら動かしたか」に換算して日ごとに合計する。
      // 口座が未記入のものは対象内とみなす（COALESCE の 1）。そうしないと、
      // 口座を書いていない大多数のレコードが帳簿から消える。
      this.db
        .prepare(`SELECT t.date AS date, SUM(
                    CASE t.kind
                      WHEN '収入' THEN CASE WHEN COALESCE(a.in_reconciliation,1)=1 THEN  t.amount ELSE 0 END
                      WHEN '支出' THEN CASE WHEN COALESCE(a.in_reconciliation,1)=1 THEN -t.amount ELSE 0 END
                      WHEN '投資' THEN CASE WHEN COALESCE(a.in_reconciliation,1)=1 THEN -t.amount ELSE 0 END
                      WHEN '振替' THEN
                        CASE WHEN COALESCE(a.in_reconciliation,1)=1 AND COALESCE(b.in_reconciliation,1)=0 THEN -t.amount
                             WHEN COALESCE(a.in_reconciliation,1)=0 AND COALESCE(b.in_reconciliation,1)=1 THEN  t.amount
                             ELSE 0 END
                      ELSE 0 END) AS effect
                  FROM transactions t
                  LEFT JOIN accounts a ON a.id = t.account_id
                  LEFT JOIN accounts b ON b.id = t.to_account_id
                  GROUP BY t.date`)
        .all<{ date: string; effect: number }>(),
    ]);

    // 全口座が同じ日に揃うとは限らないので、直近の既知残高を持ち越して合計する。
    const held = new Map<string, number>();
    const totals: { date: string; total: number }[] = [];
    for (const r of balRows.results) {
      held.set(r.account_id, r.amount);
      const sum = [...held.values()].reduce((x, y) => x + y, 0);
      const last = totals[totals.length - 1];
      if (last && last.date === r.date) last.total = sum;
      else totals.push({ date: r.date, total: sum });
    }

    const effects = new Map(txRows.results.map((r) => [r.date, r.effect]));
    const dates = [...effects.keys()].sort();

    const rows = [];
    for (let i = 1; i < totals.length; i++) {
      const a = totals[i - 1]!, b = totals[i]!;
      let book = 0;
      for (const d of dates) if (d > a.date && d <= b.date) book += effects.get(d) ?? 0;
      const days = Math.max(1, Math.round((Date.parse(b.date) - Date.parse(a.date)) / 86400000));
      const gap = (b.total - a.total) - book;
      rows.push({
        from: a.date, to: b.date, days,
        actual: b.total - a.total, book, gap,
        // 区間の長さが19日〜60日とばらつくので、1日あたりに直して比べる。
        over: Math.abs(gap) >= FLOOR && Math.abs(gap) / days > threshold / 30,
      });
    }
    return rows.slice(-limit).reverse();
  }

  /* --- 資産の記録 -------------------------------------------------------
     直近8回すべてが「月1回・10口座まとめて」だった（DESIGN.md「資産は一括編集」）。
     1件ずつ入れる画面では苦痛なので、全口座を並べて一度に保存する。 */

  /**
   * その日付の下書き。
   *   current … その日に既に記録があればその値（＝やり直し）
   *   carry   … 無ければ直近の既知残高（＝前回値をプリセットする）
   * 全口座が同じ日に揃うとは限らないので、持ち越しは口座ごとに引く。
   */
  async balanceDraft(date: string) {
    const { results } = await this.db
      .prepare(`SELECT a.id, a.institution, a.name, a.class, a.sort,
                       (SELECT amount FROM balances
                         WHERE account_id = a.id AND date <= ?1
                         ORDER BY date DESC LIMIT 1) AS carry,
                       (SELECT date FROM balances
                         WHERE account_id = a.id AND date <= ?1
                         ORDER BY date DESC LIMIT 1) AS carry_date,
                       (SELECT amount FROM balances
                         WHERE account_id = a.id AND date = ?1) AS current,
                       (SELECT memo FROM balances
                         WHERE account_id = a.id AND date = ?1) AS memo
                FROM accounts a
                WHERE a.archived = 0
                ORDER BY a.sort`)
      .bind(date)
      .all();
    return results;
  }

  /**
   * 一括保存。同じ日に同じ口座を2回持たない（UNIQUE 制約）ので、あれば上書きする。
   * 金額が空の口座はその日の記録から外す（「今回は数えなかった」を表せるようにする）。
   */
  async saveBalances(date: string, entries: { account_id: string; amount: number | null; memo: string }[]) {
    const now = new Date().toISOString();
    const stmts = entries.map((e) =>
      e.amount === null
        ? this.db.prepare(`DELETE FROM balances WHERE date = ? AND account_id = ?`)
            .bind(date, e.account_id)
        : this.db.prepare(
            `INSERT INTO balances (id,date,account_id,amount,memo,batch_id,data,created_at,updated_at)
             VALUES (?,?,?,?,?,NULL,'{}',?,?)
             ON CONFLICT(date, account_id) DO UPDATE SET
               amount = excluded.amount, memo = excluded.memo, updated_at = excluded.updated_at`)
            .bind(crypto.randomUUID(), date, e.account_id, e.amount, e.memo, now, now),
    );
    if (stmts.length) await this.db.batch(stmts);
    return entries.filter((e) => e.amount !== null).length;
  }

  /* --- meta ---------------------------------------------------------------
     書き出しは、トークンの期限切れなどで「静かに止まる」のが一番まずい壊れ方。
     成功した日時と、失敗したときの理由の両方を残して UI から見えるようにする。 */

  async getMeta<T>(key: string): Promise<T | null> {
    const row = await this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .bind(key).first<{ value: string }>();
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db
      .prepare(`INSERT INTO meta (key, value, updated) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`)
      .bind(key, JSON.stringify(value), new Date().toISOString())
      .run();
  }

  async clearMeta(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM meta WHERE key = ?').bind(key).run();
  }

  /* --- 書き出し ---------------------------------------------------------
     保管とAI用。件数は全件（5.7年で1300件強なので、分割は要らない）。
     口座名は accounts と結んでここで文字列にする。CSV1枚で読めるようにするため。 */

  async exportTransactions() {
    const { results } = await this.db
      .prepare(`SELECT t.id, t.date, t.kind, t.category, t.item, t.amount,
                       t.account_id,
                       CASE WHEN a.id IS NULL THEN ''
                            WHEN a.name = '' THEN a.institution
                            ELSE a.name || ':' || a.institution END AS account,
                       t.to_account_id,
                       CASE WHEN b.id IS NULL THEN ''
                            WHEN b.name = '' THEN b.institution
                            ELSE b.name || ':' || b.institution END AS to_account,
                       t.counterparty, t.memo, t.pair_id, t.batch_id, t.data,
                       t.created_at, t.updated_at
                FROM transactions t
                LEFT JOIN accounts a ON a.id = t.account_id
                LEFT JOIN accounts b ON b.id = t.to_account_id
                ORDER BY t.date, t.rowid`)
      .all();
    return results;
  }

  async exportBalances() {
    const { results } = await this.db
      .prepare(`SELECT b.id, b.date, b.account_id,
                       CASE WHEN a.name = '' THEN a.institution
                            ELSE a.name || ':' || a.institution END AS account,
                       a.class, b.amount, b.memo, b.batch_id, b.data,
                       b.created_at, b.updated_at
                FROM balances b JOIN accounts a ON a.id = b.account_id
                ORDER BY b.date, a.sort`)
      .all();
    return results;
  }

  async exportAccounts() {
    const { results } = await this.db
      .prepare(`SELECT id, institution, name,
                       CASE WHEN name = '' THEN institution
                            ELSE name || ':' || institution END AS account,
                       class, in_reconciliation, archived, sort, data,
                       created_at, updated_at
                FROM accounts ORDER BY sort`)
      .all();
    return results;
  }

  /**
   * 目視で確認が要る行。移行時に移動元・移動先を埋められなかった振替と、
   * 金額を持たない覚書。**ここから直接編集する**ので全列返す。
   */
  async needsReview() {
    const { results } = await this.db
      .prepare(`SELECT * FROM transactions
                WHERE (json_extract(data, '$.needs_review') IS NOT NULL OR kind = 'メモ')
                  AND json_extract(data, '$.reviewed') IS NULL
                ORDER BY date`)
      .all();
    return results;
  }

  /* --- 概要の集計 ---------------------------------------------------------
     DESIGN.md で後回しにしていた集計。実データを測ってから形を決めた。
     判断の根拠は DESIGN.md「概要に何を出すか」にある。 */

  /**
   * 資産クラスごとの総資産推移。
   *
   * **その日に記録が無い口座は、直前に分かっている残高を持ち越す。**
   * 素直に日付で GROUP BY すると、口座を1つしか記録しなかった日
   * （2022-01-01・2023-02-13・2025-10-20 など実データに10日ある）が
   * そのまま崖として出る。資産が10分の1になった日など無い。
   *
   * 全期間で64点しかないので、期間の絞り込みは画面側でやる。
   * 期間を変えるたびにサーバへ行かずに済み、圏外でも切り替えられる。
   */
  async netWorth() {
    const { results } = await this.db
      .prepare(`
        WITH d AS (SELECT DISTINCT date FROM balances),
        grid AS (SELECT d.date AS asof, a.id AS aid, a.class AS class FROM d JOIN accounts a),
        picked AS (
          SELECT g.asof, g.class, b.amount,
                 ROW_NUMBER() OVER (PARTITION BY g.asof, g.aid ORDER BY b.date DESC) AS rn
          FROM grid g
          LEFT JOIN balances b ON b.account_id = g.aid AND b.date <= g.asof
        )
        SELECT asof AS date, class, SUM(COALESCE(amount, 0)) AS total
        FROM picked WHERE rn = 1
        GROUP BY asof, class
        ORDER BY asof`)
      .all();
    return results;
  }

  /**
   * 直近 months か月の支出合計。「あと何か月」の分母になる。
   *
   * 割る数は数えた月数ではなく months で固定する。記録の無い月があったときに
   * 数えた月数で割ると、支出が少なかった月ほど平均が上がるという逆の動きをする。
   */
  async spending(from: string, to: string, months: number) {
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS total
                FROM transactions WHERE kind = '支出' AND date >= ? AND date < ?`)
      .bind(from, to)
      .first<{ total: number }>();
    return { total: row?.total ?? 0, months, monthly: Math.round((row?.total ?? 0) / months) };
  }

  /**
   * 今月ここまでの支出と、先月の同じ日までの支出。
   *
   * 月末に締めた数字は、その月にはもう間に合わない。**月の途中で比べられる形**
   * にしておかないと、行動を変えられる唯一の指標にならない。
   */
  async pace(
    monthStart: string, today: string,
    prevStart: string, prevSameDay: string, prevEnd: string,
  ) {
    const sum = `SELECT COALESCE(SUM(amount), 0) AS n FROM transactions
                 WHERE kind = '支出' AND date >= ? AND date <= ?`;
    const r = await this.db.batch<{ n: number }>([
      this.db.prepare(sum).bind(monthStart, today),
      this.db.prepare(sum).bind(prevStart, prevSameDay),
      this.db.prepare(sum).bind(prevStart, prevEnd),
    ]);
    const at = (i: number) => r[i]?.results[0]?.n ?? 0;
    return { thisMonth: at(0), prevSameDay: at(1), prevFull: at(2) };
  }

  /**
   * 毎月出ている品目。固定費の一覧にあたる。
   *
   * 固定費は1回見直せば毎月効くので、変動費を我慢するより費用対効果が高い。
   * ただし「固定費」という列は無いので、**出た月数から当てる**。
   * 表記ゆれは候補と同じ鍵で潰す（YouTube Music / youtubemusic を別物にしない）。
   */
  async recurring(from: string, to: string, minMonths: number) {
    const { results } = await this.db
      .prepare(`
        WITH norm AS (
          SELECT replace(replace(replace(lower(item), ' ', ''), '　', ''), '・', '') AS key,
                 item, category, kind, amount, date
          FROM transactions
          -- 上限も切る。今月を混ぜると「12か月のうち13か月」という数字が出る。
          WHERE item <> '' AND kind IN ('支出', '投資') AND date >= ? AND date < ?
        ),
        counted AS (
          SELECT key, item, category, kind, COUNT(*) AS spell_n, MAX(date) AS last_date
          FROM norm GROUP BY key, item, category, kind
        ),
        -- 窓関数の結果は同じ階層では使えないので、数えてから順位を付ける。
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (
                      PARTITION BY key ORDER BY spell_n DESC, last_date DESC) AS rn
          FROM counted
        ),
        agg AS (
          SELECT key, COUNT(DISTINCT substr(date, 1, 7)) AS months,
                 COUNT(*) AS n, SUM(amount) AS total
          FROM norm GROUP BY key
        )
        SELECT r.item, r.category, r.kind, a.months, a.n,
               a.total / a.n AS avg, a.total
        FROM agg a JOIN ranked r ON r.key = a.key AND r.rn = 1
        WHERE a.months >= ?
        ORDER BY a.months DESC, avg DESC`)
      .bind(from, to, minMonths)
      .all();
    return results;
  }
}
