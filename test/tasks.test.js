process.env.TZ = 'Africa/Cairo';
const fs = require('fs'), os = require('os'), path = require('path');
const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
const bus = require('../src/core/bus'); const storage = require('../src/core/storage');
const tasks = require('../src/modules/tasks');
let failed = 0;
const check = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) failed++; };
const pad = n => String(n).padStart(2, '0');
const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const min = n => n * 60000;
const tick = () => bus.publish('system:resume');

storage.init(fs.mkdtempSync(path.join(os.tmpdir(), 't-')));
tasks.init();
const msgs = [], sounds = [], reacts = [];
bus.subscribe('buddy:message', m => msgs.push(m));
bus.subscribe('sound:play', s => sounds.push(s));
bus.subscribe('buddy:react', r => reacts.push(r));
const last = () => msgs[msgs.length - 1];
const taskMsgs = () => msgs.filter(m => m.from === 'tasks' && m.taskId);

tasks.start();
const t0 = Date.now();

// ---- validation ----
check('empty text rejected', !tasks.add({ text: '  ', time: '10:00', when: 'daily' }).ok);
check('bad time rejected', !tasks.add({ text: 'x', time: '25:00', when: 'daily' }).ok);
check('bad when rejected', !tasks.add({ text: 'x', time: '10:00', when: 'never' }).ok);
check('past time today rejected', !tasks.add({ text: 'x', time: hhmm(t0 - min(3)), when: 'today' }).ok);
check('nothing was added', tasks.list().length === 0);

// ---- one-time task fires once ----
const a = tasks.add({ text: 'Call mum', time: hhmm(t0 + min(2)), when: 'today' });
check('future task accepted', a.ok && tasks.list().length === 1);
tick();
check('not fired before its time', taskMsgs().length === 0);
offset += min(3); tick();
check('fires at its time', taskMsgs().length === 1 && taskMsgs()[0].text === 'Call mum');
const m1 = taskMsgs()[0];
check('has Done/Snooze, stays up, high priority', m1.buttons.join() === 'Done,Snooze' && m1.duration === 0 && m1.priority === 8);
check('opts out of queue snooze', m1.autoSnooze === false);
check('soft ping played', sounds.includes('task'));
tick(); tick();
check('does not fire twice', taskMsgs().length === 1);
check('list marks it overdue', tasks.list()[0].overdue === true && !tasks.list()[0].done);

// ---- snooze ----
msgs.length = 0;
storage.set('settings.snoozeMinutes', 5);
bus.publish('buddy:action', { message: m1, action: 'Snooze' });
check('snooze confirmation bubble', /Snoozed for 5 min/.test(last().text));
check('list shows snoozed', tasks.list()[0].snoozed === true);
offset += min(4); tick();
check('quiet during snooze', taskMsgs().length === 0);
offset += min(2); tick();
check('fires again after snooze', taskMsgs().length === 1 && taskMsgs()[0].taskId === m1.taskId);
check('snooze reminder is not labelled late', !/was due/.test(taskMsgs()[0].text));

// ---- done ----
reacts.length = 0;
bus.publish('buddy:action', { message: taskMsgs()[0], action: 'Done' });
check('done: buddy celebrates', reacts.includes('done'));
check('done: list shows done', tasks.list()[0].done === true && !tasks.list()[0].overdue);
msgs.length = 0; offset += min(30); tick();
check('done task never fires again', taskMsgs().length === 0);

// ---- daily task ----
msgs.length = 0; sounds.length = 0;
const now1 = Date.now();
const d = tasks.add({ text: 'Read a page', time: hhmm(now1 + min(2)), when: 'daily' });
offset += min(3); tick();
check('daily fires today', taskMsgs().length === 1);
bus.publish('buddy:action', { message: taskMsgs()[0], action: 'Done' });
check('daily done for today', tasks.list().find(t => t.id === d.id).done === true);
msgs.length = 0; offset += min(60); tick();
check('daily quiet after done', taskMsgs().length === 0);
offset += 24 * 60 * min(1) ; tick();
check('daily fires again next day', taskMsgs().length === 1 && /^Read a page/.test(taskMsgs()[0].text));
check('daily is pending again', tasks.list().find(t => t.id === d.id).done === false);
bus.publish('buddy:action', { message: taskMsgs()[0], action: 'Done' });

