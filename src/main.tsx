import React, { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileImage,
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
  width?: number;
  height?: number;
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
        setStatus("Ready. Update check could not reach GitHub.");
      });
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      setStatus("No image files were selected.");
      return;
    }

    const nextImages = files.map((file) => {
      const image: SheetImage = {
        id: `${file.name}-${file.lastModified}-${uniqueId()}`,
        file,
        name: file.name,
        url: URL.createObjectURL(file)
      };

      if (isAndroidApp()) {
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
      probe.src = image.url;
      return image;
    });

    setImages((current) => [...current, ...nextImages]);
    setStatus(`${files.length} image${files.length === 1 ? "" : "s"} added.`);
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
      if (image) URL.revokeObjectURL(image.url);
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
    images.forEach((image) => URL.revokeObjectURL(image.url));
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
    } catch (error) {
      console.error(error);
      setStatus("Export failed. Try removing unsupported or very large image files.");
    } finally {
      setExportState("idle");
    }
  }

  async function exportStackedImage() {
    if (!images.length || exportState !== "idle") return;

    setExportState("stack");
    setStatus("Stacking images...");

    try {
      if (!isAndroidApp()) {
        try {
          const result = await exportStackedRaster();
          setStatus(
            `Exported a ${result.width} x ${result.height} stacked ${result.format.toUpperCase()}.`
          );
          return;
        } catch (error) {
          console.warn(error);
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
    } catch (error) {
      console.error(error);
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

  return (
    <main className="app">
      <section className="workspace" aria-label="Image to PDF workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Image Sheet PDF</p>
            <h1>Arrange images into one-page sheets</h1>
          </div>
          <div className="topActions">
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
                  {isAndroidApp() ? (
                    <FileImage size={28} aria-hidden="true" />
                  ) : (
                    <img src={image.url} alt={image.name} />
                  )}
                  <span>{index + 1}</span>
                </div>
                <div className="itemText">
                  <strong title={image.name}>{image.name}</strong>
                  <span>
                    {image.width && image.height
                      ? `${image.width} x ${image.height}`
                      : "Reading dimensions"}
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
              src={images[0].url}
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

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not create image blob."));
      }
    }, "image/png");
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
