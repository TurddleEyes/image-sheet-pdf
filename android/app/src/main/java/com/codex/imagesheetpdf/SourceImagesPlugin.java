package com.codex.imagesheetpdf;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.IntentSender;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

@CapacitorPlugin(name = "SourceImages")
public class SourceImagesPlugin extends Plugin {
    private static final int DELETE_REQUEST_CODE = 7813;
    private int pendingDeleteCount = 0;

    @PluginMethod
    public void pickImages(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickImagesCallback");
    }

    @PluginMethod
    public void deleteImages(PluginCall call) {
        JSArray input = call.getArray("uris");
        if (input == null || input.length() == 0) {
            resolveDelete(call, 0, 0, false);
            return;
        }

        ArrayList<Uri> sourceUris = new ArrayList<>();
        for (int index = 0; index < input.length(); index += 1) {
            String value = input.optString(index, "");
            if (!value.isEmpty()) {
                sourceUris.add(Uri.parse(value));
            }
        }

        if (sourceUris.isEmpty()) {
            resolveDelete(call, 0, 0, false);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ArrayList<Uri> mediaUris = new ArrayList<>();
            for (Uri sourceUri : sourceUris) {
                Uri mediaUri = toMediaStoreUri(sourceUri);
                if (mediaUri != null) {
                    mediaUris.add(mediaUri);
                }
            }

            if (!mediaUris.isEmpty()) {
                try {
                    PendingIntent pendingIntent = MediaStore.createDeleteRequest(
                        getContext().getContentResolver(),
                        mediaUris
                    );
                    pendingDeleteCount = mediaUris.size();
                    saveCall(call);
                    getActivity().startIntentSenderForResult(
                        pendingIntent.getIntentSender(),
                        DELETE_REQUEST_CODE,
                        null,
                        0,
                        0,
                        0
                    );
                    return;
                } catch (IntentSender.SendIntentException error) {
                    call.reject("Could not start Android delete request: " + error.getMessage(), error);
                    return;
                } catch (Exception error) {
                    // Fall through to direct document deletion below.
                }
            }
        }

        int deleted = deleteDocumentsDirectly(sourceUris);
        resolveDelete(call, sourceUris.size(), deleted, false);
    }

    @ActivityCallback
    private void pickImagesCallback(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject output = new JSObject();
            output.put("images", new JSArray());
            call.resolve(output);
            return;
        }

        try {
            Intent data = result.getData();
            ArrayList<Uri> uris = new ArrayList<>();
            ClipData clipData = data.getClipData();
            if (clipData != null) {
                for (int index = 0; index < clipData.getItemCount(); index += 1) {
                    uris.add(clipData.getItemAt(index).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }

            JSArray images = new JSArray();
            for (Uri uri : uris) {
                persistUriPermission(data, uri);
                images.put(copyImageForWeb(uri));
            }

            JSObject output = new JSObject();
            output.put("images", images);
            call.resolve(output);
        } catch (Exception error) {
            call.reject("Could not read selected images: " + error.getMessage(), error);
        }
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != DELETE_REQUEST_CODE) {
            return;
        }

        PluginCall call = getSavedCall();
        if (call == null) {
            return;
        }

        boolean cancelled = resultCode != Activity.RESULT_OK;
        resolveDelete(call, pendingDeleteCount, cancelled ? 0 : pendingDeleteCount, cancelled);
        pendingDeleteCount = 0;
    }

    private JSObject copyImageForWeb(Uri sourceUri) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String name = displayName(sourceUri);
        String mimeType = resolver.getType(sourceUri);
        File directory = new File(getContext().getCacheDir(), "source-images");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Could not create source image cache.");
        }

        File outputFile = uniqueFile(directory, sanitizeName(name));
        try (
            InputStream input = resolver.openInputStream(sourceUri);
            OutputStream output = new FileOutputStream(outputFile)
        ) {
            if (input == null) {
                throw new IllegalStateException("Could not open selected image.");
            }

            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }

        JSObject image = new JSObject();
        image.put("id", UUID.randomUUID().toString());
        image.put("name", name);
        image.put("mimeType", mimeType == null ? "image/jpeg" : mimeType);
        image.put("size", outputFile.length());
        image.put("fileUri", Uri.fromFile(outputFile).toString());
        image.put("sourceUri", sourceUri.toString());
        return image;
    }

    private void persistUriPermission(Intent data, Uri uri) {
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (flags == 0) {
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (Exception ignored) {
            // Some providers do not offer persistable permissions.
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameColumn >= 0) {
                    String value = cursor.getString(nameColumn);
                    if (value != null && !value.trim().isEmpty()) {
                        return value;
                    }
                }
            }
        } catch (Exception ignored) {
            // Fall back to a generated name.
        }

        return "image-" + UUID.randomUUID() + ".jpg";
    }

    private Uri toMediaStoreUri(Uri sourceUri) {
        if ("media".equals(sourceUri.getAuthority())) {
            return sourceUri;
        }

        if (!DocumentsContract.isDocumentUri(getContext(), sourceUri)) {
            return sourceUri;
        }

        String authority = sourceUri.getAuthority();
        if (!"com.android.providers.media.documents".equals(authority)) {
            return null;
        }

        String documentId = DocumentsContract.getDocumentId(sourceUri);
        String[] parts = documentId.split(":");
        if (parts.length != 2 || !"image".equals(parts[0])) {
            return null;
        }

        try {
            long id = Long.parseLong(parts[1]);
            return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private int deleteDocumentsDirectly(ArrayList<Uri> uris) {
        int deleted = 0;
        for (Uri uri : uris) {
            try {
                if (DocumentsContract.isDocumentUri(getContext(), uri)) {
                    if (DocumentsContract.deleteDocument(getContext().getContentResolver(), uri)) {
                        deleted += 1;
                    }
                } else if (getContext().getContentResolver().delete(uri, null, null) > 0) {
                    deleted += 1;
                }
            } catch (Exception ignored) {
                // Keep going so one protected/cloud image does not block the rest.
            }
        }
        return deleted;
    }

    private void resolveDelete(PluginCall call, int requested, int deleted, boolean cancelled) {
        JSObject output = new JSObject();
        output.put("requested", requested);
        output.put("deleted", deleted);
        output.put("cancelled", cancelled);
        call.resolve(output);
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

    private String sanitizeName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (cleaned.isEmpty()) {
            return "image-" + UUID.randomUUID() + ".jpg";
        }
        return cleaned;
    }
}
