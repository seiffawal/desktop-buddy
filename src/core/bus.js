// Message bus: modules publish events and subscribe to them.
const handlers = new Map(); // event name -> Set of functions

function subscribe(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn); // call this to unsubscribe
}

function run(fn, data, event) {
  try {
    fn(data, event);
  } catch (err) {
    console.error(`[bus] handler for "${event}" failed:`, err.message);
  }
}

function publish(event, data) {
  for (const fn of handlers.get(event) || []) run(fn, data, event);
  for (const fn of handlers.get('*') || []) run(fn, data, event); // '*' hears everything
}

module.exports = { subscribe, publish };