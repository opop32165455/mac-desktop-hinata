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
 *   3. 默认播放方式设为「往复循环」，让壁纸持续播放。
 *   4. 默认开启定时换装（15 分钟），定格与往复两种模式下都生效。
 *   5. 切换穿搭前预解码目标大图，消除 WebKit 降采样解码的"先模糊后清晰"。
 *   6. 开启 Plash 浏览模式后界面恢复，可正常点击操作。
 *
 * 调试参数（附加在地址末尾）：
 *   ?plash=1 / ?plash=0             强制开启或关闭适配
 *   ?playback=freeze|single|all|loop    指定播放方式（默认 loop）
 *   ?interval=0–60                  指定换装间隔（分钟，0 = 不自动换）
 */
(function () {
  'use strict';

  var KEY = 'frac-hinata.safe.we.wardrobe-v1';
  var ROTATION_MARK = KEY + '.plash-rotation-v1';
  var PLAYBACK_MARK = KEY + '.plash-playback-v1';
  var DEFAULT_INTERVAL = 15;
  var DEFAULT_PLAYBACK = 'loop';
  var PLAYBACKS = ['freeze', 'single', 'all', 'loop'];

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

  /* 2. 播放方式：默认「往复循环」，此后尊重用户在播放菜单中的选择。 */
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

  /* 3. 换装间隔：定格与往复模式下生效。快捷按钮之外的分钟数通过滑杆写入。 */
  function chooseInterval(value) {
    var button = document.querySelector('#autoOptions [data-interval="' + value + '"]');
    if (button) { button.click(); return; }
    var range = document.getElementById('intervalRange');
    if (!range) return;
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }
  var rotationApplied = false;
  function setupRotation() {
    if (rotationApplied) return;
    var asked = params.get('interval');
    if (asked !== null) {
      var value = Math.round(Number(asked));
      if (!(value >= 0 && value <= 60)) return;
      chooseInterval(value);
      rotationApplied = true;
      return;
    }
    if (!readFlag(ROTATION_MARK) && Number(storedPrefs().interval) === 0) {
      chooseInterval(DEFAULT_INTERVAL);
    }
    writeFlag(ROTATION_MARK);
    rotationApplied = true;
  }

  /* 4. 定格图预解码
   * WebKit 对超大图会先以降采样分辨率绘制、再重解码为全分辨率，切换穿搭时
   * 会出现"先模糊后清晰"的观感（Chrome 无此问题）。这里在指针移到或按下穿搭
   * 卡片时提前解码目标定格图，使切换瞬间即为全分辨率。
   * 该图同时用于 #still 与 .ambient，一次预解码覆盖两处。
   * 非浏览模式下没有指针事件，因此不会产生额外开销。 */
  var decoded = Object.create(null);
  function predecode(url) {
    if (decoded[url]) return;
    decoded[url] = true;
    var image = new Image();
    image.src = url;
    if (image.decode) image.decode().catch(function () { decoded[url] = false; });
  }
  function predecodeFromCard(event) {
    var card = event.target && event.target.closest ? event.target.closest('[data-select]') : null;
    if (!card) return;
    var look = (window.PURPLE_LOOKS || [])[Number(card.dataset.select)];
    if (look) predecode('images/look-' + look.id + '.jpg');
  }
  function setupPredecode() {
    var looks = document.getElementById('looks');
    if (!looks) return;
    looks.addEventListener('pointerover', predecodeFromCard, true);
    looks.addEventListener('pointerdown', predecodeFromCard, true);
    looks.addEventListener('focusin', predecodeFromCard, true);
  }

  // 按钮点击依赖 app.js 绑定的事件，因此需等文档解析完成。
  var controlsDone = false;
  function setupControls() {
    if (controlsDone || document.readyState === 'loading') return;
    controlsDone = true;
    setupPlayback();
    setupRotation();
    setupPredecode();
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
