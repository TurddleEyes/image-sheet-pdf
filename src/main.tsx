import React, { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileImage,
  FileText,
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
      Plugins?: {
        DownloadSaver?: {
          saveFile: (options: {
            filename: string;
            mimeType: string;
            base64Data: string;
          }) => Promise<{ uri?: string }>;
        };
        AppLog?: {
          appendLog: (options: { level: string; message: string }) => Promise<void>;
          readLog: () => Promise<{ log?: string }>;
          saveLog: (options: { filename: string }) => Promise<{ uri?: string }>;
          clearLog: () => Promise<void>;
        };
      };
    };
  }
}

type PageSize = "letter" | "a4";
type Orientation = "portrait" | "landscape" | "auto";
type FitMode = "contain" | "cover";
type StackFormat = "png" | "jpeg";

type SheetImage = {
  id: string;
  file: File;
  name: string;
  url: string;
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
};

const initialSettings: PdfSettings = {
  pageSize: "letter",
  orientation: "auto",
  fit: "contain",
  background: "white",
  stackFormat: "png",
  quality: 0.92
};

const pageFormats: Record<PageSize, { portrait: [number, number]; label: string }> = {
  letter: { portrait: [8.5, 11], label: "Letter" },
  a4: { portrait: [8.27, 11.69], label: "A4" }
};

const releasesUrl = "https://github.com/TurddleEyes/image-sheet-pdf/releases/latest";
const latestReleaseApiUrl = "https://api.github.com/repos/TurddleEyes/image-sheet-pdf/releases/latest";
const localLogKey = "image-sheet-pdf-client-log";

function App() {
  const [images, setImages] = useState<SheetImage[]>([]);
  const [settings, setSettings] = useState<PdfSettings>(initialSettings);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [exportState, setExportState] = useState<"idle" | "pdf" | "stack">("idle");
  const [status, setStatus] = useState("Choose images to start.");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => images.reduce((sum, image) => sum + image.file.size, 0),
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

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      void recordAppLog("warn", "Image picker returned no supported image files.");
      setStatus("No image files were selected.");
      return;
    }

    void recordAppLog(
      "info",
      `Adding ${files.length} image(s): ${files
        .map((file) => `${file.name} ${file.type || "unknown"} ${file.size} bytes`)
        .join("; ")}`
    );

    const nextImages: SheetImage[] = files.map((file) => {
      const image: SheetImage = {
        id: `${file.name}-${file.lastModified}-${uniqueId()}`,
        file,
        name: file.name,
        url: URL.createObjectURL(file),
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

      await downloadBlob(pdf.output("blob"), `image-sheets-${dateStamp()}.pdf`, "application/pdf");
      setStatus(`Exported ${images.length} page${images.length === 1 ? "" : "s"} as a PDF.`);
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
      if (!isAndroidApp()) {
        try {
          const result = await exportStackedRaster();
          setStatus(
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
      await downloadBlob(blob, `stacked-images-${dateStamp()}.png`, "image/png");
      setStatus(`Exported a ${width} x ${height} stacked PNG.`);
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
      `stacked-images-${dateStamp()}.svg`,
      "image/svg+xml"
    );
    setStatus(`Canvas limit avoided: exported a ${width} x ${height} stacked SVG.`);
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
    await downloadBlob(blob, `stacked-images-${dateStamp()}.${extension}`, blob.type);

    return { width, height, format: settings.stackFormat };
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
          <button type="button" onClick={() => fileInputRef.current?.click()} title="Add images">
            <ImagePlus size={20} aria-hidden="true" />
            Add images
          </button>
          <p>Drop files here, or add them from your computer.</p>
        </section>

        <section className="controls" aria-label="PDF settings">
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
          <label>
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

async function downloadBlob(blob: Blob, filename: string, fallbackMimeType = "application/octet-stream") {
  const nativeSaver = window.Capacitor?.Plugins?.DownloadSaver;
  if (window.Capacitor?.getPlatform?.() === "android" && nativeSaver) {
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

function isAndroidApp() {
  return window.Capacitor?.getPlatform?.() === "android";
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
