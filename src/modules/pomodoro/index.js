// Pomodoro module: focus and break cycles.
// It talks to the rest of the app only through the bus.
const bus = require('../../core/bus');
const storage = require('../../core/storage');
const { createMessage } = require('../../core/message');

const FAST = { focus: 8, break: 4, longBreak: 6, rounds: 2 }; // seconds, for the quick test
const AWAY_GAP_MS = 5000; // a gap this long between ticks means the PC slept or the app was frozen

const PRESETS = {
  classic: { label: 'Classic 25 / 5', focus: 25, break: 5, longBreak: 15, rounds: 4 },
  long: { label: 'Long 50 / 10', focus: 50, break: 10, longBreak: 30, rounds: 3 },
  short: { label: 'Short 15 / 3', focus: 15, break: 3, longBreak: 10, rounds: 4 },
};

const PHASES = ['idle', 'focus', 'break', 'longBreak'];

let state = freshState();
let ticker = null;
let lastShownSecond = null;
let lastTickAt = 0;

function freshState() {
  // phase: 'idle' (not started, or waiting for you to start the next round),
  //        'focus', 'break' or 'longBreak'
  return { phase: 'idle', running: false, round: 1, endsAt: 0, remainingMs: 0, fast: null };
}

function config() {
  if (state.fast) {
    const f = state.fast;
    return { focus: f.focus * 1000, break: f.break * 1000, longBreak: f.longBreak * 1000, rounds: f.rounds };
  }
  const p = storage.get('settings.pomodoro') || {};
  const number = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
  return {
    focus: number(p.focus, 25) * 60000,
    break: number(p.break, 5) * 60000,
    longBreak: number(p.longBreak, 15) * 60000,
    rounds: Math.max(1, Math.round(number(p.rounds, 4))),
  };
}

