const buddyEl = document.getElementById('buddy');
const faceEl = document.getElementById('face');
const extraEl = document.getElementById('extra');

let character = null;
let restMood = 'idle';    // the mood the buddy returns to after a one-time animation
let currentMood = null;
let moodTimer = null;
let hopTimer = null;
const pending = [];       // moods that arrive before the character has loaded

function showMood(name) {
  const mood = character.moods[name];
  clearTimeout(moodTimer);
  clearTimeout(hopTimer);
  currentMood = name;

  faceEl.textContent = mood.emoji;
  extraEl.textContent = mood.extra || '';
  buddyEl.className = 'buddy anim-' + mood.animation;

  if (mood.once) {
    moodTimer = setTimeout(() => showMood(restMood), mood.duration);
  } else if (name === 'idle') {
    scheduleHop();
  }
}

function setMood(name) {
  if (!character) {
    pending.push(name);
    return;
  }
  const mood = character.moods[name];
  if (!mood) {
    console.warn('Unknown mood:', name);
    return;
  }
  if (!mood.once) restMood = name;
  showMood(name);
}

// Idle: an occasional small hop so the buddy never looks frozen
function scheduleHop() {
  clearTimeout(hopTimer);
  hopTimer = setTimeout(() => {
    faceEl.classList.add('hop');
    setTimeout(() => faceEl.classList.remove('hop'), 900);
    scheduleHop();
  }, 5000 + Math.random() * 7000);
}

// Pause everything while the window is hidden (saves CPU)
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('paused', document.hidden);
  if (document.hidden) clearTimeout(hopTimer);
  else if (currentMood === 'idle') scheduleHop();
});

window.buddy.onMood(setMood);

window.buddy.getCharacter().then(c => {
  character = c;
  document.title = c.name;
  pending.splice(0).forEach(setMood);
  if (!currentMood) setMood('idle');
});