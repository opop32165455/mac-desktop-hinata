/* PURPLE · 片刻 — Plash 适配层
 *
 * 仅在页面运行于 Plash 中时生效（Plash 会在 <html> 上注入 is-plash-app），
 * 因此对 Wallpaper Engine 与普通浏览器预览没有影响。
 *
 * 本脚本在 app.js 之前加载，因此可以在宿主读取页面可见性之前完成修补。
 *
 * 行为：
 *   1. 非浏览模式：由 plash.css 隐藏全部界面，呈现纯净壁纸。
 *   2. 可见性修补：壁纸不存在"隐藏"状态，固定上报为可见，
 *      避免宿主因 visibilitychange 而暂停视频。
 *   3. 默认播放方式设为「全部轮播」，让壁纸持续播放并自动换装。
 *   4. 默认开启定时换装（15 分钟），作为「定格模式」下的兜底。
 *   5. 开启 Plash 浏览模式后界面恢复，可正常点击操作。
 *
 * 调试参数（附加在地址末尾）：
 *   ?plash=1 / ?plash=0             强制开启或关闭适配
 *   ?playback=freeze|single|all     指定播放方式（默认 all）
 *   ?interval=0|5|15|30             指定定格模式下的换装间隔
 */
(function () {
  'use strict';

  var KEY = 'frac-hinata.safe.we.wardrobe-v1';
  var ROTATION_MARK = KEY + '.plash-rotation-v1';
  var PLAYBACK_MARK = KEY + '.plash-playback-v1';
  var DEFAULT_INTERVAL = 15;
  var DEFAULT_PLAYBACK = 'all';
  var INTERVALS = [0, 5, 15, 30];
  var PLAYBACKS = ['freeze', 'single', 'all'];

  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var forced = params.get('plash') === '1' ? true
             : params.get('plash') === '0' ? false
             : null;

  function inPlash() {
    return forced === null ? root.classList.contains('is-plash-app') : forced;
  }

  function storedPrefs() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch (_) { return true; }
  }
  function writeFlag(key) {
    try { localStorage.setItem(key, '1'); } catch (_) {}
  }

  // 复用宿主自带的设置逻辑：点击对应按钮即可写入偏好并持久化，无需触碰内部状态。
  function choose(selector) {
    var button = document.querySelector(selector);
    if (button) button.click();
  }

  /* 1. 可见性修补
   * Plash 的窗口位于桌面图标之下，可能被系统判定为不可见，进而触发宿主的
   * visibilitychange 分支暂停视频。壁纸始终可见，因此固定上报为可见，
   * 并主动派发一次事件让宿主重新评估当前状态。 */
  var visibilityPatched = false;
  function patchVisibility() {
    if (visibilityPatched) return;
    visibilityPatched = true;
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    } catch (_) {}
    document.dispatchEvent(new Event('visibilitychange'));
  }

  /* 2. 播放方式：默认「全部轮播」，此后尊重用户在播放菜单中的选择。 */
  var playbackApplied = false;
  function setupPlayback() {
    if (playbackApplied) return;
    var asked = params.get('playback');
    if (asked !== null) {
      if (PLAYBACKS.indexOf(asked) === -1) return;
      choose('#modeMenu [data-playback="' + asked + '"]');
      playbackApplied = true;
      return;
    }
    // 仅在首次进入 Plash、且用户仍处于默认「定格模式」时接管，避免覆盖既有偏好。
    if (!readFlag(PLAYBACK_MARK) && (storedPrefs().playbackMode || 'freeze') === 'freeze') {
      choose('#modeMenu [data-playback="' + DEFAULT_PLAYBACK + '"]');
    }
    writeFlag(PLAYBACK_MARK);
    playbackApplied = true;
  }

  /* 3. 换装间隔：仅「定格模式」下生效，作为静止壁纸的兜底。 */
  var rotationApplied = false;
  function setupRotation() {
    if (rotationApplied) return;
    var asked = params.get('interval');
    if (asked !== null) {
      var value = Number(asked);
      if (INTERVALS.indexOf(value) === -1) return;
      choose('#autoOptions [data-interval="' + value + '"]');
      rotationApplied = true;
      return;
    }
    if (!readFlag(ROTATION_MARK) && Number(storedPrefs().interval) === 0) {
      choose('#autoOptions [data-interval="' + DEFAULT_INTERVAL + '"]');
    }
    writeFlag(ROTATION_MARK);
    rotationApplied = true;
  }

  // 按钮点击依赖 app.js 绑定的事件，因此需等文档解析完成。
  var controlsDone = false;
  function setupControls() {
    if (controlsDone || document.readyState === 'loading') return;
    controlsDone = true;
    setupPlayback();
    setupRotation();
  }

  function apply() {
    var active = inPlash();
    if (root.classList.contains('is-plash-mode') !== active) root.classList.toggle('is-plash-mode', active);
    if (!active) return;
    patchVisibility();
    setupControls();
  }

  function boot() {
    apply();
    // Plash 可能在页面加载完成之后才注入 is-plash-app / plash-is-browsing-mode。
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('DOMContentLoaded', apply);
  }

  boot();
})();
