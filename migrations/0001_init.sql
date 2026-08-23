-- daifuku 初期スキーマ
--
-- 約束（DESIGN.md より）
--   * 入出金と資産残高は別のもの。残高は入出金から計算しない
--   * 金額に符号を持たせない。符号は kind から導く
--   * data 列でアプリが知らないフィールドを消さない
--   * id は日時と無関係な固定値

CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  -- 機関（銀行・証券など）とサブ口座（総合、生活防衛）の2階層。
  -- 元データは「総合:A銀行」という1文字列だった。
  institution       TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  -- 資産クラス。固定しない（現金 / 投資 / 共有管理 …）
  class             TEXT NOT NULL DEFAULT '現金',
  -- 乖離検知の対象に含めるか。表示のスコープとは別（DESIGN.md「乖離検知」）
  in_reconciliation INTEGER NOT NULL DEFAULT 1,
  archived          INTEGER NOT NULL DEFAULT 0,
  sort              INTEGER NOT NULL DEFAULT 0,
  data              TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,                     -- YYYY-MM-DD
  -- 収入 / 支出 / 投資 / 振替 / メモ
  kind          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  item          TEXT NOT NULL DEFAULT '',          -- 任意
  amount        INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  account_id    TEXT REFERENCES accounts(id),      -- 任意（高額のみ必須はアプリ側で担保）
  to_account_id TEXT REFERENCES accounts(id),      -- 振替のみ
  counterparty  TEXT NOT NULL DEFAULT '',
  memo          TEXT NOT NULL DEFAULT '',
  pair_id       TEXT,                              -- 「予算」ペアの結び目
  batch_id      TEXT,                              -- CSV取込のUndo単位
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_tx_date     ON transactions(date DESC);
CREATE INDEX idx_tx_kind     ON transactions(kind, date DESC);
CREATE INDEX idx_tx_category ON transactions(category);
-- 候補学習は品目名の一致から引く
CREATE INDEX idx_tx_item     ON transactions(item);
CREATE INDEX idx_tx_pair     ON transactions(pair_id);
CREATE INDEX idx_tx_batch    ON transactions(batch_id);

CREATE TABLE balances (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- 負債はマイナスで持つので CHECK は付けない
  amount     INTEGER NOT NULL,
  memo       TEXT NOT NULL DEFAULT '',
  batch_id   TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 同じ日に同じ口座を2回記録しない（一括入力の上書き先を一意にする）
CREATE UNIQUE INDEX idx_bal_date_account ON balances(date, account_id);
CREATE INDEX idx_bal_date ON balances(date DESC);