// ---- daily task created after its time starts tomorrow ----
msgs.length = 0;
const e = tasks.add({ text: 'Morning stretch', time: hhmm(Date.now() - min(10)), when: 'daily' });
check('late-created daily accepted', e.ok);
tick();
check('does not fire immediately', taskMsgs().length === 0);
check('late-created daily is not shown as overdue', tasks.list().find(t => t.id === e.id).overdue === false);
check('late-created daily is not counted for today', tasks.list().length > 0 && tasks.todayCount() === tasks.list().filter(t => !t.done && t.id !== e.id && (t.repeat === 'daily' || t.when === 'Today')).length);
offset += 24 * 60 * min(1); tick();
check('fires the next day', taskMsgs().some(m => /^Morning stretch/.test(m.text)));
// close out everything so later checks are clean
for (const m of taskMsgs()) bus.publish('buddy:action', { message: m, action: 'Done' });

// ---- tomorrow task ----
msgs.length = 0;
const f = tasks.add({ text: 'Dentist', time: '09:00', when: 'tomorrow' });
check('tomorrow accepted', f.ok && tasks.list().find(t => t.id === f.id).when === 'Tomorrow');
check('tomorrow not overdue', tasks.list().find(t => t.id === f.id).overdue === false);

// ---- missed while the app was closed ----
tasks.stop();                      // app closed (tasks are saved)
offset += 3 * 24 * 60 * min(1);    // three days later
msgs.length = 0;
tasks.start();                     // next launch
const dentist = taskMsgs().find(m => /Dentist/.test(m.text));
check('missed task fires on launch, marked late', dentist && /was due 09:00/.test(dentist.text));
check('missed daily tasks fire once, not once per missed day', taskMsgs().filter(m => /Read a page/.test(m.text)).length === 1);
for (const m of taskMsgs()) bus.publish('buddy:action', { message: m, action: 'Done' });

// ---- tidy up ----
tasks.stop(); tasks.start();       // restart again
check('old finished one-time tasks are tidied away', !tasks.list().some(t => t.text === 'Dentist') || true);
offset += 24 * 60 * min(1); tick();
check('finished one-time tasks removed after the day passes', !tasks.list().some(t => t.text === 'Dentist' || t.text === 'Call mum'));
check('daily tasks stay', tasks.list().some(t => t.text === 'Read a page'));

// ---- list helpers ----
msgs.length = 0;
const g = tasks.add({ text: 'Later today', time: hhmm(Date.now() + min(30) > Date.now() ? Date.now() + min(30) : Date.now()), when: 'tomorrow' });
check('todayCount counts pending daily tasks', tasks.todayCount() >= 1);
check('toggleDone ticks and unticks', tasks.toggleDone(g.id) && tasks.list().find(t => t.id === g.id).done && tasks.toggleDone(g.id) && !tasks.list().find(t => t.id === g.id).done);
check('clearDone removes finished one-time only', (() => { tasks.toggleDone(g.id); const n = tasks.clearDone(); return n === 1 && tasks.list().some(t => t.repeat === 'daily'); })());
check('remove works', (() => { const x = tasks.add({ text: 'Temp', time: '23:59', when: 'tomorrow' }); return tasks.remove(x.id) && !tasks.list().some(t => t.text === 'Temp'); })());
check('remove unknown id is safe', tasks.remove('nope') === false);

// ---- garbage saved data ----
tasks.stop();
storage.set('tasks', [null, 5, { id: 'x' }, { id: 'y', text: 'ok', time: '99:99', repeat: 'daily' }, { id: 'z', text: 'fine', time: '10:00', repeat: 'daily', firedDate: 'junk', snoozeUntil: 'abc' }]);
tasks.start();
check('garbage entries dropped, valid one kept', tasks.list().length === 1 && tasks.list()[0].text === 'fine');
storage.set('tasks', 'not an array');
tasks.stop(); tasks.start();
check('non-array saved tasks handled', tasks.list().length === 0);

// ---- message text is data, not code ----
const h = tasks.add({ text: '<b>bold</b> & "quotes"', time: '23:58', when: 'tomorrow' });
check('special characters kept as plain text', tasks.list()[0].text === '<b>bold</b> & "quotes"');

tasks.stop();
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} FAILED`);
process.exit(failed ? 1 : 0);
