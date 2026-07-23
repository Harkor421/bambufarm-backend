const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");

// Crash guards — keep the tray app alive through stray async faults instead of
// silently dying. A single unhandled error (e.g. an EMFILE from a burst of scan
// sockets, or a socket 'error' with no listener) would otherwise take down the
// whole bridge, killing camera streaming with no visible cause. Log and survive.
process.on("uncaughtException", (err) => {
  console.error("[BRIDGE] uncaughtException:", err && (err.stack || err.message || err));
});
process.on("unhandledRejection", (reason) => {
  console.error("[BRIDGE] unhandledRejection:", reason && (reason.stack || reason.message || reason));
});

// Start the bridge server
const { startServer, stopBridge } = require("./index");

let mainWindow = null;
let tray = null;
const UI_PORT = 8095;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 600,
    minHeight: 400,
    title: "BambuBridge",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${UI_PORT}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    // Minimize to tray instead of closing
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, "icon.png");
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show BambuBridge", click: () => { if (mainWindow) mainWindow.show(); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip("BambuBridge");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => { if (mainWindow) mainWindow.show(); });
}

app.whenReady().then(async () => {
  // startServer (NOT startWebUI) loads the saved config from disk and
  // auto-starts the bridge when tokens + printers are already configured. Using
  // startWebUI here meant every launch began with an empty in-memory config —
  // the user had to re-login and re-scan each time and the bridge never
  // auto-resumed, so cameras stayed dark until manual setup.
  await startServer();

  createWindow();
  createTray();

  // Open external links in browser
  app.on("web-contents-created", (_, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
  });
});

app.on("window-all-closed", () => {
  // Keep running in tray on all platforms
});

// Tear the bridge down cleanly on quit so streaming/connecting ffmpeg children
// are killed instead of orphaned — an orphan keeps holding an RTSP printer's
// limited connection slot, so the camera fails to reconnect on next launch.
app.on("before-quit", () => {
  try { stopBridge(); } catch {}
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});
