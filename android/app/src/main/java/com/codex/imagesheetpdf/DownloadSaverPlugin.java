package com.codex.imagesheetpdf;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(
    name = "DownloadSaver",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "writeStorage")
    }
)
public class DownloadSaverPlugin extends Plugin {
    private final Map<String, WriteSession> sessions = new HashMap<>();

    @PluginMethod
    public void saveFile(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("writeStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeStorage", call, "storagePermsCallback");
            return;
        }

        writeDownload(call);
    }

    @PluginMethod
    public void beginFile(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("writeStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeStorage", call, "storagePermsCallback");
            return;
        }

        beginWriteSession(call);
    }

    @PluginMethod
    public void beginPickedFile(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("Missing filename.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickedFileCallback");
    }

    @PluginMethod
    public void appendFileChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String base64Data = call.getString("base64Data");

        if (sessionId == null || !sessions.containsKey(sessionId)) {
            call.reject("Unknown file write session.");
            return;
        }

        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing file data chunk.");
            return;
        }

        try {
            WriteSession session = sessions.get(sessionId);
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            session.output.write(bytes);
            JSObject result = new JSObject();
            result.put("bytes", bytes.length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not write file chunk: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void finishFile(PluginCall call) {
        String sessionId = call.getString("sessionId");
        WriteSession session = sessionId == null ? null : sessions.remove(sessionId);

        if (session == null) {
            call.reject("Unknown file write session.");
            return;
        }

        try {
            session.output.close();
            if (session.markPendingComplete) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(session.uri, values, null, null);
            }

            JSObject result = new JSObject();
            result.put("uri", session.uri.toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not finish file: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void abortFile(PluginCall call) {
        String sessionId = call.getString("sessionId");
        WriteSession session = sessionId == null ? null : sessions.remove(sessionId);

        if (session != null) {
            try {
                session.output.close();
                if (session.deleteUriOnAbort) {
                    getContext().getContentResolver().delete(session.uri, null, null);
                } else if (session.file != null && session.file.exists()) {
                    session.file.delete();
                }
            } catch (Exception ignored) {
                // Best-effort cleanup only.
            }
        }

        call.resolve();
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("writeStorage") == PermissionState.GRANTED) {
            if (call.getString("base64Data") == null) {
                beginWriteSession(call);
            } else {
                writeDownload(call);
            }
        } else {
            call.reject("Storage permission is required to save to Downloads.");
        }
    }

    @ActivityCallback
    private void pickedFileCallback(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("File save was cancelled.");
            return;
        }

        beginPickedWriteSession(call, result.getData().getData());
    }

    private void writeDownload(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String base64Data = call.getString("base64Data");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("Missing filename.");
            return;
        }

        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing file data.");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            Uri uri;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                ContentResolver resolver = getContext().getContentResolver();
                uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("Could not create Downloads entry.");
                    return;
                }

                try (OutputStream output = resolver.openOutputStream(uri)) {
                    if (output == null) {
                        call.reject("Could not open Downloads entry.");
                        return;
                    }
                    output.write(bytes);
                }

                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
            } else {
                File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloads.exists() && !downloads.mkdirs()) {
                    call.reject("Could not create Downloads folder.");
                    return;
                }

                File outputFile = uniqueFile(downloads, filename);
                try (OutputStream output = new FileOutputStream(outputFile)) {
                    output.write(bytes);
                }
                uri = Uri.fromFile(outputFile);
            }

            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not save file: " + error.getMessage(), error);
        }
    }

    private void beginWriteSession(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("Missing filename.");
            return;
        }

        try {
            Uri uri;
            OutputStream output;
            File outputFile = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                ContentResolver resolver = getContext().getContentResolver();
                uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("Could not create Downloads entry.");
                    return;
                }

                output = resolver.openOutputStream(uri);
                if (output == null) {
                    call.reject("Could not open Downloads entry.");
                    return;
                }
            } else {
                File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloads.exists() && !downloads.mkdirs()) {
                    call.reject("Could not create Downloads folder.");
                    return;
                }

                outputFile = uniqueFile(downloads, filename);
                output = new FileOutputStream(outputFile);
                uri = Uri.fromFile(outputFile);
            }

            String sessionId = UUID.randomUUID().toString();
            boolean isMediaStoreDownload = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
            sessions.put(sessionId, new WriteSession(uri, output, outputFile, isMediaStoreDownload, isMediaStoreDownload));

            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start file save: " + error.getMessage(), error);
        }
    }

    private void beginPickedWriteSession(PluginCall call, Uri uri) {
        try {
            OutputStream output = getContext().getContentResolver().openOutputStream(uri);
            if (output == null) {
                call.reject("Could not open selected file.");
                return;
            }

            String sessionId = UUID.randomUUID().toString();
            sessions.put(sessionId, new WriteSession(uri, output, null, false, false));

            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start selected file save: " + error.getMessage(), error);
        }
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

    private static class WriteSession {
        final Uri uri;
        final OutputStream output;
        final File file;
        final boolean markPendingComplete;
        final boolean deleteUriOnAbort;

        WriteSession(
            Uri uri,
            OutputStream output,
            File file,
            boolean markPendingComplete,
            boolean deleteUriOnAbort
        ) {
            this.uri = uri;
            this.output = output;
            this.file = file;
            this.markPendingComplete = markPendingComplete;
            this.deleteUriOnAbort = deleteUriOnAbort;
        }
    }
}
