/* ════════════════════════════════════════════════════════════
   FLIP CLOCK — script.js
   Architecture:
   - settings        → persisted user preferences (localStorage)
   - bus             → tiny EventTarget-based pub/sub
   - Flip engine     → low-level DOM animation for each digit slot
   - Clock / Stopwatch / Timer / Pomodoro
                     → self-contained state + calculation (Date.now()-based,
                       drift-free), each emits 'tick' / 'finish' on the bus
   - applyRender()   → single subscriber that updates the DOM, the document
                       title and the screen-reader announcer
   - Cross-cutting: Wake Lock, Notifications, Page Visibility, idle UI,
     fullscreen "screensaver" mode, settings panel, PWA service worker
   ════════════════════════════════════════════════════════════ */

const BASE_TITLE = 'Flip Clock';

/* ────────────────────────────────────────────
   SETTINGS (persisted)
   ──────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
  scale: 100,
  style: 'classic',
  flipSpeed: 'normal',     // slow | normal | fast
  showSeconds: false,
  sounds: true,
  format24: false,
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem('flipclock_settings');
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem('flipclock_settings', JSON.stringify(settings)); } catch (e) {}
}

/* ────────────────────────────────────────────
   EVENT BUS — decouples calculation from rendering
   ──────────────────────────────────────────── */
const bus = new EventTarget();
function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
function on(name, fn) { bus.addEventListener(name, (e) => fn(e.detail)); }

/* App-wide state (grouped, not scattered globals) */
const state = { mode: 'clock' };

/* ────────────────────────────────────────────
   SHARED HELPERS
   ──────────────────────────────────────────── */
function secsToDigits(secs) {
  secs = Math.max(0, secs);
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  return [Math.floor(hh/10), hh%10, Math.floor(mm/10), mm%10, Math.floor(ss/10), ss%10];
}

