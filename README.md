# daifuku

入力の楽さに全振りした家計簿。名前は**大福帳**（江戸の商家が売掛・買掛を1冊にまとめた元帳）から。

スプレッドシートで機能は足りていた。辛いのは入力だけだったので、そこだけを解く。
レシート読み取りや銀行の自動連携はやらない。

- **入出金と資産残高を切り離して記録する。** 残高は入出金から計算しない（ズレの蓄積を直すのが苦行になるため）。
  大きく乖離したときだけ知らせる
- 決めたことと理由は [DESIGN.md](DESIGN.md) に全部書いてある。迷ったらそこを読む

データは別リポジトリ（`daifuku-content`）。コードとデータのリポジトリを分ける理由も DESIGN.md にある。

コードの正本はこの公開リポジトリ。実データ、口座名、実額、取引明細、測定メモは
ここへ置かず、D1・`daifuku-content`・公開リポジトリ外のメモに分ける。

## 開発

Node.js 24 LTS（npm同梱）とGitを使う。別のOSから持ってきた `node_modules` は
使い回さず、`npm ci` で `package-lock.json` に沿って入れ直す。

```sh
npm ci
npm run setup:hooks # このチェックアウトのコミット前に漏えい検査を必ず走らせる
npx wrangler d1 migrations apply daifuku-db --local # 初回とマイグレーション追加時
npm run dev        # ローカル D1 で起動（http://localhost:8788）
```

変更後の確認：

```sh
npm run typecheck
npm test
npm run check:privacy
npx wrangler deploy --dry-run # ビルド確認。本番へは配布しない
```

ローカル開発には本番の `.dev.vars` や家計データは不要。
`npm run dev` は開発用の認証省略を明示して起動する。
WindowsのPowerShellで `npm.ps1` の実行が制限される場合は `npm.cmd`、`npx.cmd` を使う。
Node.jsをインストールしてもコマンドが見つからない場合は、ターミナルを開き直す。

標準の場所にNode.jsとGitがあるのに、作業用シェルで見つからない、または
Gitフックで `bash` が見つからない場合は、そのシェルのPATHを補う。

```powershell
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
```

## 公開前検査

過去に実データを含んでいた `daifuku-private` の履歴は、このリポジトリへmerge、
cherry-pick、mirror pushしない。コード変更はこのリポジトリで直接行う。

コミット前に、追跡済みファイルとgitignoreされていない未追跡ファイルを検査する。
`npm run setup:hooks` を一度実行すれば、以後はコミット時にも自動で走る。

```sh
npm run check:privacy
git diff --cached
```

口座名などの禁止語一覧は、それ自体が情報になるため公開リポジトリには置かない。
既定では隣の旧チェックアウトにある `../daifuku-private/notes/publish-rules.mjs` を読む。
別の場所へ移した場合は `DAIFUKU_PRIVATE_RULES` にパスを指定する。ルールが読めなければ
検査はfail-closedで停止する。意図した例外だけを `tools/publish-allow.txt` に完全一致で置く。

ローカルの作業フォルダ名は `daifuku` に揃え、旧privateチェックアウトは
`daifuku-private` として保管する。旧側の `.dev.vars`、`.wrangler` 内のローカルDB、
`tools/import.sql` はGit管理外なので、GitHubからのcloneでは復元できない。
旧側を削除する前に、これらの保全と非公開検査ルールの移設を済ませる。

測定値や取引を調べる作業は、このリポジトリの外で行う。結論だけをコードや
DESIGN.mdへ反映し、口座名・実額・取引明細は持ち込まない。

## 自動デプロイ

`.github/workflows/deploy.yml` は `main` へのpushで、本番・デモを承認待ちなしで配布する。
型検査、テスト、本番・デモのdry-run、非公開ルールによる漏えい検査がすべて成功した場合だけ、
`npm run deploy` と `npm run deploy:demo` を別ジョブで実行する。
PRでは秘密情報を使わず、型検査・テスト・両方のdry-runだけを実行する。
漏えいをpush前に止めるため、ローカルのコミットフックも引き続き使う。

### 初回設定

GitHubの Settings → Secrets and variables → Actions に次のRepository secretsを登録する。

| 名前 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 配布先アカウントに限定したCloudflareの配布用APIトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 本番・デモのWorkerがあるCloudflareアカウントID |
| `DAIFUKU_PRIVATE_RULES_SOURCE` | ローカルの `publish-rules.mjs` 全文。単独で `RULES` をexportできるもの |

トークンはCloudflareのEdit Cloudflare Workersテンプレートを基に、対象アカウント・ゾーンを
限定する。既存のCustom DomainとD1 bindingに必要な権限も確認する。
手順は [Cloudflare公式](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) を参照。
Worker内の `AUTH_TOKEN` とバックアップ用 `GITHUB_TOKEN` は既存の設定を使う。
これらをActionsへコピーしたり、デモWorkerへ追加したりする必要はない。

非公開ルールは実行中だけ作業ツリー外の一時ファイルにし、検査後に削除する。
ルール名や検査内容を公開ログへ出さないため、CIの失敗詳細はローカルで確認する。
Secret未設定・ルール不正・検査失敗なら、本番もデモも配布しない。
このworkflowにSecretsを渡すのは `main` のpush・手動実行だけ。
`main` とworkflowを変更できる人は配布権限も持つため、書き込み権限を信頼する人に限定する。

Cloudflare管理画面のWorkers BuildsなどでGit連携が既に有効なら、自動配布を二重にしないよう
無効化する。初回はActionsで両方の配布成功を確認し、デモを開いて確認する。
本番はCloudflare Accessを通って開き、認証が保たれていることを確認する。

### DB変更と復旧

**D1マイグレーションは自動実行しない。** 新しいスキーマが必要な変更では、既存コードとの
互換性と復旧方法を確認し、必要なマイグレーションを手動適用してから `main` へpushする。
旧コードと共存できない変更は、自動配布を一時停止して別途手順を組む。

同じブランチの配布は直列化し、配布中の実行は新しいpushで中断しない。
待機中の古い実行は最新の実行へ置き換わることがある。
本番・デモの片方が失敗しても、もう片方は続行するため、両ジョブの結果を確認する。
一時的な失敗なら最新mainの実行を再実行するか、ActionsのRun workflowで `main` を指定する。
古いコミットの実行は配布直前に停止する。コードを戻す場合は修正をrevertして `main` へpushする。
Workerの旧版へ戻してもDBは戻らない。DBの復旧はマイグレーションごとの手順に従う。
失敗通知はGitHubのActions通知設定で受け取る。

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

本番ホストでは `AUTH_TOKEN` が未設定だと 503 で停止する。デプロイ後は次で
`AUTH_TOKEN` と `GITHUB_TOKEN` の2つが表示されることを確認する（値そのものは出ない）。

```sh
npx wrangler secret list
```

Cloudflare Access のアプリケーション対象が `daifuku.kazuki.page` のみになっていること、
`daifuku-content` が private であることも管理画面で確認する。`GITHUB_TOKEN` は
この1リポジトリの Contents: Read and write だけを持つ fine-grained token にする。

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
