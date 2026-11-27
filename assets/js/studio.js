/* =========================================================
   工作室交互：资料、作品上传、编辑、排序与删除
   ========================================================= */
(function () {
  'use strict';

  var Store = window.PortfolioStore;
  var DATA = window.PORTFOLIO_DATA || { profile: {} };

  var state = {
    profile: null,
    works: [],
    picked: [],  // 批量操作选中的作品 id
    thumbUrls: new Map(),
    ready: false,
    busy: false,
    ordering: false,
    deleting: false,
    profileDirty: false,
    avatarDraft: '',
    rendered: false,
    freshIds: [],
    /* 表单每次输入都会 +1：自动保存完成后只有 stamp 没变才回填表单，
       避免把用户正在敲的字覆盖掉。 */
    editStamp: 0,
    profileSaving: false,
    profileQueued: false,
    /* 编辑权限：false 表示这台设备只能看（服务器判定非本机）。 */
    canEdit: true,
    accessReason: 'local',
    /* 数据层还没判断出是本地模式还是服务器模式时为 false，
       这期间不要显示任何「本地模式 / 可以同步」的提示，免得闪一下错的。 */
    modeReady: false
  };

  var reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var els = {};
  var toastTimer = 0;
  var saveIndicatorTimer = 0;
  var profileSaveTimer = 0;
  /* 自己发起写入的时间窗：窗内不响应服务器推回来的改动。 */
  var selfWriteUntil = 0;

  /* 尚未落库的自动保存，key 是那个输入元素。
     以前只有一个全局 workDirty 布尔量，任意一个字段保存成功就会把它清掉，
     别的字段挂起的输入便不再触发离开提示；定时器也挂在元素上，
     列表重建（排序/删除/上传）时不会被清理，闭包里已经脱离 DOM 的
     输入框还会在 800ms 后把过期文本写回数据库。 */
  var pendingSaves = new Map();

  function forgetPendingSave(input) {
    window.clearTimeout(input._saveTimer);
    input._saveTimer = 0;
    pendingSaves.delete(input);
  }

  /* 重建列表之前调用：把挂起中的编辑先同步进内存态并落库，
     这样重建出来的就是用户刚敲的值，也不会再有迟到的写入。 */
  function flushPendingSaves() {
    if (!pendingSaves.size) return;
    var entries = Array.from(pendingSaves.entries());
    pendingSaves.clear();
    entries.forEach(function (pair) {
      var input = pair[0];
      var entry = pair[1];
      window.clearTimeout(input._saveTimer);
      input._saveTimer = 0;
      var field = input.getAttribute('data-field');
      var current = state.works.find(function (item) {
        return item.id === entry.id;
      });
      if (field && current) current[field] = input.value.trim();
      saveWorkField(entry.card, entry.id, input, entry.status);
    });
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showToast(message, isError) {
    if (!els.toast) return;
    window.clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', Boolean(isError));
    els.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(function () {
      els.toast.classList.remove('is-visible');
    }, isError ? 5600 : 3200);
  }

  function showSaveIndicator(message, isError) {
    if (!els.saveIndicator) return;
    window.clearTimeout(saveIndicatorTimer);
    els.saveIndicator.textContent = message;
    els.saveIndicator.classList.toggle('is-error', Boolean(isError));
    els.saveIndicator.classList.toggle('is-success', !isError);
    els.saveIndicator.classList.remove('is-pulse');
    if (!isError) {
      // 重新触发一次脉冲，让每次保存都有反馈。
      void els.saveIndicator.offsetWidth;
      els.saveIndicator.classList.add('is-pulse');
      saveIndicatorTimer = window.setTimeout(function () {
        els.saveIndicator.textContent = '';
        els.saveIndicator.classList.remove('is-success', 'is-pulse');
      }, 3200);
    }
  }

  function markDirty() {
    state.profileDirty = true;
    state.editStamp += 1;
    window.clearTimeout(saveIndicatorTimer);
    if (els.saveIndicator) {
      els.saveIndicator.textContent = '正在编辑…';
      els.saveIndicator.classList.remove('is-success', 'is-error', 'is-pulse');
    }
    if (els.profileStatus) {
      els.profileStatus.textContent = '有未保存的修改';
      els.profileStatus.classList.remove('is-error');
    }
  }

  /* 把数据里的图片地址转成浏览器能直接用的地址。
     数据里存的是 `media/x.webp`（相对站点根，兼容用户名.github.io 这类子目录部署），
     但 studio.html 在根目录，相对路径会解析错。这里统一补成站点根相对路径。 */
  function mediaSrc(url) {
    var value = String(url || '');
    if (!value) return '';
    if (/^(data:|blob:|https?:)/i.test(value)) return value;
    if (value.charAt(0) === '/') return value;
    return '/' + value.replace(/^\.\//, '');
  }

  function isServerMode() {
    return Boolean(Store && typeof Store.getMode === 'function' && Store.getMode() === 'server');
  }

  /* 云端模式：连着 GitHub，可以改，改动会直接提交到仓库。 */
  function isCloudMode() {
    return Boolean(Store && typeof Store.isCloud === 'function' && Store.isCloud());
  }

  /* 线上公开版本（Vercel / GitHub Pages）且没有令牌：只有静态文件，页面只读。
     —— 云端模式虽然也是从线上打开，但要能编辑，所以必须排除掉。 */
  function isOnlineMode() {
    if (isCloudMode()) return false;
    return Boolean(Store && typeof Store.getMode === 'function' && Store.getMode() === 'static');
  }

  /* 能编辑的两种模式（本机服务器 / 云端）。 */
  function canUploadHere() {
    return isServerMode() || isCloudMode();
  }

  function syncTargetLabel(serverText, localText) {
    return isServerMode() ? serverText : localText;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    var mb = bytes / (1024 * 1024);
    if (mb < 1) return Math.max(0.1, mb).toFixed(1) + ' MB';
    if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  /* ---------- 个人资料 ---------- */

  function fillProfileForm(profile) {
    els.fieldSiteName.value = profile.siteName || 'muqiuchen';
    els.fieldName.value = profile.name || '';
    els.fieldEnglishName.value = profile.englishName || '';
    els.fieldRole.value = profile.role || '';
    els.fieldTagline.value = profile.tagline || '';
    els.fieldBio.value = profile.bio || '';
    els.fieldLocation.value = profile.location || '';
    els.fieldSince.value = profile.since || '';
    els.fieldEmail.value = profile.email || '';
    els.fieldWechat.value = profile.wechat || '';
    els.fieldQq.value = profile.qq || '';
    els.fieldInstagram.value = profile.instagram || '';
    els.fieldDouyin.value = profile.douyin || '';
    els.fieldXiaohongshu.value = profile.xiaohongshu || '';
    els.fieldWebsite.value = profile.website || '';

    state.avatarDraft = profile.avatar || '';
    renderAvatar();
    updateBrandName(profile.siteName || profile.name || 'muqiuchen');
  }

  function renderAvatar() {
    var hasAvatar = Boolean(state.avatarDraft);
    if (hasAvatar) {
      els.avatarImage.src = state.avatarDraft;
      els.avatarImage.hidden = false;
      els.avatarInitial.hidden = true;
    } else {
      els.avatarImage.removeAttribute('src');
      els.avatarImage.hidden = true;
      els.avatarInitial.hidden = false;
      var name = els.fieldName ? els.fieldName.value.trim() : '';
      els.avatarInitial.textContent = name ? Array.from(name)[0] : '光';
    }
    els.avatarRemove.hidden = !hasAvatar;
  }

  function updateBrandName(name) {
    var brand = String(name || '').trim() || 'muqiuchen';
    if (els.studioBrandName) els.studioBrandName.textContent = brand;
    document.title = '工作室 — ' + brand;
  }

  function collectProfile() {
    var name = els.fieldName.value.trim();
    if (!name) {
      els.fieldName.setCustomValidity('请填写昵称或姓名');
      els.fieldName.reportValidity();
      return null;
    }
    els.fieldName.setCustomValidity('');

    var websiteRaw = els.fieldWebsite.value.trim();
    var website = Store.normalizeWebsite(websiteRaw);
    if (websiteRaw && !website) {
      els.fieldWebsite.setCustomValidity('请填写有效的网址，例如 https://example.com');
      els.fieldWebsite.reportValidity();
      return null;
    }
    els.fieldWebsite.setCustomValidity('');
    els.fieldWebsite.value = website;

    var instagram = Store.normalizeInstagram(els.fieldInstagram.value);
    els.fieldInstagram.value = instagram;

    return {
      siteName: els.fieldSiteName.value.trim() || 'muqiuchen',
      name: name,
      englishName: els.fieldEnglishName.value.trim(),
      role: els.fieldRole.value.trim(),
      tagline: els.fieldTagline.value.trim(),
      bio: els.fieldBio.value.trim(),
      location: els.fieldLocation.value.trim(),
      since: els.fieldSince.value.trim(),
      email: els.fieldEmail.value.trim(),
      wechat: els.fieldWechat.value.trim(),
      qq: els.fieldQq.value.replace(/[^\d]/g, '').slice(0, 20),
      instagram: instagram,
      douyin: els.fieldDouyin.value.trim(),
      xiaohongshu: els.fieldXiaohongshu.value.trim(),
      website: website,
      avatar: state.avatarDraft
    };
  }

  function scheduleProfileAutoSave() {
    if (!Store) return;
    if (!state.canEdit) return; // 只读设备不排队保存
    window.clearTimeout(profileSaveTimer);
    profileSaveTimer = window.setTimeout(function () {
      profileSaveTimer = 0;
      saveProfileNow({ explicit: false });
    }, 1100);
  }

  /* 保存资料：显式点按钮和自动保存走同一条路径。
     服务器模式下保存成功会立刻推送给所有打开的页面（含手机）。 */
  async function saveProfileNow(options) {
    var explicit = Boolean(options && options.explicit);
    if (!Store || !state.profile) return;
    if (isOnlineMode()) return; // 线上公开版本只读
    if (!state.canEdit) {
      if (explicit) showToast('只有运行网站的这台电脑可以修改内容。', true);
      return;
    }
    if (state.profileSaving) {
      state.profileQueued = true;
      return;
    }

    var payload = collectProfile();
    if (!payload) return;
    if (!els.profileForm.checkValidity()) {
      if (explicit) els.profileForm.reportValidity();
      return;
    }

    var stamp = state.editStamp;
    state.profileSaving = true;
    state.profileDirty = false;
    if (explicit) els.saveProfileButton.disabled = true;
    els.profileStatus.textContent = explicit ? '正在保存…' : '正在自动保存…';
    els.profileStatus.classList.remove('is-error');

    try {
      var saved = await Store.saveProfile(payload);
      state.profile = saved;
      if (state.editStamp === stamp) {
        fillProfileForm(saved);
        els.profileStatus.textContent =
          (explicit ? '已保存 · ' : '已自动保存 · ') +
          new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } else {
        // 保存期间用户又改了：保留表单里的新内容，等下一次自动保存。
        els.profileStatus.textContent = '继续编辑中…';
      }
      showSaveIndicator(syncTargetLabel('已同步到网站', '已保存到本机'), false);
      if (explicit) showToast('个人资料已保存。');
    } catch (error) {
      state.profileDirty = true;
      var message = error && error.message ? error.message : '保存失败，请重试。';
      els.profileStatus.textContent = message;
      els.profileStatus.classList.add('is-error');
      showSaveIndicator('保存失败', true);
      if (explicit) showToast(message, true);
    } finally {
      state.profileSaving = false;
      if (explicit) els.saveProfileButton.disabled = false;
      if (state.profileQueued || (state.profileDirty && state.editStamp !== stamp)) {
        state.profileQueued = false;
        scheduleProfileAutoSave();
      }
    }
  }

  function handleProfileSubmit(event) {
    event.preventDefault();
    window.clearTimeout(profileSaveTimer);
    profileSaveTimer = 0;
    saveProfileNow({ explicit: true });
  }

  /* 头像统一先缩到长边 1000px：
     服务器模式下直接上传成 media/ 文件（不把 base64 塞进数据文件），
     本地模式下降级成 data URL 存在浏览器里。 */
  function buildAvatarCanvas(image) {
    var maxEdge = 1000;
    var scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    var context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理这张图片');
    context.fillStyle = '#f3f0e9';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(
          function (blob) {
            resolve(blob || null);
          },
          type,
          quality
        );
      } catch (error) {
        resolve(null);
      }
    });
  }

  function handleAvatarFile(file) {
    if (!file) return;
    if (!state.canEdit) {
      showToast('只有运行网站的这台电脑可以更换头像。', true);
      return;
    }
    var type = (file.type || '').toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) {
      showToast('头像请使用 JPG、PNG 或 WebP 格式。', true);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast('头像文件超过 20MB，请先压缩。', true);
      return;
    }

    var url = URL.createObjectURL(file);
    var image = new Image();
    image.decoding = 'async';

    function useLocalDataUrl(dataUrl) {
      state.avatarDraft = dataUrl;
      renderAvatar();
      markDirty();
      scheduleProfileAutoSave();
    }

    image.onload = function () {
      var canvas = null;
      try {
        canvas = buildAvatarCanvas(image);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.86);

        if (!canUploadHere()) {
          releaseAvatarCanvas(canvas);
          canvas = null;
          useLocalDataUrl(dataUrl);
          showToast('头像已准备好，会自动保存。');
          return;
        }

        els.profileStatus.textContent = '正在上传头像…';
        els.profileStatus.classList.remove('is-error');
        canvasBlob(canvas, 'image/jpeg', 0.86).then(function (blob) {
          releaseAvatarCanvas(canvas);
          canvas = null;
          if (!blob) {
            useLocalDataUrl(dataUrl);
            return;
          }
          markSelfWrite();
          return Store.uploadAvatar(blob).then(
            function (saved) {
              state.profile = saved;
              state.avatarDraft = saved.avatar;
              renderAvatar();
              els.profileStatus.textContent = '头像已更新 · 首页立即生效';
              showSaveIndicator('头像已同步到网站', false);
              showToast('头像已更新。');
            },
            function (error) {
              // 上传失败时退回本地保存，改动不会丢。
              useLocalDataUrl(dataUrl);
              showToast((error && error.message) || '头像上传失败，已改为随资料一起保存。', true);
            }
          );
        });
      } catch (error) {
        releaseAvatarCanvas(canvas);
        showToast('头像处理失败，请换一张图片。', true);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    image.onerror = function () {
      URL.revokeObjectURL(url);
      showToast('头像无法读取，请换一张图片。', true);
    };

    image.src = url;
  }

  function releaseAvatarCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
  }

  /* ---------- 当前作品读取 ---------- */

  /* 缩略图 objectURL 按作品 id 缓存在内存里：排序/删除/上传后的整列表重建
     会沿用同一个 URL，浏览器就能直接命中已解码的位图，不用重新解码一遍。
     只在作品消失（删除）或离开页面时回收。 */
  function releaseAdminUrls() {
    state.thumbUrls.forEach(function (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        /* noop */
      }
    });
    state.thumbUrls.clear();
  }

  function pruneWorkUrls() {
    var alive = {};
    state.works.forEach(function (work) {
      alive[work.id] = true;
    });
    state.thumbUrls.forEach(function (url, id) {
      if (alive[id]) return;
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        /* noop */
      }
      state.thumbUrls.delete(id);
    });
  }

  async function loadWorks() {
    var loaded = [];
    var failed = false;

    try {
      loaded = await Store.getAllWorks();
      if (!Array.isArray(loaded)) loaded = [];
    } catch (error) {
      failed = true;
      loaded = [];
    }

    // 读取失败时保留内存里已有的列表：getAllWorks 有 3 秒超时，
    // 数据库被别的标签页占用时就会命中，这时候把 state.works 清空
    // 会让刚上传成功的作品"凭空消失"，而数据其实还在 IndexedDB 里。
    if (!failed) {
      state.works = loaded;
      // 只回收已经不在列表里的作品，保留其余缩略图 URL 以便复用。
      pruneWorkUrls();
    }
    if (els.storageWarning) els.storageWarning.hidden = !failed;

    if (els.worksEmpty) {
      var emptyTitle = els.worksEmpty.querySelector('.empty-state__title');
      var emptyDescription = els.worksEmpty.querySelector('p:last-child');
      if (emptyTitle) emptyTitle.textContent = '还没有上传作品';
      if (emptyDescription) {
        emptyDescription.textContent =
          '首页目前展示的是示例作品。上传第一张照片后，示例会自动隐藏。';
      }
    }

    renderWorks();

    if (failed) {
      showToast('无法读取本地作品，请检查浏览器存储权限。', true);
      if (els.worksEmpty) {
        els.worksEmpty.hidden = false;
        var title = els.worksEmpty.querySelector('.empty-state__title');
        if (title) title.textContent = '暂时无法读取作品';
        var description = els.worksEmpty.querySelector('p:last-child');
        if (description) description.textContent = '浏览器可能禁用了本地存储，或当前处于无痕模式。';
      }
    }

    updateStorageUsage();
  }

  function updateWorksTotal() {
    if (els.worksTotal) els.worksTotal.textContent = state.works.length + ' 件';
  }

  function updateStorageUsage() {
    if (!els.storageUsage) return;

    if (isOnlineMode()) {
      els.storageUsage.textContent =
        '线上版本的作品来自仓库里的 data/ 与 media/ 目录，由 GitHub 推送后自动发布。';
      return;
    }

    if (isCloudMode()) {
      els.storageUsage.textContent =
        '作品直接存到你的 GitHub 仓库（media/ 目录），电脑不用开机。请保留原始照片备份。';
      return;
    }

    if (isServerMode()) {
      els.storageUsage.textContent =
        '作品保存在这台电脑的 media/ 目录里，同一局域网的所有设备都会看到同一份内容。请保留原始照片备份。';
      return;
    }

    if (!Store || typeof Store.estimateStorage !== 'function') return;
    Store.estimateStorage().then(function (estimate) {
      if (!els.storageUsage) return;
      if (!estimate || !estimate.usage) {
        els.storageUsage.textContent = '作品保存在当前浏览器中，请保留原始照片备份。';
        return;
      }
      var usage = formatBytes(estimate.usage);
      var quota = estimate.quota ? '浏览器可用约 ' + formatBytes(estimate.quota) : '';
      els.storageUsage.textContent =
        '当前浏览器已用约 ' + usage + (quota ? '，' + quota : '') + '。请保留原始照片备份。';
    });
  }

  /* ---------- 实时同步 ---------- */

  /* 自己刚写出去的那次改动，服务器也会以 SSE 广播回来。
     数据层已经按 revision 过滤过一道，这里再加一层时间窗保护：
     保存瞬间的广播不会把用户正在编辑的列表重新渲染一遍。 */
  function markSelfWrite() {
    selfWriteUntil = Date.now() + 2500;
  }

  /* ---------- 编辑权限：只有运行网站的这台电脑能改 ---------- */

  /* 网址来自服务器（端口可能是 80，也可能是 8080），这里只负责把链接和文字换掉。 */
  function applyUnlockLinks(unlock) {
    if (!unlock) return;
    var links = document.querySelectorAll('[data-unlock]');
    Array.prototype.forEach.call(links, function (link) {
      var key = link.getAttribute('data-unlock');
      var base = key === 'loopback' ? unlock.loopback : unlock.desktop;
      if (!base) return;
      var root = String(base).replace(/\/+$/, '') + '/';
      link.href = root + 'studio.html';
      link.textContent = root;
    });
  }

  function applyAccess(access) {
    var canEdit = !access || access.canEdit !== false;
    var reason = (access && access.reason) || (canEdit ? 'local' : 'locked');
    var mine = reason === 'locked';

    state.canEdit = canEdit;
    state.accessReason = reason;

    document.body.classList.toggle('is-locked', mine);
    if (els.lockScreen) els.lockScreen.hidden = !mine;

    if (mine) {
      // 别再让自动保存排队：这台设备写不进去。
      window.clearTimeout(profileSaveTimer);
      profileSaveTimer = 0;
      state.profileDirty = false;
      state.profileQueued = false;
      if (els.lockScreenText && access && access.unlock && access.unlock.message) {
        els.lockScreenText.textContent =
          '你现在是用别的设备打开这个页面的，只能浏览。' + access.unlock.message;
      }
    }

    renderSyncMode();
    if (canEdit) refreshSyncBanner();
    else hideSyncBanner();
  }

  /* 锁屏上的「我是这台电脑，重新检查」：问一次服务器，确认解锁就重新载入。 */
  function bindLockEvents() {
    if (!els.lockRetry) return;
    els.lockRetry.addEventListener('click', function () {
      els.lockRetry.disabled = true;
      refreshAccess(true).then(function (access) {
        if (els.lockRetry) els.lockRetry.disabled = false;
        if (access && access.canEdit) {
          showToast('已确认是这台电脑，正在重新载入…');
          window.setTimeout(function () {
            window.location.reload();
          }, 450);
          return;
        }
        showToast('这台设备仍然只能查看。要修改内容，请回到运行网站的那台电脑。', true);
      });
    });
  }

  /* 问一次服务器：这台设备到底能不能改。 */
  function refreshAccess(force) {
    if (!Store || typeof Store.getAccess !== 'function') return Promise.resolve(null);
    return Store.getAccess(Boolean(force)).then(
      function (access) {
        if (access && access.unlock) applyUnlockLinks(access.unlock);
        applyAccess(access);
        return access;
      },
      function () {
        return null;
      }
    );
  }

  function renderSyncMode() {
    if (!els.syncMode) return;
    if (!state.modeReady) return; // 还没判断出模式，保持「连接中」
    var mode = Store && typeof Store.getMode === 'function' ? Store.getMode() : 'local';
    var live = Store && typeof Store.getLiveState === 'function' ? Store.getLiveState() : 'local';
    var text = '本地模式';
    var name = 'local';

    if (!state.canEdit && state.accessReason !== 'static') {
      // 其它设备：网站能看、能实时更新，但不允许改。
      els.syncMode.setAttribute('data-state', 'locked');
      els.syncMode.textContent = '只读';
      els.syncMode.title = '只有运行网站的这台电脑能修改内容，这台设备只能查看';
      return;
    }

    if (mode === 'server') {
      if (live === 'connected') {
        text = '实时同步中';
        name = 'on';
      } else if (live === 'offline') {
        text = '连接已断开';
        name = 'off';
      } else {
        text = '正在连接';
        name = 'wait';
      }
    } else if (mode === 'cloud') {
      if (live === 'offline') {
        text = '网络断开';
        name = 'off';
      } else {
        text = '云端同步中';
        name = 'on';
      }
    } else if (mode === 'static') {
      text = '线上浏览模式';
      name = 'static';
    }

    els.syncMode.setAttribute('data-state', name);
    els.syncMode.textContent = text;
    els.syncMode.title =
      mode === 'server'
        ? '改动会立即保存到这台电脑，并推送给所有打开的页面'
        : mode === 'cloud'
          ? '改动会直接存到 GitHub，约半分钟后网站自动更新；电脑不用开机'
          : mode === 'static'
            ? '这是发布在互联网上的公开版本，内容只读'
            : '本地模式：改动只在这个浏览器里';
  }

  function showSyncBanner(text, action) {
    if (!els.syncBanner) return;
    els.syncBanner.hidden = false;
    if (els.syncBannerText) els.syncBannerText.textContent = text;
    if (!els.syncBannerAction) return;
    if (action && typeof action.handler === 'function') {
      els.syncBannerAction.hidden = false;
      els.syncBannerAction.disabled = false;
      els.syncBannerAction.textContent = action.label || '同步到网站';
      els.syncBannerAction.onclick = action.handler;
    } else {
      els.syncBannerAction.hidden = true;
      els.syncBannerAction.disabled = false;
      els.syncBannerAction.onclick = null;
    }
  }

  function hideSyncBanner() {
    if (els.syncBanner) els.syncBanner.hidden = true;
  }

  /* 线上公开版本：整页只读。
     隐藏上传区与编辑表单，换成一块说明，避免访客以为改动会生效。 */
  function applyOnlineLock() {
    if (!isOnlineMode()) return;
    document.body.classList.add('is-online');

    var locked = document.getElementById('studioLocked');
    if (locked) {
      locked.hidden = false;
      var count = document.getElementById('studioLockedCount');
      if (count) {
        count.textContent = state.works.length
          ? '线上正在展示 ' + state.works.length + ' 件作品。'
          : '线上正在展示示例作品。';
      }
    }

    var intro = document.getElementById('studioIntroCopy');
    if (intro) {
      clearNode(intro);
      var line1 = document.createElement('p');
      line1.textContent = '这是发布在互联网上的公开版本：所有人打开都看到同一批作品，页面本身不能修改。';
      var line2 = document.createElement('p');
      line2.className = 'studio-intro__note';
      line2.textContent =
        '内容来自仓库里的 data/site.json 与 media/ 目录。想更新作品，请在这台电脑上运行工作室改好，再用 GitHub Desktop 推送，网站会自动重新发布。';
      intro.appendChild(line1);
      intro.appendChild(line2);
    }

    if (els.footerNote) {
      els.footerNote.textContent =
        '这是发布在互联网上的公开版本，只能浏览；内容来自仓库里的 data/ 与 media/ 目录。';
    }

    // 表单整体只读，防止键盘或回车提交
    var form = document.getElementById('profileForm');
    if (form) form.setAttribute('aria-hidden', 'true');
  }

  /* 告诉用户两件事：
     1) 当前是本地模式还是实时同步模式；
     2) 这个浏览器里还有没有「只存在本地」的作品可以一键同步到网站。 */
  function refreshSyncBanner() {
    if (!els.syncBanner || !Store) return;
    if (!state.modeReady) return; // 模式还没确定，先不提示

    // 只读设备不需要看这些「可以同步」的提示，锁屏卡片已经说明了一切。
    if (!state.canEdit) {
      hideSyncBanner();
      return;
    }

    if (isOnlineMode()) {
      showSyncBanner(
        '这是发布在互联网上的公开版本，内容只读。要更新作品：在本机用「启动网站.cmd」打开工作室改好，再用 GitHub Desktop 提交并推送，网站会自动重新发布。'
      );
      return;
    }

    if (!canUploadHere()) {
      showSyncBanner(
        '当前是本地模式：改动只保存在这个浏览器里，手机和其它设备看不到。用项目目录里的「启动网站.cmd」打开网址，就会自动变成实时同步。'
      );
      return;
    }

    var serverIds = new Set(
      state.works.map(function (work) {
        return work.id;
      })
    );

    Promise.resolve(Store.pendingLocalWorks(serverIds)).then(
      function (pending) {
        if (!pending.length) {
          hideSyncBanner();
          return;
        }
        showSyncBanner(
          '这个浏览器里还有 ' +
            pending.length +
            ' 件作品没有同步到网站。同步之后，手机和电脑看到的就是同一份作品。',
          { label: '同步 ' + pending.length + ' 件作品', handler: runMigration }
        );
      },
      function () {
        hideSyncBanner();
      }
    );
  }

  async function runMigration() {
    if (state.busy || !Store) return;
    state.busy = true;
    markSelfWrite();
    els.uploadZone.classList.add('is-busy');
    els.uploadZone.setAttribute('aria-busy', 'true');
    if (els.syncBannerAction) els.syncBannerAction.disabled = true;

    try {
      var result = await Store.migrateLocalToServer(function (done, total, work) {
        updateProgress(
          done,
          total,
          '正在同步 ' + done + ' / ' + total + '：' + (work.title || '未命名作品')
        );
      });
      if (result.total) {
        showToast('已同步 ' + result.migrated + ' 件作品到网站。');
        showSaveIndicator('已同步到网站', false);
      } else {
        showToast('没有需要同步的作品。');
      }
      await loadWorks();
      hideSyncBanner();
    } catch (error) {
      showToast(error && error.message ? error.message : '同步失败，请重试。', true);
    } finally {
      state.busy = false;
      els.uploadZone.classList.remove('is-busy');
      els.uploadZone.removeAttribute('aria-busy');
      if (els.syncBannerAction) els.syncBannerAction.disabled = false;
      refreshSyncBanner();
    }
  }

  function listenForChanges() {
    if (!Store || typeof Store.subscribe !== 'function') return;

    Store.subscribe(function (change) {
      if (!change) return;

      if (change.type === 'live') {
        renderSyncMode();
        return;
      }

      if (change.type === 'access') {
        applyAccess(Store.accessSnapshot ? Store.accessSnapshot() : change);
        return;
      }

      // 自己写出去的改动不重复处理。
      if (Date.now() < selfWriteUntil) return;

      if (change.type === 'profile') {
        if (state.profileDirty || state.profileSaving) {
          showToast('资料在别处被更新；本页还有未保存的修改，已保留你正在编辑的内容。');
          return;
        }
        Store.getProfileAsync().then(function (profile) {
          state.profile = profile;
          if (!state.profileDirty) fillProfileForm(profile);
          showToast('个人资料已在其它设备上更新。');
        });
        return;
      }

      if (change.type === 'works' || change.type === 'site') {
        if (state.busy || state.ordering || state.deleting || pendingSaves.size) {
          showToast('作品有新的改动，等当前操作结束后会自动刷新。');
          return;
        }
        loadWorks()
          .then(function () {
            refreshSyncBanner();
          })
          .catch(function () {
            /* loadWorks 内部已经提示 */
          });
        showToast('作品列表已更新。');
      }
    });
  }

  /* ---------- 作品列表 ---------- */

  function svgIcon(paths) {
    var wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wrapper.setAttribute('class', 'icon');
    wrapper.setAttribute('viewBox', '0 0 24 24');
    wrapper.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      wrapper.appendChild(path);
    });
    return wrapper;
  }

  function makeActionButton(action, label, paths, danger) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button' + (danger ? ' icon-button--danger' : '');
    button.setAttribute('data-action', action);
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(svgIcon(paths));
    return button;
  }

  function makeField(labelText, field, value, options) {
    var label = document.createElement('label');
    label.className = 'field' + (options && options.className ? ' ' + options.className : '');
    var span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);

    var input;
    if (options && options.multiline) {
      input = document.createElement('textarea');
      input.rows = 2;
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.setAttribute('data-field', field);
    input.value = value || '';
    if (options && options.maxlength) input.maxLength = options.maxlength;
    if (options && options.placeholder) input.placeholder = options.placeholder;
    if (options && options.inputmode) input.setAttribute('inputmode', options.inputmode);
    label.appendChild(input);
    return label;
  }

  /* ---------- 作品范围（支持自定义分类） ---------- */

  var CATEGORY_PRESETS = [
    { value: '', label: '未分类' },
    { value: 'cinematic', label: '电影感' },
    { value: 'onlocation', label: '场照' },
    { value: 'studio', label: '棚拍' },
    { value: 'outdoor', label: '外景' },
    { value: 'cinematic-outdoor', label: '外景 + 电影感' },
    { value: 'composite', label: '大合成' }
  ];

  /* 自定义分类的值统一加 `custom:` 前缀。
     这样它和内置的英文 key 永远不会撞，首页一眼就能认出「这是自己写的」，
     显示时去掉前缀直接用用户输入的文字。 */
  var CUSTOM_PREFIX = 'custom:';

  function isCustomCategory(value) {
    return typeof value === 'string' && value.indexOf(CUSTOM_PREFIX) === 0;
  }

  function customCategoryText(value) {
    return isCustomCategory(value) ? value.slice(CUSTOM_PREFIX.length) : '';
  }

  /* 把一批作品里出现过的自定义分类收集起来（去重、保持出现顺序）。 */
  function collectCustomCategories(works) {
    var seen = {};
    var list = [];
    (works || []).forEach(function (work) {
      var value = work && work.category;
      if (!isCustomCategory(value)) return;
      if (seen[value]) return;
      seen[value] = true;
      list.push(value);
    });
    return list;
  }

  /* 作品范围字段：一排胶囊 + 一个「+ 自定义」。
     点「+ 自定义」变成输入框，打完回车就生效，
     这个新分类会自动出现在作品列表里所有卡片的胶囊中，
     也会自动出现在首页的筛选标签里（首页按数据动态生成）。 */
  function makeCategoryField(work, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'field work-fields__category';

    var label = document.createElement('span');
    label.textContent = '作品范围';
    wrap.appendChild(label);

    var current = work.category || '';

    /* 可选值 = 内置预设 + 全站已用过的自定义分类 */
    var choices = CATEGORY_PRESETS.slice();
    var extra = collectCustomCategories(state.works);
    extra.forEach(function (value) {
      choices.push({ value: value, label: customCategoryText(value) });
    });
    // 当前作品用的自定义值可能在列表里还没出现（新加的），补进去
    if (isCustomCategory(current) && !extra.some(function (v) { return v === current; })) {
      choices.push({ value: current, label: customCategoryText(current) });
    }

    var pills = document.createElement('div');
    pills.className = 'category-pills';

    var inputRow = document.createElement('div');
    inputRow.className = 'category-input';
    inputRow.hidden = true;

    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = '输入新的分类名，回车确认';
    input.setAttribute('aria-label', '自定义作品范围');

    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'button button--small';
    confirm.textContent = '确定';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button--ghost button--small';
    cancel.textContent = '取消';

    inputRow.appendChild(input);
    inputRow.appendChild(confirm);
    inputRow.appendChild(cancel);

    function renderPills() {
      clearNode(pills);
      choices.forEach(function (choice) {
        var pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'category-pill';
        if (isCustomCategory(choice.value)) pill.classList.add('category-pill--custom');
        pill.textContent = choice.label;
        if ((current || '') === choice.value) pill.classList.add('is-active');
        pill.addEventListener('click', function () {
          if ((current || '') === choice.value) return;
          current = choice.value;
          renderPills();
          onChange(current);
        });
        pills.appendChild(pill);
      });

      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'category-pill category-pill--add';
      add.innerHTML = '<span aria-hidden="true">+</span> 自定义';
      add.addEventListener('click', function () {
        inputRow.hidden = false;
        input.value = '';
        input.focus();
      });
      pills.appendChild(add);
    }

    function commitCustom() {
      var text = String(input.value || '').trim().slice(0, 20);
      if (!text) {
        inputRow.hidden = true;
        return;
      }
      // 已经存在的同名自定义分类，直接复用，避免出现两个一样的标签
      var existing = choices.find(function (c) {
        return isCustomCategory(c.value) && c.label === text;
      });
      var value = existing ? existing.value : CUSTOM_PREFIX + text;
      if (!existing) choices.push({ value: value, label: text });
      current = value;
      inputRow.hidden = true;
      renderPills();
      onChange(current);
    }

    confirm.addEventListener('click', commitCustom);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitCustom();
      } else if (event.key === 'Escape') {
        inputRow.hidden = true;
      }
    });
    cancel.addEventListener('click', function () {
      inputRow.hidden = true;
    });

    renderPills();
    wrap.appendChild(pills);
    wrap.appendChild(inputRow);

    var hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = '点「+ 自定义」可以自己起一个类型，例如「夜景」「和风」。新类型会自动出现在首页筛选项里。';
    wrap.appendChild(hint);

    return wrap;
  }

  function makeSelectField(labelText, field, value, choices, className) {
    var label = document.createElement('label');
    label.className = 'field' + (className ? ' ' + className : '');
    var span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);

    var select = document.createElement('select');
    select.setAttribute('data-field', field);
    choices.forEach(function (choice) {
      var option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      if ((value || '') === choice.value) option.selected = true;
      select.appendChild(option);
    });
    label.appendChild(select);
    return label;
  }

  /* ---------- 构图范围（独立模块） ---------- */

  var COMPOSITION_LABELS = {
    landscape: '横构图',
    portrait: '竖构图'
  };

  var COMPOSITION_CHOICES = [
    { value: '', label: '跟随原图' },
    { value: 'landscape', label: '横构图' },
    { value: 'portrait', label: '竖构图' }
  ];

  /* 只有横 / 竖两种，所以直接按比例一分二：
   比例 ≥ 1 判为横构图，其余判为竖构图，不存在筛不到的中间态。 */
  function autoComposition(width, height) {
    var ratio = (Number(width) || 1) / (Number(height) || 1);
    return ratio >= 1 ? 'landscape' : 'portrait';
  }

  function compositionLabelOf(value) {
    return COMPOSITION_LABELS[value] || '';
  }

  /* 构图范围是独立于「作品范围」的第二个模块：
     作品范围管的是题材（电影感 / 场照 / 棚拍 / 外景），构图范围管的是画幅
     （横 / 竖 / 方）。这里用一排胶囊按钮，而不是原生 select，
     以免深色主题下的下拉面板再出现看不清的白底浅色字。 */
  function makeCompositionField(work) {
    var wrap = document.createElement('div');
    wrap.className = 'field field--composition';

    var head = document.createElement('div');
    head.className = 'composition__head';

    var title = document.createElement('span');
    title.className = 'composition__title';
    title.textContent = '构图范围';

    var auto = document.createElement('span');
    auto.className = 'composition__auto';
    var autoValue = autoComposition(work.width, work.height);
    auto.textContent =
      '原图 ' +
      Store.formatRatio(work.width, work.height) +
      ' · 自动识别 ' +
      compositionLabelOf(autoValue);

    head.appendChild(title);
    head.appendChild(auto);
    wrap.appendChild(head);

    var input = document.createElement('input');
    input.type = 'hidden';
    input.setAttribute('data-field', 'composition');
    // 只认横 / 竖两种；历史数据里若有其它值（例如早期的「方构图」），按「跟随原图」处理。
    input.value = COMPOSITION_LABELS[work.composition] ? work.composition : '';

    var options = document.createElement('div');
    options.className = 'composition-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', '构图范围');

    function syncOptions() {
      Array.prototype.slice.call(options.querySelectorAll('.composition-option')).forEach(
        function (button) {
          var active = button.getAttribute('data-value') === input.value;
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      );
    }

    COMPOSITION_CHOICES.forEach(function (choice) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'composition-option';
      button.setAttribute('data-value', choice.value);
      button.textContent = choice.label;
      button.addEventListener('click', function () {
        if (input.value === choice.value) return;
        input.value = choice.value;
        syncOptions();
        // 复用作品字段的自动保存：先标记编辑中，再立刻落库。
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      options.appendChild(button);
    });

    syncOptions();
    wrap.appendChild(options);
    wrap.appendChild(input);
    return wrap;
  }

  /* 待完善区：刚导入、还没填资料的作品。
     每张卡片带一个「完成」按钮，点它才真正排到正式列表末尾。 */
  function createPendingSection(works) {
    var section = document.createElement('section');
    section.className = 'pending-section';

    var head = document.createElement('div');
    head.className = 'pending-section__head';

    var title = document.createElement('h3');
    title.className = 'pending-section__title';
    title.textContent = '待完善 ' + works.length + ' 件';

    /* 一键完成：把所有待完善的都排到末尾，省得一个个点。
       顺序按当前显示顺序（也就是上传顺序）。 */
    var finishAll = document.createElement('button');
    finishAll.type = 'button';
    finishAll.className = 'pending-section__finish-all';
    finishAll.textContent = '一键全部完成';
    finishAll.addEventListener('click', function (event) {
      event.preventDefault();
      finishAllPendingWorks(finishAll);
    });

    var headRow = document.createElement('div');
    headRow.className = 'pending-section__title-row';
    headRow.appendChild(title);
    headRow.appendChild(finishAll);

    var hint = document.createElement('p');
    hint.className = 'pending-section__hint';
    hint.textContent = '填好作品范围和构图后点「完成」；也可以先全部填完，再点右上角「一键全部完成」。';

    head.appendChild(headRow);
    head.appendChild(hint);
    section.appendChild(head);

    var list = document.createElement('div');
    list.className = 'pending-section__list';
    works.forEach(function (work, index) {
      list.appendChild(createWorkEditor(work, index, -1, true));
    });
    section.appendChild(list);

    return section;
  }

  function createWorkEditor(work, index, enterIndex, isPending) {
    var card = document.createElement('article');
    card.className = 'work-editor';
    card.setAttribute('data-id', work.id);
    // 入场动效只给前 12 张：延迟封顶后，第 13 张起会几十张一起动画，
    // 每张都提升成独立合成层，首屏反而更卡；其余卡片直接以终态出现。
    if (
      typeof enterIndex === 'number' &&
      enterIndex >= 0 &&
      enterIndex < 12 &&
      !reduceMotion
    ) {
      card.classList.add('is-entering');
      card.style.setProperty('--enter-i', String(enterIndex));
    }

    /* 缩略图 */
    var thumb = document.createElement('div');
    thumb.className = 'work-editor__thumb';

    /* 拖动把手：手机上最可靠的入口。
       手指按在把手上时，浏览器不会把它当成「想滚动页面」，
       所以长按一定能成立；按在别处仍然走「长按 0.3 秒」的老路径。 */
    var handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'work-editor__handle';
    handle.setAttribute('data-drag-handle', 'true');
    handle.setAttribute('aria-label', '按住拖动调整顺序');
    handle.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle>' +
      '<circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle>' +
      '<circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle>' +
      '</svg>';
    thumb.appendChild(handle);
    var thumbUrl = '';
    try {
      if (work.remote) {
        /* 服务器 / 云端返回的图片地址。store.js 为了兼容子目录部署，
           会把 `/media/x.webp` 去掉开头斜杠变成 `media/x.webp`；
           但工作室页面本身在 /studio.html，相对路径会被解析成
           /studio.html/media/x.webp → 404 → 缩略图白板。
           这里补回站点根，让它始终指向真正的图片。 */
        thumbUrl = mediaSrc(work.thumbUrl || work.displayUrl || '');
      } else {
        thumbUrl = state.thumbUrls.get(work.id) || '';
        if (!thumbUrl) {
          var thumbBlob = work.thumbBlob instanceof Blob ? work.thumbBlob : work.displayBlob;
          thumbUrl = URL.createObjectURL(thumbBlob);
          state.thumbUrls.set(work.id, thumbUrl);
        }
      }
    } catch (error) {
      thumbUrl = '';
    }

    if (thumbUrl) {
      var image = document.createElement('img');
      image.alt = work.title ? work.title : '作品缩略图';
      /* 工作室里不要懒加载。
         列表卡片很高，一屏只看得到 2~3 张，懒加载会让快速滑动时看到一片灰框，
         用起来像「缩略图坏了」。工作室总共才几十件，
         直接 eager 全部拉下来（走本地服务器或已缓存），反而更顺。
         占位颜色由 CSS 的 .work-editor__thumb 背景负责，不会白闪。 */
      image.loading = 'eager';
      image.decoding = 'async';
      /* 关掉浏览器自带的图片拖拽，不然长按拖卡片会变成拖图片 */
      image.draggable = false;
      image.addEventListener('load', function () {
        thumb.classList.add('is-loaded');
      });
      image.src = thumbUrl;
      image.addEventListener('error', function () {
        /* 一次失败再试一次：服务器刚重启、或临时网络抖动时很常见 */
        if (!image.dataset.retried) {
          image.dataset.retried = '1';
          image.src = thumbUrl + '?r=' + Date.now();
          return;
        }
        if (image.parentNode) image.parentNode.removeChild(image);
        var fallback = document.createElement('p');
        fallback.className = 'work-editor__thumb-fallback';
        fallback.textContent = '缩略图无法显示';
        thumb.appendChild(fallback);
      });
      thumb.appendChild(image);
    } else {
      var noThumb = document.createElement('p');
      noThumb.className = 'work-editor__thumb-fallback';
      noThumb.textContent = '缩略图无法显示';
      thumb.appendChild(noThumb);
    }

    var ratio = document.createElement('span');
    ratio.className = 'ratio-badge';
    ratio.textContent = Store.formatRatio(work.width, work.height);
    thumb.appendChild(ratio);

      /* 多选框：勾上就可以批量操作（删除）。
         放在缩略图左上角，一眼能看到、好点。 */
      var pick = document.createElement('label');
      pick.className = 'work-editor__pick';
      pick.title = '选中这件作品（可批量删除）';
      var pickBox = document.createElement('input');
      pickBox.type = 'checkbox';
      pickBox.setAttribute('data-pick', work.id);
      pickBox.checked = state.picked && state.picked.indexOf(work.id) !== -1;
      pickBox.addEventListener('change', function () {
        if (!state.picked) state.picked = [];
        var idx = state.picked.indexOf(work.id);
        if (pickBox.checked && idx === -1) state.picked.push(work.id);
        if (!pickBox.checked && idx !== -1) state.picked.splice(idx, 1);
        card.classList.toggle('is-picked', pickBox.checked);
        updateBulkBar();
      });
      var pickMark = document.createElement('span');
      pickMark.className = 'work-editor__pick-mark';
      pickMark.setAttribute('aria-hidden', 'true');
      pick.appendChild(pickBox);
      pick.appendChild(pickMark);
      thumb.appendChild(pick);
      if (state.picked && state.picked.indexOf(work.id) !== -1) card.classList.add('is-picked');
    card.appendChild(thumb);

    /* 编辑区 */
    var body = document.createElement('div');
    body.className = 'work-editor__body';

    var top = document.createElement('div');
    top.className = 'work-editor__top';

    var indexLabel = document.createElement('span');
    indexLabel.className = 'work-editor__index';
    indexLabel.textContent = String(index + 1).padStart(2, '0');

    var actions = document.createElement('div');
    actions.className = 'work-editor__actions';

    var up = makeActionButton('up', '上移这件作品', ['M12 19V5', 'm5 7 7-7 7 7']);
    up.disabled = index === 0;
    var down = makeActionButton('down', '下移这件作品', ['M12 5v14', 'm19 17-7 7-7-7']);
    down.disabled = index === state.works.length - 1;
    var remove = makeActionButton(
      'delete',
      '删除这件作品',
      ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 12h10l1-12', 'M9 7V4h6v3'],
      true
    );

    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(remove);

        /* 待完善的作品：行动区加一个「完成」按钮。
           点它才把 pending 清掉、真正排到正式列表末尾。 */
        if (isPending) {
          var doneBtn = document.createElement('button');
          doneBtn.type = 'button';
          doneBtn.className = 'work-editor__done';
          doneBtn.textContent = '完成';
          doneBtn.title = '资料填好后点这里，作品会排到列表末尾';
          doneBtn.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            finishPendingWork(card, work.id, doneBtn);
          });
          actions.insertBefore(doneBtn, actions.firstChild);
          card.classList.add('is-pending');
        }
    top.appendChild(indexLabel);
    top.appendChild(actions);
    body.appendChild(top);

    var fields = document.createElement('div');
    fields.className = 'work-fields';
    fields.appendChild(
      makeField('标题', 'title', work.title, { maxlength: 80, placeholder: '作品标题' })
    );
    fields.appendChild(
      makeField('年份', 'year', work.year, { maxlength: 10, inputmode: 'numeric', placeholder: '2026' })
    );
    fields.appendChild(
      makeField('拍摄地', 'location', work.location, { maxlength: 80, placeholder: '城市 / 地点' })
    );
    fields.appendChild(
      makeCategoryField(work, function onChange(nextValue) {
        saveCategory(card, work.id, nextValue, status);
      })
    );
    fields.appendChild(makeCompositionField(work));
    fields.appendChild(
      makeField('作品说明', 'caption', work.caption, {
        multiline: true,
        maxlength: 240,
        className: 'work-fields__caption',
        placeholder: '一句话描述这张照片（可选）'
      })
    );
    body.appendChild(fields);

    var status = document.createElement('p');
    status.className = 'autosave';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = '已保存';
    body.appendChild(status);

    card.appendChild(body);

    /* 自动保存 */
    var inputs = Array.prototype.slice.call(fields.querySelectorAll('[data-field]'));
    inputs.forEach(function (input) {
      var field = input.getAttribute('data-field');
      input.setAttribute('data-saved', (work[field] == null ? '' : String(work[field])).trim());

      function scheduleAutoSave(delay) {
        window.clearTimeout(input._saveTimer);
        pendingSaves.set(input, { card: card, id: work.id, status: status });
        input._saveTimer = window.setTimeout(function () {
          input._saveTimer = 0;
          pendingSaves.delete(input);
          saveWorkField(card, work.id, input, status);
        }, delay);
      }

      input.addEventListener('compositionstart', function () {
        input._composing = true;
        forgetPendingSave(input);
      });

      input.addEventListener('compositionend', function () {
        input._composing = false;
        scheduleAutoSave(300);
      });

      input.addEventListener('input', function () {
        status.classList.remove('is-error');
        status.textContent = '编辑中…';
        if (!input._composing) scheduleAutoSave(800);
      });

      input.addEventListener('change', function () {
        forgetPendingSave(input);
        saveWorkField(card, work.id, input, status);
      });
    });

    return card;
  }

  /* 保存分类。它走的是和普通字段一样的一条路：
     写进作品 → 首页重新渲染时按数据动态生成筛选项。
     不同点只是它可能带 `custom:` 前缀（自定义类型）。 */
  function saveCategory(card, id, value, status) {
    if (status) {
      status.classList.remove('is-error');
      status.textContent = '保存中…';
    }
    markSelfWrite();

    Store.updateWork(id, { category: value })
      .then(function (updated) {
        var current = state.works.find(function (item) {
          return item.id === id;
        });
        if (current && updated) {
          current.category = updated.category;
        }
        if (status) {
          status.textContent = isCustomCategory(value)
            ? '已保存，新分类「' + customCategoryText(value) + '」已加入'
            : '已保存';
        }
      })
      .catch(function (error) {
        if (status) {
          status.classList.add('is-error');
          status.textContent = error && error.message ? error.message : '保存失败';
        }
      });
  }

  /* 把「待完善」的作品转正：
     点「完成」时，给它一个真正排在末尾的序号，并清掉 pending。
     没填作品范围 / 构图也允许完成（不强求），但会顺手给个提醒。 */
  /* 一键全部完成：把所有待完善的作品依次排到末尾。
     一次只发一个请求（串行），避免并发写数据撞车。 */
  function finishAllPendingWorks(button) {
    var list = state.works.filter(function (work) {
      return work && work.pending;
    }).sort(function (a, b) {
      /* 按上传顺序处理，保证排到末尾时顺序和上传一致。 */
      /* 按上传先后排：pendingSeq 是上传时分配的递增号，
         服务端重排 order 也不影响它。没记录的老数据退回用 order。 */
      var sa = Number(a.pendingSeq) || 0;
      var sb = Number(b.pendingSeq) || 0;
      if (sa !== sb) return sa - sb;
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
    if (!list.length) return;

    if (button) {
      button.disabled = true;
      button.textContent = '处理中 0 / ' + list.length;
    }

    var maxOrder = state.works.reduce(function (max, item) {
      if (!item || item.pending) return max;
      return Math.max(max, Number.isFinite(item.order) ? item.order : -1);
    }, -1);

    var index = 0;
    var chain = Promise.resolve();

    list.forEach(function (work) {
      chain = chain.then(function () {
        return Store.updateWork(work.id, { pending: 0, order: maxOrder + 1 + index }).then(
          function () {
            work.pending = 0;
            work.order = maxOrder + 1 + index;
            index += 1;
            if (button) button.textContent = '处理中 ' + index + ' / ' + list.length;
          },
          function (error) {
            showToast(
              '「' + (work.title || '未命名') + '」完成失败：' + (error && error.message ? error.message : '未知错误'),
              true
            );
          }
        );
      });
    });

    markSelfWrite();
    chain.then(function () {
      // 重新排一次：把转正的作品挪到末尾
      var done = state.works.filter(function (w) {
        return !w.pending;
      });
      var stillPending = state.works.filter(function (w) {
        return w.pending;
      });
      done.sort(function (a, b) {
        return (Number(a.order) || 0) - (Number(b.order) || 0);
      });
      state.works = done.concat(stillPending);
      renderWorks();
      showToast('已把 ' + index + ' 件作品排到末尾');
    });
  }

  /* ---------- 批量管理 ---------- */

  function updateBulkBar() {
    var bar = document.getElementById('bulkBar');
    if (!bar) return;
    var picked = state.picked || [];
    var count = document.getElementById('bulkCount');
    if (count) count.textContent = String(picked.length);
    bar.hidden = picked.length === 0;
    /* 批量栏固定在屏幕底部，出现时给列表底部留出空间，别遮住最后一张卡片 */
    document.body.classList.toggle('has-bulk-bar', picked.length > 0);
  }

  function clearPicks() {
    state.picked = [];
    renderWorks();
    updateBulkBar();
  }

  /* 一键删除选中的作品。
     云端模式下是「一次改数据 + 一次扫目录 + 并行删图」，
     不是逐个删，所以删 3 件和删 1 件花的时间差不多。 */
  async function deletePickedWorks() {
    var picked = (state.picked || []).slice();
    if (!picked.length) return;
    if (state.busy || state.deleting) return;

    var titles = picked
      .map(function (id) {
        var found = state.works.find(function (w) {
          return w.id === id;
        });
        return found ? found.title : '';
      })
      .filter(Boolean);

    var tip =
      picked.length === 1
        ? '删除《' + titles[0] + '》？此操作无法撤销。'
        : '删除选中的 ' + picked.length + ' 件作品？此操作无法撤销。' +
          (titles.length ? '\n\n' + titles.slice(0, 6).join('、') + (titles.length > 6 ? ' 等' : '') : '');
    if (!window.confirm(tip)) return;

    state.deleting = true;
    markSelfWrite();
    var bar = document.getElementById('bulkBar');
    var deleteBtn = document.getElementById('bulkDelete');
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.textContent = '正在删除 ' + picked.length + ' 件…';
    }

    try {
      var lookup = {};
      picked.forEach(function (id) {
        lookup[id] = true;
      });

      /* 先从界面上拿掉，用户立刻看到结果；网络在后台跑。 */
      state.works = state.works.filter(function (w) {
        return !lookup[w.id];
      });
      state.picked = [];
      pruneWorkUrls();
      renderWorks();
      updateStorageUsage();
      if (bar) bar.hidden = true;

      var removed = await Store.deleteWorks(picked);
      showToast('已删除 ' + removed + ' 件作品');
      showSaveIndicator('已删除 ' + removed + ' 件', false);
    } catch (error) {
      showToast(error && error.message ? error.message : '批量删除失败，请重试', true);
      /* 失败就把列表重新拉回来，避免界面和数据不一致 */
      try {
        await loadWorks();
      } catch (refreshError) {
        /* 忽略 */
      }
    } finally {
      state.deleting = false;
      if (deleteBtn) {
        deleteBtn.disabled = false;
        deleteBtn.textContent = '一键删除选中';
      }
      updateBulkBar();
    }
  }

  /* 全选 / 取消全选 */
  function togglePickAll() {
    var all = (state.works || []).map(function (w) {
      return w.id;
    });
    if (state.picked && state.picked.length === all.length) {
      state.picked = [];
    } else {
      state.picked = all;
    }
    renderWorks();
    updateBulkBar();
  }

  function finishPendingWork(card, id, button) {
    var work = state.works.find(function (item) {
      return item.id === id;
    });
    if (!work) return;

    if (!work.category) {
      showToast('还没选作品范围，先选一个再点完成更好（也可以直接完成）', true);
    }

    var maxOrder = state.works.reduce(function (max, item) {
      if (!item || item.pending) return max;
      return Math.max(max, Number.isFinite(item.order) ? item.order : -1);
    }, -1);

    if (button) {
      button.disabled = true;
      button.textContent = '保存中';
    }
    markSelfWrite();

    Store.updateWork(id, { pending: 0, order: maxOrder + 1 })
      .then(function (updated) {
        work.pending = 0;
        work.order = Number.isFinite(updated && updated.order) ? updated.order : maxOrder + 1;
        var idx = state.works.indexOf(work);
        if (idx >= 0) {
          state.works.splice(idx, 1);
          state.works.push(work);
        }
        renderWorks();
        showToast('已排到列表末尾，可以继续调顺序');
      })
      .catch(function (error) {
        if (button) {
          button.disabled = false;
          button.textContent = '完成';
        }
        showToast(error && error.message ? error.message : '保存失败，请重试', true);
      });
  }

  function saveWorkField(card, id, input, status) {
    var field = input.getAttribute('data-field');
    if (!field) return;
    var value = input.value.trim();
    if (value === (input.getAttribute('data-saved') || '')) {
      status.textContent = '已保存';
      return;
    }

    var patch = {};
    patch[field] = value;

    status.classList.remove('is-error');
    status.textContent = '保存中…';
    markSelfWrite();

    Store.updateWork(id, patch)
      .then(function (updated) {
        var current = state.works.find(function (item) {
          return item.id === id;
        });
        input.setAttribute('data-saved', value);
        if (input.value.trim() !== value) {
          // 保存过程中又有新的输入，等下一次自动保存。
          status.textContent = '编辑中…';
          window.clearTimeout(input._saveTimer);
          pendingSaves.set(input, { card: card, id: id, status: status });
          input._saveTimer = window.setTimeout(function () {
            input._saveTimer = 0;
            pendingSaves.delete(input);
            saveWorkField(card, id, input, status);
          }, 300);
          return;
        }
        if (current) current[field] = updated[field];
        status.textContent = '已保存';
        if (!state.profileDirty) {
          showSaveIndicator(syncTargetLabel('作品已同步到网站', '作品已保存'), false);
        }
      })
      .catch(function (error) {
        // 作品刚被删除时，这次迟到的自动保存不再提示失败。
        if (
          !state.works.some(function (item) {
            return item.id === id;
          })
        ) {
          return;
        }
        status.textContent = '保存失败';
        status.classList.add('is-error');
        showToast(error && error.message ? error.message : '作品信息保存失败', true);
      });
  }

  function findEditorCard(id) {
    if (!els.worksList) return null;
    var cards = els.worksList.querySelectorAll('.work-editor');
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].getAttribute('data-id') === id) return cards[i];
    }
    return null;
  }

  /* 站点的 html 上有 scroll-behavior: smooth，直接 scrollTo / scrollBy 会被渲染成一段动画：
     手动定位时画面会「滑」过去，量 FLIP 也会读到动画中途的位置。
     临时把平滑关掉、动完再恢复，用户自己的点击滚动仍然是平滑的。 */
  function withInstantScroll(action) {
    var root = document.documentElement;
    var previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    try {
      action();
    } finally {
      root.style.scrollBehavior = previousBehavior;
    }
  }

  function captureEditorRects() {
    var rects = {};
    if (!els.worksList) return rects;
    Array.prototype.slice
      .call(els.worksList.querySelectorAll('.work-editor'))
      .forEach(function (card) {
        rects[card.getAttribute('data-id')] = card.getBoundingClientRect();
      });
    return rects;
  }

  /* FLIP：排序后让每张卡片从原来的位置滑到新位置。
     先一次性量完所有卡片、再统一写样式：边量边写会让每张卡片的
     getBoundingClientRect 都触发一次强制同步布局（整个列表重排 N 次）。 */
  function playEditorFlip(previous) {
    if (reduceMotion || !els.worksList) return;
    var cards = Array.prototype.slice.call(els.worksList.querySelectorAll('.work-editor'));

    var moves = [];
    cards.forEach(function (card) {
      var before = previous[card.getAttribute('data-id')];
      if (!before) return;
      var after = card.getBoundingClientRect();
      var delta = before.top - after.top;
      if (Math.abs(delta) < 2) return;
      moves.push({ card: card, delta: delta });
    });

    moves.forEach(function (move) {
      move.card.style.transition = 'none';
      move.card.style.transform = 'translateY(' + move.delta.toFixed(2) + 'px)';
    });

    if (!moves.length) return;

    window.requestAnimationFrame(function () {
      moves.forEach(function (move) {
        move.card.style.transition = 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)';
        move.card.style.transform = '';
      });
      window.setTimeout(function () {
        moves.forEach(function (move) {
          move.card.style.transition = '';
          move.card.style.transform = '';
        });
      }, 460);
    });
  }

  /* 记住当前滚动位置，以及焦点落在哪张卡片的哪个控件上。
     排序会把列表整个重建，重建前不记下来的话，焦点和滚动位置都会丢。 */
  function captureViewport() {
    var token = null;
    var active = document.activeElement;
    if (active && active.closest && els.worksList && els.worksList.contains(active)) {
      var card = active.closest('.work-editor');
      if (card) {
        token = {
          id: card.getAttribute('data-id'),
          action: active.getAttribute('data-action'),
          field: active.getAttribute('data-field')
        };
      }
    }
    return {
      x: window.pageXOffset || window.scrollX || 0,
      y: window.pageYOffset || window.scrollY || 0,
      token: token
    };
  }

  /* 依次还原滚动位置、再把焦点放回同一个小按钮上，
     这样连点「上移 / 下移」调顺序时手感是连续的。 */
  function restoreViewport(saved) {
    if (!saved) return;
    /* 站点的 html 上有 scroll-behavior: smooth，直接 scrollTo 会被渲染成一段动画：
       画面会「滑」回去，量 FLIP 时也会读到动画中途的位置。走瞬时滚动。 */
    withInstantScroll(function () {
      window.scrollTo(saved.x, saved.y);
    });

    if (!saved.token || !saved.token.id || !els.worksList) return;

    var card = null;
    Array.prototype.slice
      .call(els.worksList.querySelectorAll('.work-editor'))
      .some(function (item) {
        if (item.getAttribute('data-id') === saved.token.id) {
          card = item;
          return true;
        }
        return false;
      });
    if (!card) return;

    var selector = saved.token.action
      ? '[data-action="' + saved.token.action + '"]'
      : saved.token.field
        ? '[data-field="' + saved.token.field + '"]'
        : null;
    if (!selector) return;

    var next = card.querySelector(selector);
    if (!next || next.disabled || typeof next.focus !== 'function') return;
    try {
      next.focus({ preventScroll: true });
    } catch (error) {
      /* 老浏览器不认 preventScroll：宁可不还原焦点，也不要它自己滚屏 */
    }
  }

  function renderWorks(options) {
    if (!els.worksList) return;
    var previous = options && options.flip ? captureEditorRects() : null;
    /* 清空列表会让文档高度骤降，浏览器顺势把滚动位置夹回顶部 —— 这就是
       「点一下上移、画面猛地跳回最上面」的根因。先把滚动位置和焦点记下来，
       并把列表高度钉住，重建完再原样还原。 */
    var savedView = captureViewport();
    var pinnedHeight = els.worksList.getBoundingClientRect().height;

    // 先把挂起中的编辑落库，再动 DOM。
    flushPendingSaves();
    els.worksList.style.minHeight = pinnedHeight > 0 ? Math.round(pinnedHeight) + 'px' : '';
    clearNode(els.worksList);
    updateWorksTotal();

    if (!state.works.length) {
      if (els.worksEmpty) els.worksEmpty.hidden = false;
      state.rendered = true;
      state.freshIds = [];
      els.worksList.style.minHeight = '';
      restoreViewport(savedView);
      return;
    }

    if (els.worksEmpty) els.worksEmpty.hidden = true;

    /* 分成两组：待完善（刚导入、资料没填）和正式作品。
       待完善的排在最上面单独一块，不参与正式排序；
       点「完成」后 pending 清掉，才真正排到末尾。 */
    var pendingWorks = [];
    var doneWorks = [];
    state.works.forEach(function (work) {
      if (work && work.pending) pendingWorks.push(work);
      /* 待完善区按上传先后显示，不用 order（服务端会重排它）。 */
      else doneWorks.push(work);
    });

    // 首次渲染让全部卡片依次入场；之后只有新上传的作品入场。
    var entering = 0;
    var fragment = document.createDocumentFragment();

      /* 按上传先后显示待完善作品。 */
      pendingWorks.sort(function (a, b) {
        var sa = Number(a.pendingSeq) || 0;
        var sb = Number(b.pendingSeq) || 0;
        if (sa !== sb) return sa - sb;
        return (Number(a.order) || 0) - (Number(b.order) || 0);
      });

    if (pendingWorks.length) {
      fragment.appendChild(createPendingSection(pendingWorks));
    }

    doneWorks.forEach(function (work, index) {
      var isFresh = !state.rendered || state.freshIds.indexOf(work.id) !== -1;
      fragment.appendChild(createWorkEditor(work, index, isFresh ? entering : -1));
      if (isFresh) entering += 1;
    });
    els.worksList.appendChild(fragment);

    state.rendered = true;
    state.freshIds = [];
    els.worksList.style.minHeight = '';

    /* 先还原滚动位置，再量 FLIP 的位移：反过来的话，量到的差值里会混进
       「跳回顶部」那一段，卡片就会朝错误方向飞。 */
    restoreViewport(savedView);

    if (previous) playEditorFlip(previous);
  }

  async function reorderWork(id, direction) {
    if (state.ordering || state.busy) return;
    var index = state.works.findIndex(function (work) {
      return work.id === id;
    });
    if (index < 0) return;
    var target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= state.works.length) return;

    var previous = state.works.slice();
    var next = state.works.slice();
    var moved = next.splice(index, 1)[0];
    next.splice(target, 0, moved);
    var ids = next.map(function (work) {
      return work.id;
    });

    state.ordering = true;
    markSelfWrite();
    try {
      await Store.reorderWorks(ids);
      state.works = next;
      state.works.forEach(function (work, position) {
        work.order = position;
      });
      // 不用动缩略图 URL：复用同一批 URL，重建时缩略图不会重新解码。
      renderWorks({ flip: true });
      showSaveIndicator('作品顺序已更新', false);
    } catch (error) {
      state.works = previous;
      showToast(error && error.message ? error.message : '排序失败，请重试', true);
    } finally {
      state.ordering = false;
    }
  }

  /* ---------- 长按拖拽排序 ----------
     ↑ / ↓ 一次只挪一格，作品一多就很难受（尤其目标隔了十几个位置）。
     这里再加一条路：在卡片上按住约 0.3 秒就进入拖拽，卡片跟着指针走，
     松手就落在当前位置；拖到屏幕上下边缘会自动滚动，方便跨很远调顺序。
     两条路共用同一套保存逻辑，按钮照旧可用。

     流畅度上守三条规矩：
     ① 指针事件只「记账」，量尺寸 / 挪 DOM / 写样式全部放到每帧一次；
     ② 每帧先把要用的矩形一次量完，再统一写 —— 不边量边写，避免反复同步布局；
     ③ 换位要越过中线再加一点余量（DRAG_HYSTERESIS），
        否则指针停在两格交界处会来回插拔，每次都触发整列表重排。 */

  var DRAG_HOLD_MS = 320; /* 按住多久算长按 */
  /* 长按成立前允许的抖动。手机上手指按下去几乎不可能完全不动，
     触点本身也有 1~2px 的抖动，原来 8px 太严 ——
     结果是一按就开始滚屏、长按永远不成立，看着像「手机拖不动」。
     桌面留 8px（鼠标很稳），触屏放宽到 16px。 */
  var DRAG_SLOP = 8;
  var DRAG_SLOP_TOUCH = 16;
  var DRAG_EDGE = 96; /* 进入视口上下这个范围开始自动滚动 */
  var DRAG_MAX_STEP = 20; /* 自动滚动最快每帧多少像素 */
  var DRAG_HYSTERESIS = 16; /* 越过中线这么多像素才换位，防止边界来回抖 */

  /* 触屏判定：pointerType 在部分老浏览器里是空的，用能力兜底。 */
  function isTouchPointer(event) {
    if (event && event.pointerType) return event.pointerType === 'touch' || event.pointerType === 'pen';
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  }

  var dragState = { pending: null, active: null, suppressClickUntil: 0, savedScrollBehavior: '' };

  /* 卡片里的按钮、链接、输入框、下拉都不算拖拽区域，
     否则想点按钮或者定位光标时会误触发拖拽。 */
  function isDragSource(node) {
    if (!node || !node.closest) return false;
    /* 拖动把手永远可以拖，即使它在按钮里 */
    if (node.closest('[data-drag-handle]')) return true;
    return !node.closest('button, a, input, select, textarea, label, [contenteditable="true"]');
  }

  /* 按在把手上：不用等长按，立刻开始拖。
     这是手机上的主力路径 —— 手指在把手上滑动，浏览器不会当成滚动。 */
  function isDragHandle(node) {
    return Boolean(node && node.closest && node.closest('[data-drag-handle]'));
  }

  function cardFromNode(node) {
    if (!node || !node.closest || !els.worksList) return null;
    var card = node.closest('.work-editor');
    if (!card || !els.worksList.contains(card)) return null;
    return card;
  }

  function draggableCards() {
    if (!els.worksList) return [];
    return Array.prototype.slice.call(els.worksList.querySelectorAll('.work-editor'));
  }

  function clearPendingDrag() {
    if (dragState.pending && dragState.pending.timer) {
      window.clearTimeout(dragState.pending.timer);
    }
    dragState.pending = null;
  }

  function onDragPointerDown(event) {
    if (event.button && event.button !== 0) return; /* 只认左键（触摸时是 0） */
    if (dragState.pending || dragState.active) return;
    if (state.ordering || state.busy || state.deleting) return;
    if (!isDragSource(event.target)) return;
    var card = cardFromNode(event.target);
    if (!card) return;

    /* 触屏：长按期间浏览器随时可能因为「这是滑动」而发 pointercancel，
       一旦取消，后面的 move 全收不到 —— 这就是手机上拖不动的根本原因。
       这里在按下时就阻止默认行为（配合 CSS 的 touch-action: none），
       让浏览器把这段手势完全交给我们处理。 */
    if (isTouchPointer(event)) {
      try {
        event.preventDefault();
      } catch (error) {
        /* 被动监听时无法阻止，交给下面的兜底 */
      }
    }

    var pending = {
      pointerId: event.pointerId,
      card: card,
      startX: event.clientX,
      startY: event.clientY,
      touch: isTouchPointer(event),
      timer: 0
    };

    /* 按在拖动把手上、或者用的是鼠标：不需要长按，直接开始拖。
       只有「手指按在卡片其它地方」才需要长按 0.3 秒，
       这样普通滑动滚动页面不受影响。 */
    var instant = isDragHandle(event.target) || !isTouchPointer(event);
    if (instant) {
      /* 必须先挂到 dragState.pending 上再调 startDrag ——
         startDrag 开头会校验 dragState.pending === pending，
         不挂就等于自己把自己拦掉了（手机拖不动就是这里）。 */
      dragState.pending = pending;
      startDrag(pending);
      return;
    }

    pending.timer = window.setTimeout(function () {
      startDrag(pending);
    }, DRAG_HOLD_MS);
    dragState.pending = pending;
  }

  function onDragPointerMove(event) {
    var pending = dragState.pending;
    if (pending && event.pointerId === pending.pointerId) {
      /* 触屏用更宽松的阈值：手指的天然抖动不该被当成「我要滚动页面」。 */
      var slop = pending.touch ? DRAG_SLOP_TOUCH : DRAG_SLOP;
      if (
        Math.abs(event.clientX - pending.startX) > slop ||
        Math.abs(event.clientY - pending.startY) > slop
      ) {
        /* 长按还没成立指针就动了：这是普通点击或滚动，别抢 */
        clearPendingDrag();
      }
      return;
    }

    var active = dragState.active;
    if (!active || event.pointerId !== active.pointerId) return;
    /* 这里只更新位移和指针位置，真正的绘制交给每帧一次的 dragTick */
    active.translate += event.clientY - active.lastY;
    active.lastY = event.clientY;
    active.dirty = true;
  }

  function startDrag(pending) {
    if (!pending || dragState.pending !== pending) return;
    clearPendingDrag();

    var card = pending.card;
    var cards = draggableCards();
    var others = [];
    for (var i = 0; i < cards.length; i += 1) {
      /* 入场动画（.is-entering）的 keyframes 里也有 transform，而 CSS 动画会盖掉
         内联 transform：列表刚渲染完的那一秒里拖卡片，卡片是不跟手的。
         开拖时先把入场动画撤掉（去掉类即停，之后的出场动画不受影响）。 */
      if (cards[i].classList.contains('is-entering')) {
        cards[i].classList.remove('is-entering');
      }
      if (cards[i] !== card) others.push(cards[i]);
    }

    dragState.active = {
      pointerId: pending.pointerId,
      card: card,
      /* 其余卡片一次性查好：拖动过程中不再做 DOM 查询 */
      others: others,
      lastY: pending.startY,
      translate: 0,
      index: -1,
      dirty: true,
      frame: 0
    };
    card.classList.add('is-dragging');
    if (els.worksList) els.worksList.classList.add('is-dragging');
    document.body.classList.add('is-dragging-work');

    /* 拖动期间把整页的平滑滚动关掉：自动滚动每帧都要滚一次，
       带着 smooth 会排一串动画，既卡又对不上位置。松手时恢复原值。 */
    dragState.savedScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';

    /* 指针捕获：指针滑出列表甚至滑出窗口时，也还能收到 move/up */
    if (els.worksList && els.worksList.setPointerCapture) {
      try {
        els.worksList.setPointerCapture(pending.pointerId);
      } catch (error) {
        /* 不支持就算了，window 上的监听兜底 */
      }
    }

    updateDropIndex();
    paintDrag();
    dragState.active.frame = window.requestAnimationFrame(dragTick);
  }

  /* 每帧只做三件事：需要就重算落点、写位移、按需自动滚动 */
  function dragTick() {
    var active = dragState.active;
    if (!active) return;
    if (active.dirty) {
      active.dirty = false;
      /* 先量后写：updateDropIndex 内部只读矩形，必要挪一下 DOM；
         位移统一在这一帧的最后写一次。 */
      updateDropIndex();
      paintDrag();
    }
    autoScrollStep();
    active.frame = window.requestAnimationFrame(dragTick);
  }

  function paintDrag() {
    var active = dragState.active;
    if (!active) return;
    /* translate3d 让卡片走合成层，位移不再触发重排重绘 */
    active.card.style.transform = 'translate3d(0, ' + active.translate.toFixed(1) + 'px, 0)';
  }

  /* 落点判定：先把其余卡片的矩形一次量完，再决定插到第几个。
     顺序很重要 —— 全部读完再写 DOM，避免「量一次 → 写一次」反复触发同步布局。 */
  function updateDropIndex() {
    var active = dragState.active;
    if (!active) return;
    var others = active.others;
    var rects = [];
    var i;
    for (i = 0; i < others.length; i += 1) {
      rects.push(others[i].getBoundingClientRect());
    }

    var index = others.length;
    for (i = 0; i < rects.length; i += 1) {
      if (active.lastY < rects[i].top + rects[i].height / 2) {
        index = i;
        break;
      }
    }

    /* 抖动抑制：越过中线还不够，要再多走 DRAG_HYSTERESIS 像素才换位，
       否则指针停在两格交界处会来回插拔，每次都是整列表重排。 */
    if (index !== active.index && active.index >= 0) {
      if (index > active.index) {
        var below = rects[active.index];
        if (below && active.lastY < below.top + below.height / 2 + DRAG_HYSTERESIS) return;
      } else {
        var above = rects[index];
        if (above && active.lastY > above.top + above.height / 2 - DRAG_HYSTERESIS) return;
      }
    }
    if (index === active.index) return;

    /* 换位前后各量一次，把差补进位移里：卡片才会一直贴着指针，
       而不是换位瞬间「跳」一下。 */
    var before = active.card.getBoundingClientRect().top;
    var reference = others[index] || null;
    if (reference) els.worksList.insertBefore(active.card, reference);
    else els.worksList.appendChild(active.card);
    var after = active.card.getBoundingClientRect().top;
    active.translate -= after - before;
    active.index = index;
    refreshOrderLabels();
  }

  /* 列表顺序变了就顺手把序号和 ↑ / ↓ 的可用状态刷新一遍。
     只在真的变化时才写 DOM：拖动中每次都写 21 张卡片的文本会让布局反复失效。 */
  function refreshOrderLabels() {
    var cards = draggableCards();
    var last = cards.length - 1;
    cards.forEach(function (card, position) {
      var label = card.querySelector('.work-editor__index');
      if (label) {
        var next = String(position + 1).padStart(2, '0');
        if (label.textContent !== next) label.textContent = next;
      }
      var up = card.querySelector('[data-action="up"]');
      var down = card.querySelector('[data-action="down"]');
      if (up && up.disabled !== (position === 0)) up.disabled = position === 0;
      if (down && down.disabled !== (position === last)) down.disabled = position === last;
    });
  }

  /* 拖到视口上下边缘时自动滚动：滚了多少就给卡片补多少位移，它才一直贴着指针。
     拖动期间整页已经是 scroll-behavior: auto，所以这里是瞬时滚动，不会排队动画。 */
  function autoScrollStep() {
    var active = dragState.active;
    if (!active) return;
    var viewport = window.innerHeight || document.documentElement.clientHeight || 0;
    var y = active.lastY;
    var step = 0;
    if (y < DRAG_EDGE) {
      step = -Math.ceil(((DRAG_EDGE - y) / DRAG_EDGE) * DRAG_MAX_STEP);
    } else if (y > viewport - DRAG_EDGE) {
      step = Math.ceil(((y - (viewport - DRAG_EDGE)) / DRAG_EDGE) * DRAG_MAX_STEP);
    }
    if (!step) return;
    var beforeY = window.pageYOffset || window.scrollY || 0;
    window.scrollBy(0, step);
    var afterY = window.pageYOffset || window.scrollY || 0;
    active.translate += afterY - beforeY;
    paintDrag();
    active.dirty = true; /* 页面滚了，下一帧重新判一次落点 */
  }

  function finishDrag(commit) {
    var active = dragState.active;
    if (!active) return;
    dragState.active = null;
    if (active.frame) window.cancelAnimationFrame(active.frame);
    /* 恢复拖动前整页的滚动行为（通常是空字符串，也就是用 CSS 里的 smooth） */
    document.documentElement.style.scrollBehavior = dragState.savedScrollBehavior;

    var card = active.card;
    /* 松手后让卡片滑回它在列表里的位置，而不是啪一下归位 */
    card.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)';
    card.style.transform = '';
    window.setTimeout(function () {
      card.style.transition = '';
    }, 280);
    card.classList.remove('is-dragging');
    if (els.worksList) {
      els.worksList.classList.remove('is-dragging');
      if (els.worksList.releasePointerCapture) {
        try {
          els.worksList.releasePointerCapture(active.pointerId);
        } catch (error) {
          /* 指针已经不在列表上时会抛，忽略 */
        }
      }
    }
    document.body.classList.remove('is-dragging-work');

    /* 拖完松手时浏览器可能还会补一个 click，别让它误触到按钮上 */
    dragState.suppressClickUntil = Date.now() + 350;
    if (commit !== false) saveDragOrder();
  }

  /* 拖完只更新数据和状态，不重建列表：
     DOM 顺序已经是最终结果，重建会把滚动位置和缩略图再折腾一遍。 */
  function saveDragOrder() {
    var ids = draggableCards().map(function (card) {
      return card.getAttribute('data-id');
    });
    if (!ids.length) return;

    var current = state.works.map(function (work) {
      return work.id;
    });
    if (ids.join('|') === current.join('|')) return; /* 位置没变 */

    var byId = {};
    state.works.forEach(function (work) {
      byId[work.id] = work;
    });
    var next = [];
    ids.forEach(function (id) {
      if (byId[id]) next.push(byId[id]);
    });
    if (next.length !== state.works.length) return; /* 数据对不上就别乱存 */

    var previous = state.works;
    state.works = next;
    state.works.forEach(function (work, position) {
      work.order = position;
    });
    refreshOrderLabels();

    state.ordering = true;
    markSelfWrite();
    Store.reorderWorks(ids)
      .then(function () {
        showSaveIndicator('作品顺序已更新', false);
      })
      .catch(function (error) {
        state.works = previous;
        showToast(error && error.message ? error.message : '排序失败，请重试', true);
        renderWorks({ flip: true });
      })
      .then(function () {
        state.ordering = false;
      });
  }

  function setupWorkDragging() {
    if (!els.worksList || !window.PointerEvent) return;
    /* 关键：passive: false。浏览器的 pointer/touch 监听默认是「被动」的，
       被动监听里调 preventDefault() 会被忽略 —— 那就拦不住浏览器的滚动接管，
       手势依然会被 cancel，手机上依然拖不动。 */
    els.worksList.addEventListener('pointerdown', onDragPointerDown, { passive: false });
    /* move / up 挂在 window 上：指针滑出列表甚至滑出窗口也收得到 */
    window.addEventListener('pointermove', onDragPointerMove, true);
    window.addEventListener('pointerup', function (event) {
      if (dragState.pending && event.pointerId === dragState.pending.pointerId) {
        clearPendingDrag();
        return;
      }
      if (dragState.active && event.pointerId === dragState.active.pointerId) {
        finishDrag(true);
      }
    });
    window.addEventListener('pointercancel', function (event) {
      if (dragState.pending && event.pointerId === dragState.pending.pointerId) {
        clearPendingDrag();
      }
      if (dragState.active && event.pointerId === dragState.active.pointerId) {
        finishDrag(false);
      }
    });
    /* 拖动过程中别弹系统右键菜单 / 长按菜单 */
    els.worksList.addEventListener('contextmenu', function (event) {
      if (dragState.active) event.preventDefault();
    });
    /* 保险：一旦进入拖动，拦住 touchmove 的默认滚动（有些安卓 WebView
       只认 touch 事件，不认 pointer 的 preventDefault）。 */
    els.worksList.addEventListener(
      'touchmove',
      function (event) {
        if (dragState.active && event.cancelable) event.preventDefault();
      },
      { passive: false }
    );
  }

  async function deleteWorkItem(id) {
    if (state.deleting || state.busy) return;
    var work = state.works.find(function (item) {
      return item.id === id;
    });
    if (!work) return;
    var title = work.title || '这件作品';
    if (!window.confirm('删除《' + title + '》？此操作无法撤销。')) return;

    state.deleting = true;
    markSelfWrite();
    try {
      await Store.deleteWork(id);
      state.works = state.works.filter(function (item) {
        return item.id !== id;
      });

      // 先把卡片收起来，再重排列表，删除动作更连贯。
      var card = findEditorCard(id);
      if (card && !reduceMotion) {
        card.classList.add('is-leaving');
        await new Promise(function (resolve) {
          window.setTimeout(resolve, 240);
        });
      }

      pruneWorkUrls();
      renderWorks();
      updateStorageUsage();
      showToast('已删除《' + title + '》。');
      showSaveIndicator('作品已删除', false);
    } catch (error) {
      showToast(error && error.message ? error.message : '删除失败，请重试', true);
    } finally {
      state.deleting = false;
    }
  }

  function handleWorksListClick(event) {
    /* 刚拖完松手时浏览器可能补一个 click，这段时间里的点击一律忽略 */
    if (dragState.suppressClickUntil && Date.now() < dragState.suppressClickUntil) {
      dragState.suppressClickUntil = 0;
      event.preventDefault();
      return;
    }
    var button = event.target.closest('[data-action]');
    if (!button) return;
    var card = button.closest('.work-editor');
    if (!card) return;
    var id = card.getAttribute('data-id');
    if (!id) return;
    var action = button.getAttribute('data-action');

    if (action === 'up' || action === 'down') {
      reorderWork(id, action);
    } else if (action === 'delete') {
      deleteWorkItem(id);
    }
  }

  /* ---------- 上传 ---------- */

  function isQuotaError(error) {
    if (!error) return false;
    if (error.name === 'QuotaExceededError') return true;
    return /quota|storage|空间不足/i.test(String(error.message || ''));
  }

  function renderUploadErrors(errors) {
    if (!els.uploadErrors) return;
    clearNode(els.uploadErrors);
    if (!errors.length) {
      els.uploadErrors.hidden = true;
      return;
    }
    els.uploadErrors.hidden = false;
    errors.forEach(function (entry) {
      var p = document.createElement('p');
      p.textContent = '• ' + entry.name + '：' + entry.message;
      els.uploadErrors.appendChild(p);
    });
  }

  function updateProgress(completed, total, text) {
    if (els.uploadProgress) els.uploadProgress.hidden = false;
    var percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    if (els.uploadBar) {
      els.uploadBar.style.width = percent + '%';
      // 到 100% 就停掉流光动画，否则上传过一次之后它会一直扫到关页。
      els.uploadBar.classList.toggle('is-done', percent >= 100);
    }
    if (!els.uploadStatus) return;
    if (text) {
      els.uploadStatus.textContent = text;
    } else {
      els.uploadStatus.textContent = percent >= 100 ? '处理完成' : '已完成 ' + percent + '%';
    }
  }

  async function startUpload(fileList) {
    if (state.busy || !state.ready) return;
    if (isOnlineMode()) {
      showToast('这是线上公开版本，不能在这里上传。请在本机的工作室里操作。', true);
      return;
    }
    if (!state.canEdit) {
      showToast('只有运行网站的这台电脑可以添加作品。', true);
      return;
    }
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;

    state.busy = true;
    markSelfWrite();
    els.uploadZone.classList.add('is-busy');
    els.uploadZone.setAttribute('aria-busy', 'true');
    els.fileInput.disabled = true;
    if (els.uploadErrors) {
      els.uploadErrors.hidden = true;
      clearNode(els.uploadErrors);
    }

    // 本地模式下尽量让浏览器把作品数据标记为持久化存储，避免被自动清理。
    if (!canUploadHere() && Store.requestPersistence) {
      Store.requestPersistence().catch(function () {
        /* noop */
      });
    }

    var errors = [];
    /* 本次上传的递增序号：用来给待完善作品排一个稳定的先后。
       并发压缩时谁先完成不固定，但「你在选择框里选的第几张」是确定的。 */
    var pendingSeq = 0;
    var created = 0;
    var freshIds = [];
    var nextOrder =
      state.works.reduce(function (max, work) {
        return Math.max(max, Number.isFinite(work.order) ? work.order : -1);
      }, -1) + 1;
    var total = files.length;
    var stoppedForQuota = false;
    var verb = canUploadHere() ? '正在上传 ' : '正在处理 ';
    var cloud = isCloudMode();
    /* 云端模式一次并发传 3 张：每张要经历「压缩 → 传图 → 写数据」，
       串行传 5 张要等半分钟；并发 3 路能把总时间压到 1/3 左右。
       不并发更多是因为手机上传带宽有限，再多反而互相抢。 */
      /* 一次只压一张：canvas 编码是 CPU 密集的，三张同时压会把主线程占满，
         表现就是「上传时界面卡住」。串行压缩 + 每张压完立刻刷新，反而更顺。 */
      var CONCURRENCY = 1;

    updateProgress(0, total, '准备上传…');

    async function handleOne(file, index) {
      updateProgress(index, total, verb + (index + 1) + ' / ' + total + '：' + file.name);
      try {
        var derivatives = await Store.createDerivatives(file);
        var record = {
          id: Store.randomId(),
          title: Store.titleFromFilename(file.name),
          en: '',
          year: String(new Date().getFullYear()),
          location: state.profile ? state.profile.location : '',
          category: '',
          composition: '',
          caption: '',
          width: derivatives.width,
          height: derivatives.height,
          displayBlob: derivatives.displayBlob,
          thumbBlob: derivatives.thumbBlob,
          displayType: derivatives.displayType,
          thumbType: derivatives.thumbType,
          pending: 1,
          /* 用全局递增序号保证「先选的照片排在前面」：
             并发时 index 到达顺序不固定，所以用 pendingSeq 自增。 */
          pendingSeq: pendingSeq++,
          /* order 仍给一个正常值：服务端 sortStoreWorks 会把 order 重排成 0..n-1，
             负数会被抹平。待完善作品的先后改用 pendingSeq 记录，不依赖 order。 */
          order: nextOrder + index,
        };
        await Store.addWork(record);
        created += 1;
        /* 每完成一张就刷新一下列表：用户能立刻看到作品出现，
           不用等全部传完（以前要等整批结束才刷，感觉像卡住了）。 */
        try {
          await loadWorks();
        } catch (refreshError) {
          /* 刷新失败不影响上传本身 */
        }
        freshIds.push(record.id);
      } catch (error) {
        var message = error && error.message ? error.message : '处理失败';
        errors.push({ name: file.name || '未命名文件', message: message });
        if (isQuotaError(error)) {
          stoppedForQuota = true;
          errors.push({
            name: '存储空间',
            message: '浏览器本地空间不足。请删除部分作品，或换用空间更充足的浏览器后再试。'
          });
        }
      }
      updateProgress(created + errors.length, total, verb + (created + errors.length) + ' / ' + total + '…');
    }

    try {
      for (var start = 0; start < files.length; start += CONCURRENCY) {
        if (stoppedForQuota) break;
        var batch = files.slice(start, start + CONCURRENCY);
        await Promise.all(
          batch.map(function (file, offset) {
            return handleOne(file, start + offset);
          })
        );
      }
      nextOrder += created;

      // 新加入的作品在列表里做一次入场动效。
      state.freshIds = freshIds;

      try {
        await loadWorks();
      } catch (error) {
        /* loadWorks 内部已经处理错误 */
      }

      // 因空间不足中断时保留实际进度，不显示成已完成。
      if (!stoppedForQuota) updateProgress(total, total, '');
      var notAdded = files.length - created;
      var doneLabel = canUploadHere() ? '已上传 ' : '已添加 ';
      var finalHint = isCloudMode() ? '，已提交到网站，约半分钟后生效。' : canUploadHere() ? '，网站已更新。' : '。';
      if (els.uploadStatus) {
        if (created > 0) {
          els.uploadStatus.textContent =
            doneLabel + created + ' 件作品' + (notAdded ? '，' + notAdded + ' 件未能处理。' : finalHint);
        } else {
          els.uploadStatus.textContent = stoppedForQuota
            ? '没有添加作品：浏览器本地空间不足。'
            : '没有添加作品，请查看下方提示。';
        }
      }
      renderUploadErrors(errors);
    } finally {
      // 无论中途发生什么，都要把上传入口恢复回可点状态。
      state.busy = false;
      els.uploadZone.classList.remove('is-busy');
      els.uploadZone.removeAttribute('aria-busy');
      els.fileInput.disabled = false;
      els.fileInput.value = '';
    }

    if (created > 0) {
      showToast(
        isCloudMode()
          ? '已提交 ' + created + ' 件作品到网站，约半分钟后刷新就能看到。'
          : canUploadHere()
            ? '已上传 ' + created + ' 件作品，网站已实时更新。'
            : '已添加 ' + created + ' 件作品。'
      );
      refreshSyncBanner();
    } else if (errors.length) {
      showToast('作品未能添加，请查看错误提示。', true);
    }
  }

  function pickFiles() {
    if (state.busy) {
      // 视觉上有 is-busy，键盘用户也需要一句明确反馈。
      showToast('正在处理上一批照片，请稍候。', false);
      return;
    }
    if (!state.ready) return;
    els.fileInput.click();
  }

  /* ---------- 事件绑定 ---------- */

  function setupProfileEvents() {
    els.profileForm.addEventListener('submit', handleProfileSubmit);

    els.profileForm.addEventListener('input', function (event) {
      if (event.target === els.fieldName) {
        els.fieldName.setCustomValidity('');
        if (els.avatarInitial && !state.avatarDraft) {
          var currentName = els.fieldName.value.trim();
          els.avatarInitial.textContent = currentName ? Array.from(currentName)[0] : '光';
        }
      }
      if (event.target === els.fieldSiteName) {
        updateBrandName(els.fieldSiteName.value);
      }
      if (event.target === els.fieldWebsite) {
        els.fieldWebsite.setCustomValidity('');
      }
      markDirty();
      scheduleProfileAutoSave();
    });

    els.avatarChoose.addEventListener('click', function () {
      els.avatarInput.click();
    });

    els.avatarInput.addEventListener('change', function () {
      var file = els.avatarInput.files && els.avatarInput.files[0];
      if (file) handleAvatarFile(file);
      els.avatarInput.value = '';
    });

    els.avatarRemove.addEventListener('click', function () {
      state.avatarDraft = '';
      renderAvatar();
      markDirty();
      scheduleProfileAutoSave();
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.profileDirty && !pendingSaves.size && !state.busy) return;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });

    // 切到别的标签页 / 手机锁屏时立刻把还在防抖等待中的资料落下来。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'hidden' || !profileSaveTimer) return;
      window.clearTimeout(profileSaveTimer);
      profileSaveTimer = 0;
      saveProfileNow({ explicit: false });
    });
  }

  function setupUploadEvents() {
    els.uploadZone.addEventListener('click', pickFiles);

    els.uploadZone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pickFiles();
      }
    });

    els.fileInput.addEventListener('change', function () {
      var files = els.fileInput.files;
      if (files && files.length) startUpload(files);
    });

    ['dragenter', 'dragover'].forEach(function (name) {
      els.uploadZone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!state.busy) els.uploadZone.classList.add('is-dragover');
      });
    });

    els.uploadZone.addEventListener('dragleave', function (event) {
      event.preventDefault();
      if (!els.uploadZone.contains(event.relatedTarget)) {
        els.uploadZone.classList.remove('is-dragover');
      }
    });

    els.uploadZone.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      els.uploadZone.classList.remove('is-dragover');
      if (state.busy) return;
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) startUpload(files);
    });

    // 防止文件被拖到页面其它位置时浏览器直接打开图片。
    window.addEventListener('dragover', function (event) {
      event.preventDefault();
    });
    window.addEventListener('drop', function (event) {
      if (!els.uploadZone.contains(event.target)) event.preventDefault();
    });
  }

  function setupWorksEvents() {
    els.worksList.addEventListener('click', handleWorksListClick);
    setupWorkDragging();

    /* 批量操作栏的按钮 */
    var bulkDeleteEl = document.getElementById('bulkDelete');
    if (bulkDeleteEl) {
      bulkDeleteEl.addEventListener('click', deletePickedWorks);
    }
    var bulkClearEl = document.getElementById('bulkClear');
    if (bulkClearEl) {
      bulkClearEl.addEventListener('click', clearPicks);
    }
    updateBulkBar();
  }

  function cacheElements() {
    els.profileForm = $('#profileForm');
    els.fieldSiteName = $('#fieldSiteName');
    els.fieldName = $('#fieldName');
    els.fieldEnglishName = $('#fieldEnglishName');
    els.fieldRole = $('#fieldRole');
    els.fieldTagline = $('#fieldTagline');
    els.fieldBio = $('#fieldBio');
    els.fieldLocation = $('#fieldLocation');
    els.fieldSince = $('#fieldSince');
    els.fieldEmail = $('#fieldEmail');
    els.fieldWechat = $('#fieldWechat');
    els.fieldQq = $('#fieldQq');
    els.fieldInstagram = $('#fieldInstagram');
    els.fieldDouyin = $('#fieldDouyin');
    els.fieldXiaohongshu = $('#fieldXiaohongshu');
    els.fieldWebsite = $('#fieldWebsite');
    els.avatarImage = $('#avatarImage');
    els.avatarInitial = $('#avatarInitial');
    els.avatarChoose = $('#avatarChoose');
    els.avatarRemove = $('#avatarRemove');
    els.avatarInput = $('#avatarInput');
    els.saveProfileButton = $('#saveProfileButton');
    els.profileStatus = $('#profileStatus');
    els.saveIndicator = $('#saveIndicator');
    els.studioBrandName = $('#studioBrandName');
    els.syncMode = $('#syncMode');
    els.syncBanner = $('#syncBanner');
    els.syncBannerText = $('#syncBannerText');
    els.syncBannerAction = $('#syncBannerAction');
    els.footerNote = $('#footerNote');
    els.lockScreen = $('#lockScreen');
    els.lockScreenText = $('#lockScreenText');
    els.lockRetry = $('#lockRetry');
    els.studioMain = $('#studioMain');
    els.studioLocked = $('#studioLocked');

    els.uploadZone = $('#uploadZone');
    els.fileInput = $('#fileInput');
    els.uploadProgress = $('#uploadProgress');
    els.uploadBar = $('#uploadBar');
    els.uploadStatus = $('#uploadStatus');
    els.uploadErrors = $('#uploadErrors');
    els.storageWarning = $('#storageWarning');
    els.worksList = $('#worksList');
    els.worksEmpty = $('#worksEmpty');
    els.worksTotal = $('#worksTotal');
    els.storageUsage = $('#storageUsage');
    els.footerYear = $('#footerYear');
    els.toast = $('#toast');
  }

  /* ---------- 云端连接（手机编辑） ---------- */

  var Cloud = window.PortfolioCloud || null;

  /* 什么时候该显示「连接」卡片：
     - 这台设备还没配好令牌；
     - 页面是从「线上地址」打开的（本地文件 / 本机服务器不走这条路）。
     本机服务器模式（http://muqiuchen/、127.0.0.1）保持原来的「只有这台电脑能改」，
     因为在电脑上双击「启动网站.cmd」的人就是站长本人。 */
  function needsCloudSetup() {
    if (!Cloud || typeof Cloud.canWrite !== 'function') return false;
    if (Cloud.canWrite()) return false;
    var protocol = window.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    // 本机 / 局域网的服务器版本：沿用原来的逻辑，不弹连接卡片。
    if (isLocalServerHost()) return false;
    if (Store && typeof Store.isCloud === 'function' && Store.isCloud()) return false;
    return true;
  }

  function isLocalServerHost() {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'muqiuchen' || host === 'muqiuchen.local') {
      return true;
    }
    if (host === '[::1]' || host === '::1') return true;
    if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    return false;
  }

  /* 测试开关：本机上想看「访客会看到什么」时，加 ?gate=1 就行。
     真实访客在线上访问时没有令牌，自动就会走到连接卡片。 */
  function gateForcedByQuery() {
    try {
      return /[?&]gate=1\b/.test(window.location.search);
    } catch (error) {
      return false;
    }
  }

  function setupCloudSetup() {
    document.body.classList.add('is-cloud-gate');
    var setup = document.getElementById('cloudSetup');
    var main = document.getElementById('studioMain');
    if (setup) setup.hidden = false;
    if (main) main.classList.add('is-gated');

    var form = document.getElementById('cloudForm');
    var tokenField = document.getElementById('fieldToken');
    var ownerField = document.getElementById('fieldOwner');
    var repoField = document.getElementById('fieldRepo');
    var branchField = document.getElementById('fieldBranch');
    var status = document.getElementById('cloudStatus');
    var connect = document.getElementById('cloudConnect');
    var skip = document.getElementById('cloudSkip');

    var config = Cloud.getConfig ? Cloud.getConfig() : {};
    if (ownerField) ownerField.value = config.owner || '';
    if (repoField) repoField.value = config.repo || '';
    if (branchField) branchField.value = config.branch || 'main';

    /* 生成令牌的链接带上预填参数：GitHub 支持 name / expires_in / 描述，
       打开后名字和有效期已经填好，用户只要选仓库、勾权限。
       （GitHub 不允许通过 URL 预选仓库和权限，这两步仍要手点。）
       expires_in 留空 = No expiration（永不过期）。 */
    var genLink = document.getElementById('tokenGenerateLink');
    if (genLink) {
      var params = [
        'name=' + encodeURIComponent('muqiuchen-shouji'),
        'description=' + encodeURIComponent('手机上改作品集'),
        'expires_in='
      ];
      genLink.href = 'https://github.com/settings/personal-access-tokens/new?' + params.join('&');
    }

    /* 令牌输入框：聚焦时如果剪贴板里有一串 github_pat_，给个「粘贴」提示。
       手机上手动长按粘贴挺费劲，这一步能省不少事。 */
    var tokenInput = document.getElementById('fieldToken');
    if (tokenInput && navigator.clipboard && navigator.clipboard.readText) {
      tokenInput.addEventListener('focus', function once() {
        tokenInput.removeEventListener('focus', once);
        navigator.clipboard
          .readText()
          .then(function (text) {
            var value = String(text || '').trim();
            if (/^github_pat_[A-Za-z0-9_]+$/.test(value) && !tokenInput.value) {
              tokenInput.value = value;
              setStatus('已经从剪贴板粘好了，点「连接」即可');
            }
          })
          .catch(function () {
            /* 没有剪贴板权限就算了，用户自己粘 */
          });
      });
    }

    function setStatus(text, isError) {
      if (!status) return;
      status.textContent = text || '';
      status.classList.toggle('is-error', Boolean(isError));
    }

    if (skip) {
      skip.addEventListener('click', function () {
        window.location.href = 'index.html';
      });
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var token = tokenField ? tokenField.value.trim() : '';
        if (!token) {
          setStatus('请先粘贴 GitHub 令牌', true);
          if (tokenField) tokenField.focus();
          return;
        }

        Cloud.configure({
          token: token,
          owner: (ownerField && ownerField.value.trim()) || config.owner,
          repo: (repoField && repoField.value.trim()) || config.repo,
          branch: (branchField && branchField.value.trim()) || 'main'
        });

        if (connect) connect.disabled = true;
        setStatus('正在验证令牌…');

        Cloud.probe().then(function (result) {
          if (connect) connect.disabled = false;
          if (!result.ok) {
            setStatus(result.error || '连不上仓库，请检查网络或令牌', true);
            return;
          }
          if (!result.writable) {
            setStatus(result.reason || '这个令牌没有写入权限', true);
            return;
          }
          setStatus('连接成功，正在打开工作室…');
          // 令牌存好之后整页重载：store.js 启动时就会走进 cloud 模式。
          window.setTimeout(function () {
            window.location.reload();
          }, 400);
        });
      });
    }
  }

  /* ---------- 云端面板：清理、断开 ---------- */

  function setupCloudPanel() {
    var toolbar = document.getElementById('cloudToolbar');
    var panel = document.getElementById('cloudPanel');
    var info = document.getElementById('cloudPanelInfo');
    var note = document.getElementById('cloudPanelNote');
    var close = document.getElementById('cloudPanelClose');
    var forget = document.getElementById('cloudForget');
    var clean = document.getElementById('cloudCleanOrphans');

    if (!panel) return;

    /* 注意：这个函数在 Store.ready 之前就会被调用，那时 getMode() 还是初始值。
       所以这里用 canWrite() 判断（它只看有没有令牌，不依赖异步探测结果），
       等 Store.ready 之后再由 syncCloudUI() 补一次。 */
    function refreshVisibility() {
      var writable = Boolean(Cloud && Cloud.canWrite && Cloud.canWrite());
      if (toolbar) toolbar.hidden = !writable;
      if (!writable) panel.hidden = true;
      return writable;
    }

    refreshVisibility();
    window.__muqSyncCloudUI = refreshVisibility;

    function refreshInfo() {
      if (!info) return;
      var cfg = Cloud.getConfig ? Cloud.getConfig() : {};
      var rate = Cloud.getRateLimit ? Cloud.getRateLimit() : {};
      var parts = [];
      parts.push('仓库：' + (cfg.owner || '') + '/' + (cfg.repo || '') + '（' + (cfg.branch || 'main') + '）');
      if (rate.limit) parts.push('本小时还剩 ' + rate.remaining + ' / ' + rate.limit + ' 次接口调用');
      info.textContent = parts.join('　·　');
    }

    if (toolbar) {
      toolbar.addEventListener('click', function () {
        var willShow = panel.hidden;
        panel.hidden = !willShow;
        if (willShow) refreshInfo();
      });
    }

    if (close) {
      close.addEventListener('click', function () {
        panel.hidden = true;
      });
    }

    if (clean) {
      clean.addEventListener('click', function () {
        clean.disabled = true;
        if (note) note.textContent = '正在检查 media/ 目录…';
        Cloud.purgeOrphanMedia().then(
          function (result) {
            clean.disabled = false;
            if (note) {
              note.textContent = result.removed
                ? '清理完成：删掉 ' + result.removed + ' 张没被用到的图片。'
                : '很干净：没有多余的图片（共 ' + result.total + ' 个文件）。';
            }
          },
          function (error) {
            clean.disabled = false;
            if (note) note.textContent = '清理失败：' + (error && error.message ? error.message : '未知原因');
          }
        );
      });
    }

    if (forget) {
      forget.addEventListener('click', function () {
        var yes = window.confirm('断开后这台设备就变成普通访客，只能看不能改。确定吗？');
        if (!yes) return;
        Cloud.forgetToken();
        window.location.reload();
      });
    }
  }

  /* 页头的「装到主屏」按钮 */
  function setupInstallButton() {
    var button = document.getElementById('installApp');
    if (!button) return;
    if (window.PortfolioInstall && window.PortfolioInstall.available()) button.hidden = false;
    button.addEventListener('click', function () {
      if (!window.PortfolioInstall) return;
      window.PortfolioInstall.prompt().then(function (outcome) {
        if (outcome === 'unavailable') {
          showToast('这个浏览器没有提供安装入口，可以用菜单里的「添加到主屏幕」。');
        } else if (outcome === 'accepted') {
          showToast('已装到主屏，下次从桌面图标进来就是全屏的。');
        }
      });
    });
  }

  async function init() {
    cacheElements();

    if (!Store) {
      showToast('数据模块没有成功载入，请刷新页面重试。', true);
      return;
    }

    // 没连过云端的设备先停在「连接」卡片上，不加载整套后台。
    if (needsCloudSetup() || gateForcedByQuery()) {
      setupCloudSetup();
      return;
    }

    // 先用本地资料立即填充并绑定表单，避免异步读取 IndexedDB 期间
    // 用户按回车触发浏览器默认提交而刷新页面。
    state.profile = Store.getProfile();
    fillProfileForm(state.profile);
    setupProfileEvents();
    setupUploadEvents();
    setupWorksEvents();
    renderSyncMode();
    listenForChanges();
    bindLockEvents();
    refreshAccess();
    setupCloudPanel();
    setupInstallButton();

    if (typeof Store.getProfileAsync === 'function') {
      Store.getProfileAsync()
        .then(function (profile) {
          if (state.profileDirty || state.profileSaving) return;
          state.profile = profile;
          fillProfileForm(profile);
        })
        .catch(function () {
          /* 保持本地资料 */
        });
    }

    // 等第一批作品读取完成后再允许上传，避免新作品的排序被旧数据覆盖。
    els.uploadZone.classList.add('is-busy');
    loadWorks()
      .catch(function (error) {
        if (window.console && window.console.error) window.console.error(error);
        showToast('作品列表没有成功载入，请刷新后重试。', true);
      })
      .finally(function () {
        state.ready = true;
        if (!state.busy) els.uploadZone.classList.remove('is-busy');
        renderSyncMode();
        refreshSyncBanner();
        if (isOnlineMode()) applyOnlineLock();
      });

    if (els.footerYear) els.footerYear.textContent = String(new Date().getFullYear());
    if (Store.ready && typeof Store.ready.then === 'function') {
      Store.ready.then(function () {
        state.modeReady = true;
        renderSyncMode();
        refreshAccess();
        // 模式这时才确定，云端面板的显示要再刷一次。
        if (typeof window.__muqSyncCloudUI === 'function') window.__muqSyncCloudUI();
        if (isOnlineMode()) {
          applyOnlineLock();
          updateStorageUsage();
          refreshSyncBanner();
          return;
        }
        if (els.footerNote) {
          els.footerNote.textContent = isCloudMode()
            ? '资料与作品直接存到你的 GitHub 仓库，改完约半分钟网站自动更新；电脑不用开机。'
            : isServerMode()
              ? '资料与作品保存在这台电脑上；在「启动网站.cmd」打开的网址里，手机与电脑看到的是同一份内容，改动实时同步。'
              : '当前是本地模式（作品只在这个浏览器里）。用「启动网站.cmd」打开网址即可与手机共享同一份内容。';
        }
        updateStorageUsage();
        refreshSyncBanner();
      });
    }

    window.addEventListener('pagehide', releaseAdminUrls);
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) {
        loadWorks();
        refreshSyncBanner();
      }
    });
  }

  init().catch(function (error) {
    if (window.console && window.console.error) window.console.error(error);
    showToast('工作室页面没有成功载入，请刷新后重试。', true);
  });
})();
