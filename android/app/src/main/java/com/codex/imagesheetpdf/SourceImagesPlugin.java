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

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.UUID;

@CapacitorPlugin(name = "SourceImages")
public class SourceImagesPlugin extends Plugin {
    private static final int DELETE_REQUEST_CODE = 7813;
    private int pendingDeleteCount = 0;
    private ArrayList<SourceFolder> pendingFolders = new ArrayList<>();

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
    public void pickFolderBatch(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderBatchCallback");
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

        ArrayList<SourceTarget> targets = sourceTargets(sourceUris);
        ArrayList<SourceFolder> sourceFolders = sourceFolders(targets);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ArrayList<Uri> mediaUris = new ArrayList<>();
            for (SourceTarget target : targets) {
                if (target.mediaUri != null) {
                    mediaUris.add(target.mediaUri);
                }
            }

            if (!mediaUris.isEmpty()) {
                try {
                    PendingIntent pendingIntent = MediaStore.createDeleteRequest(
                        getContext().getContentResolver(),
                        mediaUris
                    );
                    pendingDeleteCount = mediaUris.size();
                    pendingFolders = sourceFolders;
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
        FolderCleanupResult folders = cleanupEmptyFolders(sourceFolders);
        resolveDelete(call, sourceUris.size(), deleted, false, folders);
    }

    @PluginMethod
    public void deleteFolders(PluginCall call) {
        JSArray input = call.getArray("uris");
        if (input == null || input.length() == 0) {
            resolveFolderDelete(call, 0, 0);
            return;
        }

        int requested = 0;
        int deleted = 0;
        ContentResolver resolver = getContext().getContentResolver();
        for (int index = 0; index < input.length(); index += 1) {
            String value = input.optString(index, "");
            if (value.isEmpty()) {
                continue;
            }

            requested += 1;
            try {
                Uri treeUri = Uri.parse(value);
                String documentId = DocumentsContract.getTreeDocumentId(treeUri);
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
                if (DocumentsContract.deleteDocument(resolver, documentUri)) {
                    deleted += 1;
                }
            } catch (Exception ignored) {
                // Keep going so one protected folder does not block the rest.
            }
        }

        resolveFolderDelete(call, requested, deleted);
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

    @ActivityCallback
    private void pickFolderBatchCallback(PluginCall call, ActivityResult result) {
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
            Uri treeUri = data.getData();
            if (treeUri == null) {
                JSObject output = new JSObject();
                output.put("images", new JSArray());
                call.resolve(output);
                return;
            }

            persistTreePermission(data, treeUri);
            String folderUri = treeUri.toString();
            String rootDocumentId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri rootDocumentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocumentId);
            String folderName = displayName(rootDocumentUri);
            JSArray images = new JSArray();
            collectFolderImages(treeUri, rootDocumentId, folderUri, folderName, images);

            JSObject output = new JSObject();
            output.put("images", images);
            output.put("folderUri", folderUri);
            output.put("folderName", folderName);
            call.resolve(output);
        } catch (Exception error) {
            call.reject("Could not read selected folder: " + error.getMessage(), error);
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
        FolderCleanupResult folders = cancelled ? new FolderCleanupResult() : cleanupEmptyFolders(pendingFolders);
        resolveDelete(call, pendingDeleteCount, cancelled ? 0 : pendingDeleteCount, cancelled, folders);
        pendingDeleteCount = 0;
        pendingFolders = new ArrayList<>();
    }

    private JSObject copyImageForWeb(Uri sourceUri) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String name = displayName(sourceUri);
        String mimeType = resolver.getType(sourceUri);
        return copyImageForWeb(sourceUri, name, mimeType, null, null);
    }

    private JSObject copyImageForWeb(
        Uri sourceUri,
        String sourceName,
        String sourceMimeType,
        String batchFolderUri,
        String batchFolderName
    ) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String name = sourceName == null || sourceName.trim().isEmpty()
            ? "image-" + UUID.randomUUID() + ".jpg"
            : sourceName;
        String mimeType = sourceMimeType == null || sourceMimeType.trim().isEmpty()
            ? resolver.getType(sourceUri)
            : sourceMimeType;
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
        if (batchFolderUri != null) {
            image.put("batchFolderUri", batchFolderUri);
        }
        if (batchFolderName != null) {
            image.put("batchFolderName", batchFolderName);
        }
        return image;
    }

    private void collectFolderImages(
        Uri treeUri,
        String documentId,
        String batchFolderUri,
        String batchFolderName,
        JSArray images
    ) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        ArrayList<FolderDocument> documents = new ArrayList<>();

