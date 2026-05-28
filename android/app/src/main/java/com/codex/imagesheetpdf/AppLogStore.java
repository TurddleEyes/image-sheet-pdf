package com.codex.imagesheetpdf;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class AppLogStore {
    private static final String LOG_FILE = "image-sheet-pdf-crash-log.txt";
    private static final int MAX_LOG_BYTES = 512 * 1024;
    private static Thread.UncaughtExceptionHandler previousHandler;
    private static boolean installed;

    private AppLogStore() {}

    static synchronized void install(Context context) {
        if (installed) {
            return;
        }

        Context appContext = context.getApplicationContext();
        previousHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            append(appContext, "CRASH", "Uncaught exception on thread " + thread.getName() + "\n" + stackTrace(throwable));
            if (previousHandler != null) {
                previousHandler.uncaughtException(thread, throwable);
            }
        });
        installed = true;
        append(appContext, "INFO", "Native logger installed. Android " + Build.VERSION.RELEASE + " API " + Build.VERSION.SDK_INT);
    }

    static synchronized void append(Context context, String level, String message) {
        try {
            File file = logFile(context);
            byte[] existing = file.exists() ? readBytes(file) : new byte[0];
            String entry = timestamp() + " [" + level + "] " + message + "\n";
            byte[] next = entry.getBytes(StandardCharsets.UTF_8);
            int keep = Math.min(existing.length, Math.max(0, MAX_LOG_BYTES - next.length));

            try (FileOutputStream output = new FileOutputStream(file, false)) {
                if (keep > 0) {
                    output.write(existing, existing.length - keep, keep);
                }
                output.write(next);
            }
        } catch (Exception ignored) {
            // Logging must never create a new crash.
        }
    }

    static synchronized String read(Context context) throws Exception {
        File file = logFile(context);
        if (!file.exists()) {
            return "";
        }
        return new String(readBytes(file), StandardCharsets.UTF_8);
    }

    static synchronized void clear(Context context) throws Exception {
        File file = logFile(context);
        if (file.exists() && !file.delete()) {
            throw new IllegalStateException("Could not delete log file.");
        }
    }

    static synchronized Uri saveToDownloads(Context context, String filename) throws Exception {
        byte[] bytes = read(context).getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0) {
            bytes = (timestamp() + " [INFO] No crash log entries yet.\n").getBytes(StandardCharsets.UTF_8);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            ContentResolver resolver = context.getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("Could not create Downloads entry.");
            }

            try (OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) {
                    throw new IllegalStateException("Could not open Downloads entry.");
                }
                output.write(bytes);
            }

            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return uri;
        }

        File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!downloads.exists() && !downloads.mkdirs()) {
            throw new IllegalStateException("Could not create Downloads folder.");
        }

        File outputFile = new File(downloads, filename);
        try (OutputStream output = new FileOutputStream(outputFile)) {
            output.write(bytes);
        }
        return Uri.fromFile(outputFile);
    }

    private static File logFile(Context context) {
        return new File(context.getFilesDir(), LOG_FILE);
    }

    private static byte[] readBytes(File file) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
        }
        return buffer.toByteArray();
    }

    private static String timestamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS z", Locale.US);
        format.setTimeZone(TimeZone.getDefault());
        return format.format(new Date());
    }

    private static String stackTrace(Throwable throwable) {
        StringWriter writer = new StringWriter();
        throwable.printStackTrace(new PrintWriter(writer));
        return writer.toString();
    }
}
