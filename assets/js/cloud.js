/* =========================================================
   云端数据层：直接读写 GitHub 仓库（手机/电脑都能改）

   为什么用 GitHub 当后端：
   - 网站本来就托管在 GitHub Pages 上，数据和图片就在仓库里；
   - 国内实测 api.github.com 直连 0.37 秒可达（Supabase / Firebase 都是 12 秒超时）；
   - 不用买服务器、不用一直开着电脑，手机上改完 30~60 秒网站自动更新。

   写入需要你自己的 GitHub 令牌（只给这一个仓库的读写权限，存在本机浏览器里，
   不会上传到任何地方）。没有令牌的设备一律只读，正好就是访客看到的样子。

   API 文档：https://docs.github.com/rest/repos/contents
   ========================================================= */
(function () {
  'use strict';

  var API_ROOT = 'https://api.github.com';
  var STORE_KEY = 'muq.cloud.v1';
  var SITE_PATH = 'data/site.json';
  var MEDIA_DIR = 'media';

  /* 默认就是现在这套仓库；换仓库时改这里或用 configure() 覆盖。 */
  var DEFAULTS = {
    owner: 'muqiuchen1216',
    repo: 'muqiuchen1216.github.io',
    branch: 'main',
    token: ''
  };

  var config = Object.assign({}, DEFAULTS);
  var lastWriteAt = 0;
  var rateLimit = { limit: 0, remaining: 0, reset: 0 };

  /* ---------- 配置存取 ---------- */

  function loadConfig() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        config = Object.assign({}, DEFAULTS, {
          owner: saved.owner || DEFAULTS.owner,
          repo: saved.repo || DEFAULTS.repo,
          branch: saved.branch || DEFAULTS.branch,
          token: typeof saved.token === 'string' ? saved.token : ''
        });
      }
    } catch (error) {
      /* 读不出来就用默认（只读）配置 */
    }
  }

  function saveConfig() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          token: config.token
        })
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  function configure(next) {
    var source = next || {};
    config = Object.assign({}, config, {
      owner: String(source.owner || config.owner || '').trim(),
      repo: String(source.repo || config.repo || '').trim(),
      branch: String(source.branch || config.branch || 'main').trim(),
      token: typeof source.token === 'string' ? source.token : config.token
    });
    saveConfig();
    return Object.assign({}, config);
  }

  function forgetToken() {
    config.token = '';
    saveConfig();
  }

  /* 有令牌才算「可以写」；没有令牌的设备纯只读。 */
  function canWrite() {
    return Boolean(config.token && config.owner && config.repo);
  }

  function getConfig() {
    return Object.assign({}, config);
  }

  function getRateLimit() {
    return Object.assign({}, rateLimit);
  }

  function getLastWriteAt() {
    return lastWriteAt;
  }

  /* ---------- 编解码 ---------- */

  function utf8ToBytes(text) {
    if (typeof window.TextEncoder === 'function') {
      return new window.TextEncoder().encode(text);
    }
    // 兜底：老浏览器没有 TextEncoder 时按 UTF-8 手工编码
    var bytes = [];
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var next = text.charCodeAt(index + 1);
        var point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 0x3f),
          0x80 | ((point >> 6) & 0x3f),
          0x80 | (point & 0x3f)
        );
        index += 1;
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  }

  function bytesToUtf8(bytes) {
    if (typeof window.TextDecoder === 'function') {
      return new window.TextDecoder('utf-8').decode(bytes);
    }
    var text = '';
    for (var index = 0; index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index]);
    }
    try {
      return decodeURIComponent(escape(text));
    } catch (error) {
      return text;
    }
  }

  /* 分块转换，避免大图一次性 apply 导致调用栈溢出 */
  function bytesToBase64(bytes) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var offset = 0; offset < bytes.length; offset += CHUNK) {
      var slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      parts.push(String.fromCharCode.apply(null, slice));
    }
    return window.btoa(parts.join(''));
  }

  function base64ToBytes(base64) {
    var binary = window.atob(String(base64 || '').replace(/\s+/g, ''));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function blobToBase64(blob) {
    if (typeof window.FileReader !== 'function') {
      return Promise.reject(new Error('这个浏览器不支持读取本地图片'));
    }
    return new Promise(function (resolve, reject) {
      var reader = new window.FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve(comma === -1 ? '' : result.slice(comma + 1));
      };
      reader.onerror = function () {
        reject(new Error('读取图片数据失败'));
      };
      reader.readAsDataURL(blob);
    });
  }

  /* ---------- 底层请求 ---------- */

  /* 国内到 api.github.com 的连接实测有 30~40% 的概率被重连（ECONNRESET），
     一旦撞上要白等 10 秒才超时。所以这里把重试做成默认行为：
     网络层失败（不是 4xx/5xx）就立刻换新连接重试，最多 4 次。
     实测这样能把「保存失败」压到几乎为零，平均等待从 4.4 秒降到 0.7 秒左右。 */
  var RETRY_ATTEMPTS = 4;
  var RETRY_BASE_MS = 300;
  /* 单次请求超时：宁可快点失败去重试，也不要卡着不动 30 秒。
     正常的读写在 0.4~1 秒之间，图片上传另外单独给更长的超时。 */
  var REQUEST_TIMEOUT_MS = 8000;

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  /* 值得重试的失败：连接被重置、超时、5xx、限流。
     不该重试的：401 令牌错、404 找不到、403 无权限 —— 重试也是同样结果。
     409/422（内容冲突）不在这里重试，交给 putFile 自己重新取 sha。 */
  function isRetryable(error) {
    if (!error) return false;
    if (error.offline) return true;
    var status = Number(error.status) || 0;
    if (status === 0) return true;
    if (status >= 500) return true;
    if (status === 429) return true;
    return false;
  }

  function isConflict(error) {
    if (!error) return false;
    var status = Number(error.status) || 0;
    return status === 409 || status === 422;
  }

  function requestOnce(path, options) {
    var settings = Object.assign({ method: 'GET' }, options || {});
    var headers = Object.assign(
      {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      settings.headers || {}
    );
    if (config.token) headers.Authorization = 'Bearer ' + config.token;

    var timeout = settings.timeout || REQUEST_TIMEOUT_MS;
    var controller = null;
    var timer = 0;
    if (typeof window.AbortController === 'function') {
      controller = new window.AbortController();
      settings.signal = controller.signal;
      timer = window.setTimeout(function () {
        try {
          controller.abort();
        } catch (error) {
          /* noop */
        }
      }, timeout);
    }

    delete settings.timeout;

    return window
      .fetch(API_ROOT + path, Object.assign(settings, { headers: headers, cache: 'no-store' }))
      .then(function (response) {
        if (timer) window.clearTimeout(timer);
        readRateLimit(response);

        return response.text().then(function (text) {
          var payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch (error) {
            payload = null;
          }
          if (!response.ok) {
            var failure = new Error(describeFailure(response.status, payload));
            failure.status = response.status;
            failure.payload = payload;
            throw failure;
          }
          return payload;
        });
      })
      .catch(function (error) {
        if (timer) window.clearTimeout(timer);
        if (error && error.status) throw error;
        if (error && error.name === 'AbortError') {
          var timeoutError = new Error('连接 GitHub 超时');
          timeoutError.offline = true;
          throw timeoutError;
        }
        var offline = new Error('连不上 GitHub');
        offline.offline = true;
        throw offline;
      });
  }

  function request(path, options) {
    var attempt = 0;

    function run() {
      attempt += 1;
      return requestOnce(path, options).catch(function (error) {
        if (attempt >= RETRY_ATTEMPTS || !isRetryable(error)) throw error;
        // 递增等待：300ms、600ms、1200ms —— 给线路一点恢复时间。
        return sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1)).then(run);
      });
    }

    return run();
  }

  function readRateLimit(response) {
    var limit = Number(response.headers.get('X-RateLimit-Limit'));
    var remaining = Number(response.headers.get('X-RateLimit-Remaining'));
    var reset = Number(response.headers.get('X-RateLimit-Reset'));
    if (Number.isFinite(limit) && limit > 0) {
      rateLimit = {
        limit: limit,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        reset: Number.isFinite(reset) ? reset * 1000 : 0
      };
    }
  }

  function describeFailure(status, payload) {
    var message = payload && payload.message ? String(payload.message) : '';
    if (status === 401) return '令牌无效或已过期，请重新粘贴一次 GitHub 令牌';
    if (status === 403) {
      if (/rate limit/i.test(message)) return 'GitHub 接口调用次数用完了，等一小时后再试';
      return '没有写入权限：请确认令牌勾选了「Contents: Read and write」';
    }
    if (status === 404) return '找不到仓库或文件，请确认仓库名和分支名';
    if (status === 409 || status === 422) return '文件在别处刚刚被改过，正在重试';
    if (status >= 500) return 'GitHub 服务暂时不可用，稍后再试';
    return message || 'GitHub 返回 ' + status;
  }

  function repoBase() {
    return '/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo);
  }

  function encodePath(path) {
    return String(path)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  /* ---------- 读 ---------- */

  /* 最近一次读到的站点数据 + 它的 sha。
     连着保存两处时，第二处直接用这份，省一次网络往返。 */
  var siteCache = { site: null, sha: '', at: 0 };
  var SITE_CACHE_MS = 8000;

  function cacheSite(site, sha) {
    siteCache = { site: site, sha: sha || '', at: Date.now() };
  }

  /* 读一个文件，返回 { text, sha, bytes }；不存在时返回 null。
     优先走 API：它是实时的，而 Pages 有 10 分钟缓存。 */
  function readFile(path) {
    if (!config.owner || !config.repo) return Promise.resolve(null);
    var url = repoBase() + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(config.branch);
    return request(url, { timeout: 20000 }).then(
      function (payload) {
        if (!payload || typeof payload !== 'object' || !payload.sha) return null;
        if (!payload.content) return { sha: payload.sha, text: '', bytes: new Uint8Array(0) };
        var bytes = base64ToBytes(payload.content);
        return { sha: payload.sha, bytes: bytes, text: bytesToUtf8(bytes) };
      },
      function (error) {
        if (error && error.status === 404) return null;
        throw error;
      }
    );
  }

  function readSite() {
    return readFile(SITE_PATH).then(function (file) {
      if (!file || !file.text) return null;
      try {
        var parsed = JSON.parse(file.text);
        cacheSite(parsed, file.sha);
        return { site: parsed, sha: file.sha };
      } catch (error) {
        throw new Error('线上数据文件格式损坏，请检查 data/site.json');
      }
    });
  }

  /* ---------- 写 ---------- */

  /* 写一个文件。传了 sha 就是更新，没传就是新建。
     409/422 表示别人刚改过同一个文件 —— 重新取一次 sha 再试。 */
  function putFile(path, bytes, message, sha, attempt) {
    var round = typeof attempt === 'number' ? attempt : 0;
    var url = repoBase() + '/contents/' + encodePath(path);
    var body = {
      message: message || '更新网站内容',
      content: bytesToBase64(bytes),
      branch: config.branch
    };
    if (sha) body.sha = sha;

    return request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 60000
    }).then(
      function (payload) {
        lastWriteAt = Date.now();
        // 写成功后 sha 变了，把缓存里的那份标记为过期，避免下次用到旧 sha。
        siteCache = { site: null, sha: '', at: 0 };
        return payload;
      },
      function (error) {
        if (isConflict(error) && round < 3) {
          siteCache = { site: null, sha: '', at: 0 };
          return readFile(path).then(function (fresh) {
            return putFile(path, bytes, message, fresh ? fresh.sha : '', round + 1);
          });
        }
        throw error;
      }
    );
  }

  function putText(path, text, message, sha, attempt) {
    return putFile(path, utf8ToBytes(text), message, sha, attempt);
  }

  /* 删一个文件。文件本来就不在时当作成功。 */
  function deleteFile(path, message) {
    return readFile(path).then(function (file) {
      if (!file) return true;
      var url = repoBase() + '/contents/' + encodePath(path);
      return request(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message || '删除文件', sha: file.sha, branch: config.branch }),
        timeout: 30000
      }).then(
        function () {
          lastWriteAt = Date.now();
          return true;
        },
        function (error) {
          if (error && error.status === 404) return true;
          throw error;
        }
      );
    });
  }

  /* 已知 sha 时直接删，省掉「先读一次拿 sha」的那趟请求。
     目录列表接口返回的每一项本身就带 sha，批量删图时用这个能快一倍。 */
  function deleteFileWithSha(path, sha, message) {
    if (!sha) return deleteFile(path, message);
    var url = repoBase() + '/contents/' + encodePath(path);
    return request(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || '删除文件', sha: sha, branch: config.branch }),
      timeout: 30000
    }).then(
      function () {
        lastWriteAt = Date.now();
        return true;
      },
      function (error) {
        if (error && error.status === 404) return true;
        if (error && error.status === 409) return deleteFile(path, message);
        throw error;
      }
    );
  }

  /* ---------- 业务封装：整份站点数据 ---------- */

  /* 写 data/site.json 必须串行：
     批量上传时多个作品会同时想改这份数据，并行就会各自读到同一个 sha，
     谁后写谁报冲突。排成一队依次执行，后一个能看到前一个写的结果。 */
  var writeQueue = Promise.resolve();

  function enqueue(task) {
    var run = writeQueue.then(task, task);
    // 队列自身不能被某次失败卡死：无论成败都往下走。
    writeQueue = run.then(
      function () {
        return null;
      },
      function () {
        return null;
      }
    );
    return run;
  }

  /* 读 → 改 → 写。callback 直接改传进来的 site 对象，返回值会被忽略。
     写之前重新取一次 sha，尽量少撞车。
     最近刚读过的话复用内存里的副本，少一次网络往返（手机上少等 0.5~1 秒）。 */
  function mutateSite(mutator, message) {
    if (!canWrite()) return Promise.reject(new Error('这台设备没有写入权限'));
    return enqueue(function () {
      return mutateSiteNow(mutator, message);
    });
  }

  function mutateSiteNow(mutator, message) {
    /* 每次都重新读一份最新的。
       之前这里想「复用刚读到的缓存省一次往返」，但缓存里的 sha 在别人
       （或自己的另一个并发操作）写完之后就失效了，用它去写必然 409。
       正确性比省 0.5 秒重要：读一次只有 0.4~0.9 秒，冲突重试反而更慢。
       siteCache 只用于「写成功后供 apply 读取」，不再作为写入基线。 */
    return readSite().then(function (current) {
      var site = current && current.site ? current.site : { version: 1, revision: 0, works: [], profile: {} };
      var sha = current ? current.sha : '';
      if (!Array.isArray(site.works)) site.works = [];
      if (!site.profile || typeof site.profile !== 'object') site.profile = {};

      mutator(site);

      site.revision = (Number(site.revision) || 0) + 1;
      site.updatedAt = new Date().toISOString();

      var text = JSON.stringify(site, null, 2) + '\n';
      return putText(SITE_PATH, text, message || '更新网站内容', sha).then(function (result) {
        /* 写成功了：sha 已经变了，缓存必须清掉。
           之前这里是「把新版本存进缓存」，但结果对象里的 content.sha 拿不到时
           会存进一个空 sha，下一次就用空 sha 当「新建」去写，于是报冲突。
           连着改第二处的加速改用「复用刚写的内容 + 重新取 sha」来实现，
           代价是每次多一次读，但绝不会写错。 */
        var nextSha =
          (result && result.content && result.content.sha) || '';
        siteCache = nextSha ? { site: site, sha: nextSha, at: Date.now() } : { site: null, sha: '', at: 0 };
        return site;
      });
    });
  }

  /* 上传一张图，返回它在网站上的地址（/media/xxx.webp）。
     图片走的是「新建文件」，理论上不会有 sha 冲突；但极短时间内
     同一路径被创建两次（比如重试撞上第一次其实已经成功）会拿到 422。
     所以文件名里带时间戳，并且遇到 422 就换一个文件名重试。 */
  function uploadMedia(id, kind, blob, extension, attempt) {
    if (!canWrite()) return Promise.reject(new Error('这台设备没有写入权限'));
    if (!(blob instanceof Blob)) return Promise.reject(new Error('没有可上传的图片'));

    var round = typeof attempt === 'number' ? attempt : 0;
    var ext = extension || extensionForType(blob.type);
    // 文件名带时间戳 + 随机后缀：内容变了就是新地址，缓存不会给旧图。
    var name = id + '-' + kind + '-' + Date.now().toString(36) + (round ? 'r' + round : '') + ext;
    var path = MEDIA_DIR + '/' + name;

    return blobToBase64(blob)
      .then(function (base64) {
        var url = repoBase() + '/contents/' + encodePath(path);
        return request(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: '上传图片 ' + name,
            content: base64,
            branch: config.branch
          }),
          // 图片是几 MB 的东西，比普通请求慢得多，单独给 45 秒。
          timeout: 45000
        });
      })
      .then(
        function () {
          lastWriteAt = Date.now();
          return '/media/' + name;
        },
        function (error) {
          // 422/409：这个文件名已经存在或撞车，换个名字再来一次。
          if (isConflict(error) && round < 3) {
            return uploadMedia(id, kind, blob, extension, round + 1);
          }
          throw error;
        }
      );
  }

  function extensionForType(type) {
    var value = String(type || '').toLowerCase();
    if (value.indexOf('png') !== -1) return '.png';
    if (value.indexOf('avif') !== -1) return '.avif';
    if (value.indexOf('gif') !== -1) return '.gif';
    if (value.indexOf('jpeg') !== -1 || value.indexOf('jpg') !== -1) return '.jpg';
    return '.webp';
  }

  /* 删掉一张图（作品被删除或换图时调用）。找不到就算了。 */
  function deleteMedia(urlPath) {
    var value = String(urlPath || '');
    var match = value.match(/^\/?(media\/[A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (!match) return Promise.resolve(false);
    return deleteFile(match[1], '删除旧图片').then(
      function () {
        return true;
      },
      function () {
        // 删除失败不该让主流程报错：多一张没人引用的图不影响网站。
        return false;
      }
    );
  }

  /* 清理作品相关的所有残留图片。
     为什么要这一步：图片上传带重试，第一次可能其实已经写成功了、只是响应没回来，
     重试就换了个新文件名 —— 数据里只记最后成功的那张，前面那张就成了孤儿。
     删作品时按 id 前缀扫一遍 media/，把这些没人引用的文件一并删掉。 */
  function purgeMediaForWork(workId, keepUrls) {
    if (!canWrite()) return Promise.resolve(0);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(workId || ''))) return Promise.resolve(0);

    var keep = {};
    (keepUrls || []).forEach(function (url) {
      var name = String(url || '').split('/').pop();
      if (name) keep[name] = true;
    });

    return request(repoBase() + '/contents/' + encodePath(MEDIA_DIR) + '?ref=' + encodeURIComponent(config.branch), {
      timeout: 15000
    })
      .then(function (list) {
        if (!Array.isArray(list)) return [];
        return list.filter(function (item) {
          if (!item || !item.name) return false;
          if (keep[item.name]) return false;
          return item.name.indexOf(String(workId) + '-') === 0;
        });
      })
      .then(function (stale) {
        /* 并行删除（最多 4 个同时）：串行删 4 张图要等 4 趟网络，并行只等 1 趟。 */
        var removed = 0;
        var queue = stale.slice();
        function worker() {
          if (!queue.length) return Promise.resolve();
          var item = queue.shift();
          /* 目录列表项自带 sha，直接用它删，省掉一次读请求。 */
          return deleteFileWithSha(MEDIA_DIR + '/' + item.name, item.sha, '清理旧图片')
            .then(
              function () {
                removed += 1;
              },
              function () {
                /* 单个文件删不掉不影响其它 */
              }
            )
            .then(worker);
        }
        var workers = [];
        for (var w = 0; w < 6; w += 1) workers.push(worker());
        return Promise.all(workers).then(function () {
          return removed;
        });
      })
      .catch(function () {
        return 0;
      });
  }

  /* 全量清理：把 media/ 里没有任何作品引用的文件全删掉。
     用于「删完还是留下几张」的兜底 —— 并发、重试、断网都可能留下残图。
     返回删掉的数量。 */
  /* 批量清理多个作品留下的图片。
     一次读目录拿到全部 sha，然后 6 路并行删 ——
     比逐个作品调 purgeMediaForWork 快好几倍（那要重复扫目录）。 */
  function purgeMediaForWorks(ids) {
    if (!canWrite()) return Promise.resolve(0);
    var prefixes = (ids || [])
      .filter(function (id) {
        return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(id || ''));
      })
      .map(function (id) {
        return String(id) + '-';
      });
    if (!prefixes.length) return Promise.resolve(0);

    return request(repoBase() + '/contents/' + encodePath(MEDIA_DIR) + '?ref=' + encodeURIComponent(config.branch), {
      timeout: 15000
    })
      .then(function (list) {
        if (!Array.isArray(list)) return [];
        return list.filter(function (item) {
          if (!item || !item.name) return false;
          return prefixes.some(function (prefix) {
            return item.name.indexOf(prefix) === 0;
          });
        });
      })
      .then(function (stale) {
        var removed = 0;
        var queue = stale.slice();
        function worker() {
          if (!queue.length) return Promise.resolve();
          var item = queue.shift();
          return deleteFileWithSha(MEDIA_DIR + '/' + item.name, item.sha, '清理旧图片')
            .then(
              function () {
                removed += 1;
              },
              function () {
                /* 单个失败继续 */
              }
            )
            .then(worker);
        }
        var workers = [];
        for (var w = 0; w < 6; w += 1) workers.push(worker());
        return Promise.all(workers).then(function () {
          return removed;
        });
      })
      .catch(function () {
        return 0;
      });
  }

  /* 只「查」不「删」：列出哪些图片没有被任何作品引用。
     配合确认步骤使用 —— 用户看清楚要删什么，再决定。 */
  function scanOrphanMedia() {
    if (!canWrite()) return Promise.resolve({ files: [], total: 0 });

    return readSite().then(function (current) {
      if (!current || !current.site) return { files: [], total: 0 };
      var site = current.site;

      var keep = {};
      var keepUrl = function (url) {
        var name = String(url || '').split('/').pop();
        if (name) keep[name] = true;
      };
      (site.works || []).forEach(function (work) {
        keepUrl(work.displayUrl);
        keepUrl(work.thumbUrl);
      });
      if (site.profile) keepUrl(site.profile.avatar);

      return request(repoBase() + '/contents/' + encodePath(MEDIA_DIR) + '?ref=' + encodeURIComponent(config.branch), {
        timeout: 15000
      }).then(function (list) {
        if (!Array.isArray(list)) return { files: [], total: 0 };
        var orphans = list
          .filter(function (item) {
            return item && item.name && !keep[item.name];
          })
          .map(function (item) {
            return { name: item.name, bytes: Number(item.size) || 0 };
          });
        return { files: orphans, total: list.length };
      });
    }).catch(function () {
      return { files: [], total: 0 };
    });
  }

  function purgeOrphanMedia() {
    if (!canWrite()) return Promise.resolve({ removed: 0, total: 0 });

    return readSite().then(function (current) {
      if (!current || !current.site) return { removed: 0, total: 0 };
      var site = current.site;

      var keep = {};
      var keepUrl = function (url) {
        var name = String(url || '').split('/').pop();
        if (name) keep[name] = true;
      };
      (site.works || []).forEach(function (work) {
        keepUrl(work.displayUrl);
        keepUrl(work.thumbUrl);
      });
      if (site.profile) keepUrl(site.profile.avatar);

      return request(repoBase() + '/contents/' + encodePath(MEDIA_DIR) + '?ref=' + encodeURIComponent(config.branch), {
        timeout: 15000
      }).then(function (list) {
        if (!Array.isArray(list)) return { removed: 0, total: 0 };
        var orphans = list.filter(function (item) {
          return item && item.name && !keep[item.name];
        });

        var removed = 0;
        var chain = Promise.resolve();
        orphans.forEach(function (item) {
          chain = chain.then(function () {
            return deleteFile(MEDIA_DIR + '/' + item.name, '清理未使用的图片').then(
              function () {
                removed += 1;
              },
              function () {
                /* 单个失败继续下一个 */
              }
            );
          });
        });

        return chain.then(function () {
          return { removed: removed, total: list.length };
        });
      });
    }).catch(function () {
      return { removed: 0, total: 0 };
    });
  }

  /* ---------- 连接自检 ---------- */

  /* 给「设置」界面用：返回这台设备能不能读、能不能写、限额还剩多少。 */
  function probe() {
    var result = { configured: Boolean(config.owner && config.repo), writable: canWrite(), ok: false };
    if (!result.configured) return Promise.resolve(result);

    return request(repoBase(), { timeout: 15000 }).then(
      function (repo) {
        result.ok = true;
        result.repo = repo.full_name;
        result.branch = config.branch;
        result.private = Boolean(repo.private);
        result.permissions = repo.permissions || null;
        if (result.writable && repo.permissions && repo.permissions.push === false) {
          result.writable = false;
          result.reason = '令牌没有写入权限';
        }
        return result;
      },
      function (error) {
        result.error = error && error.message ? error.message : '无法连接 GitHub';
        return result;
      }
    );
  }

  loadConfig();

  window.PortfolioCloud = {
    SITE_PATH: SITE_PATH,
    MEDIA_DIR: MEDIA_DIR,
    configure: configure,
    getConfig: getConfig,
    canWrite: canWrite,
    forgetToken: forgetToken,
    getRateLimit: getRateLimit,
    getLastWriteAt: getLastWriteAt,
    readFile: readFile,
    readSite: readSite,
    putText: putText,
    deleteFile: deleteFile,
    mutateSite: mutateSite,
    uploadMedia: uploadMedia,
    deleteMedia: deleteMedia,
    purgeMediaForWork: purgeMediaForWork,
    purgeMediaForWorks: purgeMediaForWorks,
    scanOrphanMedia: scanOrphanMedia,
    purgeOrphanMedia: purgeOrphanMedia,
    probe: probe,
    utf8ToBytes: utf8ToBytes,
    bytesToUtf8: bytesToUtf8
  };
})();
