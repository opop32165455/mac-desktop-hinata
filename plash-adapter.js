/* PURPLE · 片刻 — Plash 适配层
 *
 * 仅在页面运行于 Plash 中时生效（Plash 会在 <html> 上注入 is-plash-app），
 * 因此对 Wallpaper Engine 与普通浏览器预览没有任何影响。
 *
 * 行为：
 *   1. 非浏览模式：由 plash.css 隐藏全部界面，呈现纯净壁纸。
 *   2. 首次在 Plash 中运行：自动开启定时换装（默认 15 分钟）；
 *      此后尊重用户在设置面板中的选择，不再覆盖。
 *   3. 开启 Plash 浏览模式后界面自动恢复，可正常点击操作。
 *
 * 调试参数（可加在地址末尾）：
 *   ?plash=1 / ?plash=0        强制开启或关闭适配，便于浏览器中预览效果
 *   ?interval=0|5|15|30        指定自动换装间隔，0 表示不自动换装
 */
(function () {
  'use strict';

  var KEY = 'frac-hinata.safe.we.wardrobe-v1';
  var MARK = KEY + '.plash-rotation-v1';
  var DEFAULT_INTERVAL = 15;
  var INTERVALS = [0, 5, 15, 30];

  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var forced = params.get('plash') === '1' ? true
             : params.get('plash') === '0' ? false
             : null;

  function inPlash() {
    return forced === null ? root.classList.contains('is-plash-app') : forced;
  }

  function storedInterval() {
    try { return Number(JSON.parse(localStorage.getItem(KEY) || '{}').interval) || 0; } catch (_) { return 0; }
  }
  function hasMark() {
    try { return localStorage.getItem(MARK) === '1'; } catch (_) { return true; }
  }
  function setMark() {
    try { localStorage.setItem(MARK, '1'); } catch (_) {}
  }

  // 复用宿主自带的设置逻辑：点击按钮即可写入偏好并持久化，无需触碰内部状态。
  function chooseInterval(minutes) {
    var button = document.querySelector('#autoOptions [data-interval="' + minutes + '"]');
    if (button) button.click();
  }

  var rotationApplied = false;
  function setupRotation() {
    if (rotationApplied) return;
    var asked = params.get('interval');
    if (asked !== null) {
      var value = Number(asked);
      if (INTERVALS.indexOf(value) === -1) return;
      chooseInterval(value);
      rotationApplied = true;
      return;
    }
    // 只在首次进入 Plash、且用户从未设置过间隔时接管，避免覆盖既有偏好。
    if (!hasMark() && storedInterval() === 0) chooseInterval(DEFAULT_INTERVAL);
    setMark();
    rotationApplied = true;
  }

  function apply() {
    var active = inPlash();
    if (root.classList.contains('is-plash-mode') !== active) root.classList.toggle('is-plash-mode', active);
    if (active) setupRotation();
  }

  function boot() {
    apply();
    // Plash 可能在页面加载完成之后才注入 is-plash-app / plash-is-browsing-mode。
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
