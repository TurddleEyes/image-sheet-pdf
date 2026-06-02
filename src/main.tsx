import React, { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileImage,
  FileText,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Layers,
  RotateCcw,
  SortAsc,
  Trash2
} from "lucide-react";
import "./styles.css";
import packageInfo from "../package.json";

declare global {
  interface Window {
    Capacitor?: {
      getPlatform?: () => string;
      convertFileSrc?: (filePath: string) => string;
      Plugins?: {
        DownloadSaver?: {
          saveFile: (options: {
            filename: string;
            mimeType: string;
            base64Data: string;
          }) => Promise<{ uri?: string }>;
          beginFile?: (options: {
            filename: string;
            mimeType: string;
          }) => Promise<{ sessionId: string }>;
          beginPickedFile?: (options: {
            filename: string;
            mimeType: string;
          }) => Promise<{ sessionId: string }>;
          appendFileChunk?: (options: {
            sessionId: string;
            base64Data: string;
          }) => Promise<{ bytes?: number }>;
          finishFile?: (options: { sessionId: string }) => Promise<{ uri?: string }>;
          abortFile?: (options: { sessionId: string }) => Promise<void>;
        };
        AppLog?: {
          appendLog: (options: { level: string; message: string }) => Promise<void>;
          readLog: () => Promise<{ log?: string }>;
          saveLog: (options: { filename: string }) => Promise<{ uri?: string }>;
          clearLog: () => Promise<void>;
        };
        NativeStacker?: {
          beginStack: (options: {
            filename: string;
            background: "white" | "black";
            destination?: SaveDestination;
          }) => Promise<{ sessionId: string }>;
          beginImage: (options: { sessionId: string; name: string }) => Promise<void>;
          appendImageChunk: (options: {
            sessionId: string;
            base64Data: string;
          }) => Promise<void>;
          finishImage: (options: { sessionId: string }) => Promise<void>;
          finishStack: (options: {
            sessionId: string;
          }) => Promise<{ uri?: string; width: number; height: number; format: string }>;
          abortStack: (options: { sessionId: string }) => Promise<void>;
        };
        SourceImages?: {
          pickImages: () => Promise<{ images: NativePickedImage[] }>;
          pickFolderBatch?: () => Promise<{
            images: NativePickedImage[];
            folderUri?: string;
            folderName?: string;
          }>;
          deleteImages: (options: { uris: string[] }) => Promise<{
            requested: number;
            deleted: number;
            foldersDeleted?: number;
            foldersEmpty?: number;
            cancelled?: boolean;
          }>;
          deleteFolders?: (options: { uris: string[] }) => Promise<{
            requested: number;
            deleted: number;
          }>;
        };
      };
    };
  }
}

type PageSize = "letter" | "a4";
type Orientation = "portrait" | "landscape" | "auto";
type FitMode = "contain" | "cover";
type StackFormat = "png" | "jpeg";
type ThemeMode = "system" | "light" | "dark";
type SaveDestination = "downloads" | "ask";
type SourceCleanupMode = "off" | "images" | "images-and-folder";

type NativePickedImage = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  fileUri: string;
  sourceUri: string;
  batchFolderUri?: string;
  batchFolderName?: string;
};

type PickedFile = {
  file: File;
  sourceUri?: string;
  batchFolderUri?: string;
  batchFolderName?: string;
};

type SheetImage = {
  id: string;
  file: File;
  name: string;
  url: string;
  sourceUri?: string;
  batchFolderUri?: string;
  batchFolderName?: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
  status: "loading" | "ready" | "error";
};

type PdfSettings = {
  pageSize: PageSize;
  orientation: Orientation;
  fit: FitMode;
  background: "white" | "black";
  stackFormat: StackFormat;
  quality: number;
  outputName: string;
  saveDestination: SaveDestination;
  clearAfterExport: boolean;
  sourceCleanupMode: SourceCleanupMode;
  deleteSourcesAfterExport?: boolean;
};

const initialSettings: PdfSettings = {
  pageSize: "letter",
  orientation: "auto",
  fit: "contain",
  background: "white",
  stackFormat: "png",
  quality: 0.92,
  outputName: "",
  saveDestination: "downloads",
  clearAfterExport: true,
  sourceCleanupMode: "off"
};

const pageFormats: Record<PageSize, { portrait: [number, number]; label: string }> = {
  letter: { portrait: [8.5, 11], label: "Letter" },
  a4: { portrait: [8.27, 11.69], label: "A4" }
};

const releasesUrl = "https://github.com/TurddleEyes/image-sheet-pdf/releases/latest";
const latestReleaseApiUrl = "https://api.github.com/repos/TurddleEyes/image-sheet-pdf/releases/latest";
const localLogKey = "image-sheet-pdf-client-log";
const themeModeKey = "image-sheet-pdf-theme-mode";
const rememberSettingsKey = "image-sheet-pdf-remember-settings";
const exportSettingsKey = "image-sheet-pdf-export-settings";

