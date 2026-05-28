package com.codex.imagesheetpdf;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DownloadSaverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
