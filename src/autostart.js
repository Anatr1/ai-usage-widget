'use strict';

// Cross-platform "start at login".
// - Windows: registry Run key, macOS: Login Items — both via Electron's login-item API.
// - Linux: Electron does not implement login items there, so we manage a .desktop
//   entry in ~/.config/autostart (XDG autostart, honored by GNOME/KDE/XFCE/etc).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const DESKTOP_FILE = path.join(os.homedir(), '.config', 'autostart', 'usage-widget.desktop');

function launchArgs() {
  // In dev mode the registered command is "electron(.exe) <app dir>".
  return app.isPackaged ? [] : [app.getAppPath()];
}

function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(DESKTOP_FILE);
  return app.getLoginItemSettings({ path: process.execPath, args: launchArgs() }).openAtLogin;
}

function setAutostart(enable) {
  if (process.platform === 'linux') {
    try {
      if (enable) {
        const cmd = [process.execPath, ...launchArgs()].map((a) => `"${a}"`).join(' ');
        fs.mkdirSync(path.dirname(DESKTOP_FILE), { recursive: true });
        fs.writeFileSync(
          DESKTOP_FILE,
          [
            '[Desktop Entry]',
            'Type=Application',
            'Name=AI Usage Widget',
            'Comment=Claude Code & Codex usage windows',
            `Exec=${cmd}`,
            'X-GNOME-Autostart-enabled=true',
          ].join('\n') + '\n',
          'utf8'
        );
      } else {
        fs.rmSync(DESKTOP_FILE, { force: true });
      }
    } catch {
      /* autostart is best-effort */
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enable, path: process.execPath, args: launchArgs() });
}

module.exports = { getAutostart, setAutostart };
