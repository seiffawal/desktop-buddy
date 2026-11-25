const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const bus = require('../core/bus');
const storage = require('../core/storage');
const queue = require('../core/queue');
const { createMessage, PRIORITY } = require('../core/message');

const WIN_SIZE = 90;
const EXPANDED_WIDTH = 260;
const CHARACTER = 'chick';                 // folder name in assets/characters
const SLEEP_AFTER_MS = 10 * 60 * 1000;     // sleepy after 10 minutes without activity

let win = null;
let tray = null;
let trayMenu = null;
let sleeping = false;
let sleepTimer = null;

let restPos = null;          // where the buddy window sits when it is small
let expandOffset = null;     // how far the big window sits from restPos (null = window is small)
let suppressMoveUntil = 0;   // ignore 'move' events that we caused ourselves
let shownForBubble = false;  // the window was hidden and a bubble showed it

// Only one copy of the app at a time
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Shortcut: make a message and put it on the bus
function say(fields) {
  bus.publish('buddy:message', createMessage(fields));
}

// ---------- Character data ----------
ipcMain.handle('buddy:character', () => {
  const file = path.join(__dirname, '../../assets/characters', CHARACTER, 'character.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
});

// ---------- Moods ----------
const quiet = () => storage.get('settings.quietMode') || storage.get('settings.doNotDisturb');

// Any module can change the buddy's mood: bus.publish('buddy:mood', 'idle')
bus.subscribe('buddy:mood', mood => {
  if (mood === 'sleepy') sleeping = true;
  else if (mood !== 'popin') sleeping = false;
  if (win && !win.isDestroyed()) win.webContents.send('buddy:mood', mood);
});

function resetSleepTimer() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => bus.publish('buddy:mood', 'sleepy'), SLEEP_AFTER_MS);
}

// The buddy's normal state: sleepy in quiet mode, otherwise idle with a pop-in
function showRestingMood() {
  if (quiet()) {
    bus.publish('buddy:mood', 'sleepy');
  } else {
    bus.publish('buddy:mood', 'idle');
    bus.publish('buddy:mood', 'popin');
  }
  resetSleepTimer();
}

function onActivity() {
  if (sleeping && !quiet()) showRestingMood();
  else resetSleepTimer();
}

// Quiet mode and do-not-disturb put the buddy to sleep; turning them off wakes it
bus.subscribe('storage:changed', ({ path: changed }) => {
  if (changed === 'settings.quietMode' || changed === 'settings.doNotDisturb') showRestingMood();
});

// ---------- Window position ----------
function loadPosition() {
  const pos = storage.get('buddy');
  if (pos && pos.x !== null && pos.y !== null) {
    const visible = screen.getAllDisplays().some(d => {
      const b = d.workArea;
      return pos.x >= b.x && pos.x < b.x + b.width && pos.y >= b.y && pos.y < b.y + b.height;
    });
    if (visible) return pos;
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIN_SIZE - 20, y: area.y + area.height - WIN_SIZE - 20 };
}

// The user dragged the buddy: remember where the small window would be
function onWindowMoved() {
  if (Date.now() < suppressMoveUntil) return; // we moved it ourselves
  const [x, y] = win.getPosition();
  restPos = expandOffset ? { x: x + expandOffset.dx, y: y + expandOffset.dy } : { x, y };
  storage.set('buddy', restPos);
  onActivity(); // picking up the buddy wakes it
}

// Grow the window upward and sideways so the bubble fits and the buddy stays put
function expandWindow(extraHeight) {
  if (!win || win.isDestroyed()) return;
  const width = EXPANDED_WIDTH;
  const height = WIN_SIZE + extraHeight;
  const area = screen.getDisplayMatching({
    x: restPos.x, y: restPos.y, width: WIN_SIZE, height: WIN_SIZE,
  }).workArea;

  let x = restPos.x - Math.round((width - WIN_SIZE) / 2);
  let y = restPos.y - extraHeight;
  x = Math.min(Math.max(x, area.x), area.x + area.width - width); // keep on screen
  y = Math.max(y, area.y);

  expandOffset = { dx: restPos.x - x, dy: restPos.y - y };
  suppressMoveUntil = Date.now() + 300;
  win.setBounds({ x, y, width, height });
}

function collapseWindow() {
  if (!win || win.isDestroyed() || !expandOffset) return;
  expandOffset = null;
  suppressMoveUntil = Date.now() + 300;
  win.setBounds({ x: restPos.x, y: restPos.y, width: WIN_SIZE, height: WIN_SIZE });
}

// ---------- The buddy window ----------
function createWindow() {
  restPos = loadPosition();

  win = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    x: restPos.x,
    y: restPos.y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.once('did-finish-load', showRestingMood);
  win.on('move', onWindowMoved);
  win.on('system-context-menu', event => {
    event.preventDefault();                        // block the Windows menu
    if (trayMenu) trayMenu.popup({ window: win }); // show our own instead
  });
}

// ---------- Bubbles: bus <-> window ----------
bus.subscribe('bubble:show', ({ message, compact }) => {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {            // a hidden buddy still delivers its message
    win.showInactive();
    shownForBubble = true;
  }
  onActivity();
  if (!compact && message.mood && message.mood !== 'idle') {
    bus.publish('buddy:mood', message.mood);
  }
  win.webContents.send('bubble:show', { message, compact });
});

bus.subscribe('bubble:hide', () => {
  if (win && !win.isDestroyed()) win.webContents.send('bubble:hide');
});

ipcMain.handle('bubble:expand', (event, height) => {
  expandWindow(Math.min(Math.max(Number(height) || 0, 40), 220));
});

ipcMain.handle('bubble:collapse', () => {
  collapseWindow();
  if (shownForBubble && !queue.hasWaiting() && win && !win.isDestroyed()) {
    win.hide(); // it was hidden before the message, so hide it again
    shownForBubble = false;
  }
});

ipcMain.on('bubble:closed', (event, payload) => {
  if (!payload) return;
  bus.publish('bubble:closed', { id: String(payload.id), action: String(payload.action) });
});

// ---------- Tray icon ----------
function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - c, y - c) <= 7;
      buf[i] = inside ? 170 : 0;
      buf[i + 1] = inside ? 180 : 0;
      buf[i + 2] = inside ? 20 : 0;
      buf[i + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function toggleBuddy() {
  if (!win) return;
  shownForBubble = false;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    showRestingMood(); // pops back in
  }
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Desktop Buddy');
  trayMenu = Menu.buildFromTemplate([
    { label: 'Show / Hide buddy', click: toggleBuddy },
    {
      label: 'Quiet mode',
      type: 'checkbox',
      checked: !!storage.get('settings.quietMode'),
      click: item => storage.set('settings.quietMode', item.checked),
    },
    {
      label: 'Do not disturb (prayer only)',
      type: 'checkbox',
      checked: !!storage.get('settings.doNotDisturb'),
      click: item => storage.set('settings.doNotDisturb', item.checked),
    },
    {
      label: 'Preview animation',
      submenu: [
        { label: 'Idle', click: () => bus.publish('buddy:mood', 'idle') },
        { label: 'Pop in', click: () => bus.publish('buddy:mood', 'popin') },
        { label: 'Sleepy', click: () => bus.publish('buddy:mood', 'sleepy') },
      ],
    },
    {
      label: 'Test bubbles',
      submenu: [
        {
          label: 'Simple message',
          click: () => say({ text: 'Hello! I am your buddy 🐣', from: 'test' }),
        },
        {
          label: 'Task reminder (Done / Snooze)',
          click: () => say({
            text: 'Time to review your notes', from: 'tasks',
            buttons: ['Done', 'Snooze'], duration: 0, mood: 'popin', snoozeMinutes: 0.2,
          }),
        },
        {
          label: 'Prayer (jumps the queue)',
          click: () => say({
            text: 'Time for Asr', from: 'prayer',
            buttons: ['Done'], duration: 0, mood: 'popin', priority: PRIORITY.PRAYER,
          }),
        },
        {
          label: 'Long message',
          click: () => say({
            text: 'This is a longer message to check that the bubble grows to fit the text and the buddy stays in the same place on your screen.',
            from: 'test', duration: 9000,
          }),
        },
        {
          label: 'Arabic message',
          click: () => say({ text: 'حان الآن موعد صلاة العصر', from: 'test' }),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', toggleBuddy);
}

// ---------- Core wiring ----------
// Temporary: print events so you can watch the bus working.
bus.subscribe('*', (data, event) => {
  if (event !== 'storage:changed') console.log(`[bus] ${event}`);
});
bus.subscribe('buddy:action', ({ message, action }) => {
  console.log(`[buddy] "${message.text}" -> ${action}`);
});

app.whenReady().then(() => {
  storage.init(app.getPath('userData'));
  queue.init();
  createWindow();
  createTray();
  bus.publish('app:ready');

  // Temporary greeting, delete when you like
  setTimeout(() => say({ text: 'Core is working', from: 'system', mood: 'popin' }), 2000);
});

app.on('before-quit', () => storage.flush());

// The app keeps running in the tray, so closing windows does not quit it
app.on('window-all-closed', () => {});