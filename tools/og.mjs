// OGP 画像（1200×630）を組む。SVG を書き出し、PNG に焼く。
//
//   npm run og        public/og.png と tools/og.svg を書き出す
//
// **PNG が本体で、SVG は原稿。** OGP を SVG で読むクローラは無いので配るのは PNG だが、
// 文言や色を直すたびに描き直せるよう組み立てはここに残す。leaves と同じ作り。
//
// 文字は焼く時点の環境のフォントで描く。環境が変わると字幅が変わるので、
// **焼いた PNG のほうをリポジトリに置く。**
//
// 差し込む先はデモだけ。本番は Access の内側にあってクローラが到達できないので、
// 入れても効かないうえ、og:url の指す先が2つに割れる。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const F = "ui-sans-serif, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif";

// public/style.css と同じ値。ここだけ別の色を持たせない。
const INK = '#003156';        // 骨格と操作
const BG = '#e8f1ff';         // 面
const MUTED = '#4a6b85';
const LINE = '#cfe0f2';
const PANEL = '#ffffff';
const MARK = '#FFB94D';       // 目を向ける先。**地としてのみ**
const WARN = '#8a5a00';       // 明るい面で読める黄。5.21

const r = (n, d = 2) => Number(n.toFixed(d));
const T = (x, y, size, fill, s, w = 400, extra = '') =>
  `<text x="${r(x)}" y="${r(y)}" fill="${fill}" font-size="${size}" font-weight="${w}" ` +
  `font-family="${F}" ${extra}>${s}</text>`;

/* --- 大福の断面 ----------------------------------------------------------- */
// public/icon.svg と同じ形。**地は敷かない。** OGP の地がもともと薄水なので、
// アイコンの面をそのまま外へ広げたことになる。
const MARK_H = 378 - 134;     // 外形の高さ（線の外まで）
const MARK_W = 450 - 62;

function daifuku(cx, cy, h) {
  const s = h / MARK_H;
  return `<g transform="translate(${r(cx)},${r(cy)}) scale(${r(s, 4)}) translate(-256,-256)">
    <path d="M80 296 C80 216 159 152 256 152 C353 152 432 216 432 296
             A64 64 0 0 1 368 360 L144 360 A64 64 0 0 1 80 296 Z"
          fill="none" stroke="${INK}" stroke-width="36" stroke-linejoin="round"/>
    <ellipse cx="256" cy="264" rx="98" ry="48" fill="${INK}"/></g>`;
}

/* --- 右に置くアプリ画面 --------------------------------------------------- */
// 実物のスクショではなく描き起こし。**出すのは入力画面。**
// 概要のグラフのほうが見栄えはするが、あれは後から足した機能で、
// 看板にすると見た人の期待と中身がずれる（DESIGN.md「この道具が解く問題」）。
//
// leaves は本文をグレーの帯に落としたが、こちらは**短い語そのものが中身**なので
// 実際の語を置く。「昼食」「食費」が読めることに意味がある。
function screen() {
  const pill = (x, y, w, h, fill, stroke, txt, tc, fs = 17, fw = 400) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"` +
    (stroke ? ` stroke="${stroke}" stroke-width="1.5"` : '') + '/>' +
    T(x + w / 2, y + h / 2 + fs * 0.36, fs, tc, txt, fw, 'text-anchor="middle"');

  return `<g filter="url(#sh)" transform="translate(672,64) scale(1.12)">
    <rect x="0" y="0" width="400" height="620" rx="34" fill="${INK}"/>
    <rect x="12" y="12" width="376" height="596" rx="24" fill="${BG}"/>

    <!-- タブ。黄はここ1箇所だけ。現在地＝目を向ける先 -->
    ${pill(30, 40, 64, 30, MARK, null, '入力', INK, 17, 700)}
    ${T(112, 61, 17, MUTED, '概要')} ${T(168, 61, 17, MUTED, '入出金')} ${T(242, 61, 17, MUTED, '資産')}
    ${T(316, 62, 18, MUTED, '⚙')}

    <!-- 種別。選択中は紺＝押して確定するもの -->
    ${pill(30, 92, 66, 32, INK, null, '支出', '#ffffff', 17, 700)}
    ${pill(104, 92, 66, 32, PANEL, LINE, '収入', MUTED)}
    ${pill(178, 92, 66, 32, PANEL, LINE, '投資', MUTED)}
    ${pill(252, 92, 66, 32, PANEL, LINE, '振替', MUTED)}

    <rect x="30" y="140" width="340" height="86" rx="18" fill="${PANEL}"/>
    ${T(52, 199, 34, MUTED, '¥')}
    ${T(88, 201, 50, INK, '1,280', 700)}

    ${pill(30, 244, 62, 30, INK, null, '今日', '#ffffff', 16, 700)}
    ${pill(100, 244, 62, 30, PANEL, LINE, '昨日', MUTED, 16)}
    ${pill(170, 244, 78, 30, PANEL, LINE, '一昨日', MUTED, 16)}

    <!-- 候補。この道具の中心なので、必ず入れる -->
    ${T(30, 306, 15, MUTED, '候補')}
    ${pill(30, 318, 88, 34, PANEL, INK, '昼食', INK, 16)}
    ${pill(126, 318, 116, 34, PANEL, INK, 'コーヒー', INK, 16)}
    ${pill(250, 318, 102, 34, PANEL, INK, '日用品', INK, 16)}

    ${T(30, 388, 15, MUTED, 'カテゴリ')}
    ${pill(30, 400, 76, 34, INK, null, '食費', '#ffffff', 16, 700)}
    ${pill(114, 400, 96, 34, PANEL, LINE, '日用品', MUTED, 16)}
    ${pill(218, 400, 96, 34, PANEL, LINE, '交通費', MUTED, 16)}

    <rect x="30" y="452" width="340" height="42" rx="12" fill="${PANEL}" stroke="${LINE}" stroke-width="1.5"/>
    ${T(46, 479, 16, '#93a8ba', '品目（任意）')}

    <rect x="30" y="512" width="340" height="52" rx="14" fill="${INK}"/>
    ${T(200, 545, 19, '#ffffff', '保存', 700, 'text-anchor="middle"')}
  </g>`;
}

