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
  // All clips ship as H.264 MP4: Safari / Plash (WebKit) hardware-decodes it, and
  // Chromium, CEF (Wallpaper Engine) and Firefox all play it natively.
  const MEDIA_EXT = 'mp4';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
  const FREEZE_REVISION = 1;
  const defaults = {
    current: 3, favorites: [], freezes: LOOKS.map((look, index) => isPlayable(index) ? look.freeze : null),
    freezeRevision: FREEZE_REVISION, sound: false, volume: 35, brightness: 100,
    autoHide: true, fit: 'contain', interval: 0, playbackMode: 'freeze', switchMode: 'rewind'
  };
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
    fit: saved.fit === 'cover' ? 'cover' : 'contain',
    interval: [0, 5, 15, 30].includes(Number(saved.interval)) ? Number(saved.interval) : 0,
    playbackMode: ['single', 'all', 'favorites', 'loop'].includes(saved.playbackMode) ? saved.playbackMode : 'freeze',
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
  let spinId = 0;
  let spinning = false;
  let rewinding = false;
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
    document.querySelectorAll('[data-fit]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fit === prefs.fit)));
    document.querySelectorAll('[data-interval]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.interval) === prefs.interval)));
    document.querySelectorAll('[data-switch-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.switchMode === prefs.switchMode)));
    video.muted = !prefs.sound;
    video.volume = prefs.volume / 100;
    spare.muted = true;
    renderPlaybackMode();
    icon($('soundButton'), prefs.sound ? 'volume' : 'mute');
    $('soundButton').setAttribute('aria-label', prefs.sound ? '关闭声音' : '开启声音');
    $('soundButton').title = prefs.sound ? '关闭声音' : '开启声音';
    $('soundButton').setAttribute('aria-pressed', String(prefs.sound));
    activity(true);
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
  function unlockAudio() {
    if (!prefs.sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    } catch (_) {}
  }
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
      if (frameKind === 'video') video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
    }
    frameHandle = null;
  }
  function watchFrames() {
    stopWatcher();
    if (phase !== 'playing' || suspended()) return;
    const schedule = () => {
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
        // 合并文件 [0, d] 正放、[d, 2d] 倒放。倒放到折返点时跳回正放段，
        // 继续正放——如此往复，每个来回只需一次 seek。
        if (t >= 2 * d - pivotTime() - .006) video.currentTime = pivotTime();
        schedule();
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
  async function rewindBeforeSwitch() {
    if (rewinding || prefs.switchMode !== 'rewind') return;
    const d = clipDuration();
    const t = video.currentTime;
    if (!(t > .05)) return;
    rewinding = true;
    stopWatcher();
    $('timelineState').textContent = '倒带';
    if (t <= d) video.currentTime = Math.max(0, Math.min(2 * d - t, 2 * d - .05));
    await new Promise(resolve => {
      const finish = () => { video.removeEventListener('ended', finish); clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 20000);
      video.addEventListener('ended', finish, { once: true });
      const played = video.play();
      if (played && played.catch) played.catch(finish);
    });
    rewinding = false;
  }
  // 片尾自动换装同样先倒放回开头，与手动切换保持一致。
  async function rewindThenAdvance() {
    await rewindBeforeSwitch();
    advanceLoop();
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
    video.pause();
    clearTimeout(loadingTimer);
    return { id: operation, signal: controller.signal };
  }
  // Every load/seek can be cancelled. Stale async work must never alter the new look.
  // Only two media decks: one playing, one paused on the next opening frame.
  // A transition starts at the real ended event, never at a recommended freeze.
  function cycling() { return prefs.playbackMode !== 'freeze'; }
  function looping() { return prefs.playbackMode === 'loop'; }
  // 往复循环依赖合并文件：[0, d] 为正放、[d, 2d] 为整段倒放（d = 单次入场片长）。
  const DEFAULT_PIVOT = 7;
  function clipDuration() {
    const half = Number(video.duration) / 2;
    return Number.isFinite(half) && half > 1 ? half : LOOKS[current].duration;
  }
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
    $('autoOptions').classList.toggle('is-dormant', cycling());
    $('autoOptions').querySelectorAll('button').forEach(button => { button.disabled = cycling(); });
    $('autoLoopNote').hidden = !cycling();
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
    prefetch?.controller.abort(); prefetch = null;
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
    if (!cycling() || looping() || !['playing', 'paused'].includes(phase)) return;
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
      video.muted = !prefs.sound; video.volume = prefs.volume / 100;
      $('still').src = `images/look-${LOOKS[next].id}.jpg`;
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
      deck.preload = 'auto'; deck.src = `media/look-${LOOKS[index].id}.${MEDIA_EXT}`; deck.load();
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
    // 循环类模式下切换前先倒放回开头（往复 / 单套 / 轮播 / 收藏都一样）。
    if (cycling() && index !== current && phase === 'playing') await rewindBeforeSwitch();
    const task = startOperation();
    releaseSpare();
    current = index;
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
      await playSafely(task.id);
    } catch (error) { loadFailure(index, error, task.id); }
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
      phase = 'paused'; video.pause(); stopWatcher(); body.classList.remove('is-playing');
      icon($('playButton'), 'play'); $('playButton').setAttribute('aria-label', '继续播放入场');
      $('timelineState').textContent = '暂停'; setStatus('TAKE YOUR TIME.', line(current, 'pause'));
    } else if (phase === 'paused') {
      phase = 'playing'; body.classList.add('is-playing');
      icon($('playButton'), 'pause'); $('playButton').setAttribute('aria-label', '暂停入场');
      $('timelineState').textContent = '入场'; setStatus('HERE, WITH YOU.', line(current, 'resume'));
      if (cycling() && video.ended) advanceLoop(); else playSafely(operation);
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
    if (suspended()) { decks.forEach(deck => deck.pause()); stopWatcher(); clearTimeout(idleTimer); audioContext?.suspend().catch(() => {}); }
    else { lastChange = Date.now(); if (phase === 'playing') { if (cycling() && video.ended) advanceLoop(); else playSafely(operation); } activity(true); }
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
      if (changed('autoswitch')) prefs.interval = [0,5,15,30].includes(Number(properties.autoswitch.value)) ? Number(properties.autoswitch.value) : 0;
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
  $('autoOptions').addEventListener('click', event => {
    if (cycling()) return;
    const button = event.target.closest('[data-interval]');
    if (!button) return;
    prefs.interval = Number(button.dataset.interval); lastChange = Date.now(); applyPrefs(); persist();
  });
  $('soundButton').addEventListener('click', () => { prefs.sound = !prefs.sound; applyPrefs(); persist(); unlockAudio(); chime(660, .17); toast(prefs.sound ? '声音已开启。' : '安静地陪你。'); });
  $('immerseButton').addEventListener('click', async () => { cancelSpin(); if (panel === 'moment') await cancelMoment(); else if (panel) closePanel(false); body.classList.add('is-immersed'); document.activeElement.blur(); });
  const wake = () => {
    const hidden = body.classList.contains('is-immersed') || body.classList.contains('is-idle');
    body.classList.remove('is-immersed', 'is-idle'); activity(true);
    if (hidden && phase === 'held') respond(current, 'wake', 'HERE, WITH YOU.', false);
  };
  $('wakeButton').addEventListener('click', wake);
  $('brand').addEventListener('click', event => { event.preventDefault(); wake(); });
  document.addEventListener('pointermove', () => activity());
  document.addEventListener('pointerdown', () => { unlockAudio(); activity(true); });
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
    const nativePlay = deck.play.bind(deck);
    deck.play = function () {
      if (deck !== video || phase !== 'playing' || suspended()) return Promise.resolve();
      return nativePlay();
    };
    deck.addEventListener('play', () => { if (deck !== video || phase !== 'playing' || suspended()) deck.pause(); });
    // 往复模式的「片尾」由 watchFrames 按片长判定，倒带过程中也要让路。
    deck.addEventListener('ended', () => { if (deck === video && phase === 'playing' && !looping() && !rewinding) cycling() ? advanceLoop() : settle(); });
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
    if (switchReady && prefs.interval && !panel && !modeOpen && !spinning && Date.now() - lastChange >= prefs.interval * 60000) randomLook();
  }, 15000);
  function showRememberedStill() {
    $('still').src = `images/look-${LOOKS[current].id}.jpg`;
    $('still').alt = LOOKS[current].name + '穿搭推荐定格';
    document.querySelector('.ambient').style.backgroundImage = `url("images/ambient-${LOOKS[current].id}.jpg")`;
    renderCards(); updateProgress(freezeTime()); applyPrefs();
    setStatus('MOMENT, KEPT.', line(current, 'held'));
  }
  showRememberedStill();
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
