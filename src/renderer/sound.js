// Soft chimes made with the Web Audio API (no sound files needed)
let audio = null;

function context() {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

// One soft note: a sine wave that fades in quickly and out slowly
function note(frequency, start, length, volume) {
  const ctx = context();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime + start;

  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

const SOUNDS = {
  // Focus finished: three rising notes, cheerful
  'focus-end': v => {
    note(659.25, 0.00, 0.9, v);
    note(880.00, 0.18, 1.1, v);
    note(1318.5, 0.36, 1.5, v * 0.8);
  },
  // Break finished: two gentle falling notes
  'break-end': v => {
    note(880.00, 0.00, 0.8, v);
    note(659.25, 0.22, 1.3, v);
  },
  // Task due: one clear, soft ping, repeated once
  'task': v => {
    note(987.77, 0.00, 0.7, v);
    note(987.77, 0.25, 1.0, v * 0.8);
  },
};

window.buddy.onSound(({ name, volume }) => {
  const play = SOUNDS[name];
  const level = Number(volume);
  if (!play || !(level > 0)) return;
  play(0.3 * Math.min(level, 1)); // 0.3 keeps even "High" comfortable
});