function formatHMS(totalSecs) {
  totalSecs = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/* ────────────────────────────────────────────
   DOM REFERENCES
   ──────────────────────────────────────────── */
const ampmEl         = document.getElementById('ampm');
const modeLabel      = document.getElementById('modeLabel');
const actionBar      = document.getElementById('actionBar');
const actionMainBtn  = document.getElementById('actionMainBtn');
const actionSkipBtn  = document.getElementById('actionSkipBtn');
const actionResetBtn = document.getElementById('actionResetBtn');
const sep1           = document.getElementById('sep1');
const sep2           = document.getElementById('sep2');
const timerSetup     = document.getElementById('timerSetup');
const setupStartBtn  = document.getElementById('setupStartBtn');
const setupCancelBtn = document.getElementById('setupCancelBtn');
const inputH         = document.getElementById('inputH');
const inputM         = document.getElementById('inputM');
const inputS         = document.getElementById('inputS');
const presetRow      = document.getElementById('presetRow');
const pair2          = document.getElementById('pair-2');
const shell          = document.getElementById('shell');
const settingsPanel  = document.getElementById('settingsPanel');
const scaleSlider    = document.getElementById('scaleSlider');
const scaleLabel     = document.getElementById('scaleLabel');
const srAnnouncer    = document.getElementById('srAnnouncer');

/* ════════════════════════════════════════════
   FLIP ANIMATION ENGINE
   ════════════════════════════════════════════ */
const GAP_MS = 10;
const EASE_UP   = 'cubic-bezier(0.55, 0.055, 0.675, 0.19)';  // gravity pull
const EASE_DOWN = 'cubic-bezier(0.215, 0.61, 0.355, 1)';     // inertial settle

const STYLE_SPEED_MULT = { classic: 1, airport: 0.8, mechanical: 1.15, ultra: 1 };
const FLIP_SPEED_MULT  = { slow: 1.4, normal: 1.0, fast: 0.62 };

function totalSpeedMult() {
  return FLIP_SPEED_MULT[settings.flipSpeed] * STYLE_SPEED_MULT[settings.style];
}
function flipDuration() {
  const base = 210 + Math.random() * 50;
  return Math.round(base * totalSpeedMult());
}

function makeSlot(id) {
  return {
    id,
    staticUp:    document.querySelector(`#su-${id} .digit`),
    staticDown:  document.querySelector(`#sd-${id} .digit`),
    castShade:   document.getElementById(`cs-${id}`),
    flapUp:      document.getElementById(`fu-${id}`),
    flapDown:    document.getElementById(`fd-${id}`),
    flapUpNum:   document.querySelector(`#fu-${id} .digit`),
    flapDownNum: document.querySelector(`#fd-${id} .digit`),
    shadeUp:     document.getElementById(`fs-fu-${id}`),
    shadeDown:   document.getElementById(`fs-fd-${id}`),
    current: null,
    busy: false,
  };
}
const S = ['s0','s1','s2','s3','s4','s5'].map(makeSlot);

function setImmediate(slot, val) {
  const v = String(val);
  slot.flapUp.getAnimations().forEach(a => a.cancel());
  slot.flapDown.getAnimations().forEach(a => a.cancel());
  slot.shadeUp.getAnimations().forEach(a => a.cancel());
  slot.shadeDown.getAnimations().forEach(a => a.cancel());
  slot.castShade.getAnimations().forEach(a => a.cancel());

  slot.staticUp.textContent    = v;
  slot.staticDown.textContent  = v;
  slot.flapUpNum.textContent   = v;
  slot.flapDownNum.textContent = v;
  slot.flapUp.style.transform    = 'rotateX(0deg)';
  slot.flapDown.style.transform  = 'rotateX(0deg)';
  slot.shadeUp.style.background  = 'transparent';
  slot.shadeDown.style.background = 'transparent';
  slot.castShade.style.background = 'transparent';
  slot.current = v;
  slot.busy    = false;
}

function flip(slot, newVal) {
  if (slot.busy || slot.current === String(newVal)) return;
  slot.busy = true;

  const oldVal = slot.current ?? '0';
  const nv     = String(newVal);

  const durUp   = flipDuration();
  const durDown = flipDuration();

  slot.staticDown.textContent  = nv;
  slot.flapUpNum.textContent   = oldVal;
  slot.flapDownNum.textContent = nv;

  slot.flapUp.style.transform   = 'rotateX(0deg)';
  slot.flapDown.style.transform = 'rotateX(90deg)';
  slot.shadeUp.style.background   = 'transparent';
  slot.shadeDown.style.background = 'rgba(0,0,0,0.65)';
  slot.castShade.style.background = 'transparent';

  // Phase 1: upper flap falls (0° → -90°)
  const animUp = slot.flapUp.animate(
    [
      { transform: 'rotateX(0deg)',   easing: EASE_UP },
      { transform: 'rotateX(-90deg)' }
    ],
    { duration: durUp, fill: 'forwards' }
  );

  slot.shadeUp.animate(
    [
      { background: 'rgba(0,0,0,0)',    offset: 0,   easing: 'ease-in' },
      { background: 'rgba(0,0,0,0.35)', offset: 0.6, easing: 'ease-in' },
      { background: 'rgba(0,0,0,0.85)', offset: 1 }
    ],
    { duration: durUp, fill: 'forwards' }
  );

  // Dynamic cast shadow on the lower static half
  slot.castShade.animate(
    [
      { background: 'rgba(0,0,0,0)',     offset: 0,   easing: 'ease-in' },
      { background: 'rgba(0,0,0,0.45)',  offset: 0.7, easing: 'ease-in' },
      { background: 'rgba(0,0,0,0.6)',   offset: 1 }
    ],
    { duration: durUp, fill: 'forwards' }
  );

  animUp.onfinish = () => {
    slot.staticUp.textContent = nv;
    slot.flapUp.getAnimations().forEach(a => a.cancel());
    slot.flapUp.style.transform = 'rotateX(-90deg)';
    slot.shadeUp.getAnimations().forEach(a => a.cancel());
    slot.shadeUp.style.background = 'transparent';

    // Phase 2: lower flap swings out (90° → 0°)
    setTimeout(() => {
      const animDown = slot.flapDown.animate(
        [
          { transform: 'rotateX(90deg)', easing: EASE_DOWN },
          { transform: 'rotateX(0deg)' }
        ],
        { duration: durDown, fill: 'forwards' }
      );

      slot.castShade.animate(
        [
          { background: 'rgba(0,0,0,0.6)', easing: 'ease-out' },
          { background: 'rgba(0,0,0,0)' }
        ],
        { duration: durDown, fill: 'forwards' }
      );

      slot.shadeDown.animate(
        [
          { background: 'rgba(0,0,0,0.65)', easing: 'ease-out' },
          { background: 'rgba(0,0,0,0)' }
        ],
        { duration: durDown, fill: 'forwards' }
      );

      animDown.onfinish = () => {
        slot.flapUpNum.textContent   = nv;
        slot.flapDownNum.textContent = nv;
        slot.flapUp.getAnimations().forEach(a => a.cancel());
        slot.flapDown.getAnimations().forEach(a => a.cancel());
        slot.shadeUp.getAnimations().forEach(a => a.cancel());
        slot.shadeDown.getAnimations().forEach(a => a.cancel());
        slot.castShade.getAnimations().forEach(a => a.cancel());
        slot.flapUp.style.transform    = 'rotateX(0deg)';
        slot.flapDown.style.transform  = 'rotateX(0deg)';
        slot.shadeUp.style.background  = 'transparent';
        slot.shadeDown.style.background = 'transparent';
        slot.castShade.style.background = 'transparent';

        // Mechanical bounce: 0° → 3° → 0°, max 80ms
        const bounce = slot.flapDown.animate(
          [
            { transform: 'rotateX(0deg)' },
            { transform: 'rotateX(3deg)', offset: 0.5 },
            { transform: 'rotateX(0deg)' }
          ],
          { duration: 80, easing: 'ease-out', fill: 'none' }
        );
        const finishFlip = () => {
          slot.flapDown.style.transform = 'rotateX(0deg)';
          slot.current = nv;
          slot.busy    = false;
        };
        bounce.onfinish = finishFlip;
        bounce.oncancel = finishFlip;
      };
    }, GAP_MS);
  };
}

/**
 * Renders six digits. Animation is skipped (immediate set) when:
 *  - the caller explicitly requests it (animate=false), or
 *  - the tab is currently hidden (Page Visibility — saves CPU/battery).
 */
function renderDigits(digits, animate) {
  const useAnim = animate && !document.hidden;
  digits.forEach((d, i) => {
    if (useAnim) flip(S[i], d);
    else         setImmediate(S[i], d);
  });
}

/* ════════════════════════════════════════════
   RENDER SUBSCRIBER — single place that touches the DOM/title/SR text
   ════════════════════════════════════════════ */
function applyRender(detail) {
  pair2.style.display  = detail.showSecondsPair ? '' : 'none';
  sep2.style.display   = detail.showSecondsPair ? '' : 'none';
  ampmEl.style.display = detail.showAmpm ? '' : 'none';
  modeLabel.textContent = detail.label;
  sep1.classList.toggle('blinking', !!detail.blinking);
  renderDigits(detail.digits, detail.animate !== false);

  if (detail.title) document.title = detail.title;
  if (detail.announce) announce(detail.announce, detail.announceForce);
}
on('tick', applyRender);

on('finish', (detail) => {
  flashCards();
  beep();
  notify(detail.notifyTitle || BASE_TITLE, detail.notifyBody || '');
});

function flashCards() {
  document.querySelectorAll('.card').forEach(c => {
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
  });
  setTimeout(() => document.querySelectorAll('.card').forEach(c => c.classList.remove('flash')), 1800);
}

/* ════════════════════════════════════════════
   ACCESSIBILITY: live-region announcer
   ════════════════════════════════════════════ */
let lastAnnounceText = '';
let lastAnnounceTime = 0;
const ANNOUNCE_THROTTLE_MS = 15000;

function announce(text, force) {
  const now = Date.now();
  if (!text) return;
  if (!force && text === lastAnnounceText) return;
  if (!force && now - lastAnnounceTime < ANNOUNCE_THROTTLE_MS) return;
  lastAnnounceText = text;
  lastAnnounceTime = now;
  srAnnouncer.textContent = text;
}

function clockAnnouncement(h, m, isPM) {
  if (settings.format24) {
    return `Son las ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}.`;
  }
  const period = isPM ? 'de la tarde' : 'de la mañana';
  const minutes = m === 0 ? 'en punto' : `y ${m} minuto${m === 1 ? '' : 's'}`;
  return `Son las ${h} ${minutes} ${period}.`;
}

/* ════════════════════════════════════════════
   SOUND (Web Audio — no external files)
   ════════════════════════════════════════════ */
let audioCtx = null;
function beep() {
  if (!settings.sounds) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [0, 0.22, 0.44].forEach((offset, i) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(i === 0 ? 880 : i === 1 ? 1100 : 660, t + offset);
      gain.gain.setValueAtTime(0, t + offset);
      gain.gain.linearRampToValueAtTime(0.12, t + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.18);
      osc.start(t + offset);
      osc.stop(t + offset + 0.2);
    });
  } catch (e) {}
}

/* ════════════════════════════════════════════
   DESKTOP NOTIFICATIONS
   ════════════════════════════════════════════ */
function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png' });
  } catch (e) {}
}

/* ════════════════════════════════════════════
   SCREEN WAKE LOCK
   ════════════════════════════════════════════ */
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    // NotAllowedError (e.g. tab not visible) — ignore, will retry on visibilitychange
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function isAnyTimerRunning() {
  return (state.mode === 'stopwatch' && Stopwatch.running)
      || (state.mode === 'timer'     && Timer.running)
      || (state.mode === 'pomodoro'  && Pomodoro.running);
}

/* ════════════════════════════════════════════
   CLOCK
   ════════════════════════════════════════════ */
const Clock = {
  timeout: null,

  tick(animate = true) {
    const now  = new Date();
    let h      = now.getHours();
    const m    = now.getMinutes();
    const sec  = now.getSeconds();
    const isPM = h >= 12;

    if (!settings.format24) {
      h = h % 12 || 12;
      ampmEl.textContent = isPM ? 'PM' : 'AM';
    }

    const fullDigits = [
      Math.floor(h/10), h%10,
      Math.floor(m/10), m%10,
      Math.floor(sec/10), sec%10,
    ];
    const digits = settings.showSeconds ? fullDigits : [fullDigits[0],fullDigits[1],fullDigits[2],fullDigits[3],0,0];

    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(m).padStart(2,'0');
    const titleH = settings.format24 ? hh : h;
    const titleSuffix = settings.format24 ? '' : (isPM ? ' PM' : ' AM');

    emit('tick', {
      digits, animate,
      showSecondsPair: settings.showSeconds,
      showAmpm: !settings.format24,
      label: 'RELOJ',
      blinking: false,
      title: `(${titleH}:${mm}${titleSuffix}) ${BASE_TITLE}`,
      announce: clockAnnouncement(h, m, isPM),
    });
  },

  schedule() {
    clearTimeout(this.timeout);
    const interval = settings.showSeconds ? 1000 : 60000;
    this.timeout = setTimeout(() => {
      if (state.mode !== 'clock') return;
      this.tick(true);
      this.schedule();
    }, interval - (Date.now() % interval));
  },

  start() {
    this.tick(false);
    this.schedule();
    announce(clockAnnouncement(...this._h_m_pm()), true);
  },

  _h_m_pm() {
    const now = new Date();
    let h = now.getHours();
    const isPM = h >= 12;
    if (!settings.format24) h = h % 12 || 12;
    return [h, now.getMinutes(), isPM];
  },

  stop() {
    clearTimeout(this.timeout);
    this.timeout = null;
  },
};

