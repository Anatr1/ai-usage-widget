'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { getClaudeUsage } = require('./src/claude');
const { getCodexUsage } = require('./src/codex');
const { getAutostart, setAutostart } = require('./src/autostart');
const store = require('./src/store');

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
    resizable: false,
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
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      store.set({ position: { x, y } });
    }, 500);
  });

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
  };
}

ipcMain.handle('settings:get', () => currentSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  if (patch) {
    if (patch.barMode === 'fuel' || patch.barMode === 'usage') store.set({ barMode: patch.barMode });
    if (patch.layout === 'bars' || patch.layout === 'gauge') store.set({ layout: patch.layout });
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

ipcMain.on('widget:resize', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(160, Math.min(700, Math.round(height)));
  win.setContentSize(WINDOW_WIDTH, h);
});

app.on('window-all-closed', () => {
  // Tray app: stay alive unless explicitly quit.
  if (quitting) app.quit();
});
