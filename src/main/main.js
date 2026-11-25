const {
  app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, powerMonitor, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const bus = require('../core/bus');
const storage = require('../core/storage');
const queue = require('../core/queue');
const { createMessage, PRIORITY } = require('../core/message');
const pomodoro = require('../modules/pomodoro');
const tasks = require('../modules/tasks');

const WIN_SIZE = 90;
const EXPANDED_WIDTH = 260;
const CHARACTER = 'chick';                 // folder name in assets/characters
const SLEEP_AFTER_MS = 10 * 60 * 1000;     // sleepy after 10 minutes without activity
const ASSETS = path.join(__dirname, '../../assets');

// Developer extras (test menus, event log) only show when running from source
const isDev = !app.isPackaged;

let win = null;
let tasksWin = null;
let tray = null;
let sleeping = false;
let sleepTimer = null;
let baseMood = 'idle';       // what the buddy looks like at rest: idle, focus or break

let restPos = null;          // where the buddy window sits when it is small
let expandOffset = null;     // how far the big window sits from restPos (null = window is small)
let suppressMoveUntil = 0;   // ignore 'move' events that we caused ourselves
let shownForBubble = false;  // the window was hidden and a bubble showed it

app.setAppUserModelId('com.desktopbuddy.app'); // groups the taskbar entry on Windows

// Only one copy of the app at a time
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Starting the app a second time just waves hello from the first one
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) toggleBuddy();
  else showRestingMood();
});

// Shortcut: make a message and put it on the bus
function say(fields) {
  bus.publish('buddy:message', createMessage(fields));
}

// Our windows only ever show our own pages: no navigation, no pop-ups
function lockDown(webContents) {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', event => event.preventDefault());
}

// ---------- Character data ----------
ipcMain.handle('buddy:character', () => {
  const file = path.join(ASSETS, 'characters', CHARACTER, 'character.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
});

// ---------- Moods ----------
const quiet = () => storage.get('settings.quietMode') || storage.get('settings.doNotDisturb');

// Low level: change the buddy's mood right now
bus.subscribe('buddy:mood', mood => {
  if (mood === 'sleepy') sleeping = true;
  else if (mood !== 'popin') sleeping = false;
  if (win && !win.isDestroyed()) win.webContents.send('buddy:mood', mood);
});

// For modules: "while I am active, the buddy rests in this mood" (focus, break, idle)
bus.subscribe('buddy:base-mood', mood => {
  baseMood = mood || 'idle';
  if (!quiet()) bus.publish('buddy:mood', baseMood);
  resetSleepTimer();
});

// For modules: a one-time reaction such as 'done'. Quiet mode keeps the buddy calm.
bus.subscribe('buddy:react', mood => {
  if (!quiet()) bus.publish('buddy:mood', mood);
});

function resetSleepTimer() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    if (baseMood === 'idle') bus.publish('buddy:mood', 'sleepy'); // never doze off mid-focus
  }, SLEEP_AFTER_MS);
}

// The buddy's normal state: sleepy in quiet mode, otherwise its base mood with a pop-in
function showRestingMood() {
  if (quiet()) {
    bus.publish('buddy:mood', 'sleepy');
  } else {
    bus.publish('buddy:mood', baseMood);
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

// ---------- Sound ----------
const soundOn = () => storage.get('settings.sound') !== false;

function volume() {
  const v = Number(storage.get('settings.volume'));
  return v >= 0 && v <= 1 ? v : 0.5;
}

// 'force' is for the Test sound menu item, which ignores quiet mode and the sound switch
function playSound(name, force = false) {
  if (!win || win.isDestroyed()) return;
  if (!force && (quiet() || !soundOn())) return;
  win.webContents.send('sound:play', { name, volume: volume() });
}

bus.subscribe('sound:play', name => playSound(String(name)));

// ---------- Countdown on the buddy ----------
function formatTime(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function sendTimerDisplay() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const st = pomodoro.status();
  win.webContents.send(
    'timer:display',
    st.phase === 'idle' ? { text: '' } : { text: formatTime(st.remainingMs), paused: !st.running }
  );
}

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // lets chimes play without a click
    },
  });

  lockDown(win.webContents);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.once('did-finish-load', () => {
    showRestingMood();
    pomodoro.restore(); // pick up an unfinished session from last time
    tasks.start();      // start watching task times (may fire missed reminders)
    sendTimerDisplay();
  });
  win.on('move', onWindowMoved);
  win.on('system-context-menu', event => {
    event.preventDefault();                     // block the Windows menu
    buildTrayMenu().popup({ window: win });     // show our own, freshly built
  });
}

// ---------- The tasks window ----------
function openTasksWindow() {
  if (tasksWin && !tasksWin.isDestroyed()) {
    if (tasksWin.isMinimized()) tasksWin.restore();
    tasksWin.show();
    tasksWin.focus();
    return;
  }
  tasksWin = new BrowserWindow({
    width: 390,
    height: 540,
    minWidth: 330,
    minHeight: 380,
    title: 'Buddy Tasks',
    icon: path.join(ASSETS, 'icon.ico'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'tasks-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(tasksWin.webContents);
  tasksWin.setMenu(null);
  tasksWin.loadFile(path.join(__dirname, '../renderer/tasks.html'));
  tasksWin.once('ready-to-show', () => tasksWin.show());
  tasksWin.on('closed', () => { tasksWin = null; });
}

ipcMain.handle('tasks:list', () => tasks.list());
ipcMain.handle('tasks:add', (event, input) => tasks.add(input));
ipcMain.handle('tasks:toggle', (event, id) => tasks.toggleDone(String(id)));
ipcMain.handle('tasks:remove', (event, id) => tasks.remove(String(id)));
ipcMain.handle('tasks:clear-done', () => tasks.clearDone());

bus.subscribe('tasks:changed', () => {
  if (tasksWin && !tasksWin.isDestroyed()) tasksWin.webContents.send('tasks:changed');
});

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
  sendTimerDisplay();
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

// ---------- Tray icon and menu ----------
// Uses assets/icon.ico (or icon.png). Falls back to a drawn teal dot if neither loads.
function makeTrayIcon() {
  for (const name of ['icon.ico', 'icon.png']) {
    const image = nativeImage.createFromPath(path.join(ASSETS, name));
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }
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
    sendTimerDisplay();
  }
}

function pomodoroLabel(st) {
  if (st.phase === 'idle') return 'Pomodoro';
  const name = st.phase === 'focus' ? `Focus ${st.round}/${st.rounds}`
    : st.phase === 'break' ? 'Break' : 'Long break';
  return `${name} - ${formatTime(st.remainingMs)}${st.running ? '' : ' (paused)'}`;
}

function pomodoroItems(st) {
  const items = [];
  if (st.phase === 'idle') {
    items.push({ label: 'Start focus', click: () => bus.publish('pomodoro:start') });
  } else if (st.running) {
    items.push({ label: 'Pause', click: () => bus.publish('pomodoro:pause') });
  } else {
    items.push({ label: 'Resume', click: () => bus.publish('pomodoro:resume') });
  }
  if (st.phase !== 'idle') {
    items.push({ label: 'Skip to next', click: () => bus.publish('pomodoro:skip') });
    items.push({ label: 'Reset', click: () => bus.publish('pomodoro:reset') });
  }
  items.push({ type: 'separator' });

  const current = pomodoro.currentPreset();
  items.push({
    label: 'Preset',
    submenu: Object.entries(pomodoro.PRESETS).map(([key, preset]) => ({
      label: preset.label,
      type: 'radio',
      checked: current === key,
      click: () => bus.publish('pomodoro:preset', key),
    })),
  });
  if (isDev) {
    items.push({
      label: 'Quick test (short phases)',
      enabled: st.phase === 'idle',
      click: () => bus.publish('pomodoro:start', { fast: true }),
    });
  }
  return items;
}

function soundItems() {
  const current = volume();
  const levels = [['Low', 0.25], ['Medium', 0.5], ['High', 0.8]];
  return [
    {
      label: 'Sound on',
      type: 'checkbox',
      checked: soundOn(),
      click: item => storage.set('settings.sound', item.checked),
    },
    { type: 'separator' },
    ...levels.map(([label, value]) => ({
      label: `Volume: ${label}`,
      type: 'radio',
      checked: Math.abs(current - value) < 0.01,
      click: () => storage.set('settings.volume', value),
    })),
    { type: 'separator' },
    { label: 'Test sound', click: () => playSound('focus-end', true) },
  ];
}

function snoozeItems() {
  const current = Number(storage.get('settings.snoozeMinutes')) || 5;
  return [1, 5, 10, 15].map(minutes => ({
    label: `${minutes} minute${minutes === 1 ? '' : 's'}`,
    type: 'radio',
    checked: current === minutes,
    click: () => storage.set('settings.snoozeMinutes', minutes),
  }));
}

function startsWithWindows() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
}

// Extra menus for people working on the code (never shown in the installed app)
function devItems() {
  return [
    { type: 'separator' },
    {
      label: 'Preview animation',
      submenu: ['idle', 'popin', 'sleepy', 'focus', 'break', 'done'].map(mood => ({
        label: mood,
        click: () => bus.publish('buddy:mood', mood),
      })),
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
            text: 'Time to review your notes', from: 'test',
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
  ];
}

// Built fresh every time it opens, so the time left and the checkboxes are always current
function buildTrayMenu() {
  const st = pomodoro.status();
  const count = tasks.todayCount();
  return Menu.buildFromTemplate([
    { label: pomodoroLabel(st), submenu: pomodoroItems(st) },
    { label: count > 0 ? `Tasks... (${count} today)` : 'Tasks...', click: openTasksWindow },
    { type: 'separator' },
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
    { label: 'Sound', submenu: soundItems() },
    { label: 'Snooze length', submenu: snoozeItems() },
    {
      label: app.isPackaged ? 'Start with Windows' : 'Start with Windows (installed app only)',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: startsWithWindows(),
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    ...(isDev ? devItems() : []),
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    {
      label: 'About Desktop Buddy',
      click: () => say({ text: `Desktop Buddy v${app.getVersion()} 🐣`, from: 'system', duration: 4000 }),
    },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function updateTooltip() {
  if (!tray) return;
  const st = pomodoro.status();
  tray.setToolTip(st.phase === 'idle' ? 'Desktop Buddy' : `Desktop Buddy - ${pomodoroLabel(st)}`);
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  updateTooltip();
  tray.on('click', toggleBuddy);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function onPomodoroChange() {
  updateTooltip();
  sendTimerDisplay();
}
bus.subscribe('pomodoro:tick', onPomodoroChange);
bus.subscribe('pomodoro:state', onPomodoroChange);

// ---------- Developer log ----------
if (isDev) {
  bus.subscribe('*', (data, event) => {
    if (event !== 'storage:changed' && event !== 'pomodoro:tick') console.log(`[bus] ${event}`);
  });
  bus.subscribe('buddy:action', ({ message, action }) => {
    console.log(`[buddy] "${message.text}" -> ${action}`);
  });
}

// ---------- Start ----------
app.whenReady().then(() => {
  storage.init(app.getPath('userData'));
  queue.init();
  pomodoro.init();
  tasks.init();
  createWindow();
  createTray();

  // Sleep and wake: modules recheck their clocks when Windows wakes up
  powerMonitor.on('suspend', () => bus.publish('system:suspend'));
  powerMonitor.on('resume', () => bus.publish('system:resume'));

  bus.publish('app:ready');
});

app.on('before-quit', () => storage.flush());

// The app keeps running in the tray, so closing windows does not quit it
app.on('window-all-closed', () => {});