/* ════════════════════════════════════════════
   STOPWATCH
   ════════════════════════════════════════════ */
const Stopwatch = {
  elapsed: 0,
  startTs: null,
  interval: null,
  running: false,

  tick(animate = true) {
    if (this.startTs !== null) this.elapsed = Date.now() - this.startTs;
    const secs = Math.floor(this.elapsed / 1000);
    emit('tick', {
      digits: secsToDigits(secs), animate,
      showSecondsPair: true, showAmpm: false,
      label: 'CRONÓMETRO',
      blinking: this.running,
      title: `(${formatHMS(secs)}) Cronómetro – ${BASE_TITLE}`,
      announce: `Cronómetro: ${formatHMS(secs)}.`,
    });
  },

  start(fresh) {
    if (fresh) { this.elapsed = 0; this.startTs = null; this.running = false; }
    this.tick(false);
    actionMainBtn.textContent  = 'Iniciar';
    actionResetBtn.textContent = 'Reiniciar';
    actionSkipBtn.style.display = 'none';
    actionBar.classList.add('visible');
    announce('Cronómetro listo.', true);
  },

  run() {
    this.startTs = Date.now() - this.elapsed;
    this.running = true;
    clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), 250);
    actionMainBtn.textContent = 'Pausar';
    acquireWakeLock();
    this.tick();
    announce('Cronómetro iniciado.', true);
  },

  pause() {
    clearInterval(this.interval);
    this.elapsed = Date.now() - this.startTs;
    this.startTs = null;
    this.running = false;
    actionMainBtn.textContent = 'Reanudar';
    releaseWakeLock();
    this.tick();
    announce('Cronómetro en pausa.', true);
  },

  reset() {
    clearInterval(this.interval);
    this.elapsed = 0; this.startTs = null; this.running = false;
    actionMainBtn.textContent = 'Iniciar';
    releaseWakeLock();
    this.tick();
    announce('Cronómetro reiniciado.', true);
  },

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  },
};

