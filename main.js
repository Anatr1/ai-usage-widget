'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { getClaudeUsage } = require('./src/claude');
const { getCodexUsage } = require('./src/codex');
const { getAutostart, setAutostart } = require('./src/autostart');
const store = require('./src/store');
const { sizeKey, minimumSize, resizeBounds } = require('./src/window-size');

const WINDOW_WIDTH = 330;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_TEMPLATE_PATH = path.join(__dirname, 'assets', 'trayTemplate.png');
// Set WIDGET_OPAQUE=1 if your Linux compositor renders transparent windows as black.
const TRANSPARENT = !process.env.WIDGET_OPAQUE;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

let win = null;
let tray = null;
let quitting = false;
let resizeDrag = null;
let settingsExpanded = false;
let presentationKey = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

function start() {
  store.init(app.getPath('userData'));
  if (process.platform === 'darwin') app.dock.hide(); // tray app: keep it out of the Dock
  createWindow();
  createTray();
}

function boundsAreVisible(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x >= a.x - 50 && b.y >= a.y - 20 && b.x < a.x + a.width - 50 && b.y < a.y + a.height - 50;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: 400,
    useContentSize: true,
    frame: false,
    transparent: TRANSPARENT,
    backgroundColor: TRANSPARENT ? undefined : '#16161c',
    resizable: true,
    minWidth: 140,
    minHeight: 40,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: store.get('alwaysOnTop', true),
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const saved = store.get('position', null);
  if (saved && boundsAreVisible({ x: saved.x, y: saved.y })) {
    win.setPosition(saved.x, saved.y);
  } else {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(workArea.x + workArea.width - WINDOW_WIDTH - 24, workArea.y + 24);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let saveTimer = null;
  win.on('move', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      store.set({ position: { x, y } });
    }, 500);
  });

  win.on('resized', () => rememberSize(win.getBounds()));

  // Native draggable regions don't deliver DOM hover events. Read the cursor in
  // screen coordinates so the toolbar works over both graphics and clear pixels.
  let lastHover = null;
  function updateHover() {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const bounds = win.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const hovered = win.isVisible() && !win.isMinimized()
      && cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width
      && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (hovered !== lastHover) {
      lastHover = hovered;
      win.webContents.send('widget:hover', hovered);
    }
  }
  const hoverTimer = setInterval(updateHover, 100);
  win.webContents.on('did-finish-load', () => {
    lastHover = null;
    updateHover();
  });
  win.on('closed', () => clearInterval(hoverTimer));

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Test hook: WIDGET_SCREENSHOT=<path> captures the rendered widget and exits.
  if (process.env.WIDGET_SCREENSHOT) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // Optional test hook: click an element (e.g. "#btn-settings") before capturing.
          if (process.env.WIDGET_SHOT_CLICK) {
            await win.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(process.env.WIDGET_SHOT_CLICK)})?.click()`
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          const img = await win.capturePage();
          fs.writeFileSync(process.env.WIDGET_SCREENSHOT, img.toPNG());
          console.log('screenshot saved:', process.env.WIDGET_SCREENSHOT);
        } catch (err) {
          console.error('screenshot failed:', err);
        }
        quitting = true;
        app.quit();
      }, 4000);
    });
  }
}

function trayIcon() {
  // macOS menu bars want monochrome "template" images (the *Template name opts in).
  const preferred = process.platform === 'darwin' ? TRAY_TEMPLATE_PATH : ICON_PATH;
  for (const p of [preferred, ICON_PATH]) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  return nativeImage.createEmpty();
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show widget',
      click: () => {
        win.show();
        win.focus();
      },
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: (item) => {
        win.setAlwaysOnTop(item.checked);
        store.set({ alwaysOnTop: item.checked });
      },
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: getAutostart(),
      click: (item) => setAutostart(item.checked),
    },
    {
      label: 'Refresh now',
      click: () => win.webContents.send('usage:refresh'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('AI Usage Widget — Claude Code & Codex');
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });
  rebuildTrayMenu();
  // Rebuild on open so checkboxes reflect state changed elsewhere.
  tray.on('right-click', rebuildTrayMenu);
}

ipcMain.handle('usage:get', async (_e, force) => {
  const [claude, codex] = await Promise.allSettled([getClaudeUsage(!!force), getCodexUsage()]);
  return {
    claude: claude.status === 'fulfilled' ? claude.value : { error: String(claude.reason) },
    codex: codex.status === 'fulfilled' ? codex.value : { error: String(codex.reason) },
  };
});

function currentSettings() {
  return {
    barMode: store.get('barMode', 'fuel'),
    layout: store.get('layout', 'bars'),
    minimalistic: store.get('minimalistic', false),
  };
}

ipcMain.handle('settings:get', () => currentSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  if (patch) {
    if (patch.barMode === 'fuel' || patch.barMode === 'usage') store.set({ barMode: patch.barMode });
    if (patch.layout === 'bars' || patch.layout === 'gauge') store.set({ layout: patch.layout });
    if (typeof patch.minimalistic === 'boolean') store.set({ minimalistic: patch.minimalistic });
  }
  return currentSettings();
});

ipcMain.handle('widget:toggle-pin', () => {
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  store.set({ alwaysOnTop: next });
  return next;
});

ipcMain.handle('widget:get-pin', () => win.isAlwaysOnTop());

ipcMain.on('widget:hide', () => win.hide());

function rememberSize(bounds) {
  if (settingsExpanded || !presentationKey) return;
  const sizes = { ...store.get('sizes', {}) };
  sizes[presentationKey] = { width: bounds.width, height: bounds.height };
  store.set({ sizes });
}

ipcMain.on('widget:resize', (_e, size) => {
  if (!win || win.isDestroyed()) return;
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
  if (resizeDrag) return; // A countdown tick must not interrupt an active drag.
  const settings = currentSettings();
  presentationKey = sizeKey(settings);
  settingsExpanded = Number.isFinite(size.expandedHeight) && Number.isFinite(size.expandedWidth);
  const min = minimumSize(settings);
  win.setMinimumSize(min.width, min.height);
  const saved = store.get('sizes', {})[presentationKey];
  let width = saved?.width || size.width;
  let height = saved?.height || size.height;
  if (settingsExpanded) {
    // Settings are temporary: retain the closed view's saved bounds.
    width = Math.max(width, size.expandedWidth);
    height = Math.max(height, Math.ceil(size.expandedHeight * width / size.expandedWidth));
  }
  width = Math.max(min.width, Math.min(1200, Math.round(width)));
  height = Math.max(min.height, Math.min(1000, Math.round(height)));
  const [w, h] = win.getContentSize();
  if (w !== width || h !== height) win.setContentSize(width, height);
});

ipcMain.on('widget:resize-start', (_e, edge) => {
  if (!win || win.isDestroyed() || !['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(edge)) return;
  resizeDrag = { edge, bounds: win.getBounds(), cursor: screen.getCursorScreenPoint() };
});

ipcMain.on('widget:resize-update', () => {
  if (!resizeDrag || !win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = resizeBounds(resizeDrag.bounds, resizeDrag.edge,
    { x: cursor.x - resizeDrag.cursor.x, y: cursor.y - resizeDrag.cursor.y }, minimumSize(currentSettings()));
  win.setBounds(bounds);
});

ipcMain.on('widget:resize-end', () => {
  if (!resizeDrag) return;
  resizeDrag = null;
  if (win && !win.isDestroyed()) rememberSize(win.getBounds());
});

app.on('window-all-closed', () => {
  // Tray app: stay alive unless explicitly quit.
  if (quitting) app.quit();
});