        try (Cursor cursor = resolver.query(childrenUri, projection, null, null, null)) {
            if (cursor == null) {
                return;
            }

            while (cursor.moveToNext()) {
                String childDocumentId = cursorString(cursor, DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                String name = cursorString(cursor, DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                String mimeType = cursorString(cursor, DocumentsContract.Document.COLUMN_MIME_TYPE);
                if (childDocumentId != null && !childDocumentId.isEmpty()) {
                    documents.add(new FolderDocument(childDocumentId, name, mimeType));
                }
            }
        }

        Collections.sort(documents, (left, right) -> left.name.compareToIgnoreCase(right.name));
        for (FolderDocument document : documents) {
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(document.mimeType)) {
                collectFolderImages(treeUri, document.documentId, batchFolderUri, batchFolderName, images);
                continue;
            }

            if (document.mimeType == null || !document.mimeType.startsWith("image/")) {
                continue;
            }

            Uri imageUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, document.documentId);
            images.put(copyImageForWeb(imageUri, document.name, document.mimeType, batchFolderUri, batchFolderName));
        }
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

    private void persistTreePermission(Intent data, Uri treeUri) {
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (flags == 0) {
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
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

    private ArrayList<SourceTarget> sourceTargets(ArrayList<Uri> sourceUris) {
        ArrayList<SourceTarget> targets = new ArrayList<>();
        for (Uri sourceUri : sourceUris) {
            Uri mediaUri = toMediaStoreUri(sourceUri);
            targets.add(new SourceTarget(sourceUri, mediaUri, folderForSource(sourceUri, mediaUri)));
        }
        return targets;
    }

    private ArrayList<SourceFolder> sourceFolders(ArrayList<SourceTarget> targets) {
        HashMap<String, SourceFolder> folders = new HashMap<>();
        for (SourceTarget target : targets) {
            if (target.folder != null && !folders.containsKey(target.folder.key)) {
                folders.put(target.folder.key, target.folder);
            }
        }
        return new ArrayList<>(folders.values());
    }

    private SourceFolder folderForSource(Uri sourceUri, Uri mediaUri) {
        SourceFolder documentFolder = documentFolder(sourceUri);
        if (documentFolder != null) {
            return documentFolder;
        }

        if (mediaUri != null) {
            SourceFolder mediaFolder = mediaFolder(mediaUri);
            if (mediaFolder != null) {
                return mediaFolder;
            }
        }

        return null;
    }

    private SourceFolder documentFolder(Uri sourceUri) {
        if (!DocumentsContract.isDocumentUri(getContext(), sourceUri)) {
            return null;
        }

        String authority = sourceUri.getAuthority();
        if (!"com.android.externalstorage.documents".equals(authority)) {
            return null;
        }

        String documentId = DocumentsContract.getDocumentId(sourceUri);
        int slash = documentId.lastIndexOf('/');
        if (slash <= 0) {
            return null;
        }

        String parentDocumentId = documentId.substring(0, slash);
        Uri parentUri = DocumentsContract.buildDocumentUri(authority, parentDocumentId);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUri(authority, parentDocumentId);
        return SourceFolder.forDocument(parentDocumentId, parentUri, childrenUri);
    }

    private SourceFolder mediaFolder(Uri mediaUri) {
        String[] projection = {
            MediaStore.Images.Media.BUCKET_ID,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
            MediaStore.Images.Media.DATA
        };

        try (Cursor cursor = getContext().getContentResolver().query(mediaUri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) {
                return null;
            }

            String bucketId = cursorString(cursor, MediaStore.Images.Media.BUCKET_ID);
            if (bucketId == null || bucketId.isEmpty()) {
                return null;
            }

            String bucketName = cursorString(cursor, MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
            String dataPath = cursorString(cursor, MediaStore.Images.Media.DATA);
            String folderPath = null;
            if (dataPath != null && !dataPath.isEmpty()) {
                File parent = new File(dataPath).getParentFile();
                if (parent != null) {
                    folderPath = parent.getAbsolutePath();
                }
            }

            return SourceFolder.forMedia(bucketId, bucketName, folderPath);
        } catch (Exception ignored) {
            return null;
        }
    }

    private FolderCleanupResult cleanupEmptyFolders(ArrayList<SourceFolder> folders) {
        FolderCleanupResult result = new FolderCleanupResult();
        for (SourceFolder folder : folders) {
            if (!folderIsEmpty(folder)) {
                continue;
            }

            result.empty += 1;
            if (deleteFolder(folder)) {
                result.deleted += 1;
            }
        }
        return result;
    }

    private boolean folderIsEmpty(SourceFolder folder) {
        if (folder.kind == SourceFolder.Kind.DOCUMENT) {
            return documentFolderIsEmpty(folder.childrenUri);
        }

        return mediaFolderImageCount(folder.bucketId) == 0;
    }

    private boolean documentFolderIsEmpty(Uri childrenUri) {
        try (Cursor cursor = getContext().getContentResolver().query(childrenUri, null, null, null, null)) {
            return cursor == null || !cursor.moveToFirst();
        } catch (Exception ignored) {
            return false;
        }
    }

    private int mediaFolderImageCount(String bucketId) {
        try (
            Cursor cursor = getContext().getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[] { MediaStore.Images.Media._ID },
                MediaStore.Images.Media.BUCKET_ID + "=?",
                new String[] { bucketId },
                null
            )
        ) {
            return cursor == null ? -1 : cursor.getCount();
        } catch (Exception ignored) {
            return -1;
        }
    }

    private boolean deleteFolder(SourceFolder folder) {
        if (folder.kind == SourceFolder.Kind.DOCUMENT) {
            try {
                return DocumentsContract.deleteDocument(getContext().getContentResolver(), folder.documentUri);
            } catch (Exception ignored) {
                return false;
            }
        }

        if (folder.folderPath == null || folder.folderPath.isEmpty()) {
            return false;
        }

        File directory = new File(folder.folderPath);
        if (!isSafeFolderDeleteCandidate(directory)) {
            return false;
        }

        File[] children = directory.listFiles();
        if (children != null && children.length > 0) {
            return false;
        }

        return directory.delete();
    }

    private boolean isSafeFolderDeleteCandidate(File directory) {
        if (!directory.exists() || !directory.isDirectory()) {
            return false;
        }

        String name = directory.getName();
        if (
            "DCIM".equalsIgnoreCase(name) ||
            "Camera".equalsIgnoreCase(name) ||
            "Pictures".equalsIgnoreCase(name) ||
            "Download".equalsIgnoreCase(name) ||
            "Downloads".equalsIgnoreCase(name)
        ) {
            return false;
        }

        File parent = directory.getParentFile();
        return parent != null && parent.getParentFile() != null;
    }

    private String cursorString(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        if (index < 0) {
            return null;
        }
        return cursor.getString(index);
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
        resolveDelete(call, requested, deleted, cancelled, new FolderCleanupResult());
    }

    private void resolveDelete(
        PluginCall call,
        int requested,
        int deleted,
        boolean cancelled,
        FolderCleanupResult folders
    ) {
        JSObject output = new JSObject();
        output.put("requested", requested);
        output.put("deleted", deleted);
        output.put("cancelled", cancelled);
        output.put("foldersEmpty", folders.empty);
        output.put("foldersDeleted", folders.deleted);
        call.resolve(output);
    }

    private void resolveFolderDelete(PluginCall call, int requested, int deleted) {
        JSObject output = new JSObject();
        output.put("requested", requested);
        output.put("deleted", deleted);
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

    private static class FolderDocument {
        final String documentId;
        final String name;
        final String mimeType;

        FolderDocument(String documentId, String name, String mimeType) {
            this.documentId = documentId;
            this.name = name == null || name.trim().isEmpty() ? documentId : name;
            this.mimeType = mimeType;
        }
    }

    private static class SourceTarget {
        final Uri sourceUri;
        final Uri mediaUri;
        final SourceFolder folder;

        SourceTarget(Uri sourceUri, Uri mediaUri, SourceFolder folder) {
            this.sourceUri = sourceUri;
            this.mediaUri = mediaUri;
            this.folder = folder;
        }
    }

    private static class SourceFolder {
        enum Kind {
            DOCUMENT,
            MEDIA
        }

        final Kind kind;
        final String key;
        final String bucketId;
        final String folderPath;
        final Uri documentUri;
        final Uri childrenUri;

        private SourceFolder(
            Kind kind,
            String key,
            String bucketId,
            String folderPath,
            Uri documentUri,
            Uri childrenUri
        ) {
            this.kind = kind;
            this.key = key;
            this.bucketId = bucketId;
            this.folderPath = folderPath;
            this.documentUri = documentUri;
            this.childrenUri = childrenUri;
        }

        static SourceFolder forDocument(String documentId, Uri documentUri, Uri childrenUri) {
            return new SourceFolder(
                Kind.DOCUMENT,
                "document:" + documentId,
                null,
                null,
                documentUri,
                childrenUri
            );
        }

        static SourceFolder forMedia(String bucketId, String bucketName, String folderPath) {
            return new SourceFolder(
                Kind.MEDIA,
                "media:" + bucketId + ":" + (bucketName == null ? "" : bucketName),
                bucketId,
                folderPath,
                null,
                null
            );
        }
    }

    private static class FolderCleanupResult {
        int empty = 0;
        int deleted = 0;
    }
}