/* ════════════════════════════════════════════
   TIMER
   ════════════════════════════════════════════ */
const Timer = {
  total: 0,
  remain: 0,
  startTs: null,
  interval: null,
  running: false,
  finished: false,

  currentRemain() {
    if (this.startTs === null) return this.remain;
    const elapsedFromTotal = Math.floor((Date.now() - this.startTs) / 1000);
    return Math.max(0, this.total - elapsedFromTotal);
  },

  tick(animate = true) {
    this.remain = this.currentRemain();
    emit('tick', {
      digits: secsToDigits(this.remain), animate,
      showSecondsPair: true, showAmpm: false,
      label: 'TEMPORIZADOR',
      blinking: this.running,
      title: `(${formatHMS(this.remain)}) Temporizador – ${BASE_TITLE}`,
      announce: `Temporizador: ${formatHMS(this.remain)} restante.`,
    });
  },

  poll() {
    if (this.startTs === null) return;
    this.tick(true);
    if (this.remain === 0) this.finish();
  },

  start(h, m, s) {
    this.total   = h * 3600 + m * 60 + s;
    this.remain  = this.total;
    this.startTs = null; this.running = false; this.finished = false;
    emit('tick', {
      digits: secsToDigits(this.remain), animate: false,
      showSecondsPair: true, showAmpm: false,
      label: 'TEMPORIZADOR',
      blinking: false,
      title: `Temporizador – ${BASE_TITLE}`,
    });
    actionMainBtn.textContent  = 'Iniciar';
    actionResetBtn.textContent = 'Reiniciar';
    actionSkipBtn.style.display = 'none';
    actionBar.classList.add('visible');
  },

  run() {
    if (this.finished || this.remain === 0) return;
    const alreadyElapsed = this.total - this.remain;
    this.startTs = Date.now() - alreadyElapsed * 1000;
    this.running = true;
    clearInterval(this.interval);
    this.interval = setInterval(() => this.poll(), 250);
    actionMainBtn.textContent = 'Pausar';
    acquireWakeLock();
    ensureNotificationPermission();
    announce(`Temporizador iniciado: ${formatHMS(this.remain)}.`, true);
  },

  pause() {
    if (!this.running) return;
    this.remain = this.currentRemain();
    this.startTs = null;
    clearInterval(this.interval);
    this.running = false;
    actionMainBtn.textContent = 'Reanudar';
    releaseWakeLock();
    this.tick();
    announce('Temporizador en pausa.', true);
  },

  reset() {
    clearInterval(this.interval);
    this.startTs = null; this.running = false; this.finished = false;
    this.remain = this.total;
    actionMainBtn.textContent  = 'Iniciar';
    actionResetBtn.textContent = 'Reiniciar';
    releaseWakeLock();
    this.tick();
    announce('Temporizador reiniciado.', true);
  },

  finish() {
    clearInterval(this.interval);
    this.running = false; this.finished = true; this.remain = 0;
    releaseWakeLock();
    emit('tick', {
      digits: [0,0,0,0,0,0], animate: true,
      showSecondsPair: true, showAmpm: false,
      label: 'TEMPORIZADOR',
      blinking: false,
      title: `¡Listo! – ${BASE_TITLE}`,
      announce: 'El temporizador ha finalizado.',
      announceForce: true,
    });
    emit('finish', {
      notifyTitle: 'Temporizador finalizado',
      notifyBody: 'El tiempo ha llegado a cero.',
    });
    actionMainBtn.textContent  = 'Reiniciar';
    actionResetBtn.textContent = 'Reiniciar';
  },

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  },
};

/* ════════════════════════════════════════════
   POMODORO
   ════════════════════════════════════════════ */