/* --- 文言 ----------------------------------------------------------------- */
// **「帳尻」の帳は大福帳の帳。** 名前と主張が同じ字になっている。
//
// 1行目は単体だと「いい加減なアプリ」に読める。**2行目がそれを引き受ける構造**なので、
// 「だから続く。」を弱い言葉に替えると崩れる。
//
// 絵が「何を触るか」、文が「なぜ他と違うか」。同じことを2回言わせない。
const COPY = {
  h1: '帳尻は合わせない。',
  h2: 'だから続く。',
  sub1: '入出金と資産残高を切り離して記録する家計簿',
  sub2: 'Cloudflare Workers ＋ D1',
  url: 'daifuku-demo.kazuki.page',
};

const X = 80;                 // 左の外余白
const LOGO_BASE = 190;
const FS = 60;                // ロゴ文字
const SUB_SIZE = 24;
const SCREEN_X = 672;         // 電話の左端

export function buildSvg() {
  const mh = 58;                        // ロゴの大福の高さ
  const mw = (mh * MARK_W) / MARK_H;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#0a2338" flood-opacity="0.22"/>
  </filter></defs>
  <rect width="1200" height="630" fill="${BG}"/>
  ${daifuku(X + mw / 2, LOGO_BASE - FS * 0.36, mh)}
  ${T(X + mw + 24, LOGO_BASE, FS, INK, 'daifuku', 700, 'letter-spacing="-2"')}
  ${T(X, 306, 42, INK, COPY.h1, 600)}
  ${T(X, 364, 42, INK, COPY.h2, 600)}
  ${T(X, 420, SUB_SIZE, MUTED, COPY.sub1)}
  ${T(X, 456, 22, MUTED, COPY.sub2)}
  ${T(X, 520, 30, WARN, COPY.url, 600)}
  ${screen()}
</svg>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 補足行は全角なので、字数×文字サイズが電話の左端を超えないか焼く前に見る。
  // 一度ここを超えて電話に文字が突き刺さったので、目視ではなく計算で止める。
  const limit = (SCREEN_X - X) / SUB_SIZE;
  if ([...COPY.sub1].length > limit) {
    throw new Error(`補足が長い: ${[...COPY.sub1].length} 字 > ${limit.toFixed(1)} 字`);
  }

  const svg = buildSvg();
  writeFileSync(join(root, 'tools/og.svg'), svg);

  // **3倍で描いてから縮める。** 等倍だと字の縁がざらつく。
  // librsvg の既定は 72dpi なので、216 でちょうど3倍。
  const png = await sharp(Buffer.from(svg), { density: 216 })
    .resize(1200, 630)
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(root, 'public/og.png'), png);
  console.log(`public/og.png を書き出しました（${(png.length / 1024).toFixed(0)} KB）`);
}
