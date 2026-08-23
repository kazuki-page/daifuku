-- アプリの状態を置く小さな KV。いまの用途は書き出しの結果だけ。
--
-- 書き出しは、トークンの期限切れなどで「静かに止まる」のが一番まずい壊れ方。
-- 成功した日時と、失敗したときの理由を残して、UI から見えるようにする。
CREATE TABLE meta (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- 取り込みの単位。同じCSVを2回入れる事故は必ず起きるので、
-- まとめて取り消せるようにしておく（transactions と balances には最初から有る）。
ALTER TABLE accounts ADD COLUMN batch_id TEXT;
CREATE INDEX idx_accounts_batch ON accounts(batch_id);