const POMO_DURATIONS = { focus: 25*60, short: 5*60, long: 15*60 };
const POMO_LABELS    = { focus: 'FOCUS', short: 'BREAK', long: 'LONG BREAK' };
const POMO_NOTIFY    = {
  focus: { title: 'Hora de enfocarse',  body: 'Comienza un nuevo bloque de trabajo.' },
  short: { title: 'Descanso corto',     body: 'Tómate 5 minutos para descansar.' },
  long:  { title: 'Descanso largo',     body: 'Buen trabajo. Disfruta tu descanso largo.' },
};

const Pomodoro = {
  phase: 'focus',
  count: 0,
  remain: POMO_DURATIONS.focus,
  startTs: null,
  interval: null,
  running: false,

  currentRemain() {
    if (this.startTs === null) return this.remain;
    const elapsed = Math.floor((Date.now() - this.startTs) / 1000);
    return Math.max(0, POMO_DURATIONS[this.phase] - elapsed);
  },

  tick(animate = true) {
    this.remain = this.currentRemain();
    emit('tick', {
      digits: secsToDigits(this.remain), animate,
      showSecondsPair: true, showAmpm: false,
      label: POMO_LABELS[this.phase],
      blinking: this.running,
      title: `(${formatHMS(this.remain)}) ${POMO_LABELS[this.phase]} – ${BASE_TITLE}`,
      announce: `${POMO_LABELS[this.phase]}: ${formatHMS(this.remain)} restante.`,
    });
  },

  poll() {
    if (this.startTs === null) return;
    this.tick(true);
    if (this.remain === 0) this.finish();
  },

  start() {
    this.phase  = 'focus';
    this.count  = 0;
    this.remain = POMO_DURATIONS.focus;
    this.startTs = null; this.running = false;
    this.tick(false);
    actionMainBtn.textContent  = 'Iniciar';
    actionResetBtn.textContent = 'Reiniciar';
    actionSkipBtn.style.display = '';
    actionSkipBtn.textContent = 'Saltar';
    actionBar.classList.add('visible');
    announce(`Modo Pomodoro: ${POMO_LABELS[this.phase]}, ${formatHMS(this.remain)}.`, true);
  },

  run() {
    if (this.remain === 0) return;
    const alreadyElapsed = POMO_DURATIONS[this.phase] - this.remain;
    this.startTs = Date.now() - alreadyElapsed * 1000;
    this.running = true;
    clearInterval(this.interval);
    this.interval = setInterval(() => this.poll(), 250);
    actionMainBtn.textContent = 'Pausar';
    acquireWakeLock();
    ensureNotificationPermission();
    announce(`${POMO_LABELS[this.phase]} iniciado.`, true);
  },

  pause() {
    if (!this.running) return;
    this.remain = this.currentRemain();
    this.startTs = null;
    clearInterval(this.interval);
    this.running = false;
    actionMainBtn.textContent = 'Reanudar';
    releaseWakeLock();
    this.tick();
    announce('Pomodoro en pausa.', true);
  },

  reset() {
    clearInterval(this.interval);
    this.startTs = null; this.running = false;
    this.remain = POMO_DURATIONS[this.phase];
    actionMainBtn.textContent = 'Iniciar';
    releaseWakeLock();
    this.tick();
    announce(`${POMO_LABELS[this.phase]} reiniciado.`, true);
  },

  advancePhase() {
    if (this.phase === 'focus') {
      this.count++;
      this.phase = (this.count % 4 === 0) ? 'long' : 'short';
    } else {
      this.phase = 'focus';
    }
    this.remain = POMO_DURATIONS[this.phase];
    this.startTs = null; this.running = false;
    clearInterval(this.interval);
    actionMainBtn.textContent = 'Iniciar';
    this.tick(true);
    announce(`Siguiente fase: ${POMO_LABELS[this.phase]}, ${formatHMS(this.remain)}.`, true);
  },

  finish() {
    clearInterval(this.interval);
    this.running = false; this.remain = 0;
    releaseWakeLock();
    emit('tick', {
      digits: [0,0,0,0,0,0], animate: true,
      showSecondsPair: true, showAmpm: false,
      label: POMO_LABELS[this.phase],
      blinking: false,
      title: `¡Listo! – ${BASE_TITLE}`,
    });
    const notifyInfo = POMO_NOTIFY[this.phase];
    emit('finish', { notifyTitle: notifyInfo.title, notifyBody: notifyInfo.body });
    setTimeout(() => this.advancePhase(), 600);
  },

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  },
};

/* ════════════════════════════════════════════
   MODE SWITCHING
   ════════════════════════════════════════════ */
