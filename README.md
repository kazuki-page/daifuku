# daifuku

入力の楽さに全振りした家計簿。名前は**大福帳**（江戸の商家が売掛・買掛を1冊にまとめた元帳）から。

スプレッドシートで機能は足りていた。辛いのは入力だけだったので、そこだけを解く。
レシート読み取りや銀行の自動連携はやらない。

- **入出金と資産残高を切り離して記録する。** 残高は入出金から計算しない（ズレの蓄積を直すのが苦行になるため）。
  大きく乖離したときだけ知らせる
- 決めたことと理由は [DESIGN.md](DESIGN.md) に全部書いてある。迷ったらそこを読む

データは別リポジトリ（`daifuku-content`）。コードとデータのリポジトリを分ける理由も DESIGN.md にある。

開発は private のリポジトリで行っていて、**公開版には実データの測定値（`notes/`）を含めない**（下の「公開」）。

## 開発

```sh
npm install
npm run dev        # ローカル D1 で起動（http://localhost:8788）
npm run typecheck
npm run deploy
```

## 公開

`kazuki-page/daifuku`（公開）へは**ファイルを写すだけ**で、`git push` で履歴は送らない。
private の過去コミットには実額がそのまま残っているので、履歴を流した時点で
いまファイルを綺麗にしてあることに意味が無くなる。

```sh
npm run publish:public              # ../daifuku-public へ写す
git -C ../daifuku-public status     # 差分を目で見る
git -C ../daifuku-public commit -a -m '…'
git -C ../daifuku-public push
```

許可リストに書いたファイルだけが行く。書いていないものは行かない（`notes/` が落ちるのもこれ）。
写す前に中身を検査し、実額や口座名が紛れていれば**1ファイルも書かずに止まる**。
意図した例外は `tools/publish-allow.txt` に完全一致で置く。

**測って数字が出たら `notes/実測.md` に書く。** DESIGN.md は公開されるので、
そこに実額を書くと出ていく（ゲートが止めるが、止まってから直すより先に分けるほうが楽）。
決めた理由は DESIGN.md「公開の仕方」。

## デモ版

`daifuku-demo.kazuki.page`。**誰でも開ける。**

```sh
npm run dev:demo     # http://localhost:8789
npm run deploy:demo
```

本番とは別の Worker（`wrangler.demo.jsonc`）で、**D1 も合鍵も GitHub の鍵も
紐付けていない**。中身は `public/demo.js` がブラウザの `localStorage` で引き受ける。
Worker 側の `/api/*` は例外なく 503 で断る。

`npx wrangler secret list --config wrangler.demo.jsonc` が `[]` を返すこと——
これが「デモから本番のデータへ届く道が無い」ことの一番外側の確認になる。

中身は作り物の一人暮らしの家計を、開いた日から26か月ぶん遡って毎回組み立てる。
**実データからは1行も引いていない。** 何を入れてあるかと、その理由は
DESIGN.md「デモ版」にある。

`AUTH_TOKEN`（合鍵）は `wrangler secret put AUTH_TOKEN` で入れる。
ローカルでは `.dev.vars` に書く。未設定なら認証なしで動く（開発用）。

## 既存スプレッドシートからの移行

一度きりの移行なので、汎用のマッピングUIは作らず専用スクリプトにしてある。

```sh
node tools/import.mjs <csvディレクトリ> > tools/import.sql
npx wrangler d1 migrations apply daifuku-db --remote
npx wrangler d1 execute daifuku-db --remote --file=tools/import.sql
```

判断（どの列を捨てたか、`メモ` 行をどう振り分けたか）はすべて `tools/import.mjs` の
コメントに書いてある。

## OGP

`public/og.png`（1200×630）。`tools/og.mjs` が組み立てて焼く。

```sh
npm run og
```

**PNG が本体で、SVG は原稿。** 文言や色は `tools/og.mjs` の `COPY` と色の定数を直して
焼き直す。焼く時点の環境のフォントで描くので、焼いた PNG のほうをリポジトリに置く。

**差し込む先はデモだけで、本番には入れない。** 理由は DESIGN.md「OGP」。
