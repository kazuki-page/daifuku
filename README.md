# daifuku

入力の楽さに全振りした家計簿。名前は**大福帳**（江戸の商家が売掛・買掛を1冊にまとめた元帳）から。

スプレッドシートで機能は足りていた。辛いのは入力だけだったので、そこだけを解く。
レシート読み取りや銀行の自動連携はやらない。

- **入出金と資産残高を切り離して記録する。** 残高は入出金から計算しない（ズレの蓄積を直すのが苦行になるため）。
  大きく乖離したときだけ知らせる
- 決めたことと理由は [DESIGN.md](DESIGN.md) に全部書いてある。迷ったらそこを読む

データは別リポジトリ（`daifuku-content`）。コードとデータのリポジトリを分ける理由も DESIGN.md にある。

開発は private のリポジトリで行っていて、**公開版には実データの測定値（`notes/`）を含めない。**
写しているのは `tools/publish.mjs` の許可リストにあるファイルだけで、
写す前に実額や口座名が紛れていないかを検査している。

## 開発

```sh
npm install
npm run dev        # ローカル D1 で起動（http://localhost:8788）
npm run typecheck
npm run deploy
```

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