function App() {
  const [images, setImages] = useState<SheetImage[]>([]);
  const [rememberSettings, setRememberSettings] = useState(() => readRememberSettingsPreference());
  const [settings, setSettings] = useState<PdfSettings>(() =>
    readSavedExportSettings(readRememberSettingsPreference())
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeModePreference());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [exportState, setExportState] = useState<"idle" | "pdf" | "stack">("idle");
  const [status, setStatus] = useState("Choose images to start.");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => images.reduce((sum, image) => sum + image.file.size, 0),
    [images]
  );
  const sourceImageCount = useMemo(
    () => images.filter((image) => Boolean(image.sourceUri)).length,
    [images]
  );

  useEffect(() => {
    installClientLoggers();
    void recordAppLog(
      "info",
      `App mounted. version=${packageInfo.version} platform=${window.Capacitor?.getPlatform?.() ?? "web"}`
    );
  }, []);

  useEffect(() => {
    applyThemeMode(themeMode);
    saveThemeModePreference(themeMode);

    if (themeMode !== "system") {
      return undefined;
    }

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    const handleSystemThemeChange = () => applyThemeMode("system");
    media.addEventListener("change", handleSystemThemeChange);
    return () => media.removeEventListener("change", handleSystemThemeChange);
  }, [themeMode]);

  useEffect(() => {
    saveRememberSettingsPreference(rememberSettings);
    if (rememberSettings) {
      saveExportSettings(settings);
    } else {
      clearSavedExportSettings();
    }
  }, [rememberSettings, settings]);

  useEffect(() => {
    if (!isAndroidApp()) {
      return;
    }

    checkForAndroidUpdate()
      .then((release) => {
        if (!release) return;
        const shouldOpen = window.confirm(
          `Image Sheet PDF ${release.version} is available. Open the GitHub release to download the new APK?`
        );
        if (shouldOpen) {
          window.open(release.url, "_blank", "noopener,noreferrer");
        }
      })
      .catch(() => {
        void recordAppLog("warn", "Android update check failed.");
        setStatus("Ready. Update check could not reach GitHub.");
      });
  }, []);

  async function addNativeImages() {
    const nativeImages = window.Capacitor?.Plugins?.SourceImages;
    if (!nativeImages) {
      fileInputRef.current?.click();
      return;
    }

    setStatus("Opening photo picker...");
    try {
      const result = await nativeImages.pickImages();
      if (!result.images.length) {
        setStatus("No image files were selected.");
        return;
      }

      setStatus(`Reading ${result.images.length} selected photo${result.images.length === 1 ? "" : "s"}...`);
      const pickedFiles: PickedFile[] = [];
      for (const image of result.images) {
        pickedFiles.push(await nativePickedImageToFile(image));
      }

      addPickedFiles(pickedFiles);
    } catch (error) {
      console.warn(error);
      void recordAppLog("warn", "Native image picker failed or was cancelled.", error);
      setStatus("Photo picker was cancelled.");
    }
  }

  async function addNativeFolderBatch() {
    const nativeImages = window.Capacitor?.Plugins?.SourceImages;
    if (!isAndroidApp() || !nativeImages?.pickFolderBatch) {
      setStatus("Folder batches are available in the Android app.");
      return;
    }

    setStatus("Opening folder picker...");
    try {
      setSettings((current) => ({ ...current, saveDestination: "ask" }));
      const pickedFiles: PickedFile[] = [];
      const folderNames: string[] = [];
      let folderCount = 0;
      let keepAddingFolders = true;

      while (keepAddingFolders) {
        const result = await nativeImages.pickFolderBatch();
        if (!result.images.length) {
          if (!pickedFiles.length) {
            setStatus("No image files were found in that folder.");
            return;
          }
          break;
        }

        folderCount += 1;
        if (result.folderName) {
          folderNames.push(result.folderName);
        }

        setStatus(
          `Reading ${result.images.length} image${result.images.length === 1 ? "" : "s"} from ${
            result.folderName || "folder"
          }...`
        );
        for (const image of result.images) {
          pickedFiles.push(await nativePickedImageToFile(image));
        }

        keepAddingFolders = window.confirm("Add another folder batch?");
        if (keepAddingFolders) {
          setStatus("Opening folder picker...");
        }
      }

      addPickedFiles(pickedFiles);
      const folderLabel =
        folderCount === 1
          ? folderNames[0] || "1 folder"
          : `${folderCount} folders${folderNames.length ? ` (${folderNames.join(", ")})` : ""}`;
      setStatus(
        `Added ${pickedFiles.length} image${pickedFiles.length === 1 ? "" : "s"} from ${folderLabel}. Save location will be asked during export.`
      );
    } catch (error) {
      console.warn(error);
      void recordAppLog("warn", "Native folder batch picker failed or was cancelled.", error);
      setStatus("Folder picker was cancelled.");
    }
  }

  function chooseImages() {
    if (isAndroidApp() && window.Capacitor?.Plugins?.SourceImages) {
      void addNativeImages();
      return;
    }

    fileInputRef.current?.click();
  }

  function addFiles(fileList: FileList | File[]) {
    addPickedFiles(Array.from(fileList).map((file) => ({ file })));
  }

  function addPickedFiles(pickedFiles: PickedFile[]) {
    const files = pickedFiles.filter((picked) => picked.file.type.startsWith("image/"));
    if (!files.length) {
      void recordAppLog("warn", "Image picker returned no supported image files.");
      setStatus("No image files were selected.");
      return;
    }

    void recordAppLog(
      "info",
      `Adding ${files.length} image(s): ${files
        .map(({ file }) => `${file.name} ${file.type || "unknown"} ${file.size} bytes`)
        .join("; ")}`
    );

    const nextImages: SheetImage[] = files.map(({ file, sourceUri, batchFolderUri, batchFolderName }) => {
      const image: SheetImage = {
        id: `${file.name}-${file.lastModified}-${uniqueId()}`,
        file,
        name: file.name,
        url: URL.createObjectURL(file),
        sourceUri,
        batchFolderUri,
        batchFolderName,
        status: "loading"
      };

      if (isAndroidApp()) {
        generateThumbnail(image);
        return image;
      }

      const probe = new Image();
      probe.onload = () => {
        setImages((current) =>
          current.map((item) =>
            item.id === image.id
              ? { ...item, width: probe.naturalWidth, height: probe.naturalHeight }
              : item
          )
        );
      };
      probe.onerror = () => {
        setImages((current) =>
          current.map((item) => (item.id === image.id ? { ...item, status: "error" } : item))
        );
      };
      probe.src = image.url;
      return { ...image, status: "ready" as const };
    });

    setImages((current) => [...current, ...nextImages]);
    setStatus(`${files.length} image${files.length === 1 ? "" : "s"} added.`);
  }

  async function generateThumbnail(image: SheetImage) {
    try {
      void recordAppLog("info", `Thumbnail start: ${image.name}`);
      const thumbnail = await createThumbnail(image.file);
      setImages((current) =>
        current.map((item) => {
          if (item.id !== image.id) return item;
          if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
          return {
            ...item,
            thumbUrl: thumbnail.url,
            width: thumbnail.width,
            height: thumbnail.height,
            status: "ready"
          };
        })
      );
      void recordAppLog("info", `Thumbnail ready: ${image.name} ${thumbnail.width}x${thumbnail.height}`);
    } catch (error) {
      console.warn(error);
      void recordAppLog("error", `Thumbnail failed: ${image.name}`, error);
      setImages((current) =>
        current.map((item) => (item.id === image.id ? { ...item, status: "error" } : item))
      );
    }
  }

  function handlePickerChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      addFiles(event.target.files);
      event.target.value = "";
    }
  }

  function reorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    setImages((current) => {
      const fromIndex = current.findIndex((image) => image.id === fromId);
      const toIndex = current.findIndex((image) => image.id === toId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function moveImage(id: string, direction: -1 | 1) {
    setImages((current) => {
      const index = current.findIndex((image) => image.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function removeImage(id: string) {
    setImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image) releaseImageUrls(image);
      return current.filter((item) => item.id !== id);
    });
  }

  function sortByName() {
    setImages((current) =>
      [...current].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    );
    setStatus("Images sorted by filename.");
  }

  function clearImages() {
    images.forEach(releaseImageUrls);
    setImages([]);
    setStatus("Image list cleared.");
  }

  function clearExportedImages() {
    images.forEach(releaseImageUrls);
    setImages([]);
  }

  async function finishExport(message: string) {
    let finalMessage = message;

    if (settings.sourceCleanupMode !== "off") {
      finalMessage += await deleteOriginalSourceImages();
    }

    if (settings.clearAfterExport) {
      clearExportedImages();
      setStatus(`${finalMessage} Image list cleared.`);
      return;
    }

    setStatus(finalMessage);
  }

  async function deleteOriginalSourceImages() {
    const nativeImages = window.Capacitor?.Plugins?.SourceImages;
    const deleteBatchFolders = settings.sourceCleanupMode === "images-and-folder";
    const batchFolderUris = uniqueStrings(
      images
        .map((image) => image.batchFolderUri)
        .filter((uri): uri is string => Boolean(uri))
    );
    const batchFolderNames = uniqueStrings(
      images
        .map((image) => image.batchFolderName)
        .filter((name): name is string => Boolean(name))
    );
    const sourceUris = uniqueStrings(
      images
        .filter((image) => !deleteBatchFolders || !image.batchFolderUri)
        .map((image) => image.sourceUri)
        .filter((uri): uri is string => Boolean(uri))
    );
    const folderUrisToDelete = deleteBatchFolders ? batchFolderUris : [];
    const totalDeleteTargets = sourceUris.length + folderUrisToDelete.length;

    if (!isAndroidApp() || !nativeImages || !totalDeleteTargets) {
      return " No original phone photos were available to delete.";
    }

    if (folderUrisToDelete.length && !nativeImages.deleteFolders) {
      return " Batch folder deletion is not available in this Android build.";
    }

    const targetDescription = folderUrisToDelete.length
      ? `${sourceUris.length ? `${sourceUris.length} original phone photo${sourceUris.length === 1 ? "" : "s"} and ` : ""}${
          folderUrisToDelete.length
        } selected batch folder${folderUrisToDelete.length === 1 ? "" : "s"}`
      : `${sourceUris.length} original phone photo${sourceUris.length === 1 ? "" : "s"}`;
    const deleteDescription = folderUrisToDelete.length
      ? `This deletes ${
          sourceUris.length
            ? "the selected original photos and "
            : ""
        }the selected batch folder and everything inside it.`
      : "This deletes the original selected image files, but keeps any batch folder itself.";
    const folderNameLine = folderUrisToDelete.length && batchFolderNames.length
      ? `\n\nFolder${batchFolderNames.length === 1 ? "" : "s"}: ${batchFolderNames.join(", ")}`
      : "";

    const shouldDelete = window.confirm(
      `Delete ${targetDescription} now? ${deleteDescription} This cannot be undone.${folderNameLine}`
    );
    if (!shouldDelete) {
      void recordAppLog("info", "User kept original source photos and folders after export.");
      return " Original phone photos and folders kept.";
    }

    try {
      let deletedImages = 0;
      let deletedFolders = 0;
      let keptMessage = "";

      if (folderUrisToDelete.length && nativeImages.deleteFolders) {
        const folderResult = await nativeImages.deleteFolders({ uris: folderUrisToDelete });
        deletedFolders = folderResult.deleted;
        void recordAppLog(
          "info",
          `Batch folder delete complete. deleted=${folderResult.deleted} requested=${folderResult.requested}`
        );
      }

      if (sourceUris.length) {
        const result = await nativeImages.deleteImages({ uris: sourceUris });
        if (result.cancelled) {
          keptMessage = " Some original phone photos were kept.";
        } else {
          deletedImages = result.deleted;
          void recordAppLog(
            "info",
            `Original source delete complete. deleted=${result.deleted} requested=${result.requested} foldersDeleted=${result.foldersDeleted ?? 0} foldersEmpty=${result.foldersEmpty ?? 0}`
          );
        }
      }

      const imageMessage = sourceUris.length
        ? ` Deleted ${deletedImages} original phone photo${deletedImages === 1 ? "" : "s"}.`
        : "";
      const folderMessage = folderUrisToDelete.length
        ? ` Deleted ${deletedFolders} selected batch folder${deletedFolders === 1 ? "" : "s"}.`
        : "";
      return `${imageMessage}${folderMessage}${keptMessage}`;
    } catch (error) {
      void recordAppLog("error", "Original source or batch folder delete failed.", error);
      return " Original phone photo or batch folder deletion failed.";
    }
  }

  function pageDimensions(image?: SheetImage): { width: number; height: number; orientation: "p" | "l" } {
    const base = pageFormats[settings.pageSize].portrait;
    const explicit =
      settings.orientation === "landscape"
        ? "landscape"
        : settings.orientation === "portrait"
          ? "portrait"
          : image && (image.width ?? 0) > (image.height ?? Number.POSITIVE_INFINITY)
            ? "landscape"
            : "portrait";

    return explicit === "landscape"
      ? { width: base[1], height: base[0], orientation: "l" }
      : { width: base[0], height: base[1], orientation: "p" };
  }

  async function exportPdf() {
    if (!images.length || exportState !== "idle") return;

    setExportState("pdf");
    setStatus("Building PDF...");
    void recordAppLog("info", `PDF export start. images=${images.length}`);

    try {
      const { default: jsPDF } = await import("jspdf");
      const firstPage = pageDimensions(images[0]);
      const pdf = new jsPDF({
        orientation: firstPage.orientation,
        unit: "in",
        format: [firstPage.width, firstPage.height],
        compress: true
      });

      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const page = pageDimensions(image);

        if (index > 0) {
          pdf.addPage([page.width, page.height], page.orientation);
        }

        pdf.setFillColor(settings.background === "black" ? "#000000" : "#ffffff");
        pdf.rect(0, 0, page.width, page.height, "F");

        const source = await loadImage(image.url);
        const encoded = imageToJpeg(source, settings.quality, settings.background);
        const placement = placeImage(
          source.naturalWidth,
          source.naturalHeight,
          page.width,
          page.height,
          settings.fit
        );

        pdf.addImage(encoded, "JPEG", placement.x, placement.y, placement.width, placement.height);
        setStatus(`Added page ${index + 1} of ${images.length}.`);
      }

      await downloadBlob(
        pdf.output("blob"),
        outputFilename(settings.outputName, "image-sheets", "pdf"),
        "application/pdf",
        settings.saveDestination
      );
      await finishExport(`Exported ${images.length} page${images.length === 1 ? "" : "s"} as a PDF.`);
      void recordAppLog("info", "PDF export complete.");
    } catch (error) {
      console.error(error);
      void recordAppLog("error", "PDF export failed.", error);
      setStatus("Export failed. Try removing unsupported or very large image files.");
    } finally {
      setExportState("idle");
    }
  }

  async function exportStackedImage() {
    if (!images.length || exportState !== "idle") return;

    setExportState("stack");
    setStatus("Stacking images...");
    void recordAppLog(
      "info",
      `Stack export start. images=${images.length} format=${settings.stackFormat} quality=${settings.quality}`
    );

    try {
      if (isAndroidApp()) {
        const result = await exportAndroidNativeStack();
        const pngNote =
          settings.stackFormat === "jpeg"
            ? " Android used PNG because this stack may be taller than normal JPEG supports."
            : "";
        await finishExport(
          `Exported a ${result.width} x ${result.height} stacked ${result.format.toUpperCase()}.${pngNote}`
        );
        void recordAppLog(
          "info",
          `Android native stack complete. ${result.width}x${result.height} ${result.format}`
        );
        return;
      }

      if (!isAndroidApp()) {
        try {
          const result = await exportStackedRaster();
          await finishExport(
            `Exported a ${result.width} x ${result.height} stacked ${result.format.toUpperCase()}.`
          );
          void recordAppLog("info", `Stack raster export complete. ${result.width}x${result.height}`);
          return;
        } catch (error) {
          console.warn(error);
          void recordAppLog("warn", "Local stacker unavailable; using browser stack fallback.", error);
          setStatus("Local stacker unavailable; trying browser export...");
        }
      }

      const loadedImages = await loadImagesSequentially(images);
      const width = Math.max(...loadedImages.map((image) => image.naturalWidth));
      const height = loadedImages.reduce((sum, image) => sum + image.naturalHeight, 0);
      const maxCanvasDimension = 32767;
      const maxCanvasArea = isAndroidApp() ? 36_000_000 : 268_435_456;

      if (width > maxCanvasDimension || height > maxCanvasDimension || width * height > maxCanvasArea) {
        if (isAndroidApp()) {
          setStatus("That stack is too large for the phone build. Use the Windows EXE for full-size stacks.");
          void recordAppLog("warn", `Android stack refused. size=${width}x${height}`);
          return;
        }
        await exportStackedSvg(loadedImages, width, height);
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable.");
      }

      context.fillStyle = settings.background === "black" ? "#000000" : "#ffffff";
      context.fillRect(0, 0, width, height);

      let y = 0;
      loadedImages.forEach((image) => {
        const x = Math.floor((width - image.naturalWidth) / 2);
        context.drawImage(image, x, y, image.naturalWidth, image.naturalHeight);
        y += image.naturalHeight;
      });

      const blob = await canvasToBlob(canvas);
      await downloadBlob(
        blob,
        outputFilename(settings.outputName, "stacked-images", "png"),
        "image/png",
        settings.saveDestination
      );
      await finishExport(`Exported a ${width} x ${height} stacked PNG.`);
      void recordAppLog("info", `Stack browser export complete. ${width}x${height}`);
    } catch (error) {
      console.error(error);
      void recordAppLog("error", "Stack export failed.", error);
      setStatus("Stack export failed. Try removing unsupported or very large image files.");
    } finally {
      setExportState("idle");
    }
  }

  async function exportStackedSvg(
    loadedImages: HTMLImageElement[],
    width: number,
    height: number
  ) {
    setStatus("Stack is huge, saving SVG instead...");

    const imageData = await Promise.all(
      images.map(async (image, index) => ({
        href: await fileToDataUrl(image.file),
        width: loadedImages[index].naturalWidth,
        height: loadedImages[index].naturalHeight
      }))
    );

    let y = 0;
    const nodes = imageData.map((image) => {
      const x = Math.floor((width - image.width) / 2);
      const node = `<image href="${escapeXml(image.href)}" x="${x}" y="${y}" width="${image.width}" height="${image.height}" />`;
      y += image.height;
      return node;
    });

    const background = settings.background === "black" ? "#000000" : "#ffffff";
    const svg = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="100%" height="100%" fill="${background}" />`,
      ...nodes,
      `</svg>`
    ].join("\n");

    await downloadBlob(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      outputFilename(settings.outputName, "stacked-images", "svg"),
      "image/svg+xml",
      settings.saveDestination
    );
    await finishExport(`Canvas limit avoided: exported a ${width} x ${height} stacked SVG.`);
    void recordAppLog("info", `Stack SVG export complete. ${width}x${height}`);
  }

  async function exportStackedRaster() {
    const formData = new FormData();
    images.forEach((image) => formData.append("images", image.file, image.name));
    formData.append("format", settings.stackFormat);
    formData.append("background", settings.background);
    formData.append("quality", String(settings.quality));

    const response = await fetch("http://localhost:5174/api/stack-image", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const blob = await response.blob();
    const width = response.headers.get("X-Stacked-Width") ?? "?";
    const height = response.headers.get("X-Stacked-Height") ?? "?";
    const extension = settings.stackFormat === "jpeg" ? "jpg" : "png";
    await downloadBlob(
      blob,
      outputFilename(settings.outputName, "stacked-images", extension),
      blob.type,
      settings.saveDestination
    );

    return { width, height, format: settings.stackFormat };
  }

  async function exportAndroidNativeStack() {
    const nativeStacker = window.Capacitor?.Plugins?.NativeStacker;
    if (!nativeStacker) {
      throw new Error("Native Android stacker is unavailable.");
    }

    if (settings.stackFormat === "jpeg") {
      void recordAppLog(
        "info",
        "Android native stacker is using PNG output because tall JPEG files cannot exceed 65535 pixels in one dimension."
      );
    }

    const filename = outputFilename(settings.outputName, "stacked-images", "png");
    const session = await nativeStacker.beginStack({
      filename,
      background: settings.background,
      destination: settings.saveDestination
    });
    const chunkSize = 256 * 1024;

    try {
      for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
        const image = images[imageIndex];
        setStatus(`Preparing stack image ${imageIndex + 1} of ${images.length}...`);
        void recordAppLog(
          "info",
          `Android native stack image start: ${image.name} ${image.file.size} bytes`
        );

        await nativeStacker.beginImage({
          sessionId: session.sessionId,
          name: image.name
        });

        let chunkCount = 0;
        for (let offset = 0; offset < image.file.size; offset += chunkSize) {
          const chunk = image.file.slice(offset, Math.min(offset + chunkSize, image.file.size));
          await nativeStacker.appendImageChunk({
            sessionId: session.sessionId,
            base64Data: await blobToBase64Payload(chunk)
          });
          chunkCount += 1;

          if (chunkCount === 1 || chunkCount % 25 === 0) {
            void recordAppLog(
              "info",
              `Android native stack image progress: ${image.name} ${Math.min(
                offset + chunkSize,
                image.file.size
              )}/${image.file.size}`
            );
          }
        }

        await nativeStacker.finishImage({ sessionId: session.sessionId });
      }

      setStatus(
        settings.saveDestination === "ask"
          ? "Writing the stacked PNG..."
          : "Writing the stacked PNG to Downloads..."
      );
      return await nativeStacker.finishStack({ sessionId: session.sessionId });
    } catch (error) {
      await nativeStacker.abortStack({ sessionId: session.sessionId }).catch(() => undefined);
      void recordAppLog("error", "Android native stack failed.", error);
      throw error;
    }
  }

  async function saveCrashLog() {
    setStatus("Saving crash log...");
    void recordAppLog("info", "User requested crash log export.");

    try {
      const filename = `image-sheet-pdf-crash-log-${dateStamp()}.txt`;
      const nativeLog = window.Capacitor?.Plugins?.AppLog;
      if (isAndroidApp() && nativeLog) {
        await nativeLog.saveLog({ filename });
        setStatus(`Crash log saved to Downloads as ${filename}.`);
        return;
      }

      const log = readLocalClientLog() || "No crash log entries yet.\n";
      await downloadBlob(new Blob([log], { type: "text/plain" }), filename, "text/plain");
      setStatus(`Crash log saved as ${filename}.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not save crash log.");
    }
  }

  return (
    <main className="app">
      <section className="workspace" aria-label="Image to PDF workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Image Sheet PDF</p>
            <h1>Arrange images into one-page sheets</h1>
          </div>
          <div className="topActions">
            <button type="button" onClick={saveCrashLog} title="Save crash log">
              <FileText size={18} aria-hidden="true" />
              Save Log
            </button>
            <button
              type="button"
              onClick={exportStackedImage}
              disabled={!images.length || exportState !== "idle"}
              title="Export stacked image"
            >
              <Layers size={18} aria-hidden="true" />
              {exportState === "stack" ? "Stacking" : "Stack Image"}
            </button>
            <button
              className="primary"
              type="button"
              onClick={exportPdf}
              disabled={!images.length || exportState !== "idle"}
              title="Export PDF"
            >
              <Download size={18} aria-hidden="true" />
              {exportState === "pdf" ? "Exporting" : "Export PDF"}
            </button>
          </div>
        </header>

        <section
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handlePickerChange}
          />
          <button type="button" onClick={chooseImages} title="Add images">
            <ImagePlus size={20} aria-hidden="true" />
            Add images
          </button>
          {isAndroidApp() ? (
            <button type="button" onClick={addNativeFolderBatch} title="Add folder batches">
              <FolderOpen size={20} aria-hidden="true" />
              Add folder batches
            </button>
          ) : null}
          <p>{isAndroidApp() ? "Add photos from your phone." : "Drop files here, or add them from your computer."}</p>
        </section>

        <section className="controls" aria-label="PDF settings">
          <label className="filenameControl">
            Output name
            <input
              type="text"
              inputMode="text"
              value={settings.outputName}
              placeholder="Auto name"
              onChange={(event) =>
                setSettings((current) => ({ ...current, outputName: event.target.value }))
              }
            />
          </label>
          {isAndroidApp() ? (
            <label>
              Save to
              <select
                value={settings.saveDestination}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    saveDestination: event.target.value as SaveDestination
                  }))
                }
              >
                <option value="downloads">Downloads</option>
                <option value="ask">Ask each time</option>
              </select>
            </label>
          ) : null}
          <label>
            Page
            <select
              value={settings.pageSize}
              onChange={(event) =>
                setSettings((current) => ({ ...current, pageSize: event.target.value as PageSize }))
              }
            >
              {Object.entries(pageFormats).map(([value, page]) => (
                <option key={value} value={value}>
                  {page.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Orientation
            <select
              value={settings.orientation}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  orientation: event.target.value as Orientation
                }))
              }
            >
              <option value="auto">Auto per image</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          <label>
            Fit
            <select
              value={settings.fit}
              onChange={(event) =>
                setSettings((current) => ({ ...current, fit: event.target.value as FitMode }))
              }
            >
              <option value="contain">Fit full image</option>
              <option value="cover">Fill page</option>
            </select>
          </label>
          <label>
            Background
            <select
              value={settings.background}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  background: event.target.value as PdfSettings["background"]
                }))
              }
            >
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </label>
          <label>
            Theme
            <select
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Stack
            <select
              value={settings.stackFormat}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  stackFormat: event.target.value as StackFormat
                }))
              }
            >
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
          <label className="qualityControl">
            Quality
            <input
              type="range"
              min="0.55"
              max="1"
              step="0.01"
              value={settings.quality}
              onChange={(event) =>
                setSettings((current) => ({ ...current, quality: Number(event.target.value) }))
              }
            />
            <span>{Math.round(settings.quality * 100)}%</span>
          </label>
          <label className="toggleControl">
            <input
              type="checkbox"
              checked={settings.clearAfterExport}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  clearAfterExport: event.target.checked
                }))
              }
            />
            <span>Clear app list after export</span>
          </label>
          {isAndroidApp() ? (
            <label
              className="sourceCleanupControl"
              title={
                sourceImageCount
                  ? "Choose what original phone files to delete after a successful export"
                  : "Use Add images in the Android app to select deletable source photos"
              }
            >
              Source cleanup
              <select
                value={settings.sourceCleanupMode}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    sourceCleanupMode: event.target.value as SourceCleanupMode
                  }))
                }
              >
                <option value="off">Keep originals</option>
                <option value="images">Delete images only</option>
                <option value="images-and-folder">Images + batch folder</option>
              </select>
            </label>
          ) : null}
          <label className="toggleControl">
            <input
              type="checkbox"
              checked={rememberSettings}
              onChange={(event) => setRememberSettings(event.target.checked)}
            />
            <span>Remember export settings</span>
          </label>
        </section>

        <section className="listbar">
          <div>
            <strong>{images.length}</strong> image{images.length === 1 ? "" : "s"}
            <span>{formatBytes(totalSize)}</span>
          </div>
          <div className="iconRow">
            <button type="button" onClick={sortByName} disabled={images.length < 2} title="Sort by name">
              <SortAsc size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={clearImages} disabled={!images.length} title="Clear all">
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          </div>
        </section>

        <section className={images.length ? "imageGrid" : "emptyGrid"} aria-live="polite">
          {images.length ? (
            images.map((image, index) => (
              <article
                className={`imageItem ${draggedId === image.id ? "dragging" : ""}`}
                key={image.id}
                draggable
                onDragStart={() => setDraggedId(image.id)}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()}
                onDrop={() => {
                  if (draggedId) reorder(draggedId, image.id);
                  setDraggedId(null);
                }}
              >
                <div className="thumbWrap">
                  {image.thumbUrl || (!isAndroidApp() && image.url) ? (
                    <img src={image.thumbUrl ?? image.url} alt={image.name} />
                  ) : (
                    <FileImage size={28} aria-hidden="true" />
                  )}
                  <span>{index + 1}</span>
                </div>
                <div className="itemText">
                  <strong title={image.name}>{image.name}</strong>
                  <span>
                    {image.width && image.height
                      ? `${image.width} x ${image.height}`
                      : image.status === "error"
                        ? "Preview unavailable"
                        : "Preparing preview"}
                  </span>
                </div>
                <div className="itemActions">
                  <GripVertical size={18} aria-hidden="true" className="grip" />
                  <button
                    type="button"
                    onClick={() => moveImage(image.id, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveImage(image.id, 1)}
                    disabled={index === images.length - 1}
                    title="Move down"
                  >
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => removeImage(image.id)} title="Remove image">
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="emptyState">
              <FileImage size={42} aria-hidden="true" />
              <p>No images selected yet.</p>
            </div>
          )}
        </section>
      </section>
      <aside className="previewPanel" aria-label="Export preview">
        <div className="paper">
          {images[0] ? (
            <img
              src={images[0].thumbUrl ?? images[0].url}
              alt={`First page preview: ${images[0].name}`}
              className={settings.fit}
            />
          ) : (
            <FileImage size={56} aria-hidden="true" />
          )}
        </div>
        <p>{status}</p>
      </aside>
    </main>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function createThumbnail(file: File) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    try {
      return await bitmapToThumbnail(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    return await imageToThumbnail(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function nativePickedImageToFile(image: NativePickedImage): Promise<PickedFile> {
  const fileUrl = window.Capacitor?.convertFileSrc?.(image.fileUri) ?? image.fileUri;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Could not read selected photo: ${image.name}`);
  }

  const blob = await response.blob();
  const file = new File([blob], image.name, {
    type: image.mimeType || blob.type || "image/jpeg",
    lastModified: Date.now()
  });

  return {
    file,
    sourceUri: image.sourceUri,
    batchFolderUri: image.batchFolderUri,
    batchFolderName: image.batchFolderName
  };
}

async function bitmapToThumbnail(source: ImageBitmap, width: number, height: number) {
  return drawThumbnail(source, width, height);
}

async function imageToThumbnail(source: HTMLImageElement, width: number, height: number) {
  return drawThumbnail(source, width, height);
}

async function drawThumbnail(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number
) {
  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable.");
  }

  context.drawImage(source, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.78);
  return {
    url: URL.createObjectURL(blob),
    width: sourceWidth,
    height: sourceHeight
  };
}

async function loadImagesSequentially(items: SheetImage[]) {
  const loadedImages: HTMLImageElement[] = [];
  for (const item of items) {
    loadedImages.push(await loadImage(item.url));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return loadedImages;
}

function imageToJpeg(image: HTMLImageElement, quality: number, background: "white" | "black") {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable.");
  }
  context.fillStyle = background === "black" ? "#000000" : "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType = "image/png",
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not create image blob."));
      }
    }, mimeType, quality);
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function downloadBlob(
  blob: Blob,
  filename: string,
  fallbackMimeType = "application/octet-stream",
  destination: SaveDestination = "downloads"
) {
  const nativeSaver = window.Capacitor?.Plugins?.DownloadSaver;
  if (window.Capacitor?.getPlatform?.() === "android" && nativeSaver) {
    if (
      nativeSaver.beginFile &&
      nativeSaver.beginPickedFile &&
      nativeSaver.appendFileChunk &&
      nativeSaver.finishFile &&
      nativeSaver.abortFile
    ) {
      await downloadBlobInChunks(nativeSaver, blob, filename, fallbackMimeType, destination);
      return;
    }

    await nativeSaver.saveFile({
      filename,
      mimeType: blob.type || fallbackMimeType,
      base64Data: await blobToBase64Payload(blob)
    });
    return;
  }

  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadBlobInChunks(
  nativeSaver: NonNullable<NonNullable<Window["Capacitor"]>["Plugins"]>["DownloadSaver"],
  blob: Blob,
  filename: string,
  fallbackMimeType: string,
  destination: SaveDestination
) {
  if (
    !nativeSaver?.beginFile ||
    !nativeSaver.beginPickedFile ||
    !nativeSaver.appendFileChunk ||
    !nativeSaver.finishFile ||
    !nativeSaver.abortFile
  ) {
    throw new Error("Chunked Android saver is unavailable.");
  }

  const sessionStarter = destination === "ask" ? nativeSaver.beginPickedFile : nativeSaver.beginFile;
  const session = await sessionStarter({
    filename,
    mimeType: blob.type || fallbackMimeType
  });

  const chunkSize = 256 * 1024;
  let chunkCount = 0;
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const chunk = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
      await nativeSaver.appendFileChunk({
        sessionId: session.sessionId,
        base64Data: await blobToBase64Payload(chunk)
      });
      chunkCount += 1;

      if (chunkCount === 1 || chunkCount % 25 === 0) {
        void recordAppLog(
          "info",
          `Android chunked save progress: ${filename} ${Math.min(offset + chunkSize, blob.size)}/${blob.size}`
        );
      }
    }

    await nativeSaver.finishFile({ sessionId: session.sessionId });
    void recordAppLog("info", `Android chunked save complete: ${filename} ${blob.size} bytes`);
  } catch (error) {
    await nativeSaver.abortFile({ sessionId: session.sessionId }).catch(() => undefined);
    void recordAppLog("error", `Android chunked save failed: ${filename}`, error);
    throw error;
  }
}

function blobToBase64Payload(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function placeImage(
  imageWidth: number,
  imageHeight: number,
  pageWidth: number,
  pageHeight: number,
  fit: FitMode
) {
  const pageRatio = pageWidth / pageHeight;
  const imageRatio = imageWidth / imageHeight;
  const scale =
    fit === "cover"
      ? imageRatio > pageRatio
        ? pageHeight / imageHeight
        : pageWidth / imageWidth
      : imageRatio > pageRatio
        ? pageWidth / imageWidth
        : pageHeight / imageHeight;
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  return {
    width,
    height,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2
  };
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function dateStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

function outputFilename(outputName: string, fallbackStem: string, extension: string) {
  const cleanExtension = extension.replace(/^\.+/, "") || "bin";
  const cleaned = sanitizeFilenameStem(outputName);
  const stem = cleaned || `${fallbackStem}-${dateStamp()}`;
  return `${stem}.${cleanExtension}`;
}

function sanitizeFilenameStem(value: string) {
  return value
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function isAndroidApp() {
  return window.Capacitor?.getPlatform?.() === "android";
}

function readRememberSettingsPreference() {
  try {
    return localStorage.getItem(rememberSettingsKey) === "true";
  } catch {
    return false;
  }
}

function saveRememberSettingsPreference(rememberSettings: boolean) {
  try {
    localStorage.setItem(rememberSettingsKey, String(rememberSettings));
  } catch {
    // Remembering settings is optional.
  }
}

function readSavedExportSettings(rememberSettings: boolean): PdfSettings {
  if (!rememberSettings) {
    return initialSettings;
  }

  try {
    const saved = localStorage.getItem(exportSettingsKey);
    if (!saved) {
      return initialSettings;
    }

    const parsed = JSON.parse(saved) as Partial<PdfSettings>;
    return normalizeSettings(parsed);
  } catch {
    return initialSettings;
  }
}

function saveExportSettings(settings: PdfSettings) {
  try {
    localStorage.setItem(exportSettingsKey, JSON.stringify(settings));
  } catch {
    // Export settings can still be changed for the current session.
  }
}

function clearSavedExportSettings() {
  try {
    localStorage.removeItem(exportSettingsKey);
  } catch {
    // Ignore storage failures.
  }
}

function normalizeSettings(settings: Partial<PdfSettings>): PdfSettings {
  return {
    pageSize: settings.pageSize === "a4" || settings.pageSize === "letter" ? settings.pageSize : initialSettings.pageSize,
    orientation:
      settings.orientation === "portrait" ||
      settings.orientation === "landscape" ||
      settings.orientation === "auto"
        ? settings.orientation
        : initialSettings.orientation,
    fit: settings.fit === "cover" || settings.fit === "contain" ? settings.fit : initialSettings.fit,
    background:
      settings.background === "black" || settings.background === "white"
        ? settings.background
        : initialSettings.background,
    stackFormat:
      settings.stackFormat === "jpeg" || settings.stackFormat === "png"
        ? settings.stackFormat
        : initialSettings.stackFormat,
    quality:
      typeof settings.quality === "number" && Number.isFinite(settings.quality)
        ? Math.min(1, Math.max(0.55, settings.quality))
        : initialSettings.quality,
    outputName: typeof settings.outputName === "string" ? settings.outputName : initialSettings.outputName,
    saveDestination:
      settings.saveDestination === "ask" || settings.saveDestination === "downloads"
        ? settings.saveDestination
        : initialSettings.saveDestination,
    clearAfterExport:
      typeof settings.clearAfterExport === "boolean"
        ? settings.clearAfterExport
        : initialSettings.clearAfterExport,
    sourceCleanupMode: normalizeSourceCleanupMode(settings)
  };
}

function normalizeSourceCleanupMode(settings: Partial<PdfSettings>): SourceCleanupMode {
  if (
    settings.sourceCleanupMode === "off" ||
    settings.sourceCleanupMode === "images" ||
    settings.sourceCleanupMode === "images-and-folder"
  ) {
    return settings.sourceCleanupMode;
  }

  return settings.deleteSourcesAfterExport ? "images-and-folder" : initialSettings.sourceCleanupMode;
}

function readThemeModePreference(): ThemeMode {
  try {
    const saved = localStorage.getItem(themeModeKey);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function saveThemeModePreference(themeMode: ThemeMode) {
  try {
    localStorage.setItem(themeModeKey, themeMode);
  } catch {
    // Theme preference is optional; system mode remains the fallback.
  }
}

function applyThemeMode(themeMode: ThemeMode) {
  const root = document.documentElement;
  const resolvedTheme = resolveThemeMode(themeMode);

  if (themeMode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.dataset.theme = themeMode;
  }

  root.style.colorScheme = resolvedTheme;
  setThemeColor(resolvedTheme);
}

function resolveThemeMode(themeMode: ThemeMode): "light" | "dark" {
  if (themeMode !== "system") {
    return themeMode;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setThemeColor(theme: "light" | "dark") {
  const color = theme === "dark" ? "#151b1c" : "#eef0e7";
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
}

function uniqueId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function releaseImageUrls(image: SheetImage) {
  URL.revokeObjectURL(image.url);
  if (image.thumbUrl) {
    URL.revokeObjectURL(image.thumbUrl);
  }
}

let clientLoggersInstalled = false;

function installClientLoggers() {
  if (clientLoggersInstalled) {
    return;
  }
  clientLoggersInstalled = true;

  window.addEventListener("error", (event) => {
    void recordAppLog(
      "error",
      `Window error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      event.error
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    void recordAppLog("error", "Unhandled promise rejection.", event.reason);
  });
}

async function recordAppLog(level: "info" | "warn" | "error", message: string, details?: unknown) {
  const detailText = details ? `\n${formatLogDetails(details)}` : "";
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${detailText}`;
  appendLocalClientLog(line);

  const nativeLog = window.Capacitor?.Plugins?.AppLog;
  if (isAndroidApp() && nativeLog) {
    try {
      await nativeLog.appendLog({ level: level.toUpperCase(), message: `${message}${detailText}` });
    } catch {
      // Local storage keeps a fallback copy if the native bridge is unavailable.
    }
  }
}

function appendLocalClientLog(line: string) {
  try {
    const maxCharacters = 180_000;
    const current = localStorage.getItem(localLogKey) ?? "";
    const next = `${current}${line}\n`;
    localStorage.setItem(localLogKey, next.slice(Math.max(0, next.length - maxCharacters)));
  } catch {
    // Logging cannot be allowed to create app failures.
  }
}

function readLocalClientLog() {
  try {
    return localStorage.getItem(localLogKey) ?? "";
  } catch {
    return "";
  }
}

function formatLogDetails(details: unknown) {
  if (details instanceof Error) {
    return details.stack ?? `${details.name}: ${details.message}`;
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

async function checkForAndroidUpdate() {
  const response = await fetch(latestReleaseApiUrl, {
    headers: { Accept: "application/vnd.github+json" }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Update check failed.");
  }

  const release = (await response.json()) as { html_url?: string; tag_name?: string };
  const latestVersion = normalizeVersion(release.tag_name ?? "");
  if (!latestVersion || compareVersions(latestVersion, packageInfo.version) <= 0) {
    return null;
  }

  return {
    version: latestVersion,
    url: release.html_url ?? releasesUrl
  };
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string) {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
