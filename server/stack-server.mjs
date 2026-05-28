import express from "express";
import multer from "multer";
import sharp from "sharp";
import { pathToFileURL } from "node:url";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 500,
    fileSize: 250 * 1024 * 1024
  }
});

export function createStackServer() {
  const app = express();

  app.use((_, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.options("/api/stack-image", (_, res) => {
    res.sendStatus(204);
  });

  app.post("/api/stack-image", upload.array("images"), async (req, res) => {
    try {
      const files = req.files ?? [];
      if (!files.length) {
        res.status(400).json({ error: "No images uploaded." });
        return;
      }

      const format = req.body.format === "jpeg" ? "jpeg" : "png";
      const quality = clampQuality(Number(req.body.quality));
      const background = req.body.background === "black" ? "#000000" : "#ffffff";

      const prepared = await Promise.all(
        files.map(async (file) => {
          const result = await sharp(file.buffer, { limitInputPixels: false })
            .rotate()
            .png()
            .toBuffer({ resolveWithObject: true });
          return {
            buffer: result.data,
            width: result.info.width,
            height: result.info.height
          };
        })
      );

      const width = Math.max(...prepared.map((image) => image.width));
      const height = prepared.reduce((sum, image) => sum + image.height, 0);
      const layers = [];
      let top = 0;

      for (const image of prepared) {
        layers.push({
          input: image.buffer,
          left: Math.floor((width - image.width) / 2),
          top
        });
        top += image.height;
      }

      let pipeline = sharp({
        create: {
          width,
          height,
          channels: 4,
          background
        },
        limitInputPixels: false
      }).composite(layers);

      if (format === "jpeg") {
        pipeline = pipeline.flatten({ background }).jpeg({
          quality,
          mozjpeg: true,
          limitInputPixels: false
        });
      } else {
        pipeline = pipeline.png({
          compressionLevel: 0,
          adaptiveFiltering: false,
          limitInputPixels: false
        });
      }

      const output = await pipeline.toBuffer();
      res.setHeader("Content-Type", format === "jpeg" ? "image/jpeg" : "image/png");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="stacked-images-${new Date().toISOString().slice(0, 10)}.${
          format === "jpeg" ? "jpg" : "png"
        }"`
      );
      res.setHeader("X-Stacked-Width", String(width));
      res.setHeader("X-Stacked-Height", String(height));
      res.send(output);
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Image stack failed."
      });
    }
  });

  return app;
}

export function startStackServer(port = 5174) {
  const server = createStackServer().listen(port, "localhost", () => {
    console.log(`Stack image server running at http://localhost:${port}`);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.warn(`Stack image server already running at http://localhost:${port}`);
      return;
    }
    throw error;
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStackServer();
}

function clampQuality(value) {
  if (!Number.isFinite(value)) return 92;
  return Math.max(1, Math.min(100, Math.round(value * 100)));
}
