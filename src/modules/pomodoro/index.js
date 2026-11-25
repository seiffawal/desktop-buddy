// Pomodoro module: focus and break cycles.
// It talks to the rest of the app only through the bus.
const bus = require('../../core/bus');
const storage = require('../../core/storage');
const { createMessage } = require('../../core/message');

const FAST = { focus: 8, break: 4, longBreak: 6, rounds: 2 }; // seconds, for the quick test

let state = freshState();
let ticker = null;
let lastShownSecond = null;

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

function publishState() {
  bus.publish('pomodoro:state', status());
  // The core decides how the buddy looks while this is the "base" mood
  const mood = state.running ? (state.phase === 'focus' ? 'focus' : 'break') : 'idle';
  bus.publish('buddy:base-mood', mood);
}

// ---------- Ticker (uses real timestamps, so it stays accurate) ----------
function startTicker() {
  stopTicker();
  lastShownSecond = null;
  ticker = setInterval(tick, 500);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

function tick() {
  if (!state.running) return;
  const left = state.endsAt - Date.now();
  if (left <= 0) {
    finishPhase();
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
    say({
      text: `Break is over. Ready for round ${state.round} of ${config().rounds}?`,
      buttons: ['Start focus', 'Stop'],
      duration: 0,
      tag: 'next',
    });
  }
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

  // The "Break is over" bubble has buttons
  bus.subscribe('buddy:action', ({ message, action }) => {
    if (message.from !== 'pomodoro' || message.tag !== 'next') return;
    if (action === 'Start focus') start();
    else if (action === 'Stop') reset();
  });
}

function stop() { // used by tests
  stopTicker();
  state = freshState();
}

module.exports = { init, status, stop };