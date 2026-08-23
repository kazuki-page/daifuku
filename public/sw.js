// 目的は1つだけ: 圏外でもアプリの殻を開けるようにする。
// 殻が開かないと、未送信キューに書き込むことすらできない。
//
// 方針はネットワーク優先・キャッシュは代替（leaves と同じ）。
//   - オンラインなら必ずサーバに行く＝合鍵の判定を毎回通る。
//     キャッシュを先に返すと、鍵が無効になっても画面が開いてしまう
//   - 新しくデプロイした app.js が古いまま残る問題も、これで起きない
//
// API は一切キャッシュしない。金額を端末のキャッシュに残さないため。

// **名前は固定する。** 版を上げて activate で古いものを消す作りには、
// 「キャッシュが空になる」道がある（install が一部失敗 → 古いのを消す → 殻が無い）。
// fetch がネットワーク優先で成功のたびに上書きするので、版を上げる意味も薄い。
const CACHE = 'daifuku-shell';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1件ずつ入れる。addAll は1つ失敗すると全部落ちるので、
      // 例えば manifest だけ取れなかったときに殻ごと失う。
      await Promise.allSettled(
        SHELL.map(async (path) => {
          const res = await fetch(path, { credentials: 'same-origin' });
          // 401（合鍵ページ）や302（Access への転送）を焼き付けない。
          if (res.ok) await cache.put(path, res);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;      // 金額は端末に残さない
  if (url.pathname.startsWith('/cdn-cgi/')) return;  // Access はブラウザに任せる

  event.respondWith(
    fetch(request)
      .then((response) => {
        // 401（合鍵ページ）を焼き付けると、鍵を入れ直しても古い画面が出る。
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // 個別のファイルが無くても、殻さえ返せば画面は立ち上がる。
        // '/' と '/index.html' は別の鍵なので、両方たどる。
        if (request.mode === 'navigate') {
          const shell = (await caches.match('/index.html')) ?? (await caches.match('/'));
          if (shell) return shell;
        }
        throw new Error('offline and not cached');
      }),
  );
});
