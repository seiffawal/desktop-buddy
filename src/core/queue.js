// Bubble queue: decides which message is on screen, in what order, and for how long.
const bus = require('./bus');
const storage = require('./storage');
const { PRIORITY } = require('./message');

const GAP_MS = 600; // short pause between two bubbles

let queue = [];      // messages waiting, highest priority first
let current = null;  // the message on screen right now
let showTimer = null;
let gapTimer = null;
const snoozeTimers = new Set();

const doNotDisturb = () => !!storage.get('settings.doNotDisturb');
const allowed = msg => !doNotDisturb() || msg.priority >= PRIORITY.PRAYER;
const wantsAttention = msg => msg.duration === 0 || msg.buttons.length > 0;

function sortQueue() {
  queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

function add(msg) {
  if (!msg || !msg.id) return;
  const alreadyHere = (current && current.id === msg.id) || queue.some(m => m.id === msg.id);
  if (alreadyHere) return;
  queue.push(msg);
  sortQueue();
  pump();
}

function show(msg) {
  queue.splice(queue.indexOf(msg), 1);
  current = msg;
  clearTimeout(showTimer);
  bus.publish('bubble:show', { message: msg, compact: !!storage.get('settings.quietMode') });
  if (msg.duration > 0) showTimer = setTimeout(() => close(msg.id, 'timeout'), msg.duration);
}

// Decide what to show next. A higher-priority message pushes the current one aside.
function pump() {
  if (gapTimer) return;
  const next = queue.find(allowed);
  if (!next) return;
  if (!current) {
    show(next);
  } else if (next.priority > current.priority) {
    clearTimeout(showTimer);
    if (wantsAttention(current)) queue.push(current); // it comes back after the urgent one
    current = null;
    sortQueue();
    show(next);
  }
}

function snooze(msg) {
  const minutes = msg.snoozeMinutes || storage.get('settings.snoozeMinutes') || 5;
  const timer = setTimeout(() => {
    snoozeTimers.delete(timer);
    add({ ...msg, createdAt: Date.now() });
  }, minutes * 60 * 1000);
  snoozeTimers.add(timer);
}

function close(id, action) {
  if (!current || current.id !== id) return;
  const msg = current;
  current = null;
  clearTimeout(showTimer);
  bus.publish('bubble:hide');
  bus.publish('buddy:action', { message: msg, action }); // modules listen for Done, Snooze, ...
  if (String(action).toLowerCase() === 'snooze' && msg.autoSnooze !== false) snooze(msg);
  gapTimer = setTimeout(() => { gapTimer = null; pump(); }, GAP_MS);
}

function init() {
  bus.subscribe('buddy:message', add);
  bus.subscribe('bubble:closed', ({ id, action }) => close(id, action));
  bus.subscribe('storage:changed', ({ path }) => {
    if (path === 'settings.doNotDisturb') pump(); // releases held messages when it turns off
  });
}

const hasWaiting = () => queue.some(allowed);

function reset() { // used by the self-test
  queue = []; current = null;
  clearTimeout(showTimer); clearTimeout(gapTimer); gapTimer = null;
  snoozeTimers.forEach(clearTimeout); snoozeTimers.clear();
}

module.exports = { init, hasWaiting, reset };
