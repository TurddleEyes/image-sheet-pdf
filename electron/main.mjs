import { app, BrowserWindow, dialog, session, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startStackServer } from "../server/stack-server.mjs";

let stackServer;
let mainWindow;
const latestReleaseApiUrl = "https://api.github.com/repos/TurddleEyes/image-sheet-pdf/releases/latest";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#eef0e7",
    icon: join(app.getAppPath(), "dist", "icon.png"),
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
  setTimeout(() => {
    checkForUpdates().catch((error) => console.warn("Update check failed:", error));
  }, 2500);
}

function configureDownloads() {
  session.defaultSession.on("will-download", (event, item) => {
    const filePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: join(app.getPath("downloads"), item.getFilename())
    });

    if (!filePath) {
      event.preventDefault();
      return;
    }

    item.setSavePath(filePath);
  });
}

async function checkForUpdates() {
  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Image-Sheet-PDF"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub update check failed: ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = release.tag_name?.replace(/^v/i, "");
  if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) {
    return;
  }

  const installer = release.assets?.find((asset) => asset.name.endsWith(".exe"));
  if (!installer?.browser_download_url) {
    return;
  }

  const choice = await dialog.showMessageBox(mainWindow, {
    type: "info",
    buttons: ["Download update", "Later", "Open release page"],
    defaultId: 0,
    cancelId: 1,
    title: "Update available",
    message: `Image Sheet PDF ${latestVersion} is available.`,
    detail: "Download the new Windows installer now? The app will ask before opening it."
  });

  if (choice.response === 0) {
    await downloadInstaller(installer.browser_download_url, installer.name, latestVersion);
  } else if (choice.response === 2) {
    shell.openExternal(release.html_url ?? "https://github.com/TurddleEyes/image-sheet-pdf/releases/latest");
  }
}

async function downloadInstaller(url, fileName, version) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Image-Sheet-PDF" }
  });
  if (!response.ok) {
    throw new Error(`Installer download failed: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const filePath = join(app.getPath("downloads"), fileName);
  await writeFile(filePath, bytes);

  const choice = await dialog.showMessageBox(mainWindow, {
    type: "info",
    buttons: ["Open installer", "Show in folder", "Later"],
    defaultId: 0,
    cancelId: 2,
    title: "Update downloaded",
    message: `Image Sheet PDF ${version} has been downloaded.`,
    detail: filePath
  });

  if (choice.response === 0) {
    const error = await shell.openPath(filePath);
    if (error) console.warn("Could not open installer:", error);
  } else if (choice.response === 1) {
    shell.showItemInFolder(filePath);
  }
}

function compareVersions(a, b) {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

app.whenReady().then(() => {
  stackServer = startStackServer();
  configureDownloads();
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
