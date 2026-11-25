// The small countdown under the buddy
const timerEl = document.getElementById('timer');

window.buddy.onTimer(({ text, paused }) => {
  timerEl.textContent = text || '';
  timerEl.classList.toggle('visible', !!text);
  timerEl.classList.toggle('paused', !!paused);
});
