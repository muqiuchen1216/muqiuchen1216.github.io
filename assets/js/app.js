/* =========================================================
   muqiuchen — 作品集首页交互
   ========================================================= */
(function () {
  'use strict';

  var DATA = window.PORTFOLIO_DATA || { profile: {}, demos: [] };
  var Store = window.PortfolioStore;
  var DEMOS = Array.isArray(DATA.demos) ? DATA.demos : [];
  var CATEGORY_LABELS = {
    cinematic: '电影感',
    'cinematic-outdoor': '外景 + 电影感',
    composite: '大合成',
    onlocation: '场照',
    studio: '棚拍',
    outdoor: '外景'
  };
  /* 组合类型（外景 + 电影感）在卡片与筛选里用同一种金色标记，
     和另外两个独立类型区分开。 */
  var COMBO_CATEGORIES = { 'cinematic-outdoor': true };
  var COMPOSITION_LABELS = {
    landscape: '横构图',
    portrait: '竖构图'
  };

  var state = {
    works: [],
    visibleWorks: [],
    demo: false,
    objectUrls: [],
    loadToken: 0,
    layoutFrame: 0,
    lastWidth: 0,
    galleryReady: false,
    needsRefresh: false,
    filterComposition: 'all',
    filterCategory: 'all',
    filterYear: 'all'
  };

  var els = {};

  /* 首页卡片缓存（work.id → {card, url}）。切换筛选时复用同一批节点，
     图片不必重新解码；每次重新读取作品（objectURL 会换新）时清空。 */
  var cardCache = new Map();

  var lb = {
    open: false,
    index: 0,
    token: 0,
    trigger: null,
    scrollY: 0,
    scale: 1,
    tx: 0,
    ty: 0,
    pointers: new Map(),
    gesture: null,
    lastPoint: null,
    historyPushed: false,
    dragX: 0,
    /* 灯箱尺寸缓存：拖动时不再每次都读 clientWidth（那会强制同步布局）。 */
    imageW: 0,
    imageH: 0,
    stageW: 0,
    stageH: 0
  };

  /* 灯箱相关的定时器句柄：翻页会不断新建，必须显式清理。 */
  var lbReadyTimer = 0;
  var lbPreloadTimers = [];

  var toastTimer = 0;
  var worksRefreshTimer = 0;
  var liveBadgeTimer = 0;

  /* 二次优化：动效偏好与一次性状态 */
  var reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var supportsHover =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var countFrame = 0;
  var revealObserver = null;
  var navObserver = null;
  var navVisibility = {};
  var activeTilt = null;
  var metaSwapTimer = 0;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function safeText(value, fallback) {
    var text = value === null || value === undefined ? '' : String(value).trim();
    return text || fallback || '';
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

  function getProfile() {
    if (Store && typeof Store.getProfile === 'function') {
      try {
        return Store.getProfile();
      } catch (error) {
        /* 使用默认资料 */
      }
    }
    return Object.assign({}, DATA.profile || {});
  }

  function refreshProfile() {
    if (Store && typeof Store.getProfileAsync === 'function') {
      Store.getProfileAsync()
        .then(function (profile) {
          renderProfile(profile);
        })
        .catch(function () {
          renderProfile(getProfile());
        });
    } else {
      renderProfile(getProfile());
    }
  }

  /* ---------- 资料渲染 ---------- */

  function renderProfile(profile) {
    var siteName = safeText(profile.siteName, 'muqiuchen');
    var name = safeText(profile.name, siteName);
    var tagline = safeText(profile.tagline);
    var role = safeText(profile.role);
    var location = safeText(profile.location);
    var since = safeText(profile.since);
    var englishName = safeText(profile.englishName);
    var bio = safeText(profile.bio);
    var email = safeText(profile.email).replace(/\s+/g, '');
    var instagram = Store && Store.normalizeInstagram ? Store.normalizeInstagram(profile.instagram) : '';
    var douyin = Store && Store.parseSocial ? Store.parseSocial(profile.douyin, 'douyin') : null;
    var xiaohongshu = Store && Store.parseSocial ? Store.parseSocial(profile.xiaohongshu, 'xiaohongshu') : null;
    var wechat = safeText(profile.wechat);
    var qq = safeText(profile.qq);
    var website = Store && Store.normalizeWebsite ? Store.normalizeWebsite(profile.website) : '';

    $all('[data-profile]').forEach(function (element) {
      var field = element.getAttribute('data-profile');
      var value =
        field === 'siteName'
          ? siteName
          : field === 'name'
            ? name
            : field === 'englishName'
              ? englishName
              : field === 'tagline'
                ? tagline
                : field === 'role'
                  ? role
                  : field === 'location'
                    ? location
                    : field === 'since'
                      ? since
                      : '';
      element.textContent = value;
      if (!value && field !== 'name' && field !== 'siteName') {
        element.hidden = true;
      } else {
        element.hidden = false;
      }
    });

    [els.sidebarBased, els.sectionLocation, els.contactLocation, els.metaLocation, els.metaSince].forEach(
      function (element) {
        if (!element) return;
        if (element === els.metaSince) element.hidden = !since;
        else element.hidden = !location;
      }
    );

    /* 站点名称里已经带「摄影 / 作品集」这类词时就不再补一个「摄影」，
       否则会变成「光与影 · 沐秋晨作品集 摄影」这种别扭的标题。
       副标题恰好就是「光与影」时也不重复拿它当摘要。 */
    var nameHasRole = /(摄影|影像|作品集|摄影集|画廊|工作室)$/i.test(siteName);
    var brand = '光与影 · ' + siteName + (nameHasRole ? '' : ' 摄影');
    var summary = tagline && tagline !== '光与影' ? tagline : '记录光与影之间的片刻。';

    document.title = brand;
    var description = $('meta[name="description"]');
    if (description) {
      description.setAttribute('content', brand + '。' + summary);
    }
    var ogTitle = $('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', brand);
    var ogDescription = $('meta[property="og:description"]');
    if (ogDescription) ogDescription.setAttribute('content', summary);

    // 简介段落
    if (els.aboutBio) {
      clearNode(els.aboutBio);
      var paragraphs = bio
        .split(/\n\s*\n/)
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
      if (!paragraphs.length) {
        els.aboutBio.hidden = true;
      } else {
        els.aboutBio.hidden = false;
        paragraphs.forEach(function (text) {
          var p = document.createElement('p');
          p.textContent = text;
          els.aboutBio.appendChild(p);
        });
      }
    }

    // 微信：联系区里的主信息（原来这里是邮箱），点一下复制号码
    if (wechat && els.contactWechat) {
      els.contactWechat.textContent = wechat;
      els.contactWechat.setAttribute('aria-label', '复制微信号：' + wechat);
      els.contactWechat.hidden = false;
      if (els.contactWechatHint) els.contactWechatHint.hidden = false;
    } else {
      if (els.contactWechat) els.contactWechat.hidden = true;
      if (els.contactWechatHint) els.contactWechatHint.hidden = true;
    }

    // 邮箱：换到下面那排联系卡片里（原来微信待的位置）
    if (email && els.aboutEmail) {
      els.aboutEmail.textContent = email;
      els.aboutEmail.href = 'mailto:' + email;
      if (els.metaEmail) els.metaEmail.hidden = false;
    } else if (els.metaEmail) {
      els.metaEmail.hidden = true;
    }

    // Instagram
    if (instagram && els.aboutInstagram) {
      els.aboutInstagram.textContent = '@' + instagram;
      els.aboutInstagram.href = 'https://instagram.com/' + encodeURIComponent(instagram);
      if (els.metaInstagram) els.metaInstagram.hidden = false;
      if (els.contactInstagram) {
        els.contactInstagram.href = els.aboutInstagram.href;
        els.contactInstagram.hidden = false;
      }
      if (els.sideInstagram) {
        els.sideInstagram.href = els.aboutInstagram.href;
        els.sideInstagram.hidden = false;
      }
    } else {
      if (els.metaInstagram) els.metaInstagram.hidden = true;
      if (els.contactInstagram) els.contactInstagram.hidden = true;
      if (els.sideInstagram) els.sideInstagram.hidden = true;
    }

    renderSocial('douyin', douyin, els.metaDouyin, els.aboutDouyin, els.contactDouyin, els.sideDouyin);
    renderSocial(
      'xiaohongshu',
      xiaohongshu,
      els.metaXiaohongshu,
      els.aboutXiaohongshu,
      els.contactXiaohongshu,
      els.sideXiaohongshu
    );

    // 个人网站
    if (website && els.aboutWebsite && els.contactWebsite) {
      var label = website;
      try {
        var parsed = new URL(website);
        label = parsed.hostname.replace(/^www\./i, '') + (parsed.pathname === '/' ? '' : parsed.pathname);
      } catch (error) {
        label = website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      }
      els.aboutWebsite.textContent = label;
      els.aboutWebsite.href = website;
      els.contactWebsite.href = website;
      if (els.metaWebsite) els.metaWebsite.hidden = false;
      els.contactWebsite.hidden = false;
    } else {
      if (els.metaWebsite) els.metaWebsite.hidden = true;
      if (els.contactWebsite) els.contactWebsite.hidden = true;
    }

    // 微信 / QQ 没有公开主页，只显示账号；联系区里的卡片可以点击复制。
    if (els.aboutWechat) els.aboutWechat.textContent = wechat;
    if (els.metaWechat) els.metaWechat.hidden = !wechat;
    if (els.aboutQq) els.aboutQq.textContent = qq;
    if (els.metaQq) els.metaQq.hidden = !qq;

    renderContactCards(xiaohongshu, douyin, qq, email);

    // 头像
    if (els.aboutPortrait && els.aboutAvatar) {
      if (typeof profile.avatar === 'string' && profile.avatar) {
        els.aboutAvatar.src = profile.avatar;
        els.aboutAvatar.alt = name + ' 的肖像';
        els.aboutPortrait.hidden = false;
        els.aboutGrid.classList.add('has-portrait');
      } else {
        els.aboutAvatar.removeAttribute('src');
        els.aboutPortrait.hidden = true;
        els.aboutGrid.classList.remove('has-portrait');
      }
    }
  }

  function renderSocial(platform, parsed, wrapper, aboutLink, contactLink, sideLink) {
    if (parsed && parsed.href && parsed.href.indexOf('http') === 0) {
      var label = parsed.handle ? '@' + parsed.handle : '主页';
      if (aboutLink) {
        aboutLink.textContent = label;
        aboutLink.href = parsed.href;
      }
      if (wrapper) wrapper.hidden = false;
      if (contactLink) {
        contactLink.hidden = false;
        contactLink.href = parsed.href;
      }
      if (sideLink) {
        sideLink.hidden = false;
        sideLink.href = parsed.href;
      }
    } else {
      if (wrapper) wrapper.hidden = true;
      if (contactLink) contactLink.hidden = true;
      if (sideLink) sideLink.hidden = true;
    }
  }

  /* ---------- 联系卡片：小红书 / 微信 / QQ / 抖音 ---------- */

  var CONTACT_ICONS = {
    xiaohongshu:
      '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><path d="M9 12.5h7M9 16.5h4.5"/>',
    wechat:
      '<path d="M12 20.5a8.5 8.5 0 1 0-7.6-4.7L3.3 20.7l4.9-1.2a8.4 8.4 0 0 0 3.8.9Z"/><circle cx="8.6" cy="11.6" r=".7"/><circle cx="12" cy="11.6" r=".7"/><circle cx="15.4" cy="11.6" r=".7"/>',
    email: '<path d="M3.5 6.8h17v10.4h-17z"/><path d="m3.5 7.4 8.5 6.2 8.5-6.2"/>',
    qq: '<circle cx="12" cy="8.6" r="4.1"/><path d="M4.8 20.4c1.6-3.8 4.2-5.7 7.2-5.7s5.6 1.9 7.2 5.7"/>',
    douyin:
      '<path d="M15 3.8v10.4a3.7 3.7 0 1 1-3.7-3.7c.2 0 .4 0 .6.1"/><path d="M15 3.8c.5 2.7 2.3 4.4 5.2 4.7"/>'
  };

  function copyText(text, label) {
    function done() {
      showToast(label + ' 已复制：' + text);
    }

    function fallback() {
      try {
        var field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.top = '-2000px';
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        document.body.removeChild(field);
        done();
      } catch (error) {
        showToast('复制失败，请手动记下：' + text, true);
      }
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function contactCard(key, label, value, options) {
    var settings = options || {};
    var item = document.createElement('li');
    item.className = 'contact-card';
    item.setAttribute('data-contact', key);

    var hit = document.createElement(settings.href ? 'a' : 'button');
    hit.className = 'contact-card__hit';
    if (settings.href) {
      hit.href = settings.href;
      hit.target = '_blank';
      hit.rel = 'noopener noreferrer';
    } else {
      hit.type = 'button';
      hit.setAttribute('aria-label', '复制' + label + '：' + value);
      hit.addEventListener('click', function () {
        copyText(value, label);
      });
    }

    var head = document.createElement('span');
    head.className = 'contact-card__head';

    var name = document.createElement('span');
    name.className = 'contact-card__label';
    name.textContent = label;

    var icon = document.createElement('span');
    icon.className = 'contact-card__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" focusable="false">' + (CONTACT_ICONS[key] || '') + '</svg>';

    head.appendChild(name);
    head.appendChild(icon);

    var text = document.createElement('span');
    text.className = 'contact-card__value';
    text.textContent = value;

    var hint = document.createElement('span');
    hint.className = 'contact-card__hint';
    hint.textContent = settings.hint || '';

    hit.appendChild(head);
    hit.appendChild(text);
    hit.appendChild(hint);
    item.appendChild(hit);

    return item;
  }

  function renderContactCards(xiaohongshu, douyin, qq, email) {
    var host = els.contactCards;
    if (!host) return;
    clearNode(host);

    var cards = [];

    if (xiaohongshu && xiaohongshu.href) {
      cards.push(
        contactCard('xiaohongshu', '小红书', xiaohongshu.handle ? '@' + xiaohongshu.handle : '打开主页', {
          href: xiaohongshu.href,
          hint: '打开主页'
        })
      );
    }

    // 邮箱接替微信原来的位置：微信已经升到上面那行大字当主信息了。
    if (email) cards.push(contactCard('email', '邮箱', email, { hint: '点击复制' }));

    if (qq) cards.push(contactCard('qq', 'QQ', qq.replace(/[^\d]/g, ''), { hint: '点击复制' }));

    if (douyin && douyin.href) {
      cards.push(
        contactCard('douyin', '抖音', douyin.handle ? '@' + douyin.handle : '打开主页', {
          href: douyin.href,
          hint: '打开主页'
        })
      );
    }

    cards.forEach(function (card) {
      host.appendChild(card);
    });

    host.hidden = !cards.length;
  }

  /* 联系区那行大字是微信号：点一下复制，跟上面的联系卡片一个套路 */
  function setupContactActions() {
    if (!els.contactWechat) return;
    els.contactWechat.addEventListener('click', function () {
      var value = (els.contactWechat.textContent || '').trim();
      if (value) copyText(value, '微信号');
    });
  }

  /* ---------- 作品数据 ---------- */

  /* 两种作品记录都要能渲染：
     - 服务器模式：带 displayUrl / thumbUrl 的远程记录；
     - 本地模式：带 Blob 的 IndexedDB 记录。 */
  function isRenderable(work) {
    if (!work || typeof work !== 'object') return false;
    var width = Number(work.width);
    var height = Number(work.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width <= 0 || height <= 0) return false;
    if (work.remote || typeof work.displayUrl === 'string') return Boolean(work.displayUrl);
    return work.displayBlob instanceof Blob;
  }

  function isPendingRemote(work) {
    return Boolean(work && work.remote && !work.displayUrl);
  }

  function makeWork(work, displayUrl, thumbUrl, isDemo) {
    var width = Math.max(1, Number(work.width) || 1);
    var height = Math.max(1, Number(work.height) || 1);
    var ratio = width / height;
    var composition = safeText(work.composition);
    var manualComposition = COMPOSITION_LABELS[composition] ? composition : '';
    return {
      id: work.id || 'work',
      title: safeText(work.title, '未命名作品'),
      en: safeText(work.en),
      year: safeText(work.year),
      location: safeText(work.location),
      category: safeText(work.category),
      categoryLabel: CATEGORY_LABELS[work.category] || '',
      composition: composition,
      compositionLabel: manualComposition ? COMPOSITION_LABELS[manualComposition] : '',
      orientation: manualComposition || autoOrientation(ratio),
      caption: safeText(work.caption),
      width: width,
      height: height,
      ratio: ratio,
      ratioLabel:
        Store && Store.formatRatio
          ? Store.formatRatio(width, height)
          : (width / height).toFixed(2) + ' : 1',
      fullUrl: displayUrl,
      thumbUrl: thumbUrl || displayUrl,
      demo: Boolean(isDemo)
    };
  }

  function hydrateStored(work) {
    if (!isRenderable(work)) return null;
    try {
      var displayBlob = work.displayBlob;
      var thumbBlob = work.thumbBlob instanceof Blob ? work.thumbBlob : displayBlob;
      var displayUrl = URL.createObjectURL(displayBlob);
      var thumbUrl = URL.createObjectURL(thumbBlob);
      state.objectUrls.push(displayUrl);
      if (thumbUrl !== displayUrl) state.objectUrls.push(thumbUrl);
      return makeWork(work, displayUrl, thumbUrl, false);
    } catch (error) {
      return null;
    }
  }

  /* 服务器上的作品直接使用 HTTP 地址，不再创建 objectURL。 */
  function hydrateRemote(work) {
    if (!isRenderable(work)) return null;
    return makeWork(work, work.displayUrl, work.thumbUrl || work.displayUrl, false);
  }

  function hydrateAny(work) {
    return work && (work.remote || typeof work.displayUrl === 'string')
      ? hydrateRemote(work)
      : hydrateStored(work);
  }

  function hydrateDemo(work) {
    var asset = safeText(work.asset);
    if (!asset) return null;
    return makeWork(work, asset, asset, true);
  }

  function releaseObjectUrls() {
    state.objectUrls.forEach(function (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        /* noop */
      }
    });
    state.objectUrls = [];
  }

  async function loadWorks() {
    if (!els.gallery) return;
    var token = ++state.loadToken;
    var stored = [];
    var readFailed = false;

    if (Store && typeof Store.getAllWorks === 'function') {
      try {
        stored = await Store.getAllWorks();
      } catch (error) {
        readFailed = true;
        stored = [];
      }
    } else {
      readFailed = true;
    }

    if (token !== state.loadToken) return;

    // 灯箱打开期间不释放正在显示的图片地址。
    if (lb.open) {
      state.needsRefresh = true;
      return;
    }

    if (!Array.isArray(stored)) stored = [];

    // 读取失败时不要把画面上已有的作品换成示例作品：
    // 服务器重启、多标签页占用数据库都会走到这里，作品其实还在。
    if (readFailed && state.works.length) {
      showToast('作品列表暂时没有读取成功，已保留当前内容。', true);
      return;
    }

    var renderable = stored.filter(isRenderable);
    var pendingRemote = stored.filter(isPendingRemote).length;
    var invalidCount = stored.length - renderable.length - pendingRemote;

    releaseObjectUrls();
    var hydrated = renderable.map(hydrateAny).filter(Boolean);
    invalidCount += renderable.length - hydrated.length;

    var useDemo = hydrated.length === 0;
    var works = useDemo ? DEMOS.map(hydrateDemo).filter(Boolean) : hydrated;

    state.works = works;
    state.demo = useDemo;
    state.galleryReady = false;
    // 这一批 objectURL 是新的，旧卡片引用的地址已经作废。
    cardCache.clear();

    if (readFailed) {
      showToast('本地作品读取失败，已显示示例作品。请检查浏览器存储权限，或改用「启动网站.cmd」。', true);
    } else if (invalidCount > 0) {
      showToast('有 ' + invalidCount + ' 件作品数据不完整，已自动跳过。', true);
    } else if (pendingRemote > 0) {
      showToast('有 ' + pendingRemote + ' 件作品还在上传中，稍后会自动出现。');
    }

    renderYearFilter();
    applyFilters();
  }

  function refreshWorks() {
    if (lb.open) {
      state.needsRefresh = true;
      return;
    }
    loadWorks().catch(function (error) {
      if (window.console && window.console.error) window.console.error(error);
      showToast('作品列表更新失败，请刷新页面重试。', true);
    });
  }

  function scheduleWorksRefresh() {
    window.clearTimeout(worksRefreshTimer);
    worksRefreshTimer = window.setTimeout(refreshWorks, 220);
  }

  function animateCount(element, target) {
    if (!element) return;
    var value = Math.max(0, Math.round(Number(target) || 0));
    var previous = Number(element.getAttribute('data-count'));
    if (!Number.isFinite(previous)) previous = 0;

    element.setAttribute('data-count', String(value));

    if (countFrame) {
      window.cancelAnimationFrame(countFrame);
      countFrame = 0;
    }

    if (reduceMotion || previous === value) {
      element.textContent = pad2(value);
      return;
    }

    var started = 0;
    var duration = 620;

    function step(now) {
      if (!started) started = now;
      var progress = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = pad2(Math.round(previous + (value - previous) * eased));
      if (progress < 1) {
        countFrame = window.requestAnimationFrame(step);
      } else {
        countFrame = 0;
        element.textContent = pad2(value);
      }
    }

    countFrame = window.requestAnimationFrame(step);
  }

  function updateWorkCount(count, isDemo) {
    animateCount(els.workCount, count);
    if (els.sampleNote) {
      els.sampleNote.hidden = !isDemo;
      els.sampleNote.textContent = isDemo ? '示例作品 · 上传后自动替换' : '';
    }
  }

  /* 只有横 / 竖两种构图，按比例一分二，保证每张都能被筛到。 */
  function autoOrientation(ratio) {
    return ratio >= 1 ? 'landscape' : 'portrait';
  }

  /* 手动选过的构图范围优先；没选过就按原图比例自动判断。 */
  function orientationOf(work) {
    if (work && work.orientation) return work.orientation;
    if (work && COMPOSITION_LABELS[work.composition]) return work.composition;
    return autoOrientation(work ? work.ratio : 1);
  }

  function renderYearFilter() {
    if (!els.filterYear) return;
    var years = [];
    state.works.forEach(function (work) {
      if (work.year && years.indexOf(work.year) === -1) years.push(work.year);
    });
    years.sort(function (a, b) {
      return String(b).localeCompare(String(a), 'zh-CN', { numeric: true });
    });

    if (state.filterYear !== 'all' && years.indexOf(state.filterYear) === -1) {
      state.filterYear = 'all';
    }

    clearNode(els.filterYear);
    [{ value: 'all', label: '全部' }]
      .concat(
        years.map(function (year) {
          return { value: year, label: year };
        })
      )
      .forEach(function (entry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'filter-pill';
        button.setAttribute('data-filter-group', 'year');
        button.setAttribute('data-filter-value', entry.value);
        button.textContent = entry.label;
        els.filterYear.appendChild(button);
      });

    updateFilterUI();
  }

  function updateFilterUI() {
    if (!els.filters) return;
    $all('.filter-pill', els.filters).forEach(function (button) {
      var group = button.getAttribute('data-filter-group');
      var value = button.getAttribute('data-filter-value');
      var active =
        (group === 'composition' && value === state.filterComposition) ||
        (group === 'category' && value === state.filterCategory) ||
        (group === 'year' && value === state.filterYear);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  /* 每颗筛选项上带一个数量：一眼能看出哪一类有多少张，
     也能看出新加的「外景 + 电影感」用了几次。 */
  function filterCount(group, value) {
    if (value === 'all') return state.works.length;
    return state.works.filter(function (work) {
      if (group === 'composition') return orientationOf(work) === value;
      if (group === 'category') return work.category === value;
      if (group === 'year') return work.year === value;
      return false;
    }).length;
  }

  function refreshFilterCounts() {
    if (!els.filters) return;
    $all('.filter-pill', els.filters).forEach(function (button) {
      var group = button.getAttribute('data-filter-group');
      var value = button.getAttribute('data-filter-value');
      if (!group || value === null) return;

      var label = button.getAttribute('data-label');
      if (label === null) {
        label = (button.textContent || '').trim();
        button.setAttribute('data-label', label);
      }

      var count = filterCount(group, value);
      var badge = button.querySelector('.filter-pill__count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'filter-pill__count';
        badge.setAttribute('aria-hidden', 'true');
        button.appendChild(badge);
      }
      var next = String(count);
      if (badge.textContent !== next) badge.textContent = next;
      button.setAttribute('data-count', next);
      button.setAttribute('aria-label', label + '：' + count + ' 幅');
      button.classList.toggle('is-empty', value !== 'all' && count === 0);
    });
  }

  function applyFilters() {
    var composition = state.filterComposition;
    var category = state.filterCategory;
    var year = state.filterYear;
    var visible = state.works.filter(function (work) {
      var matchesComposition = composition === 'all' || orientationOf(work) === composition;
      var matchesCategory = category === 'all' || work.category === category;
      var matchesYear = year === 'all' || work.year === year;
      return matchesComposition && matchesCategory && matchesYear;
    });

    state.visibleWorks = visible;
    updateFilterUI();
    refreshFilterCounts();
    renderGallery(visible, state.demo);
  }

  /* ---------- 单个作品 ---------- */

  function createCard(work, index) {
    var card = document.createElement('article');
    card.className = 'work-entry is-loading is-entering';
    card.setAttribute('data-index', String(index));
    card.setAttribute('data-category', work.category || '');
    // 组合类型（外景 + 电影感）在卡片上用金色细节点出来。
    card.classList.toggle('is-combo', Boolean(COMBO_CATEGORIES[work.category]));
    card.style.setProperty('--enter-i', String(Math.min(index, 12)));

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'work-entry__open';
    button.setAttribute('aria-label', '查看作品《' + work.title + '》');
    button.setAttribute('aria-haspopup', 'dialog');

    var image = document.createElement('img');
    image.className = 'work-entry__image';
    image.alt = work.title + (work.location ? '，' + work.location : '');
    image.width = work.width;
    image.height = work.height;
    image.loading = index < 3 ? 'eager' : 'lazy';
    image.decoding = 'async';

    var arrow = document.createElement('span');
    arrow.className = 'work-entry__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';

    var attempts = 0;

    function reveal() {
      if (card.classList.contains('is-broken')) return;
      card.classList.remove('is-loading');
    }

    function breakCard() {
      card.classList.remove('is-loading');
      card.classList.add('is-broken');
      button.disabled = true;
      if (image.parentNode) image.parentNode.removeChild(image);
      if (arrow.parentNode) arrow.parentNode.removeChild(arrow);
      if (button.querySelector('.work-entry__fallback')) return;
      var fallback = document.createElement('span');
      fallback.className = 'work-entry__fallback';
      var name = document.createElement('b');
      name.textContent = work.title;
      var note = document.createElement('span');
      note.textContent = '图像暂不可用';
      fallback.appendChild(name);
      fallback.appendChild(note);
      button.appendChild(fallback);
    }

    image.addEventListener('load', reveal);
    image.addEventListener('error', function () {
      attempts += 1;
      if (attempts === 1 && work.thumbUrl !== work.fullUrl) {
        image.src = work.fullUrl;
        return;
      }
      breakCard();
    });

    button.appendChild(image);
    card.appendChild(button);
    /* 箭头挂在卡片上，这样图片倾斜时箭头保持水平；点击仍然穿透到按钮。 */
    card.appendChild(arrow);

    var meta = document.createElement('div');
    meta.className = 'work-entry__meta';

    var info = document.createElement('div');
    info.className = 'work-entry__info';

    var indexLabel = document.createElement('span');
    indexLabel.className = 'work-entry__index';
    indexLabel.textContent = pad2(index + 1);

    var title = document.createElement('h2');
    title.className = 'work-entry__title';
    title.textContent = work.title;

    var sub = document.createElement('p');
    sub.className = 'work-entry__sub';
    sub.textContent = [work.year, work.location, work.categoryLabel].filter(Boolean).join(' · ');

    info.appendChild(indexLabel);
    info.appendChild(title);
    info.appendChild(sub);

    var ratio = document.createElement('span');
    ratio.className = 'work-entry__ratio';
    ratio.textContent = work.ratioLabel;

    meta.appendChild(info);
    meta.appendChild(ratio);
    card.appendChild(meta);

    image.src = work.thumbUrl;
    if (image.complete) {
      if (image.naturalWidth) reveal();
      else breakCard();
    }

    return card;
  }

  function renderGallery(works, isDemo) {
    if (!els.gallery) return;
    activeTilt = null;

    var firstPaint = !state.galleryReady;

    // 先按新顺序挑好节点：同一件作品沿用上次创建的卡片（只搬位置，
    // 不重新建 <img>，也就不会重新解码），只有新出现的作品才建新卡。
    var fragment = document.createDocumentFragment();
    works.forEach(function (work, index) {
      var cached = cardCache.get(work.id);
      if (cached && cached.url === work.thumbUrl) {
        cached.card.setAttribute('data-index', String(index));
        // 入场动效只在卡片第一次出现时播放，重排不该再闪一次。
        cached.card.classList.remove('is-entering');
        fragment.appendChild(cached.card);
        return;
      }
      if (cached) cardCache.delete(work.id);
      var card = createCard(work, index);
      cardCache.set(work.id, { card: card, url: work.thumbUrl });
      fragment.appendChild(card);
    });

    clearNode(els.gallery);
    els.gallery.appendChild(fragment);

    if (firstPaint) {
      // 淡入与高度重置只在首次出现时做；切筛选时画廊不该整块闪一下。
      els.gallery.classList.remove('is-ready');
      els.gallery.style.height = '';
      els.gallery.style.removeProperty('--caption-h');
      state.galleryReady = false;
    }

    updateWorkCount(works.length, isDemo);

    if (!works.length) {
      if (els.galleryStatus) {
        els.galleryStatus.classList.remove('is-hidden');
        clearNode(els.galleryStatus);

        if (state.works.length) {
          var emptyFilter = document.createElement('span');
          emptyFilter.textContent = '这个筛选下还没有作品。';
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'filter-clear';
          clear.textContent = '查看全部作品';
          clear.addEventListener('click', function () {
            state.filterComposition = 'all';
            state.filterCategory = 'all';
            state.filterYear = 'all';
            applyFilters();
          });
          els.galleryStatus.appendChild(emptyFilter);
          els.galleryStatus.appendChild(document.createElement('br'));
          els.galleryStatus.appendChild(clear);
        } else {
          var message = document.createElement('span');
          message.textContent = '还没有作品。';
          var link = document.createElement('a');
          link.href = 'studio.html';
          link.textContent = '去工作室上传第一张照片';
          link.style.display = 'inline-block';
          link.style.marginTop = '10px';
          els.galleryStatus.appendChild(message);
          els.galleryStatus.appendChild(document.createElement('br'));
          els.galleryStatus.appendChild(link);
        }
      }
      return;
    }

    if (els.galleryStatus) els.galleryStatus.classList.add('is-hidden');

    window.requestAnimationFrame(function () {
      layoutStream();
      els.gallery.classList.add('is-ready');
      state.galleryReady = true;
    });
  }

  /* ---------- 动态双列瀑布流 ----------
     每新增一件作品，都会依据它自己的宽高比生成新区域；
     没有任何预设的画幅格子。 */
  function layoutStream() {
    if (!els.gallery || !state.visibleWorks.length) return;
    var cards = $all('.work-entry', els.gallery);
    if (!cards.length) return;

    var width = els.gallery.clientWidth;
    if (!width) return;

    var columns = width < 320 ? 1 : 2;
    var columnGap = width >= 1100 ? 28 : width >= 640 ? 16 : 8;
    var verticalGap = width >= 640 ? 38 : 20;
    var captionHeight = width >= 980 ? 66 : width >= 640 ? 64 : 0;
    var columnWidth = (width - columnGap * (columns - 1)) / columns;
    var heights = [];
    var i;

    for (i = 0; i < columns; i += 1) heights.push(0);

    cards.forEach(function (card, index) {
      var work = state.visibleWorks[index];
      if (!work) return;

      var mediaHeight = columnWidth / work.ratio;
      var cardHeight = mediaHeight + captionHeight;
      var column = 0;

      for (var c = 1; c < columns; c += 1) {
        if (heights[c] < heights[column]) column = c;
      }

      var x = column * (columnWidth + columnGap);
      var y = heights[column];

      card.style.width = columnWidth.toFixed(3) + 'px';
      card.style.height = cardHeight.toFixed(3) + 'px';
      card.style.transform = 'translate3d(' + x.toFixed(3) + 'px,' + y.toFixed(3) + 'px,0)';

      var button = card.querySelector('.work-entry__open');
      if (button) button.style.height = mediaHeight.toFixed(3) + 'px';

      heights[column] += cardHeight + verticalGap;
    });

    els.gallery.style.setProperty('--caption-h', captionHeight + 'px');
    // 说明栏的显示与否交给同一个判断，避免 CSS 断点与画廊宽度错开。
    els.gallery.classList.toggle('is-compact', captionHeight === 0);
    els.gallery.style.height = Math.max(0, Math.max.apply(null, heights) - verticalGap).toFixed(3) + 'px';
    state.lastWidth = width;
  }

  function scheduleLayout() {
    if (state.layoutFrame) window.cancelAnimationFrame(state.layoutFrame);
    state.layoutFrame = window.requestAnimationFrame(function () {
      state.layoutFrame = 0;
      var width = els.gallery ? els.gallery.clientWidth : 0;
      if (width && width !== state.lastWidth && state.galleryReady) layoutStream();
    });
  }

  function setupGalleryResize() {
    if (!els.gallery) return;

    if ('ResizeObserver' in window) {
      var observer = new ResizeObserver(function () {
        scheduleLayout();
      });
      observer.observe(els.gallery);
    }

    window.addEventListener('resize', scheduleLayout, { passive: true });
    window.addEventListener(
      'orientationchange',
      function () {
        window.setTimeout(scheduleLayout, 220);
      },
      { passive: true }
    );
  }

  /* ---------- 灯箱 ---------- */

  function setBackgroundInert(enabled) {
    var targets = [document.querySelector('.site-shell'), document.querySelector('.skip-link')];
    targets.forEach(function (element) {
      if (!element) return;
      if (enabled) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    });
  }

  function setLightboxMeta(work) {
    if (!work) return;
    var count = state.visibleWorks.length;
    els.lbCounter.textContent = pad2(lb.index + 1) + ' / ' + pad2(count);
    els.lbRatio.textContent = work.ratioLabel;
    var kicker = [work.categoryLabel, work.compositionLabel].filter(Boolean).join(' · ');
    els.lbKicker.textContent = (kicker ? kicker + ' · ' : '') + '作品 ' + pad2(lb.index + 1);
    els.lbTitle.textContent = work.title || '未命名作品';
    els.lbTitleEn.textContent = work.en || '';
    els.lbTitleEn.hidden = !work.en;
    els.lbDesc.textContent = work.caption || '';
    els.lbLocation.textContent = work.location || '';
    els.lbYear.textContent = work.year || '';
    var dot = $('.lightbox__dot', els.lightbox);
    if (dot) dot.hidden = !(work.location && work.year);
    els.lbImage.alt = work.title
      ? '作品《' + work.title + '》' + (work.location ? '，' + work.location : '')
      : '作品大图';
    els.lbPrev.hidden = count < 2;
    els.lbNext.hidden = count < 2;

    // 换图时让文字重新淡入一次，切换更有层次。
    if (els.lightboxMeta) {
      els.lightboxMeta.classList.remove('is-swapping');
      void els.lightboxMeta.offsetWidth;
      els.lightboxMeta.classList.add('is-swapping');
      window.clearTimeout(metaSwapTimer);
      metaSwapTimer = window.setTimeout(function () {
        if (els.lightboxMeta) els.lightboxMeta.classList.remove('is-swapping');
      }, 620);
    }
  }

  function resetZoom(animate) {
    lb.scale = 1;
    lb.tx = 0;
    lb.ty = 0;
    lb.dragX = 0;
    if (els.lbImage) {
      if (!animate) els.lbImage.classList.add('is-gesturing');
      els.lbImage.style.transform = 'translate3d(0,0,0) scale(1)';
      els.lbImage.classList.remove('is-zoomed');
      if (!animate) {
        window.requestAnimationFrame(function () {
          els.lbImage.classList.remove('is-gesturing');
        });
      }
    }
    if (els.lbZoom) {
      els.lbZoom.setAttribute('aria-pressed', 'false');
      els.lbZoom.setAttribute('aria-label', '放大图片');
    }
  }

  /* 只在图片就绪、开始一次手势这类时刻量一次尺寸；
     拖动过程中每帧都读 clientWidth 会让浏览器每帧强制重排。 */
  function measureLightboxMetrics() {
    if (!els.lbImage || !els.lbStage) return;
    lb.imageW = els.lbImage.clientWidth;
    lb.imageH = els.lbImage.clientHeight;
    lb.stageW = els.lbStage.clientWidth;
    lb.stageH = els.lbStage.clientHeight;
  }

  function clampPan(x, y) {
    if (!els.lbImage || !els.lbStage) return { x: 0, y: 0 };
    if (lb.scale <= 1.01) return { x: 0, y: 0 };
    if (!lb.imageW || !lb.imageH || !lb.stageW || !lb.stageH) measureLightboxMetrics();
    var imageWidth = lb.imageW * lb.scale;
    var imageHeight = lb.imageH * lb.scale;
    var maxX = Math.max(0, (imageWidth - lb.stageW) / 2);
    var maxY = Math.max(0, (imageHeight - lb.stageH) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y))
    };
  }

  function applyTransform() {
    if (!els.lbImage) return;
    var clamped = clampPan(lb.tx, lb.ty);
    lb.tx = clamped.x;
    lb.ty = clamped.y;
    var offsetX = lb.tx + (lb.dragX || 0);
    els.lbImage.style.transform =
      'translate3d(' +
      offsetX.toFixed(2) +
      'px,' +
      lb.ty.toFixed(2) +
      'px,0) scale(' +
      lb.scale.toFixed(4) +
      ')';
    els.lbImage.classList.toggle('is-zoomed', lb.scale > 1.01);
    if (els.lbZoom) {
      var zoomed = lb.scale > 1.01;
      els.lbZoom.setAttribute('aria-pressed', zoomed ? 'true' : 'false');
      els.lbZoom.setAttribute('aria-label', zoomed ? '缩小图片' : '放大图片');
    }
  }

  function toggleZoom() {
    if (!lb.open) return;
    if (lb.scale > 1.01) {
      resetZoom(true);
    } else {
      lb.scale = 2.25;
      lb.tx = 0;
      lb.ty = 0;
      els.lbImage.classList.remove('is-gesturing');
      applyTransform();
    }
  }

  function hideLoader() {
    if (els.lbLoader) els.lbLoader.classList.add('is-hidden');
  }

  function showLightboxError() {
    if (!els.lbError) return;
    hideLoader();
    els.lbError.hidden = false;
    els.lbImage.classList.remove('is-ready');
  }

  function showWork(index) {
    if (!lb.open || !state.visibleWorks.length) return;
    var count = state.visibleWorks.length;
    var nextIndex = ((index % count) + count) % count;
    var work = state.visibleWorks[nextIndex];

    lb.index = nextIndex;
    var token = ++lb.token;

    resetZoom(false);
    setLightboxMeta(work);

    els.lbError.hidden = true;
    els.lbLoader.classList.remove('is-hidden');
    els.lbImage.classList.remove('is-ready');
    els.lbImage.width = work.width;
    els.lbImage.height = work.height;
    els.lbImage.style.aspectRatio = work.width + ' / ' + work.height;

    var ready = false;

    function onReady() {
      if (token !== lb.token || !lb.open || ready) return;
      ready = true;
      hideLoader();
      els.lbImage.classList.add('is-ready');
      els.lbError.hidden = true;
      measureLightboxMetrics();
    }

    function onError() {
      if (token !== lb.token || !lb.open) return;
      ready = true;
      showLightboxError();
    }

    els.lbImage.onload = onReady;
    els.lbImage.onerror = onError;
    els.lbImage.src = work.fullUrl;

    if (els.lbImage.decode) {
      els.lbImage
        .decode()
        .then(onReady)
        .catch(function () {
          if (els.lbImage.complete && els.lbImage.naturalWidth) onReady();
          else if (els.lbImage.complete) onError();
        });
    }

    window.clearTimeout(lbReadyTimer);
    lbReadyTimer = window.setTimeout(function () {
      if (token === lb.token && lb.open && !ready && !els.lbImage.naturalWidth) onError();
    }, 15000);

    preloadNeighbours(nextIndex);
  }

  function preloadNeighbours(index) {
    if (state.visibleWorks.length < 2) return;
    lbPreloadTimers.forEach(window.clearTimeout);
    lbPreloadTimers = [];
    [-1, 1].forEach(function (offset) {
      var work =
        state.visibleWorks[
          (index + offset + state.visibleWorks.length) % state.visibleWorks.length
        ];
      if (!work || !work.fullUrl) return;
      lbPreloadTimers.push(
        window.setTimeout(function () {
          var image = new Image();
          image.decoding = 'async';
          image.src = work.fullUrl;
        }, 90)
      );
    });
  }

  /* 从当前筛选结果里随机打开一幅（灯箱已经打开时直接换一张）。 */
  function openRandomWork() {
    var count = state.visibleWorks.length;
    if (!count) {
      showToast(state.works.length ? '当前筛选下没有作品。' : '还没有可以打开的作品。', true);
      return;
    }

    var index = Math.floor(Math.random() * count);
    if (count > 1 && lb.open && index === lb.index) index = (index + 1) % count;

    if (lb.open) {
      showWork(index);
      return;
    }

    var trigger = null;
    if (els.gallery) {
      var card = els.gallery.querySelector('.work-entry[data-index="' + index + '"]');
      if (card) trigger = card.querySelector('.work-entry__open');
    }
    openLightbox(index, trigger);
  }

  function openLightbox(index, trigger) {
    if (lb.open || !state.visibleWorks.length) return;
    lb.trigger = trigger || null;
    lb.scrollY = window.scrollY;
    lb.open = true;

    if (window.history && typeof window.history.pushState === 'function') {
      try {
        window.history.pushState({ lightbox: true }, '');
        lb.historyPushed = true;
      } catch (error) {
        lb.historyPushed = false;
      }
    }

    document.documentElement.classList.add('lb-open');
    document.body.style.top = '-' + lb.scrollY + 'px';
    els.lightbox.removeAttribute('inert');
    els.lightbox.classList.add('is-open');
    els.lightbox.setAttribute('aria-hidden', 'false');
    setBackgroundInert(true);

    // 深色背景从被点中的那张照片的位置展开。
    var originX = 50;
    var originY = 50;
    if (trigger && typeof trigger.getBoundingClientRect === 'function') {
      var triggerRect = trigger.getBoundingClientRect();
      if (triggerRect.width && triggerRect.height && window.innerWidth && window.innerHeight) {
        originX = ((triggerRect.left + triggerRect.width / 2) / window.innerWidth) * 100;
        originY = ((triggerRect.top + triggerRect.height / 2) / window.innerHeight) * 100;
        // 随机打开时卡片可能在屏幕外，先夹到视口内，扩散才自然。
        originX = Math.min(100, Math.max(0, originX));
        originY = Math.min(100, Math.max(0, originY));
      }
    }
    els.lightbox.style.setProperty('--lb-origin-x', originX.toFixed(2) + '%');
    els.lightbox.style.setProperty('--lb-origin-y', originY.toFixed(2) + '%');
    els.lightbox.classList.remove('is-opening');
    if (!reduceMotion) {
      void els.lightbox.offsetWidth;
      els.lightbox.classList.add('is-opening');
      window.setTimeout(function () {
        if (els.lightbox) els.lightbox.classList.remove('is-opening');
      }, 720);
    }

    showWork(index);

    window.setTimeout(function () {
      if (lb.open && els.lbClose) els.lbClose.focus({ preventScroll: true });
    }, 30);
  }

  function closeLightbox(fromHistory) {
    if (!lb.open) return;
    var shouldGoBack = lb.historyPushed && !fromHistory;
    lb.historyPushed = false;
    lb.open = false;
    lb.token += 1;
    lb.pointers.clear();
    lb.gesture = null;
    // 关掉灯箱后不该再有超时/预载回调在跑。
    window.clearTimeout(lbReadyTimer);
    lbReadyTimer = 0;
    lbPreloadTimers.forEach(window.clearTimeout);
    lbPreloadTimers = [];
    resetZoom(false);

    els.lightbox.classList.remove('is-open');
    els.lightbox.classList.remove('is-opening');
    document.documentElement.classList.remove('lb-open');
    document.body.style.top = '';
    setBackgroundInert(false);

    var trigger = lb.trigger;
    lb.trigger = null;
    // 卡片可能已经被重新渲染（例如切换筛选之后），先确认它还在文档里。
    var connected =
      trigger && (typeof trigger.isConnected === 'boolean' ? trigger.isConnected : document.contains(trigger));
    if (connected && typeof trigger.focus === 'function') {
      trigger.focus({ preventScroll: true });
    }
    els.lightbox.setAttribute('inert', '');
    els.lightbox.setAttribute('aria-hidden', 'true');

    var previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, lb.scrollY);
    document.documentElement.style.scrollBehavior = previous;

    if (shouldGoBack) {
      try {
        window.history.back();
      } catch (error) {
        /* noop */
      }
    }

    if (state.needsRefresh) {
      state.needsRefresh = false;
      window.setTimeout(refreshWorks, 60);
    }
  }

  function navigateLightbox(delta) {
    if (!lb.open || state.visibleWorks.length < 2) return;
    showWork(lb.index + delta);
  }

  function onKeydown(event) {
    if (!lb.open) return;
    var key = event.key;

    if (key === 'Escape') {
      event.preventDefault();
      closeLightbox();
      return;
    }

    if (key === 'ArrowLeft') {
      event.preventDefault();
      navigateLightbox(-1);
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      navigateLightbox(1);
      return;
    }

    if (key === '+' || key === '=') {
      event.preventDefault();
      if (lb.scale <= 1.01) toggleZoom();
      return;
    }

    if (key === '-' || key === '_' || key === '0') {
      event.preventDefault();
      resetZoom(true);
      return;
    }

    if (key === 'Tab') {
      var focusables = $all('button, a[href]', els.lightbox).filter(function (element) {
        return !element.disabled && !element.hidden && element.offsetParent !== null;
      });
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = document.activeElement;

      if (!els.lightbox.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function distanceBetweenPointers() {
    var points = Array.from(lb.pointers.values());
    if (points.length < 2) return 1;
    var dx = points[0].x - points[1].x;
    var dy = points[0].y - points[1].y;
    return Math.max(1, Math.sqrt(dx * dx + dy * dy));
  }

  function setupLightboxGestures() {
    var stage = els.lbStage;
    if (!stage) return;

    stage.addEventListener('pointerdown', function (event) {
      if (!lb.open) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target.closest && event.target.closest('button, a')) return;

      // 手势开始时量一次尺寸，后面的每次移动都用缓存值。
      measureLightboxMetrics();

      lb.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      lb.lastPoint = { x: event.clientX, y: event.clientY };
      els.lbImage.classList.add('is-gesturing');

      if (lb.pointers.size === 1) {
        lb.gesture = {
          mode: lb.scale > 1.01 ? 'pan' : 'swipe',
          startX: event.clientX,
          startY: event.clientY,
          startTx: lb.tx,
          startTy: lb.ty,
          startTime: Date.now(),
          moved: false,
          downTarget: event.target
        };
        if (lb.gesture.mode === 'swipe') stage.classList.add('is-dragging');
      } else if (lb.pointers.size === 2) {
        lb.gesture = {
          mode: 'pinch',
          startScale: lb.scale,
          startDistance: distanceBetweenPointers(),
          startTx: lb.tx,
          startTy: lb.ty,
          startTime: Date.now(),
          moved: true,
          downTarget: null
        };
      }

      try {
        stage.setPointerCapture(event.pointerId);
      } catch (error) {
        /* noop */
      }
    });

    stage.addEventListener('pointermove', function (event) {
      if (!lb.open || !lb.pointers.has(event.pointerId)) return;
      lb.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      lb.lastPoint = { x: event.clientX, y: event.clientY };
      if (!lb.gesture) return;

      if (lb.pointers.size >= 2 && lb.gesture.mode === 'pinch') {
        event.preventDefault();
        var distance = distanceBetweenPointers();
        var factor = distance / Math.max(1, lb.gesture.startDistance);
        lb.scale = Math.min(4, Math.max(1, lb.gesture.startScale * factor));
        if (lb.scale <= 1.01) {
          lb.scale = 1;
          lb.tx = 0;
          lb.ty = 0;
        }
        applyTransform();
        return;
      }

      if (lb.pointers.size === 1) {
        var dx = event.clientX - lb.gesture.startX;
        var dy = event.clientY - lb.gesture.startY;

        if (lb.gesture.mode === 'pan' && lb.scale > 1.01) {
          event.preventDefault();
          lb.tx = lb.gesture.startTx + dx;
          lb.ty = lb.gesture.startTy + dy;
          if (Math.abs(dx) + Math.abs(dy) > 4) lb.gesture.moved = true;
          applyTransform();
        } else {
          // 未放大时左右拖动：图片跟手移动，松手后回弹或翻页。
          if (Math.abs(dx) > Math.abs(dy)) {
            event.preventDefault();
            lb.dragX = dx * 0.42;
            applyTransform();
          }
          if (Math.abs(dx) > 8 || Math.abs(dy) > 8) lb.gesture.moved = true;
        }
      }
    });

    function finishPointer(event) {
      if (!lb.pointers.has(event.pointerId)) return;
      var wasCancelled = event.type === 'pointercancel';
      lb.pointers.delete(event.pointerId);

      if (lb.pointers.size === 0) {
        var gesture = lb.gesture;
        var point = lb.lastPoint;

        if (gesture && !wasCancelled && point) {
          var dx = point.x - gesture.startX;
          var dy = point.y - gesture.startY;
          var duration = Date.now() - gesture.startTime;
          var isTap =
            !gesture.moved && duration < 500 && Math.abs(dx) < 10 && Math.abs(dy) < 10;

          if (isTap) {
            var onImage =
              gesture.downTarget === els.lbImage ||
              (els.lbImage.contains && els.lbImage.contains(gesture.downTarget));
            lb.gesture = null;
            lb.dragX = 0;
            stage.classList.remove('is-dragging');
            els.lbImage.classList.remove('is-gesturing');
            if (onImage) toggleZoom();
            else closeLightbox();
            return;
          }

          if (gesture.mode === 'swipe' && gesture.moved) {
            if (Math.abs(dx) > 52 && Math.abs(dx) > Math.abs(dy) * 1.2) {
              navigateLightbox(dx < 0 ? 1 : -1);
            } else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.2 && duration < 800) {
              closeLightbox();
            }
          }
        }

        lb.gesture = null;
        lb.dragX = 0;
        stage.classList.remove('is-dragging');
        els.lbImage.classList.remove('is-gesturing');
        if (lb.scale <= 1.01) {
          lb.scale = 1;
          lb.tx = 0;
          lb.ty = 0;
          applyTransform();
        }
      } else if (lb.pointers.size === 1) {
        var remaining = Array.from(lb.pointers.values())[0];
        lb.gesture = {
          mode: 'pan',
          startX: remaining.x,
          startY: remaining.y,
          startTx: lb.tx,
          startTy: lb.ty,
          startTime: Date.now(),
          moved: true,
          downTarget: null
        };
      }
    }

    stage.addEventListener('pointerup', finishPointer);
    stage.addEventListener('pointercancel', finishPointer);
    els.lbImage.addEventListener('contextmenu', function (event) {
      if (lb.open) event.preventDefault();
    });

    if (!('PointerEvent' in window)) {
      els.lbImage.addEventListener('click', function (event) {
        if (!lb.open) return;
        event.preventDefault();
        toggleZoom();
      });
      stage.addEventListener('click', function (event) {
        if (!lb.open) return;
        if (event.target === stage || event.target === els.lbLoader) closeLightbox();
      });
    }
  }

  function setupLightbox() {
    if (!els.lightbox) return;

    els.lbClose.addEventListener('click', function () {
      closeLightbox();
    });
    els.lbPrev.addEventListener('click', function () {
      navigateLightbox(-1);
    });
    els.lbNext.addEventListener('click', function () {
      navigateLightbox(1);
    });
    els.lbZoom.addEventListener('click', toggleZoom);
    if (els.lbRetry) {
      els.lbRetry.addEventListener('click', function () {
        showWork(lb.index);
      });
    }

    var main = $('.lightbox__main', els.lightbox);
    if (main) {
      main.addEventListener('click', function (event) {
        if (event.target === main) closeLightbox();
      });
    }

    setupLightboxGestures();
    document.addEventListener('keydown', onKeydown);

    window.addEventListener('popstate', function () {
      if (lb.open) closeLightbox(true);
    });

    window.addEventListener('resize', function () {
      // 视口变了，缓存的灯箱尺寸作废，下一次用到时重新量。
      lb.imageW = 0;
      lb.imageH = 0;
      lb.stageW = 0;
      lb.stageH = 0;
      if (lb.open && lb.scale > 1.01) applyTransform();
    });
  }

  /* =========================================================
     二次优化：入场、指针与滚动到视区时的动效
     ========================================================= */

  function setupReveal() {
    var targets = $all('[data-reveal]');
    if (!targets.length) return;

    function showAll() {
      targets.forEach(function (element) {
        element.classList.add('is-revealed');
      });
    }

    if (reduceMotion || !('IntersectionObserver' in window)) {
      showAll();
      return;
    }

    revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.06, rootMargin: '0px 0px -8% 0px' }
    );

    targets.forEach(function (element) {
      revealObserver.observe(element);
    });
  }

  /* 把大标题拆成单字（中文）与单词（西文），逐字升起。
     拆分会让父级的 letter-spacing 失效，所以先量出真实字距，
     再用每个字块的 margin-right 精确补回。 */
  function setupTitleMotion() {
    var title = els.worksTitle;
    if (!title || reduceMotion) return;

    var cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    var index = 0;
    var fragment = document.createDocumentFragment();

    function tokenize(text) {
      var tokens = [];
      var buffer = '';
      for (var i = 0; i < text.length; i += 1) {
        var char = text.charAt(i);
        if (/\s/.test(char)) {
          if (buffer) {
            tokens.push(buffer);
            buffer = '';
          }
          tokens.push(char);
        } else if (cjk.test(char)) {
          if (buffer) {
            tokens.push(buffer);
            buffer = '';
          }
          tokens.push(char);
        } else {
          buffer += char;
        }
      }
      if (buffer) tokens.push(buffer);
      return tokens;
    }

    function appendToken(parent, text) {
      if (!text) return;
      if (/^\s+$/.test(text)) {
        parent.appendChild(document.createTextNode(text));
        return;
      }
      var span = document.createElement('span');
      span.className = 'title-token';
      span.style.setProperty('--i', String(index));
      span.textContent = text;
      index += 1;
      parent.appendChild(span);
    }

    function fill(source, target) {
      Array.prototype.slice.call(source.childNodes).forEach(function (node) {
        if (node.nodeType === 3) {
          tokenize(node.textContent).forEach(function (text) {
            appendToken(target, text);
          });
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') {
          target.appendChild(document.createElement('br'));
          return;
        }
        var clone = node.cloneNode(false);
        target.appendChild(clone);
        fill(node, clone);
      });
    }

    fill(title, fragment);
    if (!index) return;

    var track = '';
    var fontSize = 0;
    try {
      var computed = window.getComputedStyle(title);
      track = computed.letterSpacing;
      fontSize = parseFloat(computed.fontSize) || 0;
    } catch (error) {
      track = '';
    }

    // 用 em 记录字距，这样缩小 / 放大窗口后依然对得上原来的排版。
    var trackPx = parseFloat(track);
    var trackValue =
      Number.isFinite(trackPx) && trackPx !== 0 && fontSize > 0
        ? (trackPx / fontSize).toFixed(4) + 'em'
        : '0px';
    title.style.setProperty('--title-track', trackValue);
    title.style.letterSpacing = '0';

    clearNode(title);
    title.appendChild(fragment);
    title.classList.add('is-split');
  }

  function clearTilt(element) {
    if (!element) return;
    element.style.removeProperty('--rx');
    element.style.removeProperty('--ry');
    element.style.removeProperty('--mx');
    element.style.removeProperty('--my');
  }

  function setupCardTilt() {
    if (!els.gallery || reduceMotion || !supportsHover) return;

    /* 指针每移动一次就量一次 rect、再写 4 个自定义属性，会造成
       「读布局 → 写样式」交替执行，浏览器只能每帧强制重排一次。
       这里改成：事件里只记位置，真正的测量与写入每帧最多做一次。 */
    var tiltFrame = 0;
    var tiltPoint = null;

    function paintTilt() {
      tiltFrame = 0;
      var target = activeTilt;
      var point = tiltPoint;
      if (!target || !point) return;

      if (!target.isConnected) {
        clearTilt(target);
        activeTilt = null;
        return;
      }

      var rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      var px = Math.min(1, Math.max(0, (point.x - rect.left) / rect.width));
      var py = Math.min(1, Math.max(0, (point.y - rect.top) / rect.height));

      target.style.setProperty('--mx', (px * 100).toFixed(2) + '%');
      target.style.setProperty('--my', (py * 100).toFixed(2) + '%');
      target.style.setProperty('--ry', ((px - 0.5) * 4.2).toFixed(3) + 'deg');
      target.style.setProperty('--rx', ((0.5 - py) * 3.4).toFixed(3) + 'deg');
    }

    function stopTilt() {
      if (tiltFrame) {
        window.cancelAnimationFrame(tiltFrame);
        tiltFrame = 0;
      }
      tiltPoint = null;
    }

    els.gallery.addEventListener(
      'pointermove',
      function (event) {
        var target =
          event.target && event.target.closest ? event.target.closest('.work-entry__open') : null;

        if (!target) {
          stopTilt();
          clearTilt(activeTilt);
          activeTilt = null;
          return;
        }

        if (activeTilt && activeTilt !== target) clearTilt(activeTilt);
        activeTilt = target;
        tiltPoint = { x: event.clientX, y: event.clientY };

        if (!tiltFrame) tiltFrame = window.requestAnimationFrame(paintTilt);
      },
      { passive: true }
    );

    els.gallery.addEventListener('pointerleave', function () {
      stopTilt();
      clearTilt(activeTilt);
      activeTilt = null;
    });
  }

  function setupNavHighlight() {
    var links = $all('.topbar__nav a');
    if (!links.length || !('IntersectionObserver' in window)) return;

    var byId = {};
    var sections = [];

    links.forEach(function (link) {
      var id = String(link.getAttribute('href') || '').replace(/^#/, '');
      var section = id ? document.getElementById(id) : null;
      if (!section) return;
      byId[id] = link;
      sections.push(section);
    });

    if (!sections.length) return;

    navObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          navVisibility[entry.target.id] = entry.isIntersecting ? entry.intersectionRatio : 0;
        });

        var bestId = '';
        var bestRatio = 0;
        Object.keys(navVisibility).forEach(function (id) {
          if (navVisibility[id] > bestRatio) {
            bestRatio = navVisibility[id];
            bestId = id;
          }
        });

        links.forEach(function (link) {
          link.classList.toggle('is-current', Boolean(bestId) && byId[bestId] === link);
        });
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1], rootMargin: '-12% 0px -58% 0px' }
    );

    sections.forEach(function (section) {
      navVisibility[section.id] = 0;
      navObserver.observe(section);
    });
  }

  /* ---------- 启动 ---------- */

  function setupGalleryClicks() {
    if (!els.gallery) return;
    els.gallery.addEventListener('click', function (event) {
      var button = event.target.closest('.work-entry__open');
      if (!button || button.disabled) return;
      var card = button.closest('.work-entry');
      if (!card) return;
      var index = Number(card.getAttribute('data-index'));
      if (!Number.isInteger(index)) return;
      openLightbox(index, button);
    });
  }

  function setupFilters() {
    if (!els.filters) return;
    els.filters.addEventListener('click', function (event) {
      var button = event.target.closest('.filter-pill');
      if (!button) return;
      var group = button.getAttribute('data-filter-group');
      var value = button.getAttribute('data-filter-value');
      if (group === 'composition') state.filterComposition = value;
      else if (group === 'category') state.filterCategory = value;
      else if (group === 'year') state.filterYear = value;
      else return;
      applyFilters();
    });
  }

  function setupRandomWork() {
    if (!els.randomWork) return;
    els.randomWork.addEventListener('click', function () {
      els.randomWork.classList.remove('is-picking');
      void els.randomWork.offsetWidth;
      els.randomWork.classList.add('is-picking');
      window.setTimeout(function () {
        if (els.randomWork) els.randomWork.classList.remove('is-picking');
      }, 460);
      openRandomWork();
    });
  }

  /* ---------- 实时更新状态 ---------- */

  function updateLiveBadge() {
    if (!els.liveBadge || !Store) return;
    var mode = typeof Store.getMode === 'function' ? Store.getMode() : 'local';
    var live = typeof Store.getLiveState === 'function' ? Store.getLiveState() : 'local';
    var text = '本地模式';
    var stateName = 'local';

    if (mode === 'server') {
      if (live === 'connected') {
        text = '实时同步';
        stateName = 'on';
      } else if (live === 'offline') {
        text = '已断开';
        stateName = 'off';
      } else {
        text = '连接中';
        stateName = 'wait';
      }
    } else if (mode === 'static') {
      text = '线上作品集';
      stateName = 'static';
    }

    els.liveBadge.setAttribute('data-state', stateName);
    if (els.liveBadgeText) els.liveBadgeText.textContent = text;
    els.liveBadge.title =
      mode === 'server'
        ? '这一页与电脑上的网站数据实时相连：工作室里的改动会自动出现在这里'
        : mode === 'static'
          ? '这是发布在互联网上的公开版本，所有人看到的都是同一批作品'
          : '当前是本地模式，数据只保存在这个浏览器里';
  }

  /* 线上公开版本不提供编辑入口：工作室链接隐藏，避免访客点进去看到只读页面。 */
  function applyModeToChrome() {
    if (!Store || typeof Store.getMode !== 'function') return;
    if (Store.getMode() !== 'static') return;
    var link = $('.topbar__studio');
    if (link) link.hidden = true;
  }

  function markLiveActivity(message) {
    if (!els.liveBadge) {
      updateLiveBadge();
      return;
    }
    els.liveBadge.classList.remove('is-fresh');
    void els.liveBadge.offsetWidth;
    els.liveBadge.classList.add('is-fresh');
    if (els.liveBadgeText) els.liveBadgeText.textContent = message;
    window.clearTimeout(liveBadgeTimer);
    liveBadgeTimer = window.setTimeout(function () {
      if (els.liveBadge) els.liveBadge.classList.remove('is-fresh');
      updateLiveBadge();
    }, 2600);
  }

  function listenForChanges() {
    // 数据层统一负责「同一浏览器的其它标签页」与「局域网里的其它设备」：
    // 服务器模式下走 SSE，本地模式下走 BroadcastChannel。
    if (Store && typeof Store.subscribe === 'function') {
      Store.subscribe(function (change) {
        if (!change) return;
        if (change.type === 'live') {
          if (!els.liveBadge || !els.liveBadge.classList.contains('is-fresh')) updateLiveBadge();
          return;
        }
        if (change.type === 'profile') {
          refreshProfile();
          markLiveActivity('资料已更新');
        } else if (change.type === 'works' || change.type === 'site') {
          if (lb.open) state.needsRefresh = true;
          else scheduleWorksRefresh();
          markLiveActivity('作品已更新');
        }
      });
    }

    if (Store && Store.ready && typeof Store.ready.then === 'function') {
      Store.ready.then(function () {
        updateLiveBadge();
        applyModeToChrome();
      });
    }
    updateLiveBadge();

    window.addEventListener('pageshow', function (event) {
      if (event.persisted && !lb.open) {
        refreshProfile();
        refreshWorks();
      }
    });
  }

  function cacheElements() {
    els.gallery = $('#gallery');
    els.galleryStatus = $('#galleryStatus');
    els.workCount = $('#workCount');
    els.randomWork = $('#randomWork');
    els.worksTitle = $('#works-title');
    els.sampleNote = $('#sampleNote');
    els.filters = $('#filters');
    els.filterComposition = $('#filterComposition');
    els.filterCategory = $('#filterCategory');
    els.filterYear = $('#filterYear');
    els.aboutGrid = $('#aboutGrid');
    els.aboutBio = $('#aboutBio');
    els.aboutEmail = $('#aboutEmail');
    els.aboutInstagram = $('#aboutInstagram');
    els.aboutDouyin = $('#aboutDouyin');
    els.aboutXiaohongshu = $('#aboutXiaohongshu');
    els.aboutWebsite = $('#aboutWebsite');
    els.metaEmail = $('#metaEmail');
    els.aboutWechat = $('#aboutWechat');
    els.metaWechat = $('#metaWechat');
    els.aboutQq = $('#aboutQq');
    els.metaQq = $('#metaQq');
    els.contactCards = $('#contactCards');
    els.metaInstagram = $('#metaInstagram');
    els.metaDouyin = $('#metaDouyin');
    els.metaXiaohongshu = $('#metaXiaohongshu');
    els.metaWebsite = $('#metaWebsite');
    els.metaLocation = $('#metaLocation');
    els.metaSince = $('#metaSince');
    els.aboutPortrait = $('#aboutPortrait');
    els.aboutAvatar = $('#aboutAvatar');
    els.contactWechat = $('#contactWechat');
    els.contactWechatHint = $('#contactWechatHint');
    els.contactInstagram = $('#contactInstagram');
    els.contactDouyin = $('#contactDouyin');
    els.contactXiaohongshu = $('#contactXiaohongshu');
    els.contactWebsite = $('#contactWebsite');
    els.sideInstagram = $('#sideInstagram');
    els.sideDouyin = $('#sideDouyin');
    els.sideXiaohongshu = $('#sideXiaohongshu');
    els.sectionLocation = $('.section-location');
    els.contactLocation = $('.contact__location');
    els.sidebarBased = $('.sidebar__based');
    els.sideYear = $('#sideYear');
    els.footerYear = $('#footerYear');
    els.toast = $('#toast');
    els.liveBadge = $('#liveBadge');
    els.liveBadgeText = $('#liveBadgeText');

    els.lightbox = $('#lightbox');
    els.lightboxMeta = $('#lbMeta');
    els.lbImage = $('#lbImage');
    els.lbLoader = $('#lbLoader');
    els.lbError = $('#lbError');
    els.lbRetry = $('#lbRetry');
    els.lbClose = $('#lbClose');
    els.lbPrev = $('#lbPrev');
    els.lbNext = $('#lbNext');
    els.lbZoom = $('#lbZoom');
    els.lbStage = $('#lbStage');
    els.lbCounter = $('#lbCounter');
    els.lbRatio = $('#lbRatio');
    els.lbKicker = $('#lbKicker');
    els.lbTitle = $('#lbTitle');
    els.lbTitleEn = $('#lbTitleEn');
    els.lbDesc = $('#lbDesc');
    els.lbLocation = $('#lbLocation');
    els.lbYear = $('#lbYear');
  }

  function init() {
    cacheElements();
    if (!els.gallery || !els.lightbox) return;

    var year = String(new Date().getFullYear());
    if (els.footerYear) els.footerYear.textContent = year;
    if (els.sideYear) els.sideYear.textContent = year;

    // 交互脚本已就绪：入场动效可以安全地依赖 .has-js。
    document.documentElement.classList.add('motion-ready');

    renderProfile(getProfile());
    refreshProfile();
    setupTitleMotion();
    setupFilters();
    setupRandomWork();
    setupContactActions();
    setupGalleryClicks();
    setupGalleryResize();
    setupLightbox();
    setupReveal();
    setupCardTilt();
    setupNavHighlight();
    listenForChanges();
    refreshWorks();
  }

  try {
    init();
  } catch (error) {
    if (window.console && window.console.error) window.console.error(error);
    showToast('页面有一部分内容没有成功载入，请刷新后重试。', true);
  }
})();
