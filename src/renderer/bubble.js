const bubbleEl = document.getElementById('bubble');
const textEl = document.getElementById('bubbleText');
const buttonsEl = document.getElementById('bubbleButtons');

let currentId = null;
let clickToClose = false;
let hideTimer = null;
let token = 0; // lets a newer show/hide cancel an older one that is still waiting

async function showBubble({ message, compact }) {
  const mine = ++token;
  clearTimeout(hideTimer);
  currentId = message.id;
  clickToClose = message.buttons.length === 0; // no buttons: click the bubble to close it

  textEl.textContent = message.text;
  buttonsEl.replaceChildren();
  message.buttons.forEach((label, index) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (index === 0) button.className = 'primary';
    button.addEventListener('click', () => window.buddy.bubbleClosed(message.id, label));
    buttonsEl.appendChild(button);
  });

  // Measure the bubble invisibly, ask the main process to make room, then show it
  bubbleEl.classList.remove('show', 'hide');
  bubbleEl.classList.toggle('compact', !!compact);
  bubbleEl.classList.add('measure');
  await window.buddy.expand(bubbleEl.offsetHeight + 12);

  if (mine !== token) return; // something newer happened while we waited
  bubbleEl.classList.remove('measure');
  bubbleEl.classList.add('show');
}

function hideBubble() {
  ++token;
  clearTimeout(hideTimer);
  currentId = null;
  bubbleEl.classList.remove('show', 'measure');
  bubbleEl.classList.add('hide');
  hideTimer = setTimeout(() => {
    bubbleEl.classList.remove('hide');
    window.buddy.collapse(); // shrink the window back to buddy size
  }, 230);
}

bubbleEl.addEventListener('click', () => {
  if (clickToClose && currentId) window.buddy.bubbleClosed(currentId, 'dismiss');
});

window.buddy.onBubbleShow(showBubble);
window.buddy.onBubbleHide(hideBubble);
