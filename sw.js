/* =========================================================
   Service Worker：让网站装到手机主屏后能秒开，断网也能看。

   缓存策略（按文件类型分开，别搞反了）：
   - 外壳（HTML/CSS/JS/图标）：网络优先，失败退回缓存。
     这样你一改代码，下次打开就是新版；断网时还能用旧版。
   - 图片 media/：缓存优先。图片文件名带时间戳、内容永不重复，
     缓存住只有好处（手机看作品集不用每次重新下载几 MB）。
   - 数据 data/site.json：网络优先，且不进预缓存。
     这是唯一会变的内容，必须拿到最新的。
   ========================================================= */

/* 改动缓存策略时把这个版本号 +1：activate 会把旧版本缓存全部删掉，
   避免用户手里留着上一版的行为。 */
var VERSION = 'muq-v19';
var SHELL_CACHE = VERSION + '-shell';
var MEDIA_CACHE = VERSION + '-media';

/* 只预缓存「打开就能用」的最小集合。故意不含 data/site.json。 */
var SHELL_FILES = [
  './',
  'index.html',
  'studio.html',
  'install.html',
  'manifest.webmanifest',
  'assets/css/base.css',
  'assets/css/site.css',
  'assets/css/studio.css',
  'assets/js/data.js',
  'assets/js/cloud.js',
  'assets/js/store.js',
  'assets/js/app.js',
  'assets/js/studio.js',
  'assets/img/favicon.svg',
  'assets/img/icon-192.png',
  'assets/img/icon-512.png',
  'assets/img/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        /* 一个个来，不要 Promise.all 并发。
           这条线路到 GitHub Pages 只有约 70 KB/s，十几个文件同时抓会把带宽切碎，
           首屏图片排在它们后面，结果就是「页面打开很久还是一堆灰框」。
           串行预缓存对首屏几乎无感（只是把 16 个请求摊开），但图片能先出来。 */
        var chain = Promise.resolve();
        SHELL_FILES.forEach(function (file) {
          chain = chain.then(function () {
            return cache.add(new Request(file, { cache: 'reload' })).catch(function () {
              /* 单个文件失败不该让整次安装失败 */
              return null;
            });
          });
        });
        return chain;
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            // 清掉上一个版本的缓存；媒体缓存用同一套版本号，一起换。
            if (key.indexOf(VERSION) !== 0) return caches.delete(key);
            return null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function isMedia(url) {
  return /\/media\//.test(url.pathname);
}

function isData(url) {
  return /\/data\//.test(url.pathname);
}

function isShell(url) {
  return (
    url.pathname.endsWith('/') ||
    /\.(html|css|js|webmanifest|svg|png|jpg|jpeg|webp|ico)$/i.test(url.pathname)
  );
}

/* 网络优先：先拿最新的，拿到就顺手更新缓存；拿不到用缓存。 */
function networkFirst(request, cacheName) {
  return fetch(request)
    .then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        if (hit) return hit;
        // 导航请求断网时退回首页缓存的壳子，至少能打开。
        if (request.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    });
}

/* 缓存优先：图片内容不变，命中就不上网。 */
function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  // 只处理自己站点 + 同目录的请求；GitHub API 等跨域请求直接放行，不进缓存。
  if (url.origin !== self.location.origin) return;

  // 数据文件永远走网络，绝不返回旧数据 —— 否则手机上会看到过期作品。
  if (isData(url)) {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(request);
      })
    );
    return;
  }

  if (isMedia(url)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE));
    return;
  }

  if (isShell(url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

/* 页面可以主动喊一声「有新版了」，让 SW 立刻接管。 */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});
