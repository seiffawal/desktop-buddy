const PRIORITY = { LOW: 1, NORMAL: 5, HIGH: 8, PRAYER: 10 };
function createMessage(fields = {}) {
  if (!fields.text) throw new Error('A buddy message needs text');
  return {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    from: 'system', text: '', mood: 'idle', buttons: [],
    priority: PRIORITY.NORMAL, duration: 6000, createdAt: Date.now(),
    ...fields,
  };
}
module.exports = { createMessage, PRIORITY };
