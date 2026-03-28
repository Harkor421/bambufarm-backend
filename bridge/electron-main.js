const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");

// Start the bridge server
const { startWebUI } = require("./index");

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
  // Start the web UI server
  await startWebUI();

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

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});
