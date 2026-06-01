package com.codex.imagesheetpdf;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(
    name = "NativeStacker",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "writeStorage")
    }
)
public class NativeStackerPlugin extends Plugin {
    private final Map<String, StackSession> sessions = new HashMap<>();

    @PluginMethod
    public void beginStack(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("writeStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeStorage", call, "storagePermsCallback");
            return;
        }

        createSession(call);
    }

    @PluginMethod
    public void beginImage(PluginCall call) {
        StackSession session = getSession(call);
        if (session == null) {
            return;
        }

        String name = call.getString("name", "image");
        try {
            if (session.currentOutput != null) {
                call.reject("Previous image was not finished.");
                return;
            }

            File file = new File(session.directory, session.images.size() + "-" + sanitizeName(name));
            session.currentFile = file;
            session.currentOutput = new FileOutputStream(file);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not start image: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void appendImageChunk(PluginCall call) {
        StackSession session = getSession(call);
        if (session == null) {
            return;
        }

        String base64Data = call.getString("base64Data");
        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing image data chunk.");
            return;
        }

        try {
            if (session.currentOutput == null) {
                call.reject("No image is open.");
                return;
            }
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            session.currentOutput.write(bytes);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not write image chunk: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void finishImage(PluginCall call) {
        StackSession session = getSession(call);
        if (session == null) {
            return;
        }

        try {
            if (session.currentOutput == null || session.currentFile == null) {
                call.reject("No image is open.");
                return;
            }
            session.currentOutput.close();
            session.images.add(session.currentFile);
            session.currentOutput = null;
            session.currentFile = null;
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not finish image: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void finishStack(PluginCall call) {
        StackSession session = getSession(call);
        if (session == null) {
            return;
        }

        try {
            if (session.currentOutput != null) {
                session.currentOutput.close();
                session.currentOutput = null;
            }

            if (session.images.isEmpty()) {
                call.reject("No images were sent to native stacker.");
                return;
            }

            PngStackWriter.StackInfo info = PngStackWriter.inspect(session.images);
            Uri uri = writeStackToDownloads(session, info);

            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            result.put("width", info.width);
            result.put("height", info.height);
            result.put("format", "png");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not stack images: " + error.getMessage(), error);
        } finally {
            sessions.remove(session.id);
            deleteRecursive(session.directory);
        }
    }

    @PluginMethod
    public void abortStack(PluginCall call) {
        String sessionId = call.getString("sessionId");
        StackSession session = sessionId == null ? null : sessions.remove(sessionId);
        if (session != null) {
            try {
                if (session.currentOutput != null) {
                    session.currentOutput.close();
                }
            } catch (Exception ignored) {
                // Best-effort cleanup only.
            }
            deleteRecursive(session.directory);
        }
        call.resolve();
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("writeStorage") == PermissionState.GRANTED) {
            createSession(call);
        } else {
            call.reject("Storage permission is required to save to Downloads.");
        }
    }

    private void createSession(PluginCall call) {
        String filename = call.getString("filename", "stacked-images.png");
        String background = call.getString("background", "white");

        try {
            String id = UUID.randomUUID().toString();
            File directory = new File(getContext().getCacheDir(), "stack-" + id);
            if (!directory.mkdirs()) {
                call.reject("Could not create stack workspace.");
                return;
            }

            StackSession session = new StackSession(id, filename, backgroundColor(background), directory);
            sessions.put(id, session);

            JSObject result = new JSObject();
            result.put("sessionId", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start native stacker: " + error.getMessage(), error);
        }
    }

    private StackSession getSession(PluginCall call) {
        String sessionId = call.getString("sessionId");
        StackSession session = sessionId == null ? null : sessions.get(sessionId);
        if (session == null) {
            call.reject("Unknown stack session.");
        }
        return session;
    }

    private Uri writeStackToDownloads(StackSession session, PngStackWriter.StackInfo info) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, ensurePngName(session.filename));
            values.put(MediaStore.Downloads.MIME_TYPE, "image/png");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            ContentResolver resolver = getContext().getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("Could not create Downloads entry.");
            }

            try (OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) {
                    throw new IllegalStateException("Could not open Downloads entry.");
                }
                PngStackWriter.write(output, session.images, session.backgroundColor);
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

        File outputFile = uniqueFile(downloads, ensurePngName(session.filename));
        try (OutputStream output = new FileOutputStream(outputFile)) {
            PngStackWriter.write(output, session.images, session.backgroundColor);
        }
        return Uri.fromFile(outputFile);
    }

    private int backgroundColor(String background) {
        return "black".equalsIgnoreCase(background) ? Color.BLACK : Color.WHITE;
    }

    private String ensurePngName(String filename) {
        String trimmed = filename == null || filename.trim().isEmpty() ? "stacked-images.png" : filename.trim();
        return trimmed.toLowerCase().endsWith(".png") ? trimmed : trimmed.replaceAll("\\.[^.]+$", "") + ".png";
    }

    private String sanitizeName(String name) {
        return name.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private File uniqueFile(File directory, String filename) {
        File candidate = new File(directory, filename);
        if (!candidate.exists()) {
            return candidate;
        }

        String stem = filename;
        String extension = "";
        int dot = filename.lastIndexOf('.');
        if (dot > 0) {
            stem = filename.substring(0, dot);
            extension = filename.substring(dot);
        }

        int index = 1;
        do {
            candidate = new File(directory, stem + "-" + index + extension);
            index++;
        } while (candidate.exists());

        return candidate;
    }

    private void deleteRecursive(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        file.delete();
    }

    private static class StackSession {
        final String id;
        final String filename;
        final int backgroundColor;
        final File directory;
        final ArrayList<File> images = new ArrayList<>();
        File currentFile;
        OutputStream currentOutput;

        StackSession(String id, String filename, int backgroundColor, File directory) {
            this.id = id;
            this.filename = filename;
            this.backgroundColor = backgroundColor;
            this.directory = directory;
        }
    }
}
