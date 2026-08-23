// D1 の中身を daifuku-content リポジトリへ CSV として書き出す。
//
// D1 が正で、こちらは派生物。目的は2つ（leaves と同じ）:
//   1. AI に読ませる材料
//   2. バックアップ。Cloudflare 側で何かあったときの最後の砦
//
// Contents API はファイル1つにつき1コミットになるので使わない。
// Git Data API で tree → commit → ref と積み、3枚まとめて1コミットにする。

import { Store } from './store';
import {
  toCsv, TRANSACTION_COLUMNS, BALANCE_COLUMNS, ACCOUNT_COLUMNS,
} from './csv';

const API = 'https://api.github.com';

const README = `# daifuku-content

[daifuku](https://github.com/kazuki-page/daifuku) の中身。**このリポジトリは生成物**で、
正はアプリ側の D1 にある。手で編集しても次の書き出しで上書きされる。

- \`transactions.csv\` … 入出金
- \`balances.csv\` … 資産残高のスナップショット
- \`accounts.csv\` … 口座

金額は区切りも通貨記号も付けない整数。符号は付けず \`kind\` から導く。日付は ISO。
\`data\` 列まで含めて欠損なく出るので、この3枚があればアプリを作り直しても中身は失わない。
`;

export type ExportTarget = { owner: string; repo: string; branch: string };

export type ExportResult =
  | { changed: false; rows: number }
  | { changed: true; rows: number; commit: string; url: string };

/** GitHub に触らずに中身だけ組み立てる（トークン無しでも確認できる）。 */
export async function buildFiles(store: Store): Promise<{ path: string; content: string }[]> {
  const [tx, bal, acct] = await Promise.all([
    store.exportTransactions(), store.exportBalances(), store.exportAccounts(),
  ]);
  return [
    { path: 'transactions.csv', content: toCsv(TRANSACTION_COLUMNS, tx) },
    { path: 'balances.csv', content: toCsv(BALANCE_COLUMNS, bal) },
    { path: 'accounts.csv', content: toCsv(ACCOUNT_COLUMNS, acct) },
    { path: 'README.md', content: README },
  ];
}

export async function exportToGitHub(
  store: Store,
  token: string,
  target: ExportTarget,
): Promise<ExportResult> {
  const gh = github(token, target);
  const files = await buildFiles(store);
  const rows = files.reduce((n, f) => n + Math.max(0, f.content.split('\r\n').length - 2), 0);

  // 空のリポジトリには ref がまだ無い。最初の1回はここが 404 になる。
  let head = await gh<{ object: { sha: string } }>(`git/ref/heads/${target.branch}`)
    .catch(() => null);

  // **コミットが1つも無いリポジトリには Git Data API でツリーを作れない**
  // （`git/trees` が 409 Git Repository is empty を返す）。
  // Contents API は空のリポジトリでも書けるので、README だけ先に置いて土台を作る。
  if (!head) {
    await gh('contents/README.md', {
      message: 'daifuku: 最初のコミット',
      content: base64(README),
      branch: target.branch,
    }, 'PUT');
    head = await gh<{ object: { sha: string } }>(`git/ref/heads/${target.branch}`);
  }

  const headCommit = await gh<{ tree: { sha: string } }>(`git/commits/${head.object.sha}`);
  const baseTreeSha = headCommit.tree.sha;
  const base = await gh<{ tree: { path: string; type: string; mode: string; sha: string }[] }>(
    `git/trees/${baseTreeSha}?recursive=1`,
  );

  // 生成物は下で作り直す。それ以外（手で置いたファイル）はそのまま残す。
  const tree: TreeEntry[] = [];
  const generated = new Set(files.map((f) => f.path));
  for (const node of base.tree) {
    if (node.type !== 'blob' || generated.has(node.path)) continue;
    tree.push({ path: node.path, mode: node.mode, type: 'blob', sha: node.sha });
  }

  for (const f of files) {
    tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
  }

  const newTree = await gh<{ sha: string }>('git/trees', { tree });
  // 中身が同じならツリーの sha も同じになる。空コミットを積まずに済む。
  if (newTree.sha === baseTreeSha) return { changed: false, rows };

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const commit = await gh<{ sha: string; html_url: string }>('git/commits', {
    message: `daifuku: 書き出し (${stamp} UTC)`,
    tree: newTree.sha,
    parents: [head.object.sha],
  });

  await gh(`git/refs/heads/${target.branch}`, { sha: commit.sha }, 'PATCH');

  return { changed: true, rows, commit: commit.sha, url: commit.html_url };
}

type TreeEntry = { path: string; mode: string; type: 'blob'; sha?: string; content?: string };

/** Contents API は中身を base64 で受け取る。btoa は素の文字列しか扱えないのでバイト列に直す。 */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function github(token: string, target: ExportTarget) {
  return async function call<T = unknown>(path: string, payload?: unknown, method?: string): Promise<T> {
    const res = await fetch(`${API}/repos/${target.owner}/${target.repo}/${path}`, {
      method: method ?? (payload ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'daifuku-exporter',
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} ${path}: ${detail.slice(0, 200) || res.statusText}`);
    }
    return (await res.json()) as T;
  };
}
