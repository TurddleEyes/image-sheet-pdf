package com.codex.imagesheetpdf;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

final class PngStackWriter {
    private static final byte[] SIGNATURE = new byte[] {
        (byte) 137, 80, 78, 71, 13, 10, 26, 10
    };

    private PngStackWriter() {}

    static StackInfo inspect(List<File> images) {
        int width = 0;
        long height = 0;

        for (File image : images) {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(image.getAbsolutePath(), options);
            if (options.outWidth <= 0 || options.outHeight <= 0) {
                throw new IllegalArgumentException("Could not read image dimensions: " + image.getName());
            }

            width = Math.max(width, options.outWidth);
            height += options.outHeight;
        }

        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("No images to stack.");
        }

        if (height > 0x7fffffffL) {
            throw new IllegalArgumentException("Stack is too tall for Android PNG output.");
        }

        return new StackInfo(width, (int) height);
    }

    static void write(OutputStream output, List<File> images, int backgroundColor) throws IOException {
        StackInfo info = inspect(images);
        try (PngEncoder encoder = new PngEncoder(output, info.width, info.height)) {
            byte[] row = new byte[1 + info.width * 3];
            int[] pixels = null;

            for (File image : images) {
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inPreferredConfig = Bitmap.Config.ARGB_8888;
                Bitmap bitmap = BitmapFactory.decodeFile(image.getAbsolutePath(), options);
                if (bitmap == null) {
                    throw new IOException("Could not decode image: " + image.getName());
                }

                try {
                    int imageWidth = bitmap.getWidth();
                    int imageHeight = bitmap.getHeight();
                    int xOffset = Math.max(0, (info.width - imageWidth) / 2);
                    if (pixels == null || pixels.length < imageWidth) {
                        pixels = new int[imageWidth];
                    }

                    for (int y = 0; y < imageHeight; y += 1) {
                        fillRow(row, backgroundColor);
                        bitmap.getPixels(pixels, 0, imageWidth, 0, y, imageWidth, 1);
                        writePixels(row, pixels, imageWidth, xOffset);
                        encoder.writeRow(row);
                    }
                } finally {
                    bitmap.recycle();
                }
            }
        }
    }

    private static void fillRow(byte[] row, int color) {
        row[0] = 0;
        byte red = (byte) Color.red(color);
        byte green = (byte) Color.green(color);
        byte blue = (byte) Color.blue(color);

        for (int index = 1; index < row.length; index += 3) {
            row[index] = red;
            row[index + 1] = green;
            row[index + 2] = blue;
        }
    }

    private static void writePixels(byte[] row, int[] pixels, int width, int xOffset) {
        int offset = 1 + xOffset * 3;
        for (int index = 0; index < width; index += 1) {
            int color = pixels[index];
            row[offset] = (byte) Color.red(color);
            row[offset + 1] = (byte) Color.green(color);
            row[offset + 2] = (byte) Color.blue(color);
            offset += 3;
        }
    }

    static final class StackInfo {
        final int width;
        final int height;

        StackInfo(int width, int height) {
            this.width = width;
            this.height = height;
        }
    }

    private static final class PngEncoder implements Closeable {
        private final OutputStream output;
        private final int width;
        private final int height;
        private final Deflater deflater;
        private final byte[] deflateBuffer = new byte[64 * 1024];
        private final byte[] idatBuffer = new byte[64 * 1024];
        private int idatLength;
        private int rowsWritten;
        private boolean finished;

        PngEncoder(OutputStream output, int width, int height) throws IOException {
            this.output = output;
            this.width = width;
            this.height = height;
            this.deflater = new Deflater(Deflater.DEFAULT_COMPRESSION);
            output.write(SIGNATURE);
            writeIhdr();
        }

        void writeRow(byte[] row) throws IOException {
            if (finished) {
                throw new IOException("PNG encoder is already finished.");
            }
            if (rowsWritten >= height) {
                throw new IOException("Too many rows written to PNG.");
            }
            deflater.setInput(row);
            drain(false);
            rowsWritten += 1;
        }

        @Override
        public void close() throws IOException {
            if (finished) {
                return;
            }
            if (rowsWritten != height) {
                throw new IOException("PNG row count mismatch.");
            }

            deflater.finish();
            drain(true);
            flushIdat();
            deflater.end();
            writeChunk("IEND", new byte[0], 0, 0);
            finished = true;
        }

        private void drain(boolean finishing) throws IOException {
            while (!deflater.needsInput() || (finishing && !deflater.finished())) {
                int count = deflater.deflate(deflateBuffer);
                if (count <= 0) {
                    if (!finishing || deflater.finished()) {
                        break;
                    }
                    continue;
                }
                writeIdatBytes(deflateBuffer, count);
            }
        }

        private void writeIdatBytes(byte[] bytes, int count) throws IOException {
            int offset = 0;
            while (offset < count) {
                int writable = Math.min(count - offset, idatBuffer.length - idatLength);
                System.arraycopy(bytes, offset, idatBuffer, idatLength, writable);
                idatLength += writable;
                offset += writable;
                if (idatLength == idatBuffer.length) {
                    flushIdat();
                }
            }
        }

        private void flushIdat() throws IOException {
            if (idatLength > 0) {
                writeChunk("IDAT", idatBuffer, 0, idatLength);
                idatLength = 0;
            }
        }

        private void writeIhdr() throws IOException {
            byte[] data = new byte[13];
            writeInt(data, 0, width);
            writeInt(data, 4, height);
            data[8] = 8;
            data[9] = 2;
            data[10] = 0;
            data[11] = 0;
            data[12] = 0;
            writeChunk("IHDR", data, 0, data.length);
        }

        private void writeChunk(String type, byte[] data, int offset, int length) throws IOException {
            byte[] typeBytes = type.getBytes(StandardCharsets.US_ASCII);
            writeInt(output, length);
            output.write(typeBytes);
            if (length > 0) {
                output.write(data, offset, length);
            }

            CRC32 crc = new CRC32();
            crc.update(typeBytes);
            if (length > 0) {
                crc.update(data, offset, length);
            }
            writeInt(output, (int) crc.getValue());
        }

        private void writeInt(OutputStream output, int value) throws IOException {
            output.write((value >>> 24) & 0xff);
            output.write((value >>> 16) & 0xff);
            output.write((value >>> 8) & 0xff);
            output.write(value & 0xff);
        }

        private void writeInt(byte[] data, int offset, int value) {
            data[offset] = (byte) ((value >>> 24) & 0xff);
            data[offset + 1] = (byte) ((value >>> 16) & 0xff);
            data[offset + 2] = (byte) ((value >>> 8) & 0xff);
            data[offset + 3] = (byte) (value & 0xff);
        }
    }
}
