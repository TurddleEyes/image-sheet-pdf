import { app, BrowserWindow, dialog, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { startStackServer } from "../server/stack-server.mjs";

let stackServer;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#eef0e7",
    title: "Image Sheet PDF",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(join(app.getAppPath(), "dist", "index.html"));
  return mainWindow;
}

function configureUpdates() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", async (info) => {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Download update", "Later", "Open release page"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Image Sheet PDF ${info.version} is available.`,
      detail: "Download it now? The app will ask before installing."
    });

    if (choice.response === 0) {
      autoUpdater.downloadUpdate();
    } else if (choice.response === 2) {
      shell.openExternal("https://github.com/TurddleEyes/image-sheet-pdf/releases/latest");
    }
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart and install", "Install later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Image Sheet PDF ${info.version} has been downloaded.`,
      detail: "Restart now to finish installing the update."
    });

    if (choice.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (error) => {
    console.warn("Update check failed:", error);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => console.warn("Update check failed:", error));
  }, 2500);
}

app.whenReady().then(() => {
  stackServer = startStackServer();
  createWindow();
  configureUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stackServer?.close();
});
