const handlers = new Map();
function subscribe(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn);
}
function run(fn, data, event) {
  try { fn(data, event); } catch (err) { console.error(`[bus] handler for "${event}" failed:`, err.message); }
}
function publish(event, data) {
  for (const fn of handlers.get(event) || []) run(fn, data, event);
  for (const fn of handlers.get('*') || []) run(fn, data, event);
}
module.exports = { subscribe, publish };
