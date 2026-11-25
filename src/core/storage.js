// Storage layer: one JSON file, safe saving, defaults for missing values.
const fs = require('fs');
const path = require('path');
const bus = require('./bus');

const DEFAULTS = {
  buddy: { x: null, y: null },
  settings: {
    city: 'Cairo',
    latitude: 30.0444,
    longitude: 31.2357,
    prayerMethod: 'Egyptian',
    pomodoro: { focus: 25, break: 5, longBreak: 15, rounds: 4 },
    quietMode: false,
    doNotDisturb: false,
  },
  tasks: [],
};

let file = null;
let data = null;
let timer = null;

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

// Saved values win, but anything missing falls back to the default.
function merge(defaults, saved) {
  const out = clone(defaults);
  for (const key of Object.keys(saved || {})) {
    out[key] = isObject(out[key]) && isObject(saved[key]) ? merge(out[key], saved[key]) : saved[key];
  }
  return out;
}

function init(dir) {
  file = path.join(dir, 'buddy-data.json');
  clearTimeout(timer);
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // first run or damaged file: start from defaults
  }
  data = merge(DEFAULTS, saved);
}

function get(pathString) {
  let value = data;
  for (const key of pathString.split('.')) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value !== null && typeof value === 'object' ? clone(value) : value;
}

function set(pathString, value) {
  const keys = pathString.split('.');
  let target = data;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
  saveSoon();
  bus.publish('storage:changed', { path: pathString, value });
}

function saveSoon() {
  clearTimeout(timer);
  timer = setTimeout(flush, 400); // groups rapid changes into one write
}

function flush() {
  clearTimeout(timer);
  if (!file || !data) return;
  try {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, file); // write-then-rename, so a crash can't corrupt the file
  } catch (err) {
    console.error('[storage] could not save:', err.message);
  }
}

module.exports = { init, get, set, flush };