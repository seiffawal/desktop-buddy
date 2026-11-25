const { app, BrowserWindow, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const WIN_SIZE = 90;
const positionFile = path.join(app.getPath('userData'), 'buddy-position.json');

let win = null;
let tray = null;
let saveTimer = null;

// Only one copy of the app at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Remember position (temporary; moves to the storage layer on Day 3) ----------
function loadPosition() {
  try {
    const pos = JSON.parse(fs.readFileSync(positionFile, 'utf8'));
    const visible = screen.getAllDisplays().some(d => {
      const b = d.workArea;
      return pos.x >= b.x && pos.x < b.x + b.width && pos.y >= b.y && pos.y < b.y + b.height;
    });
    if (visible) return pos;
  } catch (e) {
    // no saved position yet
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIN_SIZE - 20, y: area.y + area.height - WIN_SIZE - 20 };
}

function savePositionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win) return;
    const [x, y] = win.getPosition();
    try {
      fs.writeFileSync(positionFile, JSON.stringify({ x, y }));
    } catch (e) {
      console.error('Could not save position', e);
    }
  }, 400);
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

  win.setAlwaysOnTop(true, 'screen-saver'); // stays above most other windows
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('move', savePositionSoon);
}

// ---------- Tray icon ----------
function makeTrayIcon() {
  // Draws a small teal circle, so no image file is needed yet
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - c, y - c) <= 7;
      buf[i] = inside ? 170 : 0;     // blue
      buf[i + 1] = inside ? 180 : 0; // green
      buf[i + 2] = inside ? 20 : 0;  // red
      buf[i + 3] = inside ? 255 : 0; // alpha
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

app.whenReady().then(() => {
  createWindow();
  createTray();
});

// The app keeps running in the tray, so closing windows does not quit it
app.on('window-all-closed', () => {});