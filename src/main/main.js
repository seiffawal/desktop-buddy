const { app, BrowserWindow, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const bus = require('../core/bus');
const storage = require('../core/storage');
const { createMessage } = require('../core/message');

const WIN_SIZE = 90;

let win = null;
let tray = null;

// Only one copy of the app at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Remember position (now through the storage layer) ----------
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

function savePosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  storage.set('buddy', { x, y });
}

// ---------- The buddy window ----------
function createWindow() {
  const pos = loadPosition();

  win = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    x: pos.x,
    y: pos.y,
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
  win.on('move', savePosition); // storage groups rapid moves into one write
}

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
  if (win.isVisible()) win.hide();
  else win.show();
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Desktop Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / Hide buddy', click: toggleBuddy },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleBuddy);
}

// ---------- Core wiring ----------
// Temporary: print every event so you can watch the bus working.
bus.subscribe('*', (data, event) => {
  if (event !== 'storage:changed') console.log(`[bus] ${event}`);
});

// Temporary: the bubble (Day 5) will listen for this same event.
bus.subscribe('buddy:message', msg => {
  console.log(`[buddy] "${msg.text}" (from ${msg.from}, priority ${msg.priority})`);
});

app.whenReady().then(() => {
  storage.init(app.getPath('userData'));
  createWindow();
  createTray();
  bus.publish('app:ready');

  // Temporary test message, removed on Day 5
  setTimeout(() => {
    bus.publish('buddy:message', createMessage({ text: 'Core is working', from: 'system' }));
  }, 2000);
});

app.on('before-quit', () => storage.flush()); // make sure the last change is saved

// The app keeps running in the tray, so closing windows does not quit it
app.on('window-all-closed', () => {});