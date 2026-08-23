// ローカルの設定ファイルにあたるもの。Workers にファイルシステムは無いので
// モジュールとして持つ（変更＝コミット＝デプロイ、という素直な流れになる）。

export const CONFIG = {
  /**
   * CSV の書き出し先。D1 が正で、こちらは派生物。
   * コードとデータでリポジトリを分ける理由は DESIGN.md にある。
   */
  exportTo: { owner: 'kazuki-page', repo: 'daifuku-content', branch: 'main' },
} as const;
