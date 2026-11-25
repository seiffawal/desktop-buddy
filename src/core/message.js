// The universal buddy message format.
const PRIORITY = { LOW: 1, NORMAL: 5, HIGH: 8, PRAYER: 10 };

function createMessage(fields = {}) {
  if (!fields.text) throw new Error('A buddy message needs text');

  return {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    from: 'system',           // 'prayer', 'pomodoro', 'tasks', 'family:ahmed', ...
    text: '',
    mood: 'idle',             // which animation the buddy plays
    buttons: [],              // e.g. ['Done', 'Snooze']
    priority: PRIORITY.NORMAL,
    duration: 6000,           // ms on screen; 0 = stays until a button is pressed
    createdAt: Date.now(),
    ...fields,                // your values override the defaults
  };
}

module.exports = { createMessage, PRIORITY };