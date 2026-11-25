const fs = require('fs'), os = require('os'), path = require('path');
const bus = require('../src/core/bus'); const storage = require('../src/core/storage'); const queue = require('../src/core/queue');
const { createMessage, PRIORITY } = require('../src/core/message');
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) failed++; };

(async () => {
  storage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')));
  queue.init();
  const shown = [], hidden = [], actions = [];
  bus.subscribe('bubble:show', d => shown.push(d));
  bus.subscribe('bubble:hide', () => hidden.push(1));
  bus.subscribe('buddy:action', a => actions.push(a));
  const texts = () => shown.map(s => s.message.text);

  // 1. first message shows right away
  const task = createMessage({ text: 'task', buttons: ['Done', 'Snooze'], duration: 0, snoozeMinutes: 0.01 });
  bus.publish('buddy:message', task);
  check('first message shows', texts().join() === 'task');

  // 2. normal message waits behind it
  const note = createMessage({ text: 'note', duration: 0 });
  bus.publish('buddy:message', note);
  check('same-priority message waits', texts().join() === 'task');

  // 3. prayer preempts
  const prayer = createMessage({ text: 'prayer', buttons: ['Done'], duration: 0, priority: PRIORITY.PRAYER });
  bus.publish('buddy:message', prayer);
  check('prayer preempts', texts().join() === 'task,prayer');

  // 4. closing prayer -> next is the task (earlier createdAt, same priority as note) after the gap
  bus.publish('bubble:closed', { id: prayer.id, action: 'Done' });
  check('hide + action fired on close', hidden.length === 1 && actions[0].action === 'Done');
  await wait(700);
  check('task comes back after prayer', texts().join() === 'task,prayer,task');

  // 5. snooze re-adds after delay, and next waiting message shows
  bus.publish('bubble:closed', { id: task.id, action: 'Snooze' });
  await wait(700);
  check('waiting note shows after snooze', texts().pop() === 'note');
  await wait(300); // snooze 0.01 min = 600ms total
  check('snoozed task re-queued (waits behind note)', texts().join() === 'task,prayer,task,note');
  bus.publish('bubble:closed', { id: note.id, action: 'dismiss' });
  await wait(700);
  check('snoozed task returns', texts().pop() === 'task');
  bus.publish('bubble:closed', { id: task.id, action: 'Done' });
  await wait(700);

  // 6. timeout closes
  shown.length = 0; actions.length = 0;
  const brief = createMessage({ text: 'brief', duration: 100 });
  bus.publish('buddy:message', brief);
  await wait(250);
  check('timeout closes bubble', actions.length === 1 && actions[0].action === 'timeout');
  await wait(700);

  // 7. DND holds normal messages but lets prayer through
  shown.length = 0;
  storage.set('settings.doNotDisturb', true);
  const held = createMessage({ text: 'held', duration: 0 });
  bus.publish('buddy:message', held);
  check('DND holds normal message', shown.length === 0 && queue.hasWaiting() === false);
  const pr2 = createMessage({ text: 'prayer2', duration: 0, priority: PRIORITY.PRAYER });
  bus.publish('buddy:message', pr2);
  check('DND lets prayer through', texts().join() === 'prayer2');
  bus.publish('bubble:closed', { id: pr2.id, action: 'dismiss' });
  await wait(700);
  check('held message still held', texts().join() === 'prayer2');
  storage.set('settings.doNotDisturb', false);
  check('held message released when DND off', texts().join() === 'prayer2,held');

  // 8. duplicates ignored, wrong id ignored
  bus.publish('buddy:message', held);
  bus.publish('bubble:closed', { id: 'nope', action: 'Done' });
  check('duplicate and stale close ignored', texts().length === 2 && hidden.length > 0);

  // 9. a message can opt out of the queue's automatic snooze
  bus.publish('bubble:closed', { id: held.id, action: 'dismiss' }); // clear the bubble still on screen
  await wait(700);
  shown.length = 0;
  const own = createMessage({ text: 'own', buttons: ['Done', 'Snooze'], duration: 0, autoSnooze: false, snoozeMinutes: 0.005 });
  bus.publish('buddy:message', own);
  bus.publish('bubble:closed', { id: own.id, action: 'Snooze' });
  await wait(1200);
  check('autoSnooze:false stops the queue snoozing', texts().join() === 'own');
  const auto = createMessage({ text: 'auto', buttons: ['Done', 'Snooze'], duration: 0, snoozeMinutes: 0.005 });
  bus.publish('buddy:message', auto);
  bus.publish('bubble:closed', { id: auto.id, action: 'Snooze' });
  await wait(1500);
  check('normal snooze still works', texts().join() === 'own,auto,auto');

  queue.reset();
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} FAILED`);
  process.exit(failed ? 1 : 0);
})();