function stopAllEngines() {
  Clock.stop();
  Stopwatch.stop();
  Timer.stop();
  Pomodoro.stop();
  releaseWakeLock();
}

function setMode(m) {
  stopAllEngines();
  state.mode = m;
  document.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
  actionBar.classList.remove('visible');
  timerSetup.classList.remove('visible');

  if (m === 'clock') {
    document.getElementById('btnClock').classList.add('active');
    Clock.start();
  } else if (m === 'timer') {
    document.getElementById('btnTimer').classList.add('active');
    emit('tick', {
      digits: secsToDigits(Timer.remain || 0), animate: false,
      showSecondsPair: true, showAmpm: false,
      label: 'TEMPORIZADOR', blinking: false,
      title: `Temporizador – ${BASE_TITLE}`,
    });
    timerSetup.classList.add('visible');
  } else if (m === 'stopwatch') {
    document.getElementById('btnStopwatch').classList.add('active');
    Stopwatch.start(true);
  } else if (m === 'pomodoro') {
    document.getElementById('btnPomodoro').classList.add('active');
    Pomodoro.start();
  }
}

/* ════════════════════════════════════════════
   ACTION BUTTONS
   ════════════════════════════════════════════ */
actionMainBtn.addEventListener('click', () => {
  if (state.mode === 'stopwatch') {
    Stopwatch.running ? Stopwatch.pause() : Stopwatch.run();
  } else if (state.mode === 'timer') {
    if (Timer.finished) { Timer.reset(); return; }
    Timer.running ? Timer.pause() : Timer.run();
  } else if (state.mode === 'pomodoro') {
    Pomodoro.running ? Pomodoro.pause() : Pomodoro.run();
  }
});

actionSkipBtn.addEventListener('click', () => {
  if (state.mode === 'pomodoro') Pomodoro.advancePhase();
});

actionResetBtn.addEventListener('click', () => {
  if (state.mode === 'stopwatch') Stopwatch.reset();
  else if (state.mode === 'timer') Timer.reset();
  else if (state.mode === 'pomodoro') Pomodoro.reset();
});

/* ════════════════════════════════════════════
   TIMER SETUP (inputs + presets)
   ════════════════════════════════════════════ */
setupStartBtn.addEventListener('click', () => {
  const h = Math.max(0, Math.min(23, parseInt(inputH.value) || 0));
  const m = Math.max(0, Math.min(59, parseInt(inputM.value) || 0));
  const s = Math.max(0, Math.min(59, parseInt(inputS.value) || 0));
  if (h + m + s === 0) return;
  timerSetup.classList.remove('visible');
  ensureNotificationPermission();
  Timer.start(h, m, s);
});

setupCancelBtn.addEventListener('click', () => {
  timerSetup.classList.remove('visible');
  setMode('clock');
});

[inputH, inputM, inputS].forEach(inp => {
  inp.addEventListener('input', () => {
    const max = inp === inputH ? 23 : 59;
    let v = parseInt(inp.value);
    if (isNaN(v) || v < 0) inp.value = 0;
    if (v > max) inp.value = max;
    presetRow.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  });
  inp.addEventListener('focus', () => inp.select());
});

presetRow.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    presetRow.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const sec = parseInt(btn.dataset.sec);
    inputH.value = Math.floor(sec / 3600);
    inputM.value = Math.floor((sec % 3600) / 60);
    inputS.value = sec % 60;
  });
});

/* ════════════════════════════════════════════
   MODE BUTTONS
   ════════════════════════════════════════════ */
document.getElementById('btnClock').addEventListener('click', () => setMode('clock'));
document.getElementById('btnTimer').addEventListener('click', () => setMode('timer'));
document.getElementById('btnStopwatch').addEventListener('click', () => setMode('stopwatch'));
document.getElementById('btnPomodoro').addEventListener('click', () => setMode('pomodoro'));

/* ════════════════════════════════════════════
   SCALE + SETTINGS PANEL
   ════════════════════════════════════════════ */
function applyScale(val) {
  const s = val / 100;
  shell.style.setProperty('--clock-scale', s);
  if (!document.body.classList.contains('fs-mode')) {
    shell.style.transform = `scale(${s})`;
  }
  scaleLabel.textContent = val + '%';
}

scaleSlider.addEventListener('input', () => {
  const v = parseInt(scaleSlider.value);
  settings.scale = v;
  applyScale(v);
  saveSettings();
});

