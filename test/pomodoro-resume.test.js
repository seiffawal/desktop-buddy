const fs = require('fs'), os = require('os'), path = require('path');
const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
const bus = require('../src/core/bus'); const storage = require('../src/core/storage');
const pomodoro = require('../src/modules/pomodoro');
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) failed++; };

(async () => {
  storage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'p-')));
  pomodoro.init();
  const msgs = [], sounds = [], base = [];
  bus.subscribe('buddy:message', m => msgs.push(m));
  bus.subscribe('sound:play', s => sounds.push(s));
  bus.subscribe('buddy:base-mood', m => base.push(m));
  const last = () => msgs[msgs.length - 1];
  const fast = { focus: 20, break: 10, longBreak: 10, rounds: 2 };

  // ---- presets ----
  check('default is classic', pomodoro.currentPreset() === null || pomodoro.currentPreset() === 'classic');
  bus.publish('pomodoro:preset', 'long');
  check('preset saved', storage.get('settings.pomodoro.focus') === 50 && pomodoro.currentPreset() === 'long');
  check('preset bubble', /Long 50/.test(last().text) && !/next phase/.test(last().text));
  bus.publish('pomodoro:preset', 'short');
  check('short preset', storage.get('settings.pomodoro.break') === 3);
  bus.publish('pomodoro:preset', 'nonsense');
  check('unknown preset ignored', pomodoro.currentPreset() === 'short');
  bus.publish('pomodoro:start');
  check('timer uses preset (15 min)', Math.abs(pomodoro.status().remainingMs - 15 * 60000) < 100);
  bus.publish('pomodoro:preset', 'classic');
  check('mid-run preset change mentions next phase', /next phase/.test(last().text));
  check('running phase unaffected by preset', Math.abs(pomodoro.status().remainingMs - 15 * 60000) < 200);
  bus.publish('pomodoro:reset');

  // ---- sound events ----
  sounds.length = 0;
  bus.publish('pomodoro:start', { fast: { focus: 20, break: 10, longBreak: 10, rounds: 2 } });
  bus.publish('pomodoro:skip');
  check('sound at end of focus', sounds.join() === 'focus-end');
  bus.publish('pomodoro:skip');
  check('sound at end of break', sounds.join() === 'focus-end,break-end');
  bus.publish('pomodoro:reset');

  // ---- persistence: running session survives restart ----
  bus.publish('pomodoro:start', { fast });
  await wait(100);
  pomodoro.stop();                       // simulate closing the app
  check('stop forgets state', pomodoro.status().phase === 'idle');
  msgs.length = 0;
  pomodoro.restore();                    // simulate next launch
  check('running focus restored', pomodoro.status().phase === 'focus' && pomodoro.status().running);
  check('time left is kept', pomodoro.status().remainingMs > 18000 && pomodoro.status().remainingMs <= 20000);
  check('welcome back bubble', /Welcome back! Focus continues/.test(last().text));
  check('restored focus mood', base[base.length - 1] === 'focus');

  // ---- persistence: paused session ----
  bus.publish('pomodoro:pause');
  const left = pomodoro.status().remainingMs;
  pomodoro.stop(); msgs.length = 0; pomodoro.restore();
  check('paused state restored', pomodoro.status().phase === 'focus' && !pomodoro.status().running);
  check('paused time kept', Math.abs(pomodoro.status().remainingMs - left) < 50);
  check('paused bubble has Resume/Reset', last().buttons.join() === 'Resume,Reset' && last().tag === 'restored');
  bus.publish('buddy:action', { message: last(), action: 'Resume' });
  check('Resume button resumes', pomodoro.status().running);

  // ---- expired while the app was closed ----
  pomodoro.stop();
  offset += 60000;                       // app was closed for a minute, focus lasted 20s
  msgs.length = 0; sounds.length = 0;
  pomodoro.restore();
  check('expired focus settles to idle, next round', pomodoro.status().phase === 'idle' && pomodoro.status().round === 2);
  check('away message', /finished while you were away/.test(last().text) && last().buttons[0] === 'Start focus');
  check('no sound for away session', sounds.length === 0);

  // ---- idle round is remembered ----
  pomodoro.stop(); pomodoro.restore();
  check('next round remembered', pomodoro.status().round === 2 && pomodoro.status().phase === 'idle');
  bus.publish('pomodoro:reset');

  // ---- sleep and wake while running ----
  bus.publish('pomodoro:start', { fast });
  msgs.length = 0; sounds.length = 0;
  offset += 120000;                      // PC slept for 2 minutes
  bus.publish('system:resume');
  check('wake after long sleep: settles, not celebrates', pomodoro.status().phase === 'idle' && pomodoro.status().round === 2);
  check('wake message', /while you were away/.test(last().text) && sounds.length === 0);
  bus.publish('pomodoro:reset');

  // wake with time still left: just keeps going
  bus.publish('pomodoro:start', { fast: { focus: 60, break: 10, longBreak: 10, rounds: 2 } });
  offset += 20000;
  bus.publish('system:resume');
  check('wake with time left keeps running', pomodoro.status().running && pomodoro.status().phase === 'focus');
  check('remaining reflects the sleep', pomodoro.status().remainingMs > 38000 && pomodoro.status().remainingMs < 41000);
  bus.publish('pomodoro:reset');

  // corrupt saved data is ignored
  storage.set('pomodoro', { phase: 'banana', running: true });
  pomodoro.stop(); pomodoro.restore();
  check('garbage saved state ignored', pomodoro.status().phase === 'idle');
  storage.set('pomodoro', { phase: 'focus', running: true, round: 'x', endsAt: 'nope', fast: { focus: 'a' } });
  pomodoro.stop(); msgs.length = 0; pomodoro.restore();
  check('broken numbers handled safely', pomodoro.status().phase === 'idle');

  pomodoro.stop();
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} FAILED`);
  process.exit(failed ? 1 : 0);
})();
