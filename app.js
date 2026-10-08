/* PURPLE — Safe controller; build with tools/build_safe.py. */
'use strict';
(() => {
  const LOOKS = window.PURPLE_LOOKS;
  const REPLIES = window.PURPLE_REPLIES || {};
  const AVAILABLE = LOOKS.map((_, i) => i).filter(i => !LOOKS[i].locked);
  const isPlayable = i => Number.isInteger(i) && AVAILABLE.includes(i);
  const CHAPTERS = [
    { name: '日常靠近', looks: [0, 1, 3, 5] },
    { name: '慢慢心动', looks: [2, 4, 6, 7] },
    { name: '没说完的话', looks: [8, 9, 10, 11] }
  ];
  // Display order is independent of the stable IDs used for media and saved preferences.
  const DISPLAY_ORDER = CHAPTERS.flatMap(chapter => chapter.looks);
  const displayNumber = index => String(DISPLAY_ORDER.indexOf(index) + 1).padStart(2, '0');
  const pageFor = i => CHAPTERS.findIndex(chapter => chapter.looks.includes(i));
  const $ = id => document.getElementById(id);
  let video = $('film');
  let spare = $('filmNext');
  const decks = [video, spare];
  const body = document.body;
  const root = document.documentElement;
  // Keep the historic storage identity so existing favorites and frames survive a rename.
  const KEY = 'frac-hinata.safe.we.wardrobe-v1';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const number = (value, fallback, lo, hi) => Number.isFinite(Number(value)) ? clamp(Number(value), lo, hi) : fallback;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  // All clips ship as HEVC (hvc1) MP4: Safari / Plash (WebKit) and Chrome on macOS
  // hardware-decode it. CEF (Wallpaper Engine) and Firefox usually cannot; rebuild
  // with `CODEC=h264 tools/build-loop-media.sh` for those hosts.
  const MEDIA_EXT = 'mp4';
  // 视频重新生成后改这个版本号，Plash 才不会继续播缓存里的旧文件。
  const MEDIA_VERSION = '20261008g';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
  const FREEZE_REVISION = 1;
  const defaults = {
    current: 3, favorites: [], freezes: LOOKS.map((look, index) => isPlayable(index) ? look.freeze : null),
    freezeRevision: FREEZE_REVISION, sound: false, volume: 35, brightness: 100,
    autoHide: true, fit: 'contain', interval: 0, playbackMode: 'loop', switchMode: 'rewind', muteAway: true, menuBarFollow: true
  };
  // 「隔一段时间换一套」的间隔：0 = 不自动换，否则 1–60 分钟（旧版的 0/5/15/30 原样有效）。
  const intervalMinutes = value => {
    const minutes = Math.round(Number(value));
    return Number.isFinite(minutes) && minutes >= 0 && minutes <= 60 ? minutes : 0;
  };
  // 调试用：?minuteMs=2000 把「1 分钟」缩短为 2 秒，便于验证定时换装。
  const MINUTE = Number(new URLSearchParams(location.search).get('minuteMs')) || 60000;
  const PREVIOUS_FREEZES = { '02': 11.7, '05': 11.2, '07': 10.5, '08': 11.7, '09': 10.5 };
  function initialFreeze(look, index) {
    if (!isPlayable(index)) return null;
    const stored = saved.freezes?.[index];
    if (stored == null) return look.freeze;
    // Migrate remembered old defaults once; retain custom frames, including any
    // old-default timestamp explicitly chosen again after this update.
    if ((saved.freezeRevision || 0) < FREEZE_REVISION &&
        Math.abs(Number(stored) - PREVIOUS_FREEZES[look.id]) < .008) return look.freeze;
    return number(stored, look.freeze, .1, look.duration - .05);
  }
  const prefs = {
    current: isPlayable(saved.current) ? saved.current : defaults.current,
    favorites: Array.isArray(saved.favorites) ? [...new Set(saved.favorites.filter(isPlayable))] : [],
    freezes: LOOKS.map(initialFreeze),
    freezeRevision: FREEZE_REVISION,
    sound: saved.sound === true,
    volume: number(saved.volume, defaults.volume, 0, 100),
    brightness: number(saved.brightness, defaults.brightness, 65, 115),
    autoHide: saved.autoHide !== false,
    muteAway: saved.muteAway !== false,
    menuBarFollow: saved.menuBarFollow !== false,
    fit: saved.fit === 'cover' ? 'cover' : 'contain',
    interval: intervalMinutes(saved.interval),
    // 默认「往复循环」；已保存的选择（包括定格）保持不变。
    playbackMode: ['freeze', 'single', 'all', 'favorites', 'loop'].includes(saved.playbackMode) ? saved.playbackMode : defaults.playbackMode,
    // 切换穿搭的方式：'rewind' 先倒放回开头再换（默认），'cut' 直接切换。
    switchMode: saved.switchMode === 'cut' ? 'cut' : 'rewind',
    nativeValues: saved.nativeValues && typeof saved.nativeValues === 'object' ? saved.nativeValues : {}
  };
  if (prefs.playbackMode === 'favorites' && !prefs.favorites.length) prefs.playbackMode = 'freeze';
  let current = prefs.current;
  let page = pageFor(current);
  let dialogue = window.createPurpleDialogue({looks: LOOKS, replies: REPLIES, affection: window.PURPLE_AFFECTION, isPlayable});
  let privateVisits = 0;
  let lastPrivateReply = -Infinity;
  let lastPrivateAside = -Infinity;
  let baseStatus = { label: '', text: '' };
  let phase = 'held'; // held | loading | playing | paused | transition | editing | error
  let systemPaused = false;
  let documentPaused = document.hidden;
  let operation = 0;
  let controller = null;
  let loadedLook = -1;
  let frameHandle = null;
  let frameKind = null;
  let frameDeck = null;
  let spinId = 0;
  let spinning = false;
  let rewinding = false;
  let rewindTask = null;
  let pivotTimer;
  // 备用牌组正在「预滚」：提前起播，与倒放中的主牌组在折返点会合。
  let prerolling = false;
  // 未经拦截的原生 play()，只给预滚用（宿主恢复播放时不能启动备用牌组）。
  const nativePlay = new Map();
  // WebKit 只允许「被用户手势播放过」的 <video> 带声起播，且按元素计算。
  // soundBlocked：带声起播被拒、暂时静音保画面；下一次用户手势时恢复声音。
  let soundBlocked = false;
  let hostMuteNoticed = false;
  const unlockedDecks = new WeakSet();
  let bag = [];
  let idleTimer, toastTimer, loadingTimer, replyTimer;
  let lastChange = Date.now();
  let lastActivity = 0;
  let panel = null;
  let panelReturnFocus = null;
  let editorOriginal = null;
  let audioContext;
  let pendingEntry = null;
  let modeOpen = false;
  let transition = null;
  let prefetch = null;

  function persist() {
    prefs.current = current;
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  function icon(button, name) { button.querySelector('use').setAttribute('href', '#i-' + name); }
  function line(index, event) {
    if (event === 'held') return dialogue.held(index);
    if (event === 'enter') return dialogue.enter(index);
    return dialogue.reply(index, event).text;
  }
  function confirmDialogueVisible(text) {
    requestAnimationFrame(() => {
      const inToast = $('toast').classList.contains('show') && $('toastText').textContent === text;
      const inStatus = !body.classList.contains('is-idle') && !body.classList.contains('is-immersed') && $('statusText').getClientRects().length && $('statusText').textContent === text;
      if (!document.hidden && (inToast || inStatus)) dialogue.shown(text);
      else dialogue.discardReply(text);
    });
  }
  function toast(text, speaker = '她说') {
    $('toastSpeaker').textContent = speaker;
    $('toastText').textContent = text;
    $('toast').classList.add('show');
    confirmDialogueVisible(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3000);
  }
  function writeStatus(label, text) {
    $('statusLabel').textContent = label;
    $('statusText').textContent = text;
    confirmDialogueVisible(text);
  }
  function setStatus(label, text) {
    clearTimeout(replyTimer);
    baseStatus = { label, text };
    writeStatus(label, text);
  }
  function respond(index, event, label = 'HERE, WITH YOU.', central = true) {
    const words = line(index, event);
    if (central) toast(words, !isPlayable(index) ? '她说 · 衣橱手记' : '她说 · ' + LOOKS[index].short);
    if (index === current || !isPlayable(index)) {
      clearTimeout(replyTimer);
      writeStatus(label, words);
      const token = operation;
      replyTimer = setTimeout(() => {
        if (token === operation) writeStatus(baseStatus.label, baseStatus.text);
      }, 6500);
    }
    return words;
  }
  function lockedTap(index) {
    if (!LOOKS[index]?.locked || isPlayable(index)) return;
    const now = performance.now();
    activity(true);
    if (now - lastPrivateReply < 1500) return;
    lastPrivateReply = now;
    privateVisits++;
    const aside = privateVisits >= 4 && now - lastPrivateAside >= 90000;
    if (aside) { privateVisits = 0; lastPrivateAside = now; }
    respond(index, aside ? 'aside' : 'locked', 'A LITTLE SECRET.');
    const card = document.querySelector(`[data-look="${index}"]`);
    if (card) {
      card.classList.remove('locked-peek');
      void card.offsetWidth;
      card.classList.add('locked-peek');
    }
  }

  function renderCards(animate = false) {
    $('looks').innerHTML = CHAPTERS[page].looks.map(i => {
      const look = LOOKS[i];
      const locked = !isPlayable(i);
      const thumb = `thumb-${look.id}`;
      return `<div class="look-card${locked ? ' is-locked' : ''}" data-look="${i}"><button class="look-select" data-select="${i}" aria-label="${locked ? look.name + '，私藏，未开放' : '选择' + look.name + '，播放入场'}" ${locked ? 'aria-disabled="true"' : 'aria-pressed="false"'}><div class="look-image"><img src="images/${thumb}.jpg" alt="${look.name}${locked ? '模糊封面' : '穿搭封面'}" draggable="false"><span class="look-index">${displayNumber(i)}</span>${locked ? '<span class="lock-veil"><svg><use href="#i-lock"/></svg><span>' + '未开放' + '</span></span>' : '<span class="look-check"><svg><use href="#i-check"/></svg></span>'}</div></button><div class="look-bottom"><span class="look-short">${look.short}</span>${locked ? '<span class="secret-tag">' + look.tag + '</span>' : '<button class="favorite-button" data-favorite="' + i + '" aria-label="偏爱' + look.name + '" aria-pressed="false"><svg><use href="#i-heart"/></svg></button>'}</div></div>`;
    }).join('');
    $('chapterName').textContent = CHAPTERS[page].name;
    document.querySelectorAll('[data-page]').forEach(button => {
      if (Number(button.dataset.page) === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (animate) {
      $('looks').classList.remove('page-enter'); void $('looks').offsetWidth;
      $('looks').classList.add('page-enter');
    }
    updateCards();
  }
  function setPage(next, manual = true) {
    if (manual) cancelSpin();
    page = (next + CHAPTERS.length) % CHAPTERS.length;
    renderCards(true); activity(true);
  }
  function freezeTime() { return prefs.freezes[current]; }
  function suspended() { return systemPaused || documentPaused; }
  function readyControls(disabled) {
    $('playButton').disabled = disabled;
    $('momentButton').disabled = disabled || phase === 'transition';
    $('modeButton').disabled = phase === 'editing';
  }
  function updateProgress(t) {
    $('timeLabel').textContent = t.toFixed(2);
    $('timelineFill').style.width = clamp(t / LOOKS[current].duration * 100, 0, 100) + '%';
  }
  function updateCards() {
    document.querySelectorAll('.look-card').forEach(card => {
      const i = Number(card.dataset.look);
      if (!isPlayable(i)) return;
      card.classList.toggle('active', i === current);
      card.querySelector('.look-select').setAttribute('aria-pressed', String(i === current));
      card.querySelector('.favorite-button').setAttribute('aria-pressed', String(prefs.favorites.includes(i)));
      card.querySelector('.favorite-button').setAttribute('aria-label', `${prefs.favorites.includes(i) ? '取消偏爱' : '偏爱'}${LOOKS[i].name}`);
    });
    $('lookName').textContent = LOOKS[current].name;
    $('lookEnglish').textContent = LOOKS[current].english;
    $('lookNumber').textContent = displayNumber(current);
    $('randomScope').textContent = prefs.favorites.length ? `只从 ${prefs.favorites.length} 套偏爱中，为你挑选` : `九套穿搭，慢慢挑。不连续重复。`;
    renderPlaybackMode();
  }
  function applyPrefs() {
    root.style.setProperty('--brightness', prefs.brightness / 100);
    root.style.setProperty('--fit', prefs.fit);
    $('brightness').value = prefs.brightness;
    $('brightnessValue').textContent = prefs.brightness + '%';
    $('volume').value = prefs.volume;
    $('volumeValue').textContent = prefs.volume + '%';
    $('idleToggle').checked = prefs.autoHide;
    $('awayToggle').checked = prefs.muteAway;
    $('menuBarToggle').checked = prefs.menuBarFollow;
    syncMenuBar();
    document.querySelectorAll('[data-fit]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fit === prefs.fit)));
    document.querySelectorAll('[data-interval]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.interval) === prefs.interval)));
    renderInterval();
    document.querySelectorAll('[data-switch-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.switchMode === prefs.switchMode)));
    applySound();
    // 预滚中的备用牌组已按声音设置起播，只在关掉声音时跟着静音。
    if (!prerolling || !prefs.sound) spare.muted = true;
    renderPlaybackMode();
    icon($('soundButton'), prefs.sound ? 'volume' : 'mute');
    $('soundButton').setAttribute('aria-label', prefs.sound ? '关闭声音' : '开启声音');
    $('soundButton').title = prefs.sound ? '关闭声音' : '开启声音';
    $('soundButton').setAttribute('aria-pressed', String(prefs.sound));
    activity(true);
  }
  // 滑杆只表示分钟数；关闭（等我来选）时滑杆停在上次的值，标签写明不自动换。
  let lastInterval = prefs.interval || 15;
  function renderInterval() {
    if (prefs.interval) lastInterval = prefs.interval;
    $('intervalRange').value = lastInterval;
    $('intervalValue').textContent = prefs.interval ? `每 ${prefs.interval} 分钟` : '不自动换';
  }
  function activity(force = false) {
    if (!force && performance.now() - lastActivity < 120) return;
    lastActivity = performance.now();
    body.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (prefs.autoHide && !panel && !modeOpen && !spinning && phase !== 'loading' && !suspended()) {
      idleTimer = setTimeout(() => {
        if (!panel && !modeOpen && !spinning && phase !== 'loading') {
          body.classList.add('is-idle');
          if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.interface')) document.activeElement.blur();
        }
      }, 15000);
    }
  }
  // 声音以 prefs.sound 为准，每次换牌、换装都重新套用，不让某次临时静音残留下去。
  // retry：换装 / 自动轮换时总是先试带声播放，真被拒绝了 playSafely 会立刻退回静音，
  // 观感上没有代价；往复折返不 retry —— 被拒会让新牌组停一下，每个来回都卡一次。
  function applySound(retry = false) {
    if (retry) soundBlocked = false;
    video.muted = !prefs.sound || soundBlocked;
    video.volume = soundLevel();
  }
  /* 离开桌面时静音：本地服务的 /desktop-state 报告「是否在看桌面」
   * （tools/desktop-state.js，系统自带 osascript 运行，只读窗口位置与最前面的应用，不需要屏幕录制权限）。
   * 判定以「最前面的应用是不是桌面本身（访达 / 程序坞 / 控制中心 / Plash）」为主，窗口覆盖率为兜底：
   * 只看覆盖率时，没最大化的窗口（1920×1080 上通常只占 50%–70%）永远到不了阈值，切进程序也一直有声音。
   * 不在桌面时把音量 300ms 淡到 0，回到桌面再淡回来。用音量而不是 muted —— 无手势取消静音会被 WebKit 暂停。
   * 没有这个接口（Wallpaper Engine、普通浏览器）时探不到就不再轮询，行为同以前。 */
  let duck = 1, duckTarget = 1, duckTimer = 0, awayTimer = 0, awayProbe = 'unknown', awayFails = 0;
  function soundLevel() { return prefs.volume / 100 * duck * quiet; }
  /* 往复循环段静音：每套第一次正放到底有声音；一进入倒放（循环开始）就把音量淡到 0，
   * 循环里的倒放、正放都不出声。切换穿搭的倒带、换上来的新一套恢复声音。
   * 同样只动音量、不动 muted（无手势取消静音会被 WebKit 暂停）。 */
  let quiet = 1, quietTarget = 1, quietTimer = 0;
  function rampQuiet(target, ms = 200) {
    if (target === quietTarget && (target === quiet || quietTimer)) return;
    quietTarget = target;
    clearTimeout(quietTimer); quietTimer = 0;
    const from = quiet, start = performance.now();
    const step = () => {
      const k = ms ? Math.min(1, (performance.now() - start) / ms) : 1;
      quiet = from + (target - from) * k;
      try { video.volume = soundLevel(); } catch (_) {}
      quietTimer = k < 1 ? setTimeout(step, 16) : 0;
    };
    step();
  }
  function rampDuck(target) {
    if (target === duckTarget) return;
    duckTarget = target;
    clearTimeout(duckTimer);
    const from = duck, start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 300);
      duck = from + (target - from) * k;
      try { video.volume = soundLevel(); } catch (_) {}
      if (k < 1) duckTimer = setTimeout(step, 16);
    };
    step();
  }
  /* 菜单栏跟随衣橱：Plash 的壁纸窗口从菜单栏下方开始，菜单栏那一条露出的是系统桌面图片。
   * 当前穿搭、画面比例、明暗或开关变化时，经本地服务的 /wallpaper（tools/wallpaper.cgi）告诉
   * 常驻助手（tools/desktop-state.js），由它生成衔接的图片并设为主屏的系统桌面图片；关闭时恢复原图。
   * 只在 Plash 里通过本地 http 运行时生效；只在内容变化时发送。 */
  let menuBarKey = '';
  function syncMenuBar() {
    if (!root.classList.contains('is-plash-mode') || location.protocol !== 'http:' || !isPlayable(current)) return;
    const params = {look: LOOKS[current].id, fit: prefs.fit, b: Math.round(prefs.brightness), enabled: prefs.menuBarFollow ? 1 : 0};
    const key = JSON.stringify(params);
    if (key === menuBarKey) return;
    menuBarKey = key;
    fetch('wallpaper?' + new URLSearchParams(params), {headers: {'X-Purple': '1'}, cache: 'no-store'})
      .then(response => { if (!response.ok) menuBarKey = ''; })
      .catch(() => { menuBarKey = ''; });
  }
  async function pollDesktop() {
    syncMenuBar();
    clearTimeout(awayTimer);
    // 关掉声音或关掉「离开桌面时静音」时不轮询；重新打开时由按钮事件重新启动。
    if (!prefs.sound || !prefs.muteAway || location.protocol === 'file:') { awayProbe = 'unknown'; awayFails = 0; rampDuck(1); return; }
    let delay = 1000;
    try {
      const response = await fetch('desktop-state', {cache: 'no-store'});
      if (!response.ok) throw new Error('status ' + response.status);
      const state = await response.json();
      awayProbe = 'ok'; awayFails = 0;
      // 桌面状态助手每秒更新一次；超过 10 秒没更新（助手停了）就当作在桌面，不再静音。
      const fresh = !state.at || Date.now() / 1000 - state.at < 10;
      rampDuck(fresh && state.onDesktop === false ? 0 : 1);
    } catch (_) {
      // 登录后页面可能比状态助手先就绪（首次请求 404），单次失败不能就此判死：
      // 连续 3 次都失败才认定「没有这项能力」，之后仍以 30 秒间隔重试，助手晚起来也能自愈。
      awayFails++;
      if (awayFails >= 3) { awayProbe = 'missing'; rampDuck(1); delay = 30000; }
    }
    awayTimer = setTimeout(pollDesktop, delay);
  }
  // 在用户手势里对两个牌组各 play() 一次，WebKit 便会解除该元素的带声播放限制。
  // 暂停中的牌组立即 pause() 并恢复原静音状态，不会出声、也不会挪动画面。
  function unlockDecks() {
    for (const deck of decks) {
      // 没有 src 的备用牌组也要解锁：WebKit 在 play() 检查资源之前就已解除限制，之后换源仍然有效。
      if (unlockedDecks.has(deck) || deck.ended) continue;
      unlockedDecks.add(deck);
      if (!deck.paused) { nativePlay.get(deck)().catch(() => {}); continue; }
      const muted = deck.muted;
      deck.muted = false;
      nativePlay.get(deck)().catch(() => {});
      deck.pause(); deck.muted = muted;
    }
    if (soundBlocked) {
      soundBlocked = false;
      applySound();
      if (phase === 'playing' && !suspended() && video.paused) playSafely(operation);
    }
  }
  // 不再创建 Web Audio（AudioContext）：点击音效带来的额外音频会话没有必要，
  // 壁纸的声音只来自 <video> 元素本身，绝不触碰系统的音频设备、音量或静音。
  // audioContext 保持为空，chime() 因此直接返回。
  function unlockAudio() {}
  function chime(pitch = 660, length = .11) {
    if (!prefs.sound || !audioContext || audioContext.state !== 'running' || suspended()) return;
    try {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = pitch;
      gain.gain.setValueAtTime(.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(.0001, prefs.volume / 100 * .035), audioContext.currentTime + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + length);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + length + .02);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch (_) {}
  }

  function stopWatcher() {
    if (frameHandle !== null) {
      // 牌组可能已经对调，必须向「注册时」的那个牌组取消，不能按当前的 video 取消。
      if (frameKind === 'video' && frameDeck) frameDeck.cancelVideoFrameCallback(frameHandle);
      else if (frameKind === 'animation') cancelAnimationFrame(frameHandle);
    }
    frameHandle = null; frameDeck = null;
  }
  function watchFrames() {
    stopWatcher();
    if (phase !== 'playing' || suspended()) return;
    const schedule = () => {
      frameDeck = video;
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameKind = 'video'; frameHandle = video.requestVideoFrameCallback(callback);
      } else { frameKind = 'animation'; frameHandle = requestAnimationFrame(callback); }
    };
    const callback = (_, metadata) => {
      frameHandle = null;
      if (phase !== 'playing' || suspended() || rewinding) return;
      const t = metadata ? metadata.mediaTime : video.currentTime;
      const d = clipDuration();
      updateProgress(Math.min(t, d));
      if (looping()) {
        // 第一次正放到底、开始倒放：循环段静音。
        if (t >= d - FRAME / 2 && quietTarget !== 0) rampQuiet(0);
        // 合并文件前半正放、后半倒放。倒放到折返点时回到正放段继续正放。
        // 备用牌组停在折返点前 PREROLL 秒；主牌组倒放到折返点前 PREROLL 秒时让它起播，
        // 两者从两侧同时走向折返点，到点时备用牌组已在运动，硬切过去没有起播停顿。
        // 牌组未就绪时退回普通 seek。
        const pivot = pivotTime(), turn = mirror(pivot);
        if (!prerolling && t >= turn - PREROLL - prerollBias - .006 && t < turn && pivotReady()) startPreroll();
        if (t >= turn - .006) {
          // 主牌组刚显示到折返帧。备用牌组应正好走到这一帧：偏差记下来，校准下一轮的起播时机
          // （WebKit 起播延迟因机器与负载而异，固定提前量总会差几帧）。
          if (prerolling && turnError === null) {
            // 目标：主牌组刚显示折返帧，备用牌组下一帧正好是折返帧的后一帧（钟摆式转向，
            // 不重复、不跳帧）。
            // WebKit 的 currentTime 比屏幕上正显示的帧领先约一帧，所以对准「折返帧后两帧」。
            turnError = spare.currentTime - (pivot + 2 * FRAME);
            prerollBias = clamp(prerollBias - turnError * .7, -.1, .3);
          }
          if (prerolling && spare.currentTime >= pivot + 1.5 * FRAME) swapLoopDecks();
          // 备用牌组起播稍慢时，让主牌组多倒放一点点等它，不定住画面。
          else if (prerolling && t < turn + .25) schedule();
          else {
            stopPreroll();
            // seek 尚未完成时回调里的时间可能仍是旧值，不能重复 seek，否则会卡死在折返点。
            if (!video.seeking) { video.currentTime = pivotTime(); schedulePivot(PIVOT_DELAY); }
            schedule();
          }
        } else schedule();
      } else if (!cycling() && t >= freezeTime() - .006) settle();
      // 文件是「正放 + 倒放」的合并体，片尾要靠时间判断，不能等 ended（那是 2d 处）。
      else if (t >= d - .006) rewindThenAdvance();
      else schedule();
    };
    schedule();
  }
  function settle() {
    stopWatcher();
    phase = 'held';
    video.pause();
    if (Number.isFinite(video.duration) && Math.abs(video.currentTime - freezeTime()) > .009) video.currentTime = Math.min(freezeTime(), video.duration - .04);
    body.classList.remove('is-playing');
    $('loading').hidden = true;
    clearTimeout(loadingTimer);
    updateProgress(freezeTime());
    $('timelineState').textContent = '定格';
    icon($('playButton'), 'repeat');
    $('playButton').setAttribute('aria-label', '再看一次入场');
    $('playButton').title = '再看一次入场';
    setStatus('MOMENT, KEPT.', line(current, 'held'));
    readyControls(false);
    activity(true);
  }
  // 往复模式下切换前先把当前这一段倒放回开头（原片 0 秒处），再切到新的一套。
  // 合并文件里 [d, 2d] 是倒放段，正放位置 t 对应的倒放位置是 2d − t。
  // 倒带过程中重复调用会拿到同一个 promise —— 多次点击复用同一次倒带，不会互相打断。
  function rewindBeforeSwitch() {
    if (prefs.switchMode !== 'rewind') return Promise.resolve();
    if (rewindTask) return rewindTask;
    const d = clipDuration();
    const t = video.currentTime;
    if (!(t > .05)) return Promise.resolve();
    rewinding = true;
    stopWatcher();
    stopPreroll();
    // 切换穿搭的倒带要有声音（动作配着脚步声），从循环段的静音里淡回来。
    rampQuiet(1, 150);
    $('timelineState').textContent = '倒带';
    // 片尾自动换装时 t 已在正放/倒放的接缝处，合并文件会自然续进倒放段，不必 seek（seek 会卡一下）。
    if (t <= d && d - t > .05) video.currentTime = Math.max(0, Math.min(mirror(t), 2 * d - .05));
    rewindTask = new Promise(resolve => {
      const finish = () => { video.removeEventListener('ended', finish); clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 20000);
      video.addEventListener('ended', finish, { once: true });
      const played = video.play();
      if (played && played.catch) played.catch(finish);
    }).then(() => { rewinding = false; rewindTask = null; });
    return rewindTask;
  }
  // 片尾自动换装同样先倒放回开头，与手动切换保持一致。
  async function rewindThenAdvance() {
    const before = current;
    await rewindBeforeSwitch();
    // 倒带期间若用户点了别的穿搭，交给那次 selectLook 处理，这里不再自动换装。
    if (current !== before) return;
    advanceLoop();
  }
  /* 往复的折返点需要一次向后 seek，而 WebKit 的 seek 会清空解码管线并重新缓冲，
   * 产生一次可见顿挫。实测折返点距最近关键帧只差 0.33 秒（20 帧），
   * 所以瓶颈不是解码量，改关键帧间隔也无济于事 —— 只能让这次 seek 不被看见。
   * 做法：备用牌组提前定位到折返点，到点时硬切过去。切点两侧是同一帧，因此无缝。
   * 但暂停的牌组 play() 后要过几帧才真正走起来（WebKit 需要重新 preroll），
   * 硬切到暂停牌组仍会定住几帧 —— 所以让它提前 PREROLL 秒起播，见 watchFrames。 */
  const PREROLL = .3;
  // 自适应的额外提前量（秒），见 watchFrames；turnError 是本轮测得的会合偏差。
  // 初值取 WebKit 实测的起播延迟（约 4 帧），第一次折返就不会差太多。
  let prerollBias = .07, turnError = null;
  function parkTime() { return Math.max(0, pivotTime() - PREROLL); }
  function pivotReady() {
    return Boolean(prefetch) && prefetch.element === spare && prefetch.index === current &&
      spare.readyState >= 2 && !spare.seeking && (prerolling || Math.abs(spare.currentTime - parkTime()) < .05);
  }
  // 预滚直接按最终的声音状态起播，换牌时不再改 muted：WebKit 对「没有用户手势时取消静音」
  // 会直接暂停元素，旧做法因此被迫退回静音，壁纸收不到点击，声音就一直不回来。
  // 预滚期间音量为 0（不是静音），换牌时与主牌组交叉淡变音量 —— 改音量不需要用户手势。
  // 之前被拒过也每一轮在这里重试带声；仍被拒就静音继续预滚，画面不受影响。
  function startPreroll() {
    prerolling = true; turnError = null;
    const deck = spare;
    deck.volume = 0;
    deck.muted = !prefs.sound;
    nativePlay.get(deck)().catch(error => {
      if (!prerolling || deck !== spare) return;
      if (error?.name !== 'NotAllowedError' || deck.muted) { stopPreroll(); return; }
      deck.muted = true;
      nativePlay.get(deck)().catch(() => { if (prerolling && deck === spare) stopPreroll(); });
    });
  }
  // 预滚中断后，备用牌组已离开停靠点，必须作废并重新准备。
  function stopPreroll() {
    if (!prerolling) return;
    prerolling = false;
    spare.pause();
    prefetch?.controller.abort(); prefetch = null;
  }
  function preparePivot() {
    if (!looping() || prefetch || phase === 'loading' || phase === 'transition') return;
    const pivot = parkTime();
    const item = {index: current, element: spare, controller: new AbortController(), promise: null};
    prefetch = item;
    const deck = spare, signal = item.controller.signal;
    // 往复时备用牌组一直垫在主牌组下面、保持可见（同样 .999），换牌只改层级：
    // 不透明度从 0 变为可见时 WebKit 要重新建立视频图层、提交首帧，正是折返瞬间的一两帧空白。
    deck.pause(); deck.muted = true; deck.style.opacity = '.999'; deck.style.zIndex = '0';
    video.style.zIndex = '1';
    item.promise = (async () => {
      if (deck.dataset.look !== LOOKS[current].id || deck.readyState < 2) await loadSource(deck, current, signal);
      if (Math.abs(deck.currentTime - pivot) > .02 || deck.seeking) {
        await mediaEvent('seeked', signal, () => { deck.currentTime = pivot; }, deck);
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      deck.dataset.look = LOOKS[current].id;
      return deck;
    })();
    // Speculative preparation is silent; a failed handoff falls back to a plain seek.
    item.promise.catch(() => {});
  }
  // 准备下一轮要推迟一点：seek 会占用解码器与 IO，若正好压在新牌组起播的那几帧上
  // 就会掉帧。但循环段只有 1.2–2.2 秒（一个来回 2.3–4.4 秒），推迟太久会让 seek
  // 压在下一次折返前，所以只避开起播的头 0.35 秒。
  const PIVOT_DELAY = 350;
  function schedulePivot(delayMs) {
    clearTimeout(pivotTimer);
    pivotTimer = setTimeout(() => {
      if (looping() && phase === 'playing' && !rewinding) preparePivot();
    }, delayMs);
  }
  function swapLoopDecks() {
    const outgoing = video, incoming = spare;
    video = incoming; spare = outgoing;
    // 旧的预取对象已随牌组对调失效，必须清掉，否则 preparePivot 会被守卫挡住不再准备。
    prefetch = null; prerolling = false;
    video.id = 'film'; spare.id = 'filmNext';
    // 倒放段也有（倒放的）声音：两个牌组在折返点播的是同一瞬间的声音，80ms 交叉淡变，
    // 不会出现爆音或断音。淡出后再停掉看不见的旧牌组，免得它继续抢占解码。
    const level = soundLevel();
    const retire = () => { if (outgoing === spare) { outgoing.pause(); outgoing.muted = true; } };
    if (incoming.muted || outgoing.muted) { incoming.volume = level; retire(); }
    else { fadeVolume(incoming, 0, level, 80); fadeVolume(outgoing, outgoing.volume, 0, 80, retire); }
    // 两个牌组都已在合成、都是 .999（避免 macOS 叠加层泛白），换牌只对调层级，
    // 同一次绘制里生效；旧牌组留在下面，下一轮直接在原地 seek 到停靠点。
    video.style.opacity = '.999'; video.style.zIndex = '1'; video.classList.add('visible');
    spare.style.opacity = '.999'; spare.style.zIndex = '0'; spare.classList.remove('visible');
    startLoopDeck(video);
    watchFrames();
    schedulePivot(PIVOT_DELAY);
  }
  // 新牌组从没被用户手势播放过：开着声音时 WebKit 可能拒绝它带声起播（或取消静音时直接暂停它），
  // 以前这个拒绝被吞掉，画面就永远停在折返点。被拒时退回静音继续播，画面优先。
  function fadeVolume(deck, from, to, ms, done) {
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / ms);
      try { deck.volume = clamp(from + (to - from) * k, 0, 1); } catch (_) {}
      if (k < 1) setTimeout(step, 8); else done?.();
    };
    step();
  }
  // 换上来的牌组已在预滚中以最终声音状态播放，这里不改 muted（音量由换牌时的淡变负责）。
  function startLoopDeck(deck) {
    const id = operation;
    if (!prefs.sound) deck.muted = true;
    soundBlocked = prefs.sound && deck.muted;
    deck.play().catch(() => {});
    // 兜底：万一新牌组没走起来，静音再播，画面优先；下一轮预滚会再试带声。
    setTimeout(() => {
      if (deck !== video || id !== operation || phase !== 'playing' || suspended() || !deck.paused) return;
      if (prefs.sound) soundBlocked = true;
      deck.muted = true;
      deck.play().catch(() => {});
    }, 120);
  }
  function cancelSpin() {
    ++spinId;
    spinning = false;
    body.classList.remove('is-spinning');
    document.querySelectorAll('.rolling').forEach(card => card.classList.remove('rolling'));
    $('randomButton').disabled = false;
    $('randomText').textContent = '交给心动';
    syncTransition();
  }
  function startOperation() {
    cancelTransition();
    pendingEntry = null;
    controller?.abort();
    controller = new AbortController();
    ++operation;
    stopWatcher();
    stopPreroll();
    video.pause();
    clearTimeout(loadingTimer);
    return { id: operation, signal: controller.signal };
  }
  // Every load/seek can be cancelled. Stale async work must never alter the new look.
  // Only two media decks: one playing, one paused on the next opening frame.
  // A transition starts at the real ended event, never at a recommended freeze.
  function cycling() { return prefs.playbackMode !== 'freeze'; }
  function looping() { return prefs.playbackMode === 'loop'; }
  // 单套 / 全部 / 收藏轮播自己会换装，此时「隔一段时间换一套」暂不生效；定格与往复都支持。
  function rotating() { return cycling() && !looping(); }
  // 往复循环依赖合并文件：[0, d] 为正放、[d, 2d] 为整段倒放（d = 单次入场片长）。
  const DEFAULT_PIVOT = 7;
  const FRAME = 1 / 60;
  // 单段片长 = N 帧（合并文件共 2N 帧）。按帧数取整：容器时长可能少记最后一帧（2N-1 帧），
  // 也可能被音轨的 AAC 补齐多出几毫秒，四舍五入到 N 两种情况都对。
  function clipDuration() {
    const frames = Math.round(Number(video.duration) * 30);
    return Number.isFinite(frames) && frames > 60 ? frames / 60 : LOOKS[current].duration;
  }
  // 正放时间 t 在倒放段里的对应时间。倒放段是原始帧 N-2 … 0（不重复正放末帧），
  // 所以原始帧 i 的倒放位置是 2N-2-i，见 tools/build-loop-media.sh。
  function mirror(t) { return 2 * (clipDuration() - FRAME) - t; }
  // 折返点：默认 7 秒，可在 catalog.js 的 look 上写 "pivot" 单独调整。
  function pivotTime() {
    const look = LOOKS[current];
    const pivot = Number(look.pivot);
    return Number.isFinite(pivot) && pivot > 0 && pivot < look.duration ? pivot : DEFAULT_PIVOT;
  }
  function favoriteOrder() { return DISPLAY_ORDER.filter(i => isPlayable(i) && prefs.favorites.includes(i)); }
  function nextLoopIndex() {
    if (prefs.playbackMode === 'single') return current;
    const order = prefs.playbackMode === 'all' ? DISPLAY_ORDER.filter(isPlayable) : favoriteOrder();
    if (!order.length) return null;
    const position = DISPLAY_ORDER.indexOf(current);
    return order.find(i => DISPLAY_ORDER.indexOf(i) > position) ?? order[0];
  }
  function renderPlaybackMode() {
    const labels = {freeze: '定格模式', single: '单套循环', all: '全部轮播', favorites: '收藏轮播', loop: '往复循环'};
    body.dataset.playbackMode = prefs.playbackMode;
    $('modeButton').setAttribute('aria-label', '播放方式：' + labels[prefs.playbackMode]);
    $('modeButton').title = labels[prefs.playbackMode] + ' · 切换播放方式';
    $('modeButton').disabled = phase === 'editing';
    $('favoriteCount').textContent = prefs.favorites.length;
    $('favoriteModeHint').textContent = prefs.favorites.length ? '喜欢的这几套，慢慢穿给你看' : '先点亮喜欢的穿搭';
    document.querySelectorAll('[data-playback]').forEach(option => {
      option.setAttribute('aria-checked', String(option.dataset.playback === prefs.playbackMode));
      option.setAttribute('aria-disabled', String(option.dataset.playback === 'favorites' && !prefs.favorites.length));
    });
    const loopToggle = $('loopToggle');
    if (loopToggle) loopToggle.checked = looping();
    $('autoOptions').classList.toggle('is-dormant', rotating());
    $('autoOptions').querySelectorAll('button').forEach(button => { button.disabled = rotating(); });
    $('intervalRow').classList.toggle('is-dormant', rotating());
    $('intervalRange').disabled = rotating();
    $('autoLoopNote').hidden = !rotating();
    if (phase === 'playing' && cycling()) $('timelineState').textContent = labels[prefs.playbackMode];
    if (phase === 'transition') {
      const paused = transition?.userPaused;
      $('timelineState').textContent = paused ? '暂停' : nextLoopIndex() === current ? '再看一遍' : '轻轻换一套';
      icon($('playButton'), paused ? 'play' : 'pause');
      $('playButton').setAttribute('aria-label', paused ? '继续循环播放' : '暂停循环播放');
      $('playButton').title = paused ? '继续循环播放' : '暂停循环播放';
    } else if (cycling() && (phase === 'playing' || phase === 'paused')) {
      $('playButton').setAttribute('aria-label', phase === 'paused' ? '继续循环播放' : '暂停循环播放');
      $('playButton').title = phase === 'paused' ? '继续循环播放' : '暂停循环播放';
    }
  }
  function openModeMenu() {
    if (phase === 'editing' || panel) return;
    clearTimeout(toastTimer); $('toast').classList.remove('show');
    modeOpen = true; $('modeMenu').hidden = false;
    $('modeButton').setAttribute('aria-expanded', 'true');
    activity(true); clearTimeout(idleTimer); renderPlaybackMode(); syncTransition();
    $('modeMenu').querySelector('[aria-checked="true"]').focus({preventScroll: true});
  }
  function closeModeMenu(restoreFocus = true) {
    if (!modeOpen) return;
    modeOpen = false; $('modeMenu').hidden = true;
    $('modeButton').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('modeButton').focus({preventScroll: true});
    syncTransition(); activity(true);
  }
  function setPlaybackMode(mode, speak = true) {
    if (!['freeze', 'single', 'all', 'favorites', 'loop'].includes(mode) || phase === 'editing') return;
    if (mode === 'favorites' && !favoriteOrder().length) return;
    closeModeMenu();
    if (mode === prefs.playbackMode) return;
    const interrupted = phase === 'transition';
    if (interrupted) { startOperation(); phase = 'held'; }
    prefs.playbackMode = mode;
    rampQuiet(1, 0);
    releaseSpare(); persist(); renderPlaybackMode();
    lastChange = Date.now();
    if (mode === 'freeze') selectLook(current, {restore: true, quiet: true});
    else {
      const selected = mode === 'favorites' && !prefs.favorites.includes(current) ? favoriteOrder()[0] : current;
      if (selected !== current || !['playing', 'paused'].includes(phase)) selectLook(selected, {quiet: true});
      else primeLoop();
    }
    if (speak) {
      const words = {freeze: '好，就把喜欢的这一刻留下。', single: '这么喜欢这一套呀……那就再陪你看一会儿。', all: '那就慢慢看，我一套一套换给你。', favorites: '你点过心的，我都记得。慢慢穿给你看。', loop: '那就来回走给你看，进进退退，都留在你眼前。'};
      toast(words[mode]);
      if (mode !== 'freeze') setStatus('STAY A LITTLE.', words[mode]);
      unlockAudio(); chime(660, .12);
    }
  }
  function releaseSpare() {
    prefetch?.controller.abort(); prefetch = null; prerolling = false;
    // 往复时主牌组带着行内 .999；交还给 CSS 的 #film.visible 控制，出错隐藏等才会生效。
    video.style.opacity = '';
    spare.pause(); spare.muted = true;
    spare.style.opacity = '0'; spare.style.zIndex = '1';
    spare.removeAttribute('src'); spare.removeAttribute('data-look'); spare.load();
  }
  function prepareNext(index) {
    if (!isPlayable(index)) return Promise.reject(new Error('unavailable'));
    if (prefetch?.index === index && prefetch.element === spare) return prefetch.promise;
    prefetch?.controller.abort();
    const item = {index, element: spare, controller: new AbortController(), promise: null};
    prefetch = item;
    const deck = item.element, signal = item.controller.signal;
    deck.pause(); deck.muted = true; deck.style.opacity = '0'; deck.style.zIndex = '1';
    item.promise = (async () => {
      if (deck.dataset.look !== LOOKS[index].id || deck.readyState < 2) await loadSource(deck, index, signal);
      if (deck.currentTime > .002 || deck.seeking) await mediaEvent('seeked', signal, () => { deck.currentTime = 0; }, deck);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      deck.dataset.look = LOOKS[index].id;
      return deck;
    })();
    // Speculative loading is silent; an actual failed handoff uses loadFailure.
    item.promise.catch(() => {});
    return item.promise;
  }
  function primeLoop() {
    if (!cycling() || !['playing', 'paused'].includes(phase)) return;
    // 往复模式不换装，改为让备用牌组提前定位到折返点（稍作延后，避开起播那几帧）。
    if (looping()) { schedulePivot(1200); return; }
    const next = nextLoopIndex();
    if (next !== null) prepareNext(next);
  }
  // Browsing settings or playback choices must not hold an automatic round.
  function transitionBlocked(tx) { return suspended() || tx.userPaused || panel === 'moment' || spinning; }
  function syncTransition() {
    const tx = transition;
    if (!tx) return;
    if (transitionBlocked(tx)) tx.animation?.pause();
    else {
      if (tx.animation?.playState === 'paused') tx.animation.play();
      [...tx.waiters].forEach(wake => wake());
    }
  }
  async function waitForTransition(tx) {
    if (tx.cancelled || tx.signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (!transitionBlocked(tx)) return Promise.resolve();
    await new Promise((resolve, reject) => {
      const clean = () => { tx.waiters.delete(wake); tx.signal.removeEventListener('abort', abort); };
      const wake = () => {
        if (tx.cancelled || tx.signal.aborted) { abort(); return; }
        if (!transitionBlocked(tx)) { clean(); resolve(); }
      };
      const abort = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
      tx.waiters.add(wake); tx.signal.addEventListener('abort', abort, {once: true});
    });
    // Pause state can change again in the same input event; recheck after waking.
    return waitForTransition(tx);
  }
  function cancelTransition() {
    const tx = transition;
    if (!tx) return;
    tx.cancelled = true; tx.animation?.cancel();
    [...tx.waiters].forEach(wake => wake());
    transition = null;
    spare.style.opacity = '0'; spare.style.zIndex = '1';
    video.style.zIndex = '1';
    body.classList.remove('is-loop-transition');
  }
  async function advanceLoop(userPaused = false) {
    if (!cycling() || phase !== 'playing' || transition || suspended()) return;
    const next = nextLoopIndex();
    if (next === null) { setPlaybackMode('freeze', false); return; }
    const task = startOperation();
    phase = 'transition';
    const tx = transition = {...task, userPaused, waiters: new Set(), cancelled: false, animation: null};
    body.classList.remove('is-playing'); body.classList.add('is-loop-transition');
    readyControls(false); renderPlaybackMode();
    $('loading').hidden = true;
    try {
      const [incoming] = await Promise.all([prepareNext(next), decodeStill(next)]);
      await waitForTransition(tx);
      // Let the completed motion breathe; never shorten either source clip.
      await delay(140);
      await waitForTransition(tx);
      if (task.id !== operation) return;
      incoming.style.zIndex = '2';
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      tx.animation = incoming.animate([{opacity: 0}, {opacity: .999}], {
        duration: reduced ? 100 : 460, easing: 'cubic-bezier(.4,0,.25,1)', fill: 'forwards'
      });
      syncTransition();
      await tx.animation.finished;
      await waitForTransition(tx);
      if (task.id !== operation) return;
      // The outgoing frame stays opaque below the incoming frame: no black dip.
      const outgoing = video, previous = current;
      stopWatcher();
      prefetch = null;
      video = incoming; spare = outgoing;
      spare.id = 'filmNext'; video.id = 'film';
      video.style.opacity = '.999'; video.style.zIndex = '1'; video.classList.add('visible');
      spare.classList.remove('visible'); spare.style.opacity = '0'; spare.style.zIndex = '1'; spare.muted = true;
      tx.animation.cancel(); video.style.opacity = ''; transition = null;
      current = next; loadedLook = next; phase = 'playing';
      rampQuiet(1, 0);
      applySound(true);
      $('still').src = `images/look-${LOOKS[next].id}.jpg`;
      syncMenuBar();
      $('still').alt = LOOKS[next].name + '穿搭推荐定格';
      document.querySelector('.ambient').style.backgroundImage = `url("images/ambient-${LOOKS[next].id}.jpg")`;
      if (page !== pageFor(next)) { page = pageFor(next); renderCards(false); } else updateCards();
      body.classList.remove('is-loop-transition'); body.classList.add('is-playing');
      icon($('playButton'), 'pause'); readyControls(false); renderPlaybackMode(); updateProgress(0); persist();
      // Automatic rounds never call toast/activity or wake an immersed interface.
      if (previous !== next) setStatus('HERE, WITH YOU.', dialogue.enter(next, {allowAffection: false}));
      await playSafely(task.id);
    } catch (error) {
      if (task.id === operation && !tx.cancelled) loadFailure(current, error, task.id);
    }
  }


  function mediaEvent(event, signal, action, element = video) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('media')); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      if (signal.aborted) return abort();
      element.addEventListener(event, done, { once: true });
      element.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 22000);
      try { action(); } catch (error) { cleanup(); reject(error); }
    });
  }
  async function loadSource(deck, index, signal) {
    await mediaEvent('loadeddata', signal, () => {
      deck.preload = 'auto'; deck.src = `media/look-${LOOKS[index].id}.${MEDIA_EXT}?v=${MEDIA_VERSION}`; deck.load();
    }, deck);
  }
  async function ensureLoaded(index, signal) {
    if (!isPlayable(index)) throw new Error('unavailable');
    if (loadedLook === index && video.readyState >= 2) return;
    loadedLook = -1;
    await loadSource(video, index, signal);
    loadedLook = index;
    video.dataset.look = LOOKS[index].id;
  }
  async function seek(time, signal) {
    const target = clamp(time, 0, Math.max(0, video.duration - .045));
    if (Math.abs(video.currentTime - target) < .002 && !video.seeking) return false;
    await mediaEvent('seeked', signal, () => { video.currentTime = target; });
    return true;
  }
  // WebKit fires seeked before the frame is on screen; wait for it (bounded) before lifting the curtain.
  function framePresented(deck, ms = 320) {
    if (!deck.requestVideoFrameCallback) return delay(40);
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      deck.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
  }
  // Decode the 4K still and its backdrop off-screen so swapping them never shows a half-drawn image.
  function decodeStill(index) {
    return Promise.all(['look', 'ambient'].map(kind => {
      const image = new Image();
      image.src = `images/${kind}-${LOOKS[index].id}.jpg`;
      return image.decode ? image.decode().catch(() => {}) : Promise.resolve();
    }));
  }
  async function playSafely(id) {
    if (suspended() || phase !== 'playing') return;
    try {
      await video.play();
      if (id !== operation) return;
      if (suspended() || phase !== 'playing') { video.pause(); return; }
      if (pendingEntry?.id === id) {
        const entry = pendingEntry;
        pendingEntry = null;
        const words = entry.event === 'quiet'
          ? null
          : entry.event === 'enter'
          ? dialogue.enter(entry.index, {allowAffection: entry.allowAffection})
          : line(entry.index, entry.event);
        if (words) setStatus('HERE, WITH YOU.', words);
      }
      renderPlaybackMode();
      watchFrames();
      primeLoop();
    } catch (error) {
      if (id !== operation || phase !== 'playing' || suspended()) return;
      // 带声起播被拒（没有用户手势）：先静音继续播，下一次点击时恢复声音。
      if (error.name === 'NotAllowedError' && !video.muted) { soundBlocked = true; applySound(); return playSafely(id); }
      phase = 'paused';
      body.classList.remove('is-playing');
      $('timelineState').textContent = '待播放';
      icon($('playButton'), 'play');
      $('playButton').setAttribute('aria-label', '继续播放入场');
      setStatus('READY WHEN YOU ARE.', '点一下播放，等你。');
      if (error.name !== 'NotAllowedError') toast('播放暂时中断，点播放继续。');
    }
  }
  function loadFailure(index, error, id) {
    if (error.name === 'AbortError' || id !== operation) return;
    cancelTransition();
    releaseSpare();
    pendingEntry = null;
    dialogue.cancelPending();
    phase = 'error';
    video.pause(); video.classList.remove('visible');
    $('still').src = `images/look-${LOOKS[index].id}.jpg`;
    $('still').alt = LOOKS[index].name + '穿搭推荐定格';
    $('curtain').classList.remove('closed');
    $('loading').hidden = true;
    clearTimeout(loadingTimer);
    body.classList.remove('is-playing');
    setStatus('A LITTLE PAUSE.', '入场加载未完成，点击重试。');
    icon($('playButton'), 'repeat');
    $('playButton').setAttribute('aria-label', '重试入场');
    readyControls(false);
    toast('视频暂时无法播放。请确认 media 文件夹完整，再点重试。');
    activity(true);
  }
  async function selectLook(index, { restore = false, entry = 'enter', allowAffection = true, preserveRandom = false, quiet = false } = {}) {
    if (!isPlayable(index)) { lockedTap(index); return; }
    closeModeMenu(false);
    if (cycling()) restore = false;
    if (!preserveRandom && (index !== current || (!restore && entry === 'enter'))) dialogue.cancelPending();
    cancelSpin();
    if (panel) closePanel(false);

    // 先接受选择：卡片高亮、名称与编号立刻更新，倒带动画随后才跟上。
    // 倒带期间仍可继续点击，只会更新 current；倒带结束后以「当前选择」为准加载，
    // 因此多次点击不会让早先那一次胜出。
    const changed = index !== current;
    current = index;
    if (page !== pageFor(index)) setPage(pageFor(index), false);
    updateCards(); persist();

    if (changed && cycling() && phase === 'playing') await rewindBeforeSwitch();

    index = current;
    const task = startOperation();
    releaseSpare();
    if (page !== pageFor(index)) setPage(pageFor(index), false);
    phase = 'loading';
    readyControls(true);
    body.classList.remove('is-playing');
    updateCards(); persist();
    if (!quiet) activity(true);
    // Keep the current line during the short transition; speak once entry starts.
    clearTimeout(replyTimer);
    $('timelineState').textContent = '准备';
    $('curtain').classList.add('closed');
    loadingTimer = setTimeout(() => { if (task.id === operation) $('loading').hidden = false; }, 900);
    const stillReady = decodeStill(index);
    try {
      await delay(420);
      if (task.id !== operation) return;
      await ensureLoaded(index, task.signal);
      if (task.id !== operation) return;
      // The curtain is still closed, so the deck can be shown early and composite its frame.
      video.classList.add('visible');
      const painted = framePresented(video);
      const moved = await seek(restore ? freezeTime() : 0, task.signal);
      await Promise.all([moved ? painted : delay(40), stillReady]);
      if (task.id !== operation) return;
      $('still').src = `images/look-${LOOKS[index].id}.jpg`;
      syncMenuBar();
      $('still').alt = LOOKS[index].name + '穿搭推荐定格';
      document.querySelector('.ambient').style.backgroundImage = `url("images/ambient-${LOOKS[index].id}.jpg")`;
      await delay(40);
      if (task.id !== operation) return;
      $('curtain').classList.remove('closed');
      $('loading').hidden = true; clearTimeout(loadingTimer);
      readyControls(false);
      lastChange = Date.now();
      if (restore) { settle(); return; }
      phase = 'playing';
      body.classList.add('is-playing');
      icon($('playButton'), 'pause');
      $('playButton').setAttribute('aria-label', '暂停入场');
      $('playButton').title = '暂停 / 继续入场';
      $('timelineState').textContent = '入场';
      pendingEntry = {id: task.id, index, event: quiet ? 'quiet' : entry, allowAffection};
      updateProgress(0);
      // 新的一套：第一次正放到底要有声音。
      rampQuiet(1, 0);
      applySound(true);
      await playSafely(task.id);
    } catch (error) { loadFailure(index, error, task.id); }
  }
  // 往复模式没有「下一套」：播到文件末尾（折返判定被错过）时回到折返点继续，
  // 不能交给 advanceLoop —— 它会因为 nextLoopIndex() 为空把模式改回定格。
  function resumeCycle() {
    if (looping() && video.ended) { video.currentTime = pivotTime(); playSafely(operation); }
    else if (cycling() && video.ended) advanceLoop();
    else playSafely(operation);
  }
  function togglePlayback() {
    if (phase === 'transition' && transition) {
      transition.userPaused = !transition.userPaused;
      syncTransition(); renderPlaybackMode(); activity(true);
      return;
    }
    if (phase === 'loading' || phase === 'editing') return;
    unlockAudio();
    if (phase === 'playing') {
      phase = 'paused'; video.pause(); stopWatcher(); stopPreroll(); body.classList.remove('is-playing');
      icon($('playButton'), 'play'); $('playButton').setAttribute('aria-label', '继续播放入场');
      $('timelineState').textContent = '暂停'; setStatus('TAKE YOUR TIME.', line(current, 'pause'));
    } else if (phase === 'paused') {
      phase = 'playing'; body.classList.add('is-playing');
      icon($('playButton'), 'pause'); $('playButton').setAttribute('aria-label', '暂停入场');
      $('timelineState').textContent = '入场'; setStatus('HERE, WITH YOU.', line(current, 'resume'));
      resumeCycle();
    } else selectLook(current, { entry: 'replay' });
    activity(true);
  }
  function randomIndex() {
    const pool = prefs.favorites.length ? prefs.favorites : AVAILABLE;
    bag = bag.filter(i => pool.includes(i));
    if (!bag.length) {
      bag = [...pool];
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    if (bag[bag.length - 1] === current && pool.length > 1) {
      if (bag.length > 1) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      else { bag = []; return randomIndex(); }
    }
    return bag.pop();
  }
  async function randomLook() {
    if (spinning || panel) return;
    unlockAudio();
    spinning = true;
    const token = ++spinId;
    const selected = randomIndex();
    if (page !== pageFor(selected)) setPage(pageFor(selected), false);
    $('randomButton').disabled = true;
    $('randomText').textContent = '心动挑选中';
    body.classList.add('is-spinning'); activity(true); syncTransition();
    const pool = prefs.favorites.length ? prefs.favorites : AVAILABLE;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rounds = reduced ? 1 : 12;
    for (let step = 0; step < rounds; step++) {
      if (token !== spinId) return;
      const visiblePool = CHAPTERS[page].looks.filter(i => pool.includes(i));
      const highlight = step === rounds - 1 ? selected : visiblePool[step % visiblePool.length];
      document.querySelectorAll('.look-card').forEach(card => card.classList.toggle('rolling', Number(card.dataset.look) === highlight));
      chime(420 + step * 30, .045);
      await delay(reduced ? 30 : 45 + step * 10);
    }
    if (token !== spinId) return;
    chime(880, .3);
    dialogue.cancelPending();
    const response = dialogue.reply(selected, 'random');
    toast(response.text, '她说 · ' + LOOKS[selected].short);
    selectLook(selected, {allowAffection: !response.rare, preserveRandom: true});
  }

  function closePanel(restoreFocus = true) {
    closeReset(false);
    $('settingsPanel').hidden = true; $('momentPanel').hidden = true;
    $('settingsButton').setAttribute('aria-expanded', 'false');
    body.classList.remove('has-panel'); panel = null;
    if (restoreFocus) panelReturnFocus?.focus({ preventScroll: true });
    panelReturnFocus = null;
    syncTransition();
    activity(true);
  }
  function showPanel(name, trigger) {
    closeModeMenu(false);
    body.classList.remove('is-idle', 'is-immersed');
    closePanel(false);
    panel = name; panelReturnFocus = trigger;
    body.classList.add('has-panel');
    $(name + 'Panel').hidden = false;
    clearTimeout(idleTimer);
    syncTransition();
  }
  async function openMoment() {
    if (phase === 'loading' || phase === 'editing') return;
    cancelSpin();
    editorOriginal = { time: loadedLook === current && video.classList.contains('visible') ? video.currentTime : freezeTime(), phase };
    const task = startOperation();
    phase = 'editing'; body.classList.remove('is-playing');
    showPanel('moment', $('momentButton'));
    readyControls(true); $('momentRange').disabled = true; $('saveMoment').disabled = true;
    $('momentLook').textContent = LOOKS[current].name;
    const words = line(current, 'edit');
    setStatus('FIND YOUR MOMENT.', words);
    $('momentHint').textContent = words;
    try {
      await ensureLoaded(current, task.signal);
      await seek(editorOriginal.time, task.signal);
      if (task.id !== operation || panel !== 'moment') return;
      video.classList.add('visible');
      $('momentRange').max = video.duration - .05;
      $('momentDuration').textContent = ' / ' + video.duration.toFixed(2) + ' s';
      $('momentRange').value = video.currentTime;
      $('momentTime').textContent = video.currentTime.toFixed(2);
      $('momentRange').disabled = false; $('saveMoment').disabled = false;
      $('momentRange').focus({ preventScroll: true });
    } catch (error) { if (task.id === operation && error.name !== 'AbortError') { closePanel(); loadFailure(current, error, task.id); } }
  }
  function previewTime(value) {
    if (phase !== 'editing' || loadedLook !== current || $('momentRange').disabled) return;
    const t = clamp(Number(value), .1, Number($('momentRange').max));
    video.currentTime = t;
    $('momentRange').value = t;
    $('momentTime').textContent = t.toFixed(2);
    updateProgress(t);
  }
  async function cancelMoment() {
    if (panel !== 'moment') return;
    const original = editorOriginal;
    const task = startOperation();
    closePanel();
    try {
      await ensureLoaded(current, task.signal);
      await seek(original?.time ?? freezeTime(), task.signal);
      if (task.id !== operation) return;
      video.classList.add('visible');
      if (original?.phase === 'held' || original?.phase === 'error') settle();
      else {
        phase = 'paused'; icon($('playButton'), 'play');
        $('playButton').setAttribute('aria-label', '继续播放入场');
        $('timelineState').textContent = '暂停'; setStatus('TAKE YOUR TIME.', line(current, 'pause'));
        readyControls(false); updateProgress(video.currentTime);
      }
    respond(current, 'cancel', 'TAKE YOUR TIME.', false);
    } catch (error) { loadFailure(current, error, task.id); }
  }
  function saveMoment() {
    if (phase !== 'editing' || $('saveMoment').disabled) return;
    prefs.freezes[current] = Number($('momentRange').value);
    prefs.playbackMode = 'freeze'; releaseSpare(); renderPlaybackMode();
    persist(); closePanel(); settle(); lastChange = Date.now();
    respond(current, 'saved', 'YOUR MOMENT, KEPT.');
    chime(784, .22);
  }
  function onSuspend() {
    body.classList.toggle('is-system-paused', suspended());
    if (suspended()) { stopPreroll(); decks.forEach(deck => deck.pause()); stopWatcher(); clearTimeout(idleTimer); audioContext?.suspend().catch(() => {}); }
    else { lastChange = Date.now(); if (phase === 'playing') resumeCycle(); activity(true); }
    syncTransition();
  }

  window.wallpaperPropertyListener = {
    setPaused(isPaused) { systemPaused = Boolean(isPaused); onSuspend(); },
    applyUserProperties(properties) {
      const changed = key => {
        if (!properties[key]) return false;
        const value = properties[key].value;
        const known = Object.prototype.hasOwnProperty.call(prefs.nativeValues, key);
        if (known && prefs.nativeValues[key] === value) return false;
        prefs.nativeValues[key] = value;
        // A reset before the host's first callback also needs a baseline. Later
        // intentional edits of known properties continue to work normally.
        return known || !prefs.nativeValues.__resetBaseline;
      };
      if (changed('sound')) prefs.sound = Boolean(properties.sound.value);
      if (changed('volume')) prefs.volume = number(properties.volume.value, prefs.volume, 0, 100);
      if (changed('brightness')) prefs.brightness = number(properties.brightness.value, prefs.brightness, 65, 115);
      if (changed('autohide')) prefs.autoHide = Boolean(properties.autohide.value);
      if (changed('fit')) prefs.fit = properties.fit.value === 'cover' ? 'cover' : 'contain';
      if (changed('autoswitch')) prefs.interval = intervalMinutes(properties.autoswitch.value);
      const lookChanged = changed('look');
      if (['sound', 'volume', 'brightness', 'autohide', 'fit', 'autoswitch', 'look'].every(key => Object.prototype.hasOwnProperty.call(prefs.nativeValues, key))) {
        delete prefs.nativeValues.__resetBaseline;
      }
      applyPrefs(); persist();
      if (lookChanged) {
        const index = Number(properties.look.value) - 1;
        if (isPlayable(index)) selectLook(index, {restore: true});
      }
    }
  };
  function closeReset(restoreFocus = true) {
    if ($('resetConfirm').hidden) return;
    $('resetConfirm').hidden = true;
    $('resetSettingsButton').setAttribute('aria-expanded', 'false');
    $('resetFeedback').hidden = true;
    if (restoreFocus) $('resetSettingsButton').focus({preventScroll: true});
  }
  $('resetSettingsButton').addEventListener('click', () => {
    if (!$('resetConfirm').hidden) { closeReset(); return; }
    // Finish an unsaved position preview before showing a separate confirmation.
    window.dispatchEvent(new Event('purple:reset-prompt'));
    $('resetFeedback').hidden = true;
    $('resetConfirm').hidden = false;
    $('resetSettingsButton').setAttribute('aria-expanded', 'true');
    $('cancelReset').focus({preventScroll: true});
    $('resetConfirm').scrollIntoView({block: 'nearest'});
  });
  $('cancelReset').addEventListener('click', () => closeReset());
  $('confirmReset').addEventListener('click', () => {
    if (panel !== 'settings' || $('resetConfirm').hidden) return;
    const next = {...defaults, favorites: [], freezes: [...defaults.freezes],
      // Host synchronization metadata is not a user preference. Retain the last
      // observed values so a repeated host callback cannot undo the reset.
      nativeValues: {...prefs.nativeValues, __resetBaseline: true}};
    const updates = [[KEY, next], [KEY + '.reading-v1', {size: 'standard'}], [KEY + '.layout-v1', {offsetRatio: 0}]];
    const originals = [], written = [];
    try {
      for (const [key] of updates) originals.push([key, localStorage.getItem(key)]);
      for (const [key, value] of updates) {
        localStorage.setItem(key, JSON.stringify(value)); written.push(key);
      }
    } catch (_) {
      for (const [key, value] of originals) {
        if (!written.includes(key)) continue;
        try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_) {}
      }
      $('resetFeedback').textContent = '暂时无法保存重置结果，请稍后重试。';
      $('resetFeedback').hidden = false;
      return;
    }
    // Cancel every pending playback/spin task before it can persist old choices.
    startOperation(); phase = 'held'; cancelSpin(); releaseSpare();
    video.classList.remove('visible'); video.style.opacity = '';
    video.removeAttribute('src'); video.removeAttribute('data-look'); video.load();
    audioContext?.suspend().catch(() => {});
    loadedLook = -1;
    clearTimeout(replyTimer); clearTimeout(toastTimer); clearTimeout(idleTimer);
    $('toast').classList.remove('show'); $('loading').hidden = true;
    $('curtain').classList.remove('closed');
    body.classList.remove('is-playing', 'is-immersed', 'is-idle');
    Object.assign(prefs, next); current = defaults.current; page = pageFor(current);
    bag = []; editorOriginal = null; privateVisits = 0; lastPrivateReply = lastPrivateAside = -Infinity;
    dialogue = window.createPurpleDialogue({looks: LOOKS, replies: REPLIES, affection: window.PURPLE_AFFECTION, isPlayable});
    lastChange = Date.now();
    closeModeMenu(false); closePanel();
    // These modules update their in-memory state without writing additional keys.
    window.dispatchEvent(new Event('purple:reset-settings'));
    showRememberedStill();
    $('timelineState').textContent = '定格'; icon($('playButton'), 'repeat');
    $('playButton').title = '再看一次入场'; $('playButton').setAttribute('aria-label', '再看一次入场');
    readyControls(false); renderPlaybackMode();
    toast('已回到初始状态。', '设置已恢复');
    // 默认是往复循环：恢复后直接开始播放。
    if (cycling()) selectLook(current, {quiet: true});
  });


  $('looks').addEventListener('click', event => {
    const select = event.target.closest('[data-select]');
    if (select) { unlockAudio(); chime(523, .08); selectLook(Number(select.dataset.select)); return; }
    const favorite = event.target.closest('[data-favorite]');
    if (favorite) {
      const i = Number(favorite.dataset.favorite);
      if (!isPlayable(i)) return;
      const exists = prefs.favorites.includes(i);
      prefs.favorites = exists ? prefs.favorites.filter(x => x !== i) : [...prefs.favorites, i];
      bag = []; cancelSpin(); updateCards(); persist(); activity(true);
      if (prefs.playbackMode === 'favorites' && !prefs.favorites.length) setPlaybackMode('freeze', false);
      else if (phase === 'transition' && prefs.playbackMode === 'favorites') {
        const paused = transition?.userPaused;
        startOperation(); phase = 'playing'; advanceLoop(paused);
      } else primeLoop();
      respond(i, exists ? 'unfavorite' : 'favorite', 'A LITTLE PREFERENCE.');
    }
  });
  $('prevPage').addEventListener('click', () => setPage(page - 1));
  $('nextPage').addEventListener('click', () => setPage(page + 1));
  $('pageTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-page]');
    if (button) setPage(Number(button.dataset.page));
  });
  $('randomButton').addEventListener('click', randomLook);
  $('playButton').addEventListener('click', togglePlayback);
  $('modeButton').addEventListener('click', () => modeOpen ? closeModeMenu() : openModeMenu());
  $('modeMenu').addEventListener('click', event => {
    const option = event.target.closest('[data-playback]');
    if (!option || option.getAttribute('aria-disabled') === 'true') return;
    setPlaybackMode(option.dataset.playback);
  });
  document.addEventListener('pointerdown', event => {
    if (modeOpen && !event.target.closest('.playback-mode')) closeModeMenu(false);
  });
  document.addEventListener('focusin', event => {
    if (modeOpen && !event.target.closest('.playback-mode')) closeModeMenu(false);
  });
  $('modeMenu').addEventListener('keydown', event => {
    const options = [...$('modeMenu').querySelectorAll('[data-playback]')].filter(option => option.getAttribute('aria-disabled') !== 'true');
    const index = options.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next].focus({preventScroll: true});
    }
  });
  $('momentButton').addEventListener('click', openMoment);
  $('cancelMoment').addEventListener('click', cancelMoment);
  $('saveMoment').addEventListener('click', saveMoment);
  $('momentRange').addEventListener('input', event => previewTime(event.target.value));
  $('prevFrame').addEventListener('click', () => previewTime(Number($('momentRange').value) - 1 / LOOKS[current].fps));
  $('nextFrame').addEventListener('click', () => previewTime(Number($('momentRange').value) + 1 / LOOKS[current].fps));
  $('resetMoment').addEventListener('click', () => { previewTime(LOOKS[current].freeze); respond(current, 'reset', 'FIND YOUR MOMENT.'); });
  $('settingsButton').addEventListener('click', () => {
    if (panel === 'settings') { closePanel(); return; }
    if (phase === 'editing') return;
    cancelSpin(); showPanel('settings', $('settingsButton'));
    $('settingsButton').setAttribute('aria-expanded', 'true'); $('closeSettings').focus({ preventScroll: true });
  });
  $('closeSettings').addEventListener('click', () => closePanel());
  $('brightness').addEventListener('input', event => { prefs.brightness = Number(event.target.value); applyPrefs(); persist(); });
  $('volume').addEventListener('input', event => { prefs.volume = Number(event.target.value); applyPrefs(); persist(); });
  $('idleToggle').addEventListener('change', event => { prefs.autoHide = event.target.checked; applyPrefs(); persist(); });
  $('awayToggle').addEventListener('change', event => { prefs.muteAway = event.target.checked; applyPrefs(); persist(); pollDesktop(); });
  $('menuBarToggle').addEventListener('change', event => { prefs.menuBarFollow = event.target.checked; applyPrefs(); persist(); });
  // 设置面板里的「循环 / 定格」开关：循环即往复播放，定格即停在自选的一帧。
  $('loopToggle').addEventListener('change', event => { setPlaybackMode(event.target.checked ? 'loop' : 'freeze'); });
  // HTML buttons keep settings inside the web renderer across wallpaper hosts.
  $('fitOptions').addEventListener('click', event => {
    const button = event.target.closest('[data-fit]');
    if (!button) return;
    prefs.fit = button.dataset.fit; applyPrefs(); persist();
  });
  // 切换方式：倒带（先倒放回开头再换）或闪入（直接切换）。
  $('switchOptions').addEventListener('click', event => {
    const button = event.target.closest('[data-switch-mode]');
    if (!button) return;
    prefs.switchMode = button.dataset.switchMode; applyPrefs(); persist();
  });
  $('intervalRange').addEventListener('input', event => {
    if (rotating()) return;
    prefs.interval = intervalMinutes(event.target.value) || 1; lastChange = Date.now(); applyPrefs(); persist();
  });
  $('autoOptions').addEventListener('click', event => {
    if (rotating()) return;
    const button = event.target.closest('[data-interval]');
    if (!button) return;
    prefs.interval = Number(button.dataset.interval); lastChange = Date.now(); applyPrefs(); persist();
  });
  $('soundButton').addEventListener('click', () => { prefs.sound = !prefs.sound; applyPrefs(); persist(); pollDesktop(); unlockAudio(); chime(660, .17); toast(prefs.sound ? '声音已开启。' : '安静地陪你。'); });
  $('immerseButton').addEventListener('click', async () => { cancelSpin(); if (panel === 'moment') await cancelMoment(); else if (panel) closePanel(false); body.classList.add('is-immersed'); document.activeElement.blur(); });
  const wake = () => {
    const hidden = body.classList.contains('is-immersed') || body.classList.contains('is-idle');
    body.classList.remove('is-immersed', 'is-idle'); activity(true);
    if (hidden && phase === 'held') respond(current, 'wake', 'HERE, WITH YOU.', false);
  };
  $('wakeButton').addEventListener('click', wake);
  $('brand').addEventListener('click', event => { event.preventDefault(); wake(); });
  document.addEventListener('pointermove', () => activity());
  document.addEventListener('pointerdown', () => { unlockDecks(); unlockAudio(); activity(true); });
  // click / keydown 在 WebKit 里一定算用户手势，作为 pointerdown 的兜底。
  document.addEventListener('click', unlockDecks, true);
  document.addEventListener('keydown', unlockDecks, true);
  document.addEventListener('focusin', () => activity(true));
  document.addEventListener('visibilitychange', () => { documentPaused = document.hidden; onSuspend(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (!$('resetConfirm').hidden) closeReset(); else if (modeOpen) closeModeMenu(); else if (panel === 'moment') cancelMoment(); else if (panel) closePanel(); else wake(); return; }
    // Mouse controls cover every function. These are only browser-preview conveniences.
    if (event.target.matches('input,select,textarea,button,a') || panel || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[1-9]$/.test(event.key)) selectLook(DISPLAY_ORDER[Number(event.key) - 1]);
    else if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    else if (event.key.toLowerCase() === 'r') randomLook();
    else if (event.key.toLowerCase() === 'h') body.classList.toggle('is-immersed');
    activity(true);
  });
  for (const deck of decks) {
    // Host media-resume calls must never start the prepared, invisible deck.
    const play = deck.play.bind(deck);
    nativePlay.set(deck, play);
    deck.play = function () {
      if (deck !== video || phase !== 'playing' || suspended()) return Promise.resolve();
      return play();
    };
    deck.addEventListener('play', () => {
      if (deck === spare && prerolling && phase === 'playing' && !suspended()) return;
      if (deck !== video || phase !== 'playing' || suspended()) deck.pause();
    });
    // 往复模式的「片尾」由 watchFrames 按片长判定；万一错过折返点播到了文件末尾，回折返点继续。
    deck.addEventListener('ended', () => {
      if (deck !== video || phase !== 'playing' || rewinding) return;
      if (looping()) resumeCycle(); else cycling() ? advanceLoop() : settle();
    });
    // 宿主（如 Plash 的「静音」选项）会注入脚本强制把所有 <video> 设为静音。
    // 不跟它抢（它在每次 DOM 变化时都会再静音一次），只提示一次去哪里关掉。
    deck.addEventListener('volumechange', () => {
      if (deck !== video || hostMuteNoticed || !deck.muted || !prefs.sound || soundBlocked) return;
      hostMuteNoticed = true;
      toast('声音被壁纸程序静音了。请在 Plash 设置里关闭静音选项。', '提示');
    });
    deck.addEventListener('timeupdate', () => { if (deck === video && phase === 'playing' && !cycling() && video.currentTime >= freezeTime()) settle(); });
    deck.addEventListener('waiting', () => { if (deck === video && phase === 'playing' && !suspended()) { clearTimeout(loadingTimer); loadingTimer = setTimeout(() => { if (phase === 'playing' && video.readyState < 3) $('loading').hidden = false; }, 900); } });
    deck.addEventListener('playing', () => { if (deck === video) { clearTimeout(loadingTimer); $('loading').hidden = true; } });
    deck.addEventListener('error', () => { if (deck === video && (phase === 'playing' || phase === 'paused')) loadFailure(current, new Error('decode'), operation); });
  }

  function updateClock() {
    const date = new Date();
    $('clock').textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  updateClock();
  setInterval(() => {
    if (suspended()) return;
    updateClock();
    // 往复模式没有「定格」态，改用 playing 作为可切换条件；触发后会先倒带再换装。
    const switchReady = looping() ? (phase === 'playing' && !rewinding) : (!cycling() && phase === 'held');
    if (switchReady && prefs.interval && !panel && !modeOpen && !spinning && Date.now() - lastChange >= prefs.interval * MINUTE) randomLook();
  }, Math.min(15000, MINUTE / 4));
  function showRememberedStill() {
    $('still').src = `images/look-${LOOKS[current].id}.jpg`;
    $('still').alt = LOOKS[current].name + '穿搭推荐定格';
    document.querySelector('.ambient').style.backgroundImage = `url("images/ambient-${LOOKS[current].id}.jpg")`;
    renderCards(); updateProgress(freezeTime()); applyPrefs();
    setStatus('MOMENT, KEPT.', line(current, 'held'));
  }
  showRememberedStill();
  pollDesktop();
  if (cycling()) {
    const index = prefs.playbackMode === 'favorites' && !prefs.favorites.includes(current) ? favoriteOrder()[0] : current;
    selectLook(index, {quiet: true});
  } else if (Math.abs(freezeTime() - LOOKS[current].freeze) > .008) selectLook(current, { restore: true });
})();

/* Self-contained optional layout feature; no writes to wardrobe/playback preferences. */
(() => {
  'use strict';
  const KEY = 'frac-hinata.safe.we.wardrobe-v1.layout-v1';
  const $ = id => document.getElementById(id);
  const root = document.documentElement, body = document.body;
  const wardrobe = document.querySelector('.wardrobe');
  const status = document.querySelector('.now-playing');
  const range = $('layoutRange'), settings = $('settingsPanel');
  const guide = document.createElement('div');
  guide.className = 'layout-guide'; guide.hidden = true;
  guide.setAttribute('aria-hidden', 'true');
  guide.innerHTML = '<span>左侧界面对齐线</span>';
  body.append(guide);
  let savedRatio = 0, draftRatio = 0, offset = 0, editing = false, resizeFrame = 0;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}').offsetRatio;
    if (Number.isFinite(value)) savedRatio = Math.max(-.25, Math.min(.25, value));
  } catch (_) {}
  const label = pixels => Math.abs(pixels) < 1 ? '默认位置' : `${pixels > 0 ? '右移' : '左移'} ${Math.abs(pixels)} px`;
  function bounds() {
    const width = root.clientWidth;
    const card = wardrobe.getBoundingClientRect();
    const brand = $('brand').getBoundingClientRect();
    const topRight = document.querySelector('.top-right').getBoundingClientRect();
    const playback = document.querySelector('.playback').getBoundingClientRect();
    const bottom = status.getBoundingClientRect();
    const baseLeft = card.left - offset, baseRight = card.right - offset;
    // A modest horizontal allowance keeps the column in the existing left composition.
    let max = Math.min(width * .12, Math.max(0, width * .52 - baseRight), topRight.left - (brand.right - offset) - 24);
    if (bottom.width) {
      const textWidth = Math.min(bottom.width, 15 + parseFloat(getComputedStyle(status.querySelector('p')).maxWidth));
      max = Math.min(max, playback.left - (bottom.left - offset + textWidth) - 24);
    }
    return {min:Math.min(0, Math.ceil(16 - baseLeft)), max:Math.max(0, Math.floor(max))};
  }
  function render() {
    const {min, max} = bounds();
    const requested = Math.round((editing ? draftRatio : savedRatio) * root.clientWidth);
    offset = Math.max(min, Math.min(max, requested));
    root.style.setProperty('--left-offset', offset + 'px');
    range.min = min; range.max = max; range.value = offset;
    range.disabled = min === max;
    range.setAttribute('aria-valuetext', label(offset));
    $('layoutValue').textContent = label(offset);
    $('layoutSummary').textContent = label(offset) + ' · 左侧整列一起移动';
    $('layoutLeft').disabled = offset <= min;
    $('layoutRight').disabled = offset >= max;
    $('layoutNote').textContent = max - min < 40
      ? '当前屏幕的留白较窄，可移动范围已收拢。'
      : '为桌面图标留一点空位，人物和播放控件留在原处。';
  }
  function finish(save, focus = true) {
    if (!editing) return;
    if (save) {
      savedRatio = offset / root.clientWidth;
      try { localStorage.setItem(KEY, JSON.stringify({offsetRatio:savedRatio})); } catch (_) {}
    }
    editing = false;
    $('layoutControls').hidden = true;
    $('layoutButton').setAttribute('aria-expanded', 'false');
    guide.hidden = true; body.classList.remove('is-layout-adjusting');
    render();
    if (focus && !settings.hidden) $('layoutButton').focus({preventScroll:true});
  }
  function preview(pixels) {
    if (!editing) return;
    draftRatio = pixels / root.clientWidth;
    render();
  }
  $('layoutButton').addEventListener('click', () => {
    if (editing) { finish(false); return; }
    editing = true; draftRatio = savedRatio;
    $('layoutControls').hidden = false;
    $('layoutButton').setAttribute('aria-expanded', 'true');
    guide.hidden = false; body.classList.add('is-layout-adjusting');
    render();
    range.focus({preventScroll:true});
    $('layoutControls').scrollIntoView({block:'nearest', behavior:'instant'});
  });
  range.addEventListener('input', () => preview(Number(range.value)));
  $('layoutLeft').addEventListener('click', () => preview(offset - 8));
  $('layoutRight').addEventListener('click', () => preview(offset + 8));
  $('layoutReset').addEventListener('click', () => preview(0));
  $('layoutCancel').addEventListener('click', () => finish(false));
  $('layoutDone').addEventListener('click', () => finish(true));
  settings.addEventListener('keydown', event => {
    if (editing && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); finish(false);
    }
  });
  new MutationObserver(() => { if (settings.hidden) finish(false, false); }).observe(settings, {attributes:true, attributeFilter:['hidden']});
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(render);
  });
  window.addEventListener('purple:typography-change', render);
  window.addEventListener('purple:reset-prompt', () => finish(false, false));
  window.addEventListener('purple:reset-settings', () => {
    savedRatio = draftRatio = 0;
    finish(false, false); render();
  });
  render();
})();

/* Typography preferences are independent of media, favorites and layout position. */
(() => {
  'use strict';
  const KEY = 'frac-hinata.safe.we.wardrobe-v1.reading-v1';
  const body = document.body, wardrobe = document.querySelector('.wardrobe');
  const footer = document.querySelector('.bottom-bar');
  const status = document.querySelector('.now-playing'), credit = document.querySelector('.credit');
  const immersion = document.querySelector('#immerseButton span');
  const root = document.documentElement;
  const choices = ['standard', 'comfortable', 'larger', 'large'];
  let size = 'standard', frame = 0;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}').size;
    if (choices.includes(value)) size = value;
  } catch (_) {}
  function setLength(name, value) {
    const previous = parseFloat(root.style.getPropertyValue(name));
    if (!Number.isFinite(previous) || Math.abs(previous - value) > .05) root.style.setProperty(name, value + 'px');
  }
  function alignFooter() {
    if (getComputedStyle(status).display === 'none' || getComputedStyle(immersion).display === 'none') {
      root.style.removeProperty('--creator-bottom'); root.style.removeProperty('--companion-top');
      return;
    }
    const textBottom = element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return range.getBoundingClientRect().bottom;
    };
    // Remove the idle animation offset from measurement, even during a fade.
    const footerShift = footer.getBoundingClientRect().bottom - (innerHeight - parseFloat(getComputedStyle(footer).bottom));
    const target = textBottom(immersion) - footerShift;
    const creditBottom = parseFloat(getComputedStyle(credit).bottom);
    setLength('--creator-bottom', creditBottom + textBottom(credit) - target);
    const gap = parseFloat(getComputedStyle(status.querySelector('p')).fontSize) * 4 / 3;
    const currentTop = parseFloat(getComputedStyle(status).top) || 0;
    const naturalBottom = status.getBoundingClientRect().bottom - footerShift - currentTop;
    setLength('--companion-top', credit.getBoundingClientRect().top - gap - naturalBottom);
  }
  function fitWardrobe() {
    alignFooter();
    wardrobe.style.removeProperty('top'); wardrobe.style.removeProperty('bottom');
    wardrobe.style.removeProperty('max-height'); wardrobe.classList.remove('is-reading-constrained');
    const box = wardrobe.getBoundingClientRect();
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 24;
    const footerTop = getComputedStyle(status).display === 'none' ? footer.getBoundingClientRect().top : status.getBoundingClientRect().top;
    const bottom = footerTop - 28;
    if (box.top < top || box.bottom > bottom) {
      const y = Math.max(top, Math.min(box.top, bottom - box.height));
      wardrobe.style.top = (y - parseFloat(getComputedStyle(wardrobe).marginTop)) + 'px'; wardrobe.style.bottom = 'auto';
      if (box.height > bottom - y) {
        wardrobe.style.maxHeight = Math.max(100, bottom - y) + 'px';
        wardrobe.classList.add('is-reading-constrained');
      }
    }
  }
  function scheduleFit() { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitWardrobe); }
  function apply() {
    body.dataset.textSize = size;
    const screenRatio = Math.min(innerWidth / 2560, innerHeight / 1440);
    const landscape = innerWidth / innerHeight >= 4 / 3;
    const compact = landscape && innerHeight > 850 ? Math.max(0, Math.min(1, (1 - screenRatio) / .25)) : 0;
    const highResolution = landscape ? Math.max(0, Math.min(1, (screenRatio - 1) / .5)) : 0;
    wardrobe.style.setProperty('--wardrobe-composition-scale', 1 - .05 * compact + .08 * highResolution);
    wardrobe.style.setProperty('--wardrobe-lift', (18 * compact) + 'px');
    // QHD cover/name proportion, plus the final approved 10% increase at 4K.
    wardrobe.style.setProperty('--wardrobe-name-factor', 1 - (1 - 1.15 * 1.1 / 1.8) * highResolution);
    const beyondQHD = Math.min(innerWidth / 2560, innerHeight / 1440) > 1;
    body.classList.toggle('is-reading-gentle', size === 'comfortable' || (size === 'standard' && beyondQHD));
    body.classList.toggle('is-reading-enlarged', size === 'larger' || size === 'large');
    document.querySelectorAll('[data-text-size]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.textSize === size));
    });
    scheduleFit();
    window.dispatchEvent(new Event('purple:typography-change'));
  }
  document.getElementById('textSizeOptions').addEventListener('click', event => {
    const button = event.target.closest('[data-text-size]');
    if (!button || !choices.includes(button.dataset.textSize)) return;
    size = button.dataset.textSize;
    try { localStorage.setItem(KEY, JSON.stringify({size})); } catch (_) {}
    apply();
    button.scrollIntoView({block:'nearest', behavior:'instant'});
  });
  window.addEventListener('resize', apply);
  window.addEventListener('purple:reset-settings', () => { size = 'standard'; apply(); });
  const observer = new ResizeObserver(scheduleFit);
  [wardrobe, status, credit, footer, document.querySelector('.topbar')].forEach(element => observer.observe(element));
  document.fonts.ready.then(scheduleFit);
  apply();
})();