function describe(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} sec`;
}

function clock(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const phaseName = phase => (phase === 'focus' ? 'Focus' : phase === 'break' ? 'Break' : 'Long break');

function say(fields) {
  bus.publish('buddy:message', createMessage({ from: 'pomodoro', ...fields }));
}

// ---------- State out ----------
function status() {
  let remainingMs = state.remainingMs;
  if (state.running) remainingMs = Math.max(state.endsAt - Date.now(), 0);
  return {
    phase: state.phase,
    running: state.running,
    round: state.round,
    rounds: config().rounds,
    remainingMs,
  };
}

// Saved on every change, so a restart can pick up where it left off
function persist() {
  storage.set('pomodoro', {
    phase: state.phase,
    running: state.running,
    round: state.round,
    endsAt: state.endsAt,
    remainingMs: state.remainingMs,
    fast: state.fast,
  });
}

function publishState() {
  persist();
  bus.publish('pomodoro:state', status());
  // The core decides how the buddy looks while this is the "base" mood
  const mood = state.running ? (state.phase === 'focus' ? 'focus' : 'break') : 'idle';
  bus.publish('buddy:base-mood', mood);
}

// ---------- Ticker (uses real timestamps, so it stays accurate) ----------
function startTicker() {
  stopTicker();
  lastShownSecond = null;
  lastTickAt = Date.now();
  ticker = setInterval(tick, 500);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

function tick() {
  if (!state.running) return;
  const now = Date.now();
  const gap = now - lastTickAt;
  lastTickAt = now;
  const left = state.endsAt - now;

  if (left <= 0) {
    // If time jumped (sleep, freeze), the phase ended while nobody was there
    if (gap > AWAY_GAP_MS) settleAway();
    else finishPhase();
    return;
  }

  state.remainingMs = left;
  const second = Math.ceil(left / 1000);
  if (second !== lastShownSecond) {
    lastShownSecond = second;
    bus.publish('pomodoro:tick', status());
  }
}

// ---------- Phases ----------
function begin(phase) {
  const c = config();
  const ms = phase === 'focus' ? c.focus : phase === 'break' ? c.break : c.longBreak;
  state.phase = phase;
  state.running = true;
  state.endsAt = Date.now() + ms;
  state.remainingMs = ms;
  startTicker();
  publishState();
  return { ms, c };
}

function startFocus() {
  const { ms, c } = begin('focus');
  say({ text: `Focus time! Round ${state.round} of ${c.rounds} (${describe(ms)})`, duration: 4000 });
}

function finishPhase() {
  const c = config();

  if (state.phase === 'focus') {
    const isLong = state.round >= c.rounds;
    const { ms } = begin(isLong ? 'longBreak' : 'break');
    bus.publish('buddy:react', 'done'); // celebrate, then settle into the break mood
    bus.publish('sound:play', 'focus-end');
    say({
      text: isLong
        ? `All ${c.rounds} rounds done! Long break for ${describe(ms)} 🎉`
        : `Great work! Break for ${describe(ms)} ☕`,
      duration: 8000,
    });
  } else if (state.phase === 'break' || state.phase === 'longBreak') {
    const wasLong = state.phase === 'longBreak';
    state.round = wasLong ? 1 : state.round + 1;
    if (wasLong) state.fast = null; // a quick test ends with the full cycle
    state.phase = 'idle';
    state.running = false;
    state.remainingMs = 0;
    stopTicker();
    publishState();
    bus.publish('sound:play', 'break-end');
    say({
      text: `Break is over. Ready for round ${state.round} of ${config().rounds}?`,
      buttons: ['Start focus', 'Stop'],
      duration: 0,
      tag: 'next',
    });
  }
}

// The phase ended while the app was closed or the PC was asleep.
// No celebration and no sound: just move to "ready for the next round".
function settleAway() {
  const c = config();
  const wasFocus = state.phase === 'focus';
  const cycleDone = state.phase === 'longBreak' || (wasFocus && state.round >= c.rounds);

  stopTicker();
  state.round = cycleDone ? 1 : state.round + 1;
  if (cycleDone) state.fast = null;
  state.phase = 'idle';
  state.running = false;
  state.remainingMs = 0;
  publishState();

  say({
    text: `${wasFocus ? 'Your focus round finished while you were away. ' : 'Welcome back! '}Ready for round ${state.round} of ${config().rounds}?`,
    buttons: ['Start focus', 'Stop'],
    duration: 0,
    tag: 'next',
  });
}

// ---------- Controls ----------
function start() {
  if (state.phase === 'idle') startFocus();
  else if (!state.running) resume();
}

function pause() {
  if (!state.running) return;
  state.remainingMs = Math.max(state.endsAt - Date.now(), 0);
  state.running = false;
  stopTicker();
  publishState();
}

function resume() {
  if (state.running || state.phase === 'idle') return;
  state.endsAt = Date.now() + state.remainingMs;
  state.running = true;
  startTicker();
  publishState();
}

function reset() {
  stopTicker();
  state = freshState();
  publishState();
}

function skip() {
  if (state.phase !== 'idle') finishPhase();
}

// ---------- Presets ----------
function currentPreset() {
  const p = storage.get('settings.pomodoro') || {};
  return Object.keys(PRESETS).find(key => {
    const preset = PRESETS[key];
    return p.focus === preset.focus && p.break === preset.break &&
      p.longBreak === preset.longBreak && p.rounds === preset.rounds;
  }) || null;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  storage.set('settings.pomodoro', {
    focus: preset.focus, break: preset.break, longBreak: preset.longBreak, rounds: preset.rounds,
  });
  const running = state.phase !== 'idle';
  say({
    text: `Preset: ${preset.label}${running ? ' (starts with the next phase)' : ''}`,
    duration: 4000,
  });
  bus.publish('pomodoro:state', status()); // refresh the displays
}

// ---------- Resume after restart ----------
function validFast(f) {
  if (!f || typeof f !== 'object') return null;
  const keys = ['focus', 'break', 'longBreak', 'rounds'];
  return keys.every(k => Number(f[k]) > 0) ? { focus: +f.focus, break: +f.break, longBreak: +f.longBreak, rounds: +f.rounds } : null;
}

// Call once the buddy window is ready, because it may show a bubble
function restore() {
  const saved = storage.get('pomodoro');
  if (!saved || !PHASES.includes(saved.phase)) return;

  state = {
    phase: saved.phase,
    running: !!saved.running,
    round: Math.max(1, Math.round(Number(saved.round) || 1)),
    endsAt: Number(saved.endsAt) || 0,
    remainingMs: Number(saved.remainingMs) || 0,
    fast: validFast(saved.fast),
  };

  if (state.phase === 'idle') {
    state.running = false;
    publishState(); // just remembers which round is next
  } else if (state.running && state.endsAt > Date.now()) {
    startTicker();
    publishState();
    say({
      text: `Welcome back! ${phaseName(state.phase)} continues - ${clock(state.endsAt - Date.now())} left`,
      duration: 5000,
    });
  } else if (state.running) {
    settleAway(); // it ended while the app was closed
  } else {
    publishState(); // it was paused
    say({
      text: `${phaseName(state.phase)} is paused - ${clock(state.remainingMs)} left`,
      buttons: ['Resume', 'Reset'],
      duration: 0,
      tag: 'restored',
    });
  }
}

function init() {
  bus.subscribe('pomodoro:start', options => {
    if (state.phase === 'idle' && options && options.fast) {
      state = freshState();
      state.fast = options.fast === true ? FAST : options.fast; // quick test with short phases
    }
    start();
  });
  bus.subscribe('pomodoro:pause', pause);
  bus.subscribe('pomodoro:resume', resume);
  bus.subscribe('pomodoro:reset', reset);
  bus.subscribe('pomodoro:skip', skip);
  bus.subscribe('pomodoro:preset', applyPreset);

  // After sleep or wake, check the clock right away
  bus.subscribe('system:resume', tick);

  // Bubble buttons
  bus.subscribe('buddy:action', ({ message, action }) => {
    if (message.from !== 'pomodoro') return;
    if (message.tag === 'next') {
      if (action === 'Start focus') start();
      else if (action === 'Stop') reset();
    } else if (message.tag === 'restored') {
      if (action === 'Resume') resume();
      else if (action === 'Reset') reset();
    }
  });
}

function stop() { // used by tests: forget the in-memory state, like a restart
  stopTicker();
  state = freshState();
}

module.exports = { init, status, restore, stop, PRESETS, currentPreset };
