// Tasks module: reminders at a set time, once (today or tomorrow) or every day.
// It talks to the rest of the app only through the bus.
const bus = require('../../core/bus');
const storage = require('../../core/storage');
const { createMessage, PRIORITY } = require('../../core/message');

const MAX_WAIT_MS = 60 * 1000;   // never sleep longer than a minute, so clock changes cannot strand us
const LATE_MS = 2 * 60 * 1000;   // a reminder this late is labelled "was due ..."
const MAX_TASKS = 200;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

let items = [];
let timer = null;
let started = false;

// ---------- Date helpers (all local time) ----------
const pad = n => String(n).padStart(2, '0');

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The moment a "YYYY-MM-DD" day and "HH:MM" time happen, in local time.
// Building it fresh each time keeps it correct across daylight saving changes.
function at(day, time) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

// ---------- Loading and saving ----------
const isValid = t =>
  t && typeof t === 'object' && typeof t.id === 'string' &&
  typeof t.text === 'string' && t.text.trim() && TIME_RE.test(t.time) &&
  (t.repeat === 'daily' || DAY_RE.test(t.date));

function normalize(t) {
  const daily = t.repeat === 'daily';
  return {
    id: t.id,
    text: t.text.trim().slice(0, 120),
    time: t.time,
    repeat: daily ? 'daily' : 'none',
    date: daily ? null : t.date,
    done: !!t.done,                                     // one-time tasks
    doneDate: DAY_RE.test(t.doneDate) ? t.doneDate : null,   // daily tasks: the day it was ticked
    firedDate: DAY_RE.test(t.firedDate) ? t.firedDate : null, // the day its reminder was shown
    skipDate: DAY_RE.test(t.skipDate) ? t.skipDate : null,   // a day this daily task deliberately starts after
    snoozeUntil: Number(t.snoozeUntil) > 0 ? Number(t.snoozeUntil) : null,
    createdAt: Number(t.createdAt) || Date.now(),
  };
}

function load() {
  const saved = storage.get('tasks');
  items = (Array.isArray(saved) ? saved : []).filter(isValid).map(normalize);
}

function save() {
  storage.set('tasks', items);
  bus.publish('tasks:changed');
}

const find = id => items.find(t => t.id === id);

// ---------- Rules ----------
const isDone = (t, today) => (t.repeat === 'daily' ? t.doneDate === today : t.done);

// When should this task next fire? (null = nothing to wait for)
function nextDue(t, now) {
  if (t.snoozeUntil) return t.snoozeUntil;
  const today = dayKey(now);
  if (t.repeat === 'daily') {
    if (t.firedDate !== today && t.doneDate !== today && t.skipDate !== today) return at(today, t.time);
    return at(addDays(today, 1), t.time);
  }
  if (t.done || t.firedDate === t.date) return null;
  return at(t.date, t.time);
}

function fire(t, now, due) {
  const wasSnoozed = t.snoozeUntil !== null;
  t.snoozeUntil = null;
  t.firedDate = t.repeat === 'daily' ? dayKey(now) : t.date;
  const late = !wasSnoozed && now - due > LATE_MS;

  bus.publish('sound:play', 'task');
  bus.publish('buddy:message', createMessage({
    from: 'tasks',
    taskId: t.id,
    text: late ? `${t.text} (was due ${t.time})` : t.text,
    buttons: ['Done', 'Snooze'],
    duration: 0,                 // stays until you answer
    mood: 'popin',
    priority: PRIORITY.HIGH,     // above Pomodoro bubbles, below prayer
    autoSnooze: false,           // this module handles snooze itself, and remembers it
  }));
}

// ---------- Scheduler: sleep until the next event, never longer than a minute ----------
function schedule() {
  clearTimeout(timer);
  if (!started) return;
  const now = Date.now();
  let next = Infinity;
  for (const t of items) {
    const due = nextDue(t, now);
    if (due !== null && due < next) next = due;
  }
  const delay = Math.min(Math.max(next - now, 0), MAX_WAIT_MS) + 25;
  timer = setTimeout(check, delay);
}

function check() {
  if (!started) return;
  const now = Date.now();
  const today = dayKey(now);
  let changed = false;

  // finished one-time tasks from earlier days are tidied away
  const before = items.length;
  items = items.filter(t => !(t.repeat !== 'daily' && t.done && t.date < today));
  if (items.length !== before) changed = true;

  for (const t of items) {
    const due = nextDue(t, now);
    if (due !== null && due <= now) {
      fire(t, now, due);
      changed = true;
    }
  }
  if (changed) save();
  schedule();
}

