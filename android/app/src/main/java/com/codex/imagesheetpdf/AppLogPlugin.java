package com.codex.imagesheetpdf;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "AppLog",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "writeStorage")
    }
)
public class AppLogPlugin extends Plugin {
    @PluginMethod
    public void appendLog(PluginCall call) {
        String level = call.getString("level", "INFO");
        String message = call.getString("message", "");
        AppLogStore.append(getContext(), level, message);
        call.resolve();
    }

    @PluginMethod
    public void readLog(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("log", AppLogStore.read(getContext()));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read crash log: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void clearLog(PluginCall call) {
        try {
            AppLogStore.clear(getContext());
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not clear crash log: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void saveLog(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("writeStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeStorage", call, "storagePermsCallback");
            return;
        }

        writeLog(call);
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("writeStorage") == PermissionState.GRANTED) {
            writeLog(call);
        } else {
            call.reject("Storage permission is required to save the crash log to Downloads.");
        }
    }

    private void writeLog(PluginCall call) {
        String filename = call.getString("filename", "image-sheet-pdf-crash-log.txt");

        try {
            JSObject result = new JSObject();
            result.put("uri", AppLogStore.saveToDownloads(getContext(), filename).toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not save crash log: " + error.getMessage(), error);
        }
    }
}
