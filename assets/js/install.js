/* =========================================================
   装到主屏：注册 Service Worker + 显示「安装」入口。

   为什么不用真的 .apk：
   安卓 Chrome / Edge 支持把 PWA 装到主屏，装完有自己的图标、全屏打开、
   能离线看，用起来和原生 APP 一样 —— 但不需要开发者账号、不用签名、
   改一次代码所有设备立刻就是新版。Windows 上同样可以装成独立窗口。

   小米 K80 上怎么装：
   1. 用 Chrome（或 Edge）打开 https://muqiuchen1216.github.io/
   2. 右上角菜单 → 安装应用 / 添加到主屏幕；
   3. 之后从桌面图标点进去就是全屏的，没有地址栏。
   ========================================================= */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // 只在自己的站点上注册；file:// 打开时跳过（SW 在那里根本不可用）。
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (event) {
    // 拦一下浏览器的默认横条，改成站内自己的按钮，样式统一。
    event.preventDefault();
    deferredPrompt = event;
    document.documentElement.setAttribute('data-can-install', 'true');
    var button = document.getElementById('installApp');
    if (button) button.hidden = false;
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    document.documentElement.removeAttribute('data-can-install');
    var button = document.getElementById('installApp');
    if (button) button.hidden = true;
  });

  window.addEventListener('load', function () {
    /* 等页面 load 之后再等 3 秒才注册 SW。
       原因：SW 安装时要预缓存十几个外壳文件，而这条线路到 GitHub Pages
       只有约 70 KB/s —— 一装上就抢带宽，首屏那两张图会被挤到后面，
       用户看到的是一堆灰框。等首屏安静下来再装，体验明显更顺。 */
    window.setTimeout(function () {
      navigator.serviceWorker
        .register('sw.js', { scope: './' })
        .catch(function () {
          /* 注册失败不影响正常浏览，只是没有离线能力 */
        });
    }, 3000);
  });

  /* 给页面上的按钮用：window.PortfolioInstall.prompt() */
  window.PortfolioInstall = {
    available: function () {
      return Boolean(deferredPrompt);
    },
    prompt: function () {
      if (!deferredPrompt) return Promise.resolve('unavailable');
      var event = deferredPrompt;
      deferredPrompt = null;
      event.prompt();
      return event.userChoice.then(function (choice) {
        return choice && choice.outcome ? choice.outcome : 'dismissed';
      });
    }
  };
})();