function bindSegRow(rowId, currentVal, onChange) {
  const row = document.getElementById(rowId);
  const btns = row.querySelectorAll('.seg-btn');
  btns.forEach(b => {
    b.classList.toggle('active', b.dataset.val === String(currentVal));
    b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onChange(b.dataset.val);
      saveSettings();
    });
  });
}

document.getElementById('btnSettings').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('visible');
  document.getElementById('btnSettings').classList.toggle('active', settingsPanel.classList.contains('visible'));
});

document.addEventListener('click', (e) => {
  if (!settingsPanel.contains(e.target) && e.target !== document.getElementById('btnSettings')) {
    settingsPanel.classList.remove('visible');
    document.getElementById('btnSettings').classList.remove('active');
  }
});

/* ════════════════════════════════════════════
   FULLSCREEN / SCREENSAVER MODE
   ════════════════════════════════════════════ */
const fsIcon    = document.getElementById('fsIcon');
const FS_EXPAND = `<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>`;
const FS_SHRINK = `<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 0 2 2v3M16 21v-3a2 2 0 0 0 2-2h3"/>`;

document.getElementById('btnFullscreen').addEventListener('click', () => {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fs) {
    (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || function(){}).call(document.documentElement);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
  }
});

function fitFullscreenScale() {
  shell.style.transform = 'none';
  void shell.offsetWidth;
  const rect = shell.getBoundingClientRect();
  const scaleX = (window.innerWidth  * 0.9) / rect.width;
  const scaleY = (window.innerHeight * 0.9) / rect.height;
  const fsScale = Math.min(scaleX, scaleY);
  shell.style.transform = `scale(${fsScale})`;
}

function updateFsIcon() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  fsIcon.innerHTML = fs ? FS_SHRINK : FS_EXPAND;
  if (fs) {
    document.body.classList.add('fs-mode');
    document.body.style.background = '#000';
    requestAnimationFrame(fitFullscreenScale);
  } else {
    document.body.classList.remove('fs-mode');
    document.body.style.background = '';
    applyScale(settings.scale);
  }
}
document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);
window.addEventListener('resize', () => {
  if (document.body.classList.contains('fs-mode')) fitFullscreenScale();
});

/* ════════════════════════════════════════════
   AUTO-HIDE CONTROLS (idle state)
   ════════════════════════════════════════════ */
let idleTimer = null;
function resetIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!settingsPanel.classList.contains('visible') && !timerSetup.classList.contains('visible')) {
      document.body.classList.add('idle');
    }
  }, 3000);
}
['mousemove', 'touchstart', 'click', 'keydown'].forEach(ev =>
  document.addEventListener(ev, resetIdle, { passive: true })
);

/* ════════════════════════════════════════════
   PAGE VISIBILITY — pause animation work in background tabs,
   catch up instantly (no animation) when the tab regains focus
   ════════════════════════════════════════════ */
function catchUp() {
  if (state.mode === 'clock')      Clock.tick(false);
  else if (state.mode === 'stopwatch') Stopwatch.tick(false);
  else if (state.mode === 'timer')     Timer.tick(false);
  else if (state.mode === 'pomodoro')  Pomodoro.tick(false);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    catchUp();
    if (isAnyTimerRunning()) acquireWakeLock();
  }
});

/* ════════════════════════════════════════════
   PWA: service worker registration
   ════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

/* ════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════ */
loadSettings();
applyScale(settings.scale);
scaleSlider.value = settings.scale;
shell.dataset.style = settings.style;

bindSegRow('styleRow', settings.style, (v) => {
  settings.style = v;
  shell.dataset.style = v;
});
bindSegRow('speedRow', settings.flipSpeed, (v) => {
  settings.flipSpeed = v;
});
bindSegRow('secondsRow', settings.showSeconds ? 'on' : 'off', (v) => {
  settings.showSeconds = (v === 'on');
  if (state.mode === 'clock') Clock.tick(false);
});
bindSegRow('soundsRow', settings.sounds ? 'on' : 'off', (v) => {
  settings.sounds = (v === 'on');
});
bindSegRow('formatRow', settings.format24 ? '24' : '12', (v) => {
  settings.format24 = (v === '24');
  if (state.mode === 'clock') Clock.tick(false);
});

setMode('clock');
resetIdle();