// ---------- Actions ----------
function setDone(t, done) {
  const today = dayKey(Date.now());
  if (t.repeat === 'daily') t.doneDate = done ? today : null;
  else t.done = done;
  if (done) t.snoozeUntil = null;
}

function markDone(id) {
  const t = find(id);
  if (!t || isDone(t, dayKey(Date.now()))) return;
  setDone(t, true);
  save();
  schedule();
  bus.publish('buddy:react', 'done');
}

function snooze(id) {
  const t = find(id);
  if (!t || isDone(t, dayKey(Date.now()))) return;
  const setting = Number(storage.get('settings.snoozeMinutes'));
  const minutes = setting > 0 ? setting : 5;
  t.snoozeUntil = Date.now() + minutes * 60000;
  save();
  schedule();
  bus.publish('buddy:message', createMessage({
    from: 'tasks', text: `Snoozed for ${minutes} min`, duration: 2500, priority: PRIORITY.NORMAL,
  }));
}

// ---------- API for the tasks window ----------
function add(input) {
  const text = String((input && input.text) || '').trim();
  const time = String((input && input.time) || '');
  const when = String((input && input.when) || '');
  const now = Date.now();
  const today = dayKey(now);

  if (!text) return { ok: false, error: 'Write what the task is.' };
  if (text.length > 120) return { ok: false, error: 'Please keep it under 120 characters.' };
  if (!TIME_RE.test(time)) return { ok: false, error: 'Choose a time.' };
  if (!['today', 'tomorrow', 'daily'].includes(when)) return { ok: false, error: 'Choose when it repeats.' };
  if (items.length >= MAX_TASKS) return { ok: false, error: 'Too many tasks. Delete a few first.' };

  const daily = when === 'daily';
  const date = when === 'tomorrow' ? addDays(today, 1) : today;
  if (when === 'today' && at(today, time) <= now) {
    return { ok: false, error: 'That time has already passed today.' };
  }

  const task = normalize({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text, time,
    repeat: daily ? 'daily' : 'none',
    date: daily ? null : date,
    // a daily task whose time already passed today starts tomorrow
    skipDate: daily && at(today, time) <= now ? today : null,
    createdAt: now,
  });
  items.push(task);
  save();
  schedule();
  return { ok: true, id: task.id };
}

function toggleDone(id) {
  const t = find(id);
  if (!t) return false;
  setDone(t, !isDone(t, dayKey(Date.now())));
  save();
  schedule();
  return true;
}

function remove(id) {
  const before = items.length;
  items = items.filter(t => t.id !== id);
  if (items.length === before) return false;
  save();
  schedule();
  return true;
}

function clearDone() {
  const today = dayKey(Date.now());
  const before = items.length;
  items = items.filter(t => !(t.repeat !== 'daily' && isDone(t, today)));
  if (items.length !== before) { save(); schedule(); }
  return before - items.length;
}

function list() {
  const now = Date.now();
  const today = dayKey(now);
  const tomorrow = addDays(today, 1);
  return items
    .map(t => {
      const daily = t.repeat === 'daily';
      const day = daily ? today : t.date;
      const dueAt = at(day, t.time);
      const done = !!isDone(t, today);
      return {
        id: t.id,
        text: t.text,
        time: t.time,
        repeat: t.repeat,
        when: daily ? 'Every day' : day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : day,
        done,
        overdue: !done && dueAt < now && t.skipDate !== today,
        snoozed: !done && t.snoozeUntil !== null,
        sortKey: dueAt,
      };
    })
    .sort((a, b) => Number(a.done) - Number(b.done) || a.sortKey - b.sortKey);
}

// How many tasks still need doing today (for the menu)
function todayCount() {
  const today = dayKey(Date.now());
  return items.filter(t => !isDone(t, today) && t.skipDate !== today && (t.repeat === 'daily' || t.date <= today)).length;
}

// ---------- Lifecycle ----------
function init() {
  bus.subscribe('system:resume', check); // after sleep, catch up right away
  bus.subscribe('buddy:action', ({ message, action }) => {
    if (message.from !== 'tasks' || !message.taskId) return;
    if (action === 'Done') markDone(message.taskId);
    else if (action === 'Snooze') snooze(message.taskId);
  });
}

// Call once the buddy window is ready, because reminders show bubbles
function start() {
  started = true;
  load();
  check();
}

function stop() { // used by tests: like closing the app
  started = false;
  clearTimeout(timer);
  items = [];
}

module.exports = { init, start, stop, add, toggleDone, remove, clearDone, list, todayCount };
