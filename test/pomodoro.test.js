const fs = require('fs'), os = require('os'), path = require('path');
const bus = require('../src/core/bus'); const storage = require('../src/core/storage');
const pomodoro = require('../src/modules/pomodoro');
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) failed++; };

(async () => {
  storage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'p-')));
  pomodoro.init();
  const msgs = [], base = [], react = [];
  bus.subscribe('buddy:message', m => msgs.push(m));
  bus.subscribe('buddy:base-mood', m => base.push(m));
  bus.subscribe('buddy:react', m => react.push(m));
  const last = () => msgs[msgs.length - 1];

  check('starts idle', pomodoro.status().phase === 'idle' && !pomodoro.status().running);

  // quick test: focus 0.8s, break 0.6s, long 0.6s, 2 rounds
  bus.publish('pomodoro:start', { fast: { focus: 0.8, break: 0.6, longBreak: 0.6, rounds: 2 } });
  check('focus begins', pomodoro.status().phase === 'focus' && pomodoro.status().running);
  check('focus mood is base mood', base[base.length - 1] === 'focus');
  check('start bubble says round 1 of 2', /Round 1 of 2/.test(last().text));

  await wait(300);
  bus.publish('pomodoro:pause');
  const frozen = pomodoro.status().remainingMs;
  check('pause stops running, idle mood', !pomodoro.status().running && base[base.length - 1] === 'idle');
  await wait(900);
  check('paused time does not drain', Math.abs(pomodoro.status().remainingMs - frozen) < 30);
  check('paused phase did not end', pomodoro.status().phase === 'focus');
  bus.publish('pomodoro:resume');
  check('resume runs again, focus mood', pomodoro.status().running && base[base.length - 1] === 'focus');

  await wait(1000);
  check('focus -> break', pomodoro.status().phase === 'break');
  check('celebration fired', react.includes('done'));
  check('break mood', base[base.length - 1] === 'break');
  check('break message', /Break for/.test(last().text));

  await wait(1000);
  check('break -> idle waiting', pomodoro.status().phase === 'idle' && pomodoro.status().round === 2);
  check('next-round bubble has buttons', last().buttons.join() === 'Start focus,Stop' && last().duration === 0);

  // press the "Start focus" button
  bus.publish('buddy:action', { message: last(), action: 'Start focus' });
  check('button starts round 2', pomodoro.status().phase === 'focus' && pomodoro.status().round === 2);
  check('round 2 bubble', /Round 2 of 2/.test(last().text));

  await wait(1300);
  check('last round -> long break', pomodoro.status().phase === 'longBreak');
  check('long break message', /All 2 rounds done/.test(last().text));

  await wait(1000);
  check('long break -> idle, round resets', pomodoro.status().phase === 'idle' && pomodoro.status().round === 1);

  // Stop button resets
  bus.publish('pomodoro:start');
  check('normal start after test uses real settings (25 min)', Math.abs(pomodoro.status().remainingMs - 25 * 60000) < 100);
  check('real start says 25 min', /25 min/.test(last().text) && /of 4/.test(last().text));
  bus.publish('pomodoro:skip');
  check('skip focus -> break', pomodoro.status().phase === 'break');
  bus.publish('pomodoro:skip');
  check('skip break -> waiting', pomodoro.status().phase === 'idle' && pomodoro.status().round === 2);
  bus.publish('buddy:action', { message: last(), action: 'Stop' });
  check('Stop resets to round 1', pomodoro.status().phase === 'idle' && pomodoro.status().round === 1);

  // start again, then reset mid-focus
  bus.publish('pomodoro:start');
  bus.publish('pomodoro:reset');
  check('reset returns to idle', pomodoro.status().phase === 'idle' && base[base.length - 1] === 'idle');

  // ticks publish at most once per second
  let ticks = 0;
  bus.subscribe('pomodoro:tick', () => ticks++);
  bus.publish('pomodoro:start', { fast: { focus: 2.2, break: 1, longBreak: 1, rounds: 2 } });
  await wait(2000);
  check('ticks about once per second', ticks >= 1 && ticks <= 3);
  bus.publish('pomodoro:reset');

  // ignored actions from other senders
  const before = pomodoro.status().phase;
  bus.publish('buddy:action', { message: { from: 'tasks', tag: 'next' }, action: 'Start focus' });
  check('other modules buttons ignored', pomodoro.status().phase === before);

  pomodoro.stop();
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} FAILED`);
  process.exit(failed ? 1 : 0);
})();
