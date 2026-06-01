package com.codex.imagesheetpdf;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AppLogStore.install(this);
        registerPlugin(DownloadSaverPlugin.class);
        registerPlugin(AppLogPlugin.class);
        registerPlugin(NativeStackerPlugin.class);
        registerPlugin(SourceImagesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
