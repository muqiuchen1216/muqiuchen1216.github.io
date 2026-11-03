/* =========================================================
   数据层：网站共享数据 + 浏览器本地数据

   有两种工作方式，页面会自动选择：

   1. 服务器模式（推荐，用「启动网站.cmd」打开的网址）
      资料与作品保存在电脑上的 data/site.json，图片保存在 media/。
      所有设备（手机、平板、别的浏览器）看到的是同一份内容；
      任何一处保存后，服务器会通过 SSE 把改动实时推给所有打开的页面。

   2. 本地模式（直接双击 HTML、或把网站传到静态托管时）
      和以前完全一样：资料在 localStorage，作品在 IndexedDB，
      只存在当前浏览器里。

   页面通过 PortfolioStore.ready / getMode() 得知当前是哪种模式。
   ========================================================= */
(function () {
  'use strict';

  var DATA = window.PORTFOLIO_DATA || {};
  var DEFAULT_PROFILE = Object.assign(
    {
      siteName: 'muqiuchen',
      name: 'muqiuchen',
      englishName: 'MUQIUCHEN',
      role: '摄影师 / 视觉创作者',
      tagline: '把日常，留在光里。',
      bio: '',
      location: '',
      email: '',
      wechat: '',
      qq: '',
      instagram: '',
      douyin: '',
      xiaohongshu: '',
      website: '',
      since: '',
      avatar: ''
    },
    DATA.profile || {}
  );

  var DB_NAME = 'quiet-light-portfolio';
  var DB_VERSION = 1;
  var PROFILE_DB_NAME = 'quiet-light-profile';
  var PROFILE_DB_VERSION = 1;
  var PROFILE_KEY = 'quiet-light.profile.v1';
  var PROFILE_STAMP_KEY = 'quiet-light.profile.updated';
  var MAX_FILE_BYTES = 60 * 1024 * 1024;
  var DISPLAY_EDGE = 2600;
  var THUMB_EDGE = 1400;

  var API_BASE = '/__muqiuchen__/api';
  var JSON_HEADERS = { 'Content-Type': 'application/json' };
  var MEDIA_URL_PATTERN = /^\/media\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  /* 线上（Vercel / GitHub Pages 等纯静态托管）没有服务器接口，改为读取这份公开数据。
     路径是相对的，所以部署在子目录（例如 用户名.github.io/仓库名/）也能用。 */
  var PUBLISHED_FILE = 'data/site.json';
  var READ_ONLY_MESSAGE = '这是线上公开版本，只能浏览。要修改请在本机运行「启动网站.cmd」打开工作室，改完再推送到 GitHub。';

  var dbPromise = null;
  var profileDbPromise = null;
  var channel = null;

  /* ---------- 状态 ---------- */
  var mode = 'local'; // 'local' | 'server' | 'static'
  var siteSnapshot = null;
  var publishedProfile = null;
  var publishedWorks = null;
  var lastRevision = 0;
  var liveState = 'connecting'; // connecting | connected | offline | local | static
  /* 编辑权限：服务器模式下，只有运行网站的那台电脑能改内容。
     checked=false 表示还没问过服务器，此时按「可以编辑」处理，交给具体操作去报错。 */
  var accessState = { canEdit: true, checked: false, unlock: null };
  var subscribers = [];
  var liveSource = null;
  var livePollTimer = 0;
  var readyResolve = null;
  var readyPromise = new Promise(function (resolve) {
    readyResolve = resolve;
  });

  try {
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('quiet-light-portfolio');
      channel.addEventListener('message', function (event) {
        var type = event.data && event.data.type;
        if (type === 'profile' || type === 'works') {
          emit({ type: type, local: true });
        }
      });
    }
  } catch (error) {
    channel = null;
  }

  window.addEventListener('storage', function (event) {
    if (event.key === PROFILE_KEY) emit({ type: 'profile', local: true });
  });

  function notify(type) {
    if (!channel) return;
    try {
      channel.postMessage({ type: type, at: Date.now() });
    } catch (error) {
      /* 通知失败不影响数据本身 */
    }
  }

  /* ---------- 订阅（同一浏览器 + 同一局域网的实时更新） ---------- */

  function emit(change) {
    if (!subscribers.length) return;
    subscribers.slice().forEach(function (handler) {
      try {
        handler(change);
      } catch (error) {
        /* 某个订阅者出错不影响其它订阅者 */
      }
    });
  }

  function subscribe(handler) {
    if (typeof handler !== 'function') return function () {};
    subscribers.push(handler);
    ensureLiveChannel();
    return function () {
      var index = subscribers.indexOf(handler);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  function setLiveState(next) {
    if (liveState === next) return;
    liveState = next;
    emit({ type: 'live', state: next });
  }

  function stopLiveChannel() {
    if (liveSource) {
      try {
        liveSource.close();
      } catch (error) {
        /* noop */
      }
      liveSource = null;
    }
    if (livePollTimer) {
      window.clearInterval(livePollTimer);
      livePollTimer = 0;
    }
  }

  function ensureLiveChannel() {
    if (mode !== 'server') {
      setLiveState('local');
      return;
    }
    if (liveSource || livePollTimer) return;

    if (typeof window.EventSource === 'function') {
      setLiveState('connecting');
      var source = new window.EventSource(API_BASE + '/events');
      liveSource = source;

      source.addEventListener('open', function () {
        setLiveState('connected');
      });
      source.addEventListener('hello', function () {
        setLiveState('connected');
      });
      source.addEventListener('changed', function (event) {
        setLiveState('connected');
        var payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          payload = null;
        }
        var revision = payload && typeof payload.revision === 'number' ? payload.revision : 0;
        // 自己刚写入的那一次改动会以同样的 revision 回传，跳过它，
        // 免得正在编辑的页面被自己的保存打断。
        if (revision && revision <= lastRevision) return;
        if (revision) lastRevision = revision;
        siteSnapshot = null;
        emit({ type: (payload && payload.type) || 'works', revision: revision });
      });
      source.addEventListener('error', function () {
        setLiveState('connecting');
      });
      return;
    }

    // 老浏览器没有 EventSource 时退回轮询。
    livePollTimer = window.setInterval(function () {
      apiRequest('/site', { method: 'GET' }, 8000).then(
        function (payload) {
          setLiveState('connected');
          var revision = typeof payload.revision === 'number' ? payload.revision : 0;
          if (revision <= lastRevision) return;
          adoptSite(payload);
          emit({ type: 'site', revision: revision });
        },
        function () {
          setLiveState('offline');
        }
      );
    }, 5000);
  }

  /* ---------- 服务器接口 ---------- */

  function apiRequest(path, options, timeout) {
    var settings = Object.assign({ cache: 'no-store' }, options || {});
    var controller = null;
    var timer = 0;

    if (typeof window.AbortController === 'function') {
      controller = new window.AbortController();
      settings.signal = controller.signal;
      if (timeout) {
        timer = window.setTimeout(function () {
          try {
            controller.abort();
          } catch (error) {
            /* noop */
          }
        }, timeout);
      }
    }

    return window
      .fetch(API_BASE + path, settings)
      .then(function (response) {
        return response.text().then(function (text) {
          var payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch (error) {
            payload = null;
          }
          if (!response.ok || !payload || payload.ok !== true) {
            var failure = new Error(
              (payload && (payload.message || payload.error)) || '服务端返回 ' + response.status
            );
            failure.status = response.status;
            failure.code = (payload && payload.code) || '';
            failure.payload = payload;
            // 服务器说「这台设备不在允许编辑的范围里」，立刻把界面切成只读。
            if (failure.code === 'locked') setAccess(false, payload.unlock);
            throw failure;
          }
          return payload;
        });
      })
      .then(
        function (payload) {
          if (timer) window.clearTimeout(timer);
          return payload;
        },
        function (error) {
          if (timer) window.clearTimeout(timer);
          if (error && error.offline) throw error;
          if (error && error.name === 'AbortError') {
            var timeoutError = new Error('本地服务器没有响应');
            timeoutError.offline = true;
            throw timeoutError;
          }
          if (error instanceof Error && error.status) throw error;
          var offline = new Error('无法连接本地服务器');
          offline.offline = true;
          throw offline;
        }
      );
  }

  function adoptSite(payload) {
    if (!payload) return;
    siteSnapshot = payload;
    var revision = Number(payload.revision);
    if (Number.isFinite(revision) && revision > lastRevision) lastRevision = revision;
    if (typeof payload.canEdit === 'boolean') setAccess(payload.canEdit, payload.unlock);
  }

  /* ---------- 编辑权限 ---------- */

  function setAccess(canEdit, unlock) {
    var changed = accessState.checked !== true || accessState.canEdit !== canEdit;
    accessState = {
      canEdit: canEdit,
      checked: true,
      unlock: unlock || accessState.unlock || null
    };
    if (changed) emit({ type: 'access', canEdit: canEdit, local: true });
    return accessState;
  }

  function accessSnapshot() {
    if (mode === 'static') return { canEdit: false, checked: true, unlock: null, reason: 'static' };
    if (mode !== 'server') return { canEdit: true, checked: true, unlock: null, reason: 'local' };
    return {
      canEdit: accessState.canEdit,
      checked: accessState.checked,
      unlock: accessState.unlock,
      reason: accessState.canEdit ? 'server' : 'locked'
    };
  }

  function getAccess(force) {
    return readyPromise.then(function () {
      if (mode !== 'server') return accessSnapshot();
      if (accessState.checked && !force) return accessSnapshot();
      return fetchSite().then(accessSnapshot, function (error) {
        // 连不上服务器时不锁界面，交给具体的保存动作报错。
        if (error && error.code !== 'locked' && !error.status) return accessSnapshot();
        return accessSnapshot();
      });
    });
  }

  function remoteWork(work) {
    return Object.assign({}, work, { remote: true });
  }

  /* 线上公开数据：和服务器返回的形状一致，所以首页渲染逻辑可以完全复用。 */
  function relativeMedia(url) {
    if (typeof url !== 'string' || !MEDIA_URL_PATTERN.test(url)) return url;
    // 去掉开头的斜杠，这样部署在子目录（GitHub Pages 项目页）时也能找到图片。
    return url.slice(1);
  }

  function adoptPublished(payload) {
    if (!payload || typeof payload !== 'object') return false;
    var works = Array.isArray(payload.works) ? payload.works : [];
    if (!payload.profile && !works.length) return false;
    publishedProfile = sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, payload.profile || {}));
    publishedProfile.avatar = relativeMedia(publishedProfile.avatar);
    publishedWorks = works.map(function (work) {
      var mapped = remoteWork(work);
      mapped.displayUrl = relativeMedia(mapped.displayUrl);
      mapped.thumbUrl = relativeMedia(mapped.thumbUrl);
      return mapped;
    });
    var revision = Number(payload.revision);
    if (Number.isFinite(revision) && revision > lastRevision) lastRevision = revision;
    cacheProfileLocally(publishedProfile, Date.now());
    return true;
  }

  function fetchPublished() {
    if (typeof window.fetch !== 'function') return Promise.resolve(false);
    /* 带一个时间戳：GitHub Pages 这类托管会给所有文件加 10 分钟缓存，
       不加的话刚传上去的新作品手机上要等一会儿才看得见。
       Vercel 那边不受影响（该文件本来就是不缓存的）。 */
    var url = PUBLISHED_FILE + '?v=' + Date.now();
    return window
      .fetch(url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) return false;
        return response.json().then(
          function (payload) {
            return adoptPublished(payload);
          },
          function () {
            return false;
          }
        );
      })
      .catch(function () {
        return false;
      });
  }

  function detectMode() {
    if (typeof window.fetch !== 'function' || !/^https?:$/.test(window.location.protocol)) {
      return Promise.resolve('local');
    }
    return apiRequest('/site', { method: 'GET' }, 4000).then(
      function (payload) {
        adoptSite(payload);
        return 'server';
      },
      function () {
        return fetchPublished().then(function (found) {
          return found ? 'static' : 'local';
        });
      }
    );
  }

  function fetchSite() {
    return apiRequest('/site', { method: 'GET' }, 10000).then(function (payload) {
      adoptSite(payload);
      return payload;
    });
  }

  function fetchWorks() {
    return fetchSite().then(function (payload) {
      var works = Array.isArray(payload.works) ? payload.works : [];
      return works.map(remoteWork);
    });
  }

  function uploadAsset(id, kind, blob, fallbackType) {
    if (!(blob instanceof Blob)) return Promise.resolve('');
    var type = blob.type || fallbackType || 'application/octet-stream';
    return apiRequest(
      '/media/' + encodeURIComponent(id) + '/' + kind,
      { method: 'POST', headers: { 'Content-Type': type }, body: blob },
      60000
    ).then(function (payload) {
      return payload.url || '';
    });
  }

  function addWorkRemote(record) {
    var source = record || {};
    var id = source.id || randomId();
    var payload = Object.assign({}, source, { id: id });
    var displayBlob = payload.displayBlob instanceof Blob ? payload.displayBlob : null;
    var thumbBlob = payload.thumbBlob instanceof Blob ? payload.thumbBlob : null;
    var displayType = payload.displayType;
    var thumbType = payload.thumbType;

    delete payload.displayBlob;
    delete payload.thumbBlob;
    delete payload.displayType;
    delete payload.thumbType;
    delete payload.remote;

    return uploadAsset(id, 'display', displayBlob, displayType)
      .then(function (displayUrl) {
        payload.displayUrl = displayUrl;
        if (thumbBlob && thumbBlob !== displayBlob) {
          return uploadAsset(id, 'thumb', thumbBlob, thumbType);
        }
        return displayUrl;
      })
      .then(function (thumbUrl) {
        payload.thumbUrl = thumbUrl || payload.displayUrl || '';
        return apiRequest(
          '/works',
          { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ work: payload }) },
          20000
        );
      })
      .then(function (data) {
        if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
        siteSnapshot = null;
        return remoteWork(data.work);
      });
  }

  function updateWorkRemote(id, patch) {
    return apiRequest(
      '/works/' + encodeURIComponent(id),
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ patch: patch || {} }) },
      20000
    ).then(function (data) {
      if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
      siteSnapshot = null;
      return remoteWork(data.work);
    });
  }

  function deleteWorkRemote(id) {
    return apiRequest('/works/' + encodeURIComponent(id), { method: 'DELETE' }, 20000).then(
      function (data) {
        if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
        siteSnapshot = null;
        return true;
      }
    );
  }

  function reorderWorksRemote(ids) {
    return apiRequest(
      '/works/order',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: ids || [] }) },
      20000
    ).then(function (data) {
      if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
      siteSnapshot = null;
      return true;
    });
  }

  function dataUrlToBlob(dataUrl) {
    try {
      var parts = String(dataUrl).split(',');
      if (parts.length !== 2) return null;
      var meta = parts[0].match(/^data:([^;]+);base64$/i);
      if (!meta) return null;
      var binary = window.atob(parts[1]);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: meta[1] });
    } catch (error) {
      return null;
    }
  }

  function saveProfileRemote(clean, updatedAt) {
    // 旧版存下来的头像是 base64 data URL；第一次保存时顺手转成 media 文件，
    // 之后的数据文件里就只剩一个短地址了。
    var avatarBlob = /^data:image\//i.test(clean.avatar) ? dataUrlToBlob(clean.avatar) : null;
    var prepared = avatarBlob
      ? uploadAvatarRemote(avatarBlob).then(
          function (saved) {
            return saved.avatar || '';
          },
          function () {
            return clean.avatar;
          }
        )
      : Promise.resolve(clean.avatar);

    return prepared.then(function (avatar) {
      var payload = Object.assign({}, clean, { avatar: avatar || '' });
      return apiRequest(
        '/profile',
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ profile: payload }) },
        20000
      ).then(function (data) {
        if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
        siteSnapshot = null;
        var saved = sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, data.profile || {}));
        cacheProfileLocally(saved, updatedAt);
        return saved;
      });
    });
  }

  function uploadAvatarRemote(blob) {
    if (!(blob instanceof Blob)) return Promise.reject(new Error('没有可上传的头像文件'));
    return apiRequest(
      '/profile/avatar',
      { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob },
      40000
    ).then(function (data) {
      if (data && typeof data.revision === 'number') lastRevision = Math.max(lastRevision, data.revision);
      siteSnapshot = null;
      var saved = sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, data.profile || {}));
      cacheProfileLocally(saved, Date.now());
      return saved;
    });
  }

  function cacheProfileLocally(profile, updatedAt) {
    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      window.localStorage.setItem(PROFILE_STAMP_KEY, String(Number(updatedAt) || Date.now()));
    } catch (error) {
      /* 本地缓存写不进去也不影响服务器上的数据 */
    }
  }

  /* ---------- IndexedDB：作品 ---------- */

  function openDatabase() {
    if (!('indexedDB' in window) || !window.indexedDB) {
      return Promise.reject(new Error('当前浏览器不支持本地作品存储'));
    }

    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(new Error('无法打开本地作品存储'));
        return;
      }

      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains('works')) {
          var store = database.createObjectStore('works', { keyPath: 'id' });
          store.createIndex('order', 'order', { unique: false });
        }
      };

      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () {
          try {
            database.close();
          } catch (error) {
            /* noop */
          }
          dbPromise = null;
        };
        resolve(database);
      };

      request.onerror = function () {
        dbPromise = null;
        reject(request.error || new Error('无法打开本地作品存储'));
      };

      request.onblocked = function () {
        dbPromise = null;
        reject(new Error('本地作品存储被其他页面占用，请关闭其他页面后重试'));
      };
    });

    return dbPromise;
  }

  function sortWorks(works) {
    return works.slice().sort(function (a, b) {
      var orderA = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      var orderB = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  function openProfileDatabase() {
    if (!('indexedDB' in window) || !window.indexedDB) {
      return Promise.reject(new Error('当前浏览器不支持本地资料存储'));
    }

    if (profileDbPromise) return profileDbPromise;

    profileDbPromise = new Promise(function (resolve, reject) {
      var request;
      try {
        request = window.indexedDB.open(PROFILE_DB_NAME, PROFILE_DB_VERSION);
      } catch (error) {
        reject(new Error('无法打开本地资料存储'));
        return;
      }

      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () {
          try {
            database.close();
          } catch (error) {
            /* noop */
          }
          profileDbPromise = null;
        };
        resolve(database);
      };

      request.onerror = function () {
        profileDbPromise = null;
        reject(request.error || new Error('无法打开本地资料存储'));
      };

      request.onblocked = function () {
        profileDbPromise = null;
        reject(new Error('本地资料存储被其他页面占用'));
      };
    });

    return profileDbPromise;
  }

  function readProfileFromDb() {
    return openProfileDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('settings', 'readonly');
        var request = transaction.objectStore('settings').get('profile');
        request.onsuccess = function () {
          resolve(request.result || null);
        };
        request.onerror = function () {
          reject(request.error || new Error('读取资料失败'));
        };
      });
    });
  }

  function writeProfileToDb(profile, updatedAt) {
    return openProfileDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('settings', 'readwrite');
        transaction.objectStore('settings').put({
          key: 'profile',
          value: profile,
          updatedAt: updatedAt
        });
        transaction.oncomplete = function () {
          resolve(true);
        };
        transaction.onerror = function () {
          reject(transaction.error || new Error('保存资料失败'));
        };
        transaction.onabort = function () {
          reject(transaction.error || new Error('保存资料被中断'));
        };
      });
    });
  }

  function getAllWorksFromDb() {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('works', 'readonly');
        var request = transaction.objectStore('works').getAll();

        request.onsuccess = function () {
          var result = Array.isArray(request.result) ? request.result : [];
          resolve(sortWorks(result));
        };

        request.onerror = function () {
          reject(request.error || new Error('读取作品失败'));
        };

        transaction.onabort = function () {
          reject(transaction.error || new Error('读取作品被中断'));
        };
      });
    });
  }

  function getAllWorksLocal() {
    // 本地数据库在极少数被其它页面锁住的情况下可能迟迟不返回，
    // 超时后让界面显示示例作品或明确错误，而不是一直停在加载中。
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('读取作品超时'));
      }, 3000);

      getAllWorksFromDb().then(
        function (works) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(works);
        },
        function (error) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function addWorkLocal(record) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('works', 'readwrite');
        var store = transaction.objectStore('works');
        store.put(record);

        transaction.oncomplete = function () {
          notify('works');
          resolve(record);
        };
        transaction.onerror = function () {
          reject(transaction.error || new Error('保存作品失败'));
        };
        transaction.onabort = function () {
          reject(transaction.error || new Error('保存作品被中断'));
        };
      });
    });
  }

  function updateWorkLocal(id, patch) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('works', 'readwrite');
        var store = transaction.objectStore('works');
        var updated = null;
        var cancelled = false;
        var request = store.get(id);

        request.onsuccess = function () {
          var current = request.result;
          if (!current) {
            cancelled = true;
            transaction.abort();
            reject(new Error('这件作品已不存在'));
            return;
          }
          updated = Object.assign({}, current, patch, { id: id });
          store.put(updated);
        };

        request.onerror = function () {
          reject(request.error || new Error('读取作品失败'));
        };

        transaction.oncomplete = function () {
          if (cancelled || !updated) return;
          notify('works');
          resolve(updated);
        };
        transaction.onerror = function () {
          reject(transaction.error || new Error('更新作品失败'));
        };
        transaction.onabort = function () {
          if (!cancelled) reject(transaction.error || new Error('更新作品被中断'));
        };
      });
    });
  }

  function deleteWorkLocal(id) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('works', 'readwrite');
        transaction.objectStore('works').delete(id);

        transaction.oncomplete = function () {
          notify('works');
          resolve(true);
        };
        transaction.onerror = function () {
          reject(transaction.error || new Error('删除作品失败'));
        };
        transaction.onabort = function () {
          reject(transaction.error || new Error('删除作品被中断'));
        };
      });
    });
  }

  function reorderWorksLocal(ids) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction('works', 'readwrite');
        var store = transaction.objectStore('works');
        var positions = new Map();
        ids.forEach(function (id, index) {
          positions.set(id, index);
        });

        var request = store.getAll();
        request.onsuccess = function () {
          var all = request.result || [];
          all.forEach(function (work) {
            if (!positions.has(work.id)) return;
            var next = Object.assign({}, work, { order: positions.get(work.id) });
            store.put(next);
          });
        };
        request.onerror = function () {
          reject(request.error || new Error('读取作品顺序失败'));
        };

        transaction.oncomplete = function () {
          notify('works');
          resolve(true);
        };
        transaction.onerror = function () {
          reject(transaction.error || new Error('保存排序失败'));
        };
        transaction.onabort = function () {
          reject(transaction.error || new Error('保存排序被中断'));
        };
      });
    });
  }

  /* ---------- 资料 ---------- */

  function isAvatarValue(value) {
    if (typeof value !== 'string' || !value) return false;
    return /^data:image\/(jpeg|png|webp);base64,/i.test(value) || MEDIA_URL_PATTERN.test(value);
  }

  function sanitizeProfile(input) {
    var source = input && typeof input === 'object' ? input : {};
    var result = {};
    var stringFields = [
      'siteName',
      'name',
      'englishName',
      'role',
      'tagline',
      'bio',
      'location',
      'email',
      'wechat',
      'qq',
      'instagram',
      'douyin',
      'xiaohongshu',
      'website',
      'since'
    ];

    stringFields.forEach(function (key) {
      result[key] = typeof source[key] === 'string' ? source[key].trim().slice(0, 3000) : '';
    });

    result.siteName = result.siteName || 'muqiuchen';
    result.name = result.name || '未命名摄影师';
    result.englishName = result.englishName || '';
    result.avatar = isAvatarValue(source.avatar) ? source.avatar : '';

    return result;
  }

  function getProfile() {
    var stored = null;
    try {
      var raw = window.localStorage.getItem(PROFILE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (error) {
      stored = null;
    }

    // 从旧版默认资料迁移到 muqiuchen 品牌，不覆盖用户自己改过的其他字段。
    if (stored && typeof stored === 'object' && !stored.siteName) {
      if (stored.name === '林深') stored.name = 'muqiuchen';
      if (stored.englishName === 'LIN SHEN') stored.englishName = 'MUQIUCHEN';
      if (stored.email === 'hello@linshen.photo') stored.email = 'hello@muqiuchen.com';
      if (stored.instagram === 'linshen.photo') stored.instagram = '';
    }

    if (!stored || typeof stored !== 'object') {
      return sanitizeProfile(DEFAULT_PROFILE);
    }

    return sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, stored));
  }

  function getLocalProfileStamp() {
    try {
      return Number(window.localStorage.getItem(PROFILE_STAMP_KEY)) || 0;
    } catch (error) {
      return 0;
    }
  }

  function getProfileAsyncLocal() {
    var local = getProfile();
    return Promise.race([
      readProfileFromDb(),
      new Promise(function (resolve, reject) {
        window.setTimeout(function () {
          reject(new Error('读取资料超时'));
        }, 2500);
      })
    ]).then(
      function (record) {
        if (!record || !record.value) return local;
        var dbStamp = Number(record.updatedAt) || 0;
        if (dbStamp <= getLocalProfileStamp()) return local;
        return sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, record.value));
      },
      function () {
        return local;
      }
    );
  }

  function saveProfileLocal(clean) {
    var updatedAt = Date.now();
    var localError = null;
    var dbError = null;

    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(clean));
      window.localStorage.setItem(PROFILE_STAMP_KEY, String(updatedAt));
    } catch (error) {
      localError = error;
    }

    return Promise.race([
      writeProfileToDb(clean, updatedAt),
      new Promise(function (resolve, reject) {
        window.setTimeout(function () {
          reject(new Error('保存资料超时'));
        }, 3000);
      })
    ]).then(
      function () {
        return null;
      },
      function (error) {
        dbError = error;
        return null;
      }
    ).then(function () {
      if (localError && dbError) {
        throw new Error(
          localError.name === 'QuotaExceededError'
            ? '本地存储空间不足，头像可能过大'
            : '浏览器无法保存个人资料'
        );
      }
      notify('profile');
      return clean;
    });
  }

  /* ---------- 图片处理 ---------- */

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'w-' + window.crypto.randomUUID();
    }
    return 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function titleFromFilename(filename) {
    if (!filename) return '未命名作品';
    var name = String(filename)
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s*-\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return name || '未命名作品';
  }

  function gcd(a, b) {
    var x = Math.abs(Math.round(a));
    var y = Math.abs(Math.round(b));
    while (y) {
      var temp = y;
      y = x % y;
      x = temp;
    }
    return x || 1;
  }

  var KNOWN_RATIOS = [
    [1, '1 : 1'],
    [4 / 5, '4 : 5'],
    [5 / 4, '5 : 4'],
    [3 / 4, '3 : 4'],
    [4 / 3, '4 : 3'],
    [2 / 3, '2 : 3'],
    [3 / 2, '3 : 2'],
    [16 / 9, '16 : 9'],
    [9 / 16, '9 : 16'],
    [5 / 3, '5 : 3'],
    [3 / 5, '3 : 5'],
    [7 / 5, '7 : 5'],
    [5 / 7, '5 : 7'],
    [2, '2 : 1'],
    [3, '3 : 1'],
    [1.85, '1.85 : 1'],
    [2.35, '2.35 : 1'],
    [2.39, '2.39 : 1'],
    [21 / 9, '21 : 9'],
    [9 / 21, '9 : 21']
  ];

  function formatRatio(width, height) {
    var w = Number(width);
    var h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return '';
    }

    var ratio = w / h;
    var best = null;
    var bestDifference = Infinity;

    KNOWN_RATIOS.forEach(function (entry) {
      var difference = Math.abs(ratio - entry[0]) / entry[0];
      if (difference < bestDifference) {
        bestDifference = difference;
        best = entry[1];
      }
    });

    if (best && bestDifference <= 0.012) return best;

    var divisor = gcd(w, h);
    var rw = Math.round(w / divisor);
    var rh = Math.round(h / divisor);
    if (rw <= 60 && rh <= 60) {
      return rw + ' : ' + rh;
    }

    var value = Math.round(ratio * 100) / 100;
    return String(value).replace(/\.0+$/, '') + ' : 1';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (error) {
        reject(new Error('无法读取这个文件'));
        return;
      }

      var image = new Image();
      var settled = false;

      function fail() {
        if (settled) return;
        settled = true;
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          /* noop */
        }
        reject(new Error('图片无法解码，请换一张 JPG、PNG、WebP 或 AVIF'));
      }

      image.onload = function () {
        if (settled) return;
        settled = true;
        if (!image.naturalWidth || !image.naturalHeight) {
          try {
            URL.revokeObjectURL(url);
          } catch (error) {
            /* noop */
          }
          reject(new Error('图片尺寸无效'));
          return;
        }
        resolve({
          image: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          release: function () {
            try {
              URL.revokeObjectURL(url);
            } catch (error) {
              /* noop */
            }
            image.onload = null;
            image.onerror = null;
            image.src = '';
          }
        });
      };

      image.onerror = fail;
      image.decoding = 'async';
      image.src = url;

      // 极少数浏览器不会触发 onload / onerror，设置兜底计时避免上传永远卡住。
      window.setTimeout(function () {
        if (!settled) fail();
      }, 30000);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('图片处理超时'));
      }, 20000);

      function finish(blob) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (blob) resolve(blob);
        else reject(new Error('无法生成图片预览'));
      }

      try {
        canvas.toBlob(finish, type, quality);
      } catch (error) {
        done = true;
        window.clearTimeout(timer);
        reject(new Error('当前浏览器无法处理这张图片'));
      }
    });
  }

  async function encodeCanvas(canvas, quality) {
    var blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') {
      blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }
    return blob;
  }

  /* 把任意图源（<img> / canvas / ImageBitmap）按最长边缩到画布上。
     单独拆出来是为了让缩略图能直接基于已经缩好的显示图再缩一次。 */
  function drawToCanvas(source, width, height, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(width, height));
    var targetWidth = Math.max(1, Math.round(width * scale));
    var targetHeight = Math.max(1, Math.round(height * scale));
    var canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    var context = canvas.getContext('2d');
    if (!context) {
      canvas.width = 1;
      canvas.height = 1;
      throw new Error('当前浏览器无法创建图片画布');
    }

    // 透明区域使用纸张色，避免 PNG 转 JPEG 后出现黑底。
    context.fillStyle = '#f3f0e9';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, targetWidth, targetHeight);

    return canvas;
  }

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
  }

  function resizeImage(source, width, height, maxEdge, quality) {
    var canvas = drawToCanvas(source, width, height, maxEdge);
    return encodeCanvas(canvas, quality).then(
      function (blob) {
        releaseCanvas(canvas);
        return blob;
      },
      function (error) {
        releaseCanvas(canvas);
        throw error;
      }
    );
  }

  async function createDerivatives(file) {
    if (!file || typeof file.size !== 'number') {
      throw new Error('没有选择有效的图片文件');
    }

    var type = (file.type || '').toLowerCase();
    if (type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(file.name || '')) {
      throw new Error('HEIC 格式无法在浏览器中处理，请先在手机设置中导出为 JPG，或上传 JPG / PNG');
    }
    if (type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) {
      throw new Error('为了保证安全与清晰度，请上传 JPG、PNG、WebP 或 AVIF 图片');
    }
    if (type && type.indexOf('image/') !== 0) {
      throw new Error('这不是图片文件');
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('单张图片超过 60MB，请压缩后再上传');
    }

    var decoded;
    try {
      decoded = await loadImageElement(file);
    } catch (error) {
      throw error;
    }

    var width = decoded.width;
    var height = decoded.height;
    var displayBlob;
    var thumbBlob;

    var displayCanvas = null;
    try {
      // 缩略图直接基于已缩好的显示图再缩一次：从原始大图（常见 24MP）
      // 再重采样一遍既慢、画质也没有收益，而上传时的卡顿主要来自这里。
      displayCanvas = drawToCanvas(decoded.image, width, height, DISPLAY_EDGE);
      displayBlob = await encodeCanvas(displayCanvas, 0.9);
      thumbBlob = await resizeImage(displayCanvas, displayCanvas.width, displayCanvas.height, THUMB_EDGE, 0.82);
      releaseCanvas(displayCanvas);
      displayCanvas = null;
    } catch (error) {
      releaseCanvas(displayCanvas);
      // 如果画布编码失败（例如旧版浏览器的编码器异常），保留原文件作为兜底，
      // 仍然可以显示，不会出现空白作品。
      if (file.size <= 20 * 1024 * 1024 && (!type || type.indexOf('image/') === 0)) {
        displayBlob = file;
        thumbBlob = file;
      } else {
        decoded.release();
        throw new Error('这张图片暂时无法处理，请尝试改为 JPG 或尺寸更小的版本');
      }
    }

    decoded.release();

    return {
      width: width,
      height: height,
      displayBlob: displayBlob,
      thumbBlob: thumbBlob,
      displayType: displayBlob.type || type || 'image/jpeg',
      thumbType: thumbBlob.type || type || 'image/jpeg'
    };
  }

  /* ---------- 社交链接 ---------- */

  function normalizeWebsite(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
      try {
        var url = new URL(raw);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      } catch (error) {
        return '';
      }
      return '';
    }
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/.*)?$/i.test(raw)) {
      return 'https://' + raw;
    }
    return '';
  }

  function normalizeInstagram(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    raw = raw.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '');
    raw = raw.replace(/^@/, '').replace(/\/+$/, '').split(/[/?#]/)[0];
    return raw.replace(/[^a-z0-9._]/gi, '').slice(0, 60);
  }

  function parseSocial(value, platform) {
    var raw = String(value || '').trim();
    if (!raw) return { handle: '', href: '', isUrl: false };

    if (/^(www\.|v\.)?(douyin|xhslink|xiaohongshu)\.com\//i.test(raw)) {
      raw = 'https://' + raw;
    }

    if (/^https?:\/\//i.test(raw)) {
      try {
        var url = new URL(raw);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return { handle: '', href: url.href, isUrl: true };
        }
      } catch (error) {
        return { handle: '', href: '', isUrl: false };
      }
      return { handle: '', href: '', isUrl: false };
    }

    var handle = raw
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?(douyin|xhslink|xiaohongshu)\.com\//i, '')
      .replace(/\/+$/, '')
      .split(/[/?#]/)[0]
      .replace(/[^\w.\-\u4e00-\u9fa5]/g, '')
      .slice(0, 60);

    if (!handle) return { handle: '', href: '', isUrl: false };

    var href =
      platform === 'douyin'
        ? 'https://www.douyin.com/search/' + encodeURIComponent(handle)
        : 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(handle);

    return { handle: handle, href: href, isUrl: false };
  }

  function estimateStorage() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      return Promise.resolve(null);
    }
    return navigator.storage
      .estimate()
      .then(function (estimate) {
        return {
          usage: Number(estimate.usage) || 0,
          quota: Number(estimate.quota) || 0
        };
      })
      .catch(function () {
        return null;
      });
  }

  function requestPersistence() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      return Promise.resolve(false);
    }
    return navigator.storage.persist().catch(function () {
      return false;
    });
  }

  /* ---------- 统一的对外接口（按模式自动分流） ---------- */

  /* 线上公开版本（纯静态托管）只读，写操作统一给出中文提示。 */
  function readOnly() {
    return Promise.reject(new Error(READ_ONLY_MESSAGE));
  }

  function isReadOnly() {
    return mode === 'static';
  }

  function getAllWorks() {
    return readyPromise.then(function () {
      if (mode === 'server') return fetchWorks();
      if (mode === 'static') return publishedWorks ? publishedWorks.slice() : [];
      return getAllWorksLocal();
    });
  }

  function addWork(record) {
    return readyPromise.then(function () {
      if (mode === 'server') return addWorkRemote(record);
      if (mode === 'static') throw new Error(READ_ONLY_MESSAGE);
      return addWorkLocal(record);
    });
  }

  function updateWork(id, patch) {
    return readyPromise.then(function () {
      if (mode === 'server') return updateWorkRemote(id, patch);
      if (mode === 'static') throw new Error(READ_ONLY_MESSAGE);
      return updateWorkLocal(id, patch);
    });
  }

  function deleteWork(id) {
    return readyPromise.then(function () {
      if (mode === 'server') return deleteWorkRemote(id);
      if (mode === 'static') throw new Error(READ_ONLY_MESSAGE);
      return deleteWorkLocal(id);
    });
  }

  function reorderWorks(ids) {
    return readyPromise.then(function () {
      if (mode === 'server') return reorderWorksRemote(ids);
      if (mode === 'static') throw new Error(READ_ONLY_MESSAGE);
      return reorderWorksLocal(ids);
    });
  }

  function getProfileAsync() {
    return readyPromise.then(function () {
      if (mode === 'static') return publishedProfile || getProfile();
      if (mode !== 'server') return getProfileAsyncLocal();
      return fetchSite().then(
        function (payload) {
          var merged = sanitizeProfile(Object.assign({}, DEFAULT_PROFILE, payload.profile || {}));
          cacheProfileLocally(merged, Date.now());
          return merged;
        },
        function () {
          return getProfile();
        }
      );
    });
  }

  function saveProfile(profile) {
    var clean = sanitizeProfile(profile);
    return readyPromise.then(function () {
      if (mode === 'static') throw new Error(READ_ONLY_MESSAGE);
      if (mode === 'server') return saveProfileRemote(clean, Date.now());
      return saveProfileLocal(clean);
    });
  }

  /* 服务器模式下把头像单独上传成 media 文件，避免把 base64 塞进数据文件。
     本地模式返回空字符串，由工作室自己转成 data URL。 */
  function uploadAvatar(blob) {
    return readyPromise.then(function () {
      if (mode !== 'server') return '';
      return uploadAvatarRemote(blob);
    });
  }

  /* ---------- 本地 → 服务器 的迁移 ---------- */

  function localWorksWithImages() {
    return getAllWorksLocal().then(
      function (works) {
        return works.filter(function (work) {
          return work && work.displayBlob instanceof Blob;
        });
      },
      function () {
        return [];
      }
    );
  }

  function pendingLocalWorks(serverIds) {
    var known = serverIds instanceof Set ? serverIds : new Set(serverIds || []);
    return localWorksWithImages().then(function (works) {
      return works.filter(function (work) {
        return !known.has(work.id);
      });
    });
  }

  function migrateLocalToServer(onProgress) {
    return readyPromise.then(function () {
      if (mode !== 'server') {
        throw new Error('当前是本地模式，没有可同步的网站服务器');
      }
      // 先拿服务器上已有的 id，已经在网站上的作品不再重复上传。
      return fetchSite()
        .then(function (payload) {
          var known = (Array.isArray(payload.works) ? payload.works : []).map(function (work) {
            return work.id;
          });
          return pendingLocalWorks(known);
        })
        .then(function (works) {
          if (!works.length) return { total: 0, migrated: 0 };
          var migrated = 0;
          var order = 0;
          var chain = Promise.resolve();
          works.forEach(function (work) {
            chain = chain.then(function () {
              var record = Object.assign({}, work, { order: order });
              order += 1;
              return addWorkRemote(record).then(function () {
                migrated += 1;
                if (typeof onProgress === 'function') onProgress(migrated, works.length, work);
              });
            });
          });
          return chain.then(function () {
            emit({ type: 'works', revision: lastRevision });
            return { total: works.length, migrated: migrated };
          });
        });
    });
  }

  function getMode() {
    return mode;
  }

  function getLiveState() {
    return liveState;
  }

  function getRevision() {
    return lastRevision;
  }

  function getSnapshot() {
    return siteSnapshot;
  }

  /* ---------- 启动：自动判断当前是哪种模式 ---------- */

  detectMode().then(function (result) {
    mode = result;
    readyResolve({ mode: mode });
    if (mode === 'server') ensureLiveChannel();
    else if (mode === 'static') setLiveState('static');
    else setLiveState('local');
  });

  window.PortfolioStore = {
    defaultProfile: DEFAULT_PROFILE,
    ready: readyPromise,
    getMode: getMode,
    isReadOnly: isReadOnly,
    readOnlyMessage: READ_ONLY_MESSAGE,
    getLiveState: getLiveState,
    getRevision: getRevision,
    getSnapshot: getSnapshot,
    getAccess: getAccess,
    accessSnapshot: accessSnapshot,
    subscribe: subscribe,
    getAllWorks: getAllWorks,
    addWork: addWork,
    updateWork: updateWork,
    deleteWork: deleteWork,
    reorderWorks: reorderWorks,
    getProfile: getProfile,
    getProfileAsync: getProfileAsync,
    saveProfile: saveProfile,
    uploadAvatar: uploadAvatar,
    pendingLocalWorks: pendingLocalWorks,
    migrateLocalToServer: migrateLocalToServer,
    createDerivatives: createDerivatives,
    titleFromFilename: titleFromFilename,
    formatRatio: formatRatio,
    randomId: randomId,
    normalizeWebsite: normalizeWebsite,
    normalizeInstagram: normalizeInstagram,
    parseSocial: parseSocial,
    estimateStorage: estimateStorage,
    requestPersistence: requestPersistence,
    clamp: clamp,
    stopLiveChannel: stopLiveChannel
  };
})();
