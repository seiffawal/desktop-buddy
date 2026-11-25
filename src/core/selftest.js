// Run with: npm run test:core
const fs = require('fs');
const os = require('os');
const path = require('path');
const bus = require('./bus');
const { createMessage, PRIORITY } = require('./message');
const storage = require('./storage');

let failed = 0;
function check(name, condition) {
  console.log((condition ? 'PASS  ' : 'FAIL  ') + name);
  if (!condition) failed++;
}

// --- bus ---
let got = null;
const off = bus.subscribe('test', d => (got = d));
bus.publish('test', { a: 1 });
check('bus delivers an event', got && got.a === 1);
off();
got = null;
bus.publish('test', { a: 2 });
check('unsubscribe works', got === null);

const seen = [];
bus.subscribe('*', (d, event) => seen.push(event));
bus.publish('anything', 1);
check('wildcard hears every event', seen.includes('anything'));

let secondRan = false;
bus.subscribe('boom', () => { throw new Error('on purpose'); });
bus.subscribe('boom', () => { secondRan = true; });
bus.publish('boom'); // the error line printed above is expected
check('one broken handler does not stop the others', secondRan);

// --- message ---
const m = createMessage({ text: 'Hello', from: 'prayer', priority: PRIORITY.PRAYER });
check('message has defaults', m.mood === 'idle' && Array.isArray(m.buttons) && m.id);
check('message keeps your values', m.from === 'prayer' && m.priority === 10);
let threw = false;
try { createMessage({}); } catch (e) { threw = true; }
check('message without text is rejected', threw);

// --- storage ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-test-'));
storage.init(dir);
check('storage gives defaults', storage.get('settings.city') === 'Cairo');
storage.set('settings.city', 'Alexandria');
storage.set('settings.pomodoro.focus', 30);
storage.flush();
storage.init(dir); // simulates restarting the app
check('storage remembers values', storage.get('settings.city') === 'Alexandria');
check('storage remembers nested values', storage.get('settings.pomodoro.focus') === 30);
check('untouched defaults survive', storage.get('settings.pomodoro.break') === 5);
check('tasks starts as an empty array', Array.isArray(storage.get('tasks')));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`);
process.exitCode = failed === 0 ? 0 : 1;