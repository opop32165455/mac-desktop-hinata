/* PURPLE · 片刻 — 独立应用适配层
 *
 * 仅在页面运行于独立应用（Tauri 外壳，src-tauri/）中时生效；在 Plash、Wallpaper Engine
 * 与普通浏览器里 window.__TAURI__ 不存在，本脚本什么都不做。
 *
 * 本脚本在 app.js 之前加载，向它提供 window.PURPLE_NATIVE：
 *   media      穿搭编号 → 视频地址。视频是应用的打包资源，经 asset 协议按路径读取（支持 Range）。
 *   ready      视频地址准备好之后兑现，app.js 等它再开始播放。
 *   active     用户是否在看桌面（外壳每秒告知一次），用于「离开桌面时静音」。
 *   primary    是否主屏。多显示器时每块屏幕各有一个窗口，只有主屏出声。
 *   onChange   active 变化时调用，由 app.js 填入。
 *
 * 另外：
 *   - <html> 加上 is-native；可操作模式再加 is-interactive（纯壁纸模式的界面隐藏规则在 native.css）。
 *   - 首次运行默认每 15 分钟换一套（与 Plash 版一致），此后尊重用户的选择。
 *   - 点选前预解码定格图，消除 WebKit「先模糊后清晰」。
 */
(function () {
  'use strict';

  var tauri = window.__TAURI__;
  if (!tauri || !tauri.event || !tauri.core) return;

  var KEY = 'frac-hinata.safe.we.wardrobe-v1';
  var ROTATION_MARK = KEY + '.native-rotation-v1';
  var DEFAULT_INTERVAL = 15;
  var MEDIA_EXT = 'mp4';

  var root = document.documentElement;
  var shell = window.__PURPLE_SHELL__ || {};
  var native = window.PURPLE_NATIVE = {
    media: {},
    ready: null,
    active: true,
    primary: shell.primary !== false,
    onChange: null
  };

  root.classList.add('is-native');
  root.classList.toggle('is-interactive', shell.interactive !== false);

  function setActive(active) {
    if (native.active === active) return;
    native.active = active;
    if (native.onChange) native.onChange();
  }
  tauri.event.listen('app-active', function (event) { setActive(event.payload !== false); });
  tauri.event.listen('boss-key', function (event) { setActive(!event.payload); }); // payload = 是否已隐藏
  tauri.event.listen('interactive-mode', function (event) { root.classList.toggle('is-interactive', Boolean(event.payload)); });

  native.ready = (async function () {
    try {
      var dir = await tauri.path.resourceDir();
      var looks = window.PURPLE_LOOKS || [];
      for (var i = 0; i < looks.length; i++) {
        if (looks[i].locked) continue;
        native.media[looks[i].id] = tauri.core.convertFileSrc(await tauri.path.join(dir, 'media', 'look-' + looks[i].id + '.' + MEDIA_EXT));
      }
    } catch (_) { /* 退回相对路径 */ }
  })();

  // 首次运行：仍是默认的「不自动换」时，改为每 15 分钟换一套。借用页面自己的滑杆写入并保存。
  function setupRotation() {
    var done = true, saved = {};
    try { done = localStorage.getItem(ROTATION_MARK) === '1'; saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    if (!done && !Number(saved.interval)) {
      var button = document.querySelector('#autoOptions [data-interval="' + DEFAULT_INTERVAL + '"]');
      var range = document.getElementById('intervalRange');
      if (button) button.click();
      else if (range) { range.value = String(DEFAULT_INTERVAL); range.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    try { localStorage.setItem(ROTATION_MARK, '1'); } catch (_) {}
  }

  var decoded = Object.create(null);
  function predecodeFromCard(event) {
    var card = event.target && event.target.closest ? event.target.closest('[data-select]') : null;
    var look = card && (window.PURPLE_LOOKS || [])[Number(card.dataset.select)];
    if (!look) return;
    var url = 'images/look-' + look.id + '.jpg';
    if (decoded[url]) return;
    decoded[url] = true;
    var image = new Image();
    image.src = url;
    if (image.decode) image.decode().catch(function () { decoded[url] = false; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupRotation();
    var looks = document.getElementById('looks');
    if (!looks) return;
    looks.addEventListener('pointerover', predecodeFromCard, true);
    looks.addEventListener('pointerdown', predecodeFromCard, true);
  });
})();
