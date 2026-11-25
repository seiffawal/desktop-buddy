const listEl = document.getElementById('list');
const formEl = document.getElementById('form');
const textEl = document.getElementById('text');
const timeEl = document.getElementById('time');
const whenEl = document.getElementById('when');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const footerEl = document.querySelector('.footer');
const clearEl = document.getElementById('clear');

const pad = n => String(n).padStart(2, '0');

// A handy default: ten minutes from now
function defaultTime() {
  const d = new Date(Date.now() + 10 * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function row(task) {
  const li = document.createElement('li');
  li.className = 'task' + (task.done ? ' done' : '') + (task.overdue ? ' overdue' : '');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = task.done;
  check.addEventListener('change', () => window.tasksApi.toggle(task.id).then(render));

  const body = document.createElement('div');
  body.className = 'body';

  const text = document.createElement('div');
  text.className = 'text';
  text.dir = 'auto';
  text.textContent = task.text;          // always text, never HTML

  const meta = document.createElement('div');
  meta.className = 'meta';
  let info = `${task.time} · ${task.when}`;
  if (task.snoozed) info += ' · 💤 snoozed';
  else if (task.overdue) info += ' · overdue';
  meta.textContent = info;

  body.append(text, meta);

  const del = document.createElement('button');
  del.className = 'delete';
  del.type = 'button';
  del.title = 'Delete task';
  del.setAttribute('aria-label', 'Delete task');
  del.textContent = '✕';
  del.addEventListener('click', () => window.tasksApi.remove(task.id).then(render));

  li.append(check, body, del);
  return li;
}

async function render() {
  const tasks = await window.tasksApi.list();
  listEl.replaceChildren(...tasks.map(row));
  emptyEl.hidden = tasks.length > 0;
  footerEl.hidden = !tasks.some(t => t.done && t.repeat !== 'daily');
}

formEl.addEventListener('submit', async event => {
  event.preventDefault();
  const result = await window.tasksApi.add({
    text: textEl.value,
    time: timeEl.value,
    when: whenEl.value,
  });
  if (!result.ok) {
    errorEl.textContent = result.error;
    return;
  }
  errorEl.textContent = '';
  render();
  textEl.value = '';
  timeEl.value = defaultTime();
  textEl.focus();
});

clearEl.addEventListener('click', () => window.tasksApi.clearDone().then(render));

window.tasksApi.onChanged(render);
setInterval(render, 30000);   // keeps "overdue" up to date
timeEl.value = defaultTime();
render();
textEl.focus();
