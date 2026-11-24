package cn.lecturedesk.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import java.io.OutputStream;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int PICK_BOOK = 487;
    private static final String[] BOOK_MIME_TYPES = {
        "application/pdf", "application/msword", "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    };
    private static final int SAVE_FILE = 488;
    private static final String PEN_DOUBLE_TAP = "com.huawei.stylus.action.BUTTON_DOUBLE_PRESSED";
    private final ExecutorService disk = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> picker;
    private volatile SaveJob saveJob;
    private volatile boolean destroyed;
    private volatile float contactPressure = -1;
    private volatile long contactTime;
    private long lastPenShortcut = -500;
    private boolean penReceiverRegistered;
    private long lastPenEvent = -1;
    private WebView view;
    private DeskNetwork network;
    private DeskSpeech speech;
    private DeskUpdater updater;
    private final PenInputTest penTest = new PenInputTest(this);
    private final BroadcastReceiver penReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (PEN_DOUBLE_TAP.equals(intent.getAction()) && hasWindowFocus() && !penTest.doubleTapBroadcast()) {
                openPenShortcuts(null);
            }
        }
    };

    private static class SaveJob {
        final String id;
        final String data;
        SaveJob(String id, String data) { this.id = id; this.data = data; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(44, 58, 49));
        getWindow().setNavigationBarColor(Color.rgb(44, 58, 49));
        network = new DeskNetwork(this);
        speech = new DeskSpeech(this);
        updater = new DeskUpdater(this);
        penTest.load();
        view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.setWebViewClient(new DeskAssets(getAssets()));
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picker != null) picker.onReceiveValue(null);
                picker = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, BOOK_MIME_TYPES)
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, PICK_BOOK); }
                catch (ActivityNotFoundException error) { selectedBooks(null); }
                return true;
            }
        });
        view.addJavascriptInterface(new DeskBridge(), "LectureDeskNative");
        setContentView(view);
        view.loadUrl(DeskAssets.ORIGIN + "/");
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        observePen("TOUCH", event);
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
            int index = event.getActionIndex();
            int tool = event.getToolType(index);
            contactPressure = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER
                ? Math.max(0, Math.min(1, event.getPressure(index))) : -1;
            contactTime = SystemClock.uptimeMillis();
        }
        return super.dispatchTouchEvent(event);
    }

    @Override public boolean dispatchGenericMotionEvent(MotionEvent event) {
        observePen("MOTION", event);
        return super.dispatchGenericMotionEvent(event);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        penTest.key(event, lastPenEvent);
        if (penTest.matches(event, lastPenEvent)) {
            openPenShortcuts(event.getDevice());
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        penTest.focus(focused);
        if (focused && !destroyed) registerPenReceiver();
        else unregisterPenReceiver();
    }

    private void registerPenReceiver() {
        if (penReceiverRegistered) return;
        IntentFilter filter = new IntentFilter(PEN_DOUBLE_TAP);
        try {
            // The OEM broadcast comes from outside this app, so use a focus-scoped receiver.
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(penReceiver, filter, Context.RECEIVER_EXPORTED);
            else registerReceiver(penReceiver, filter);
            penReceiverRegistered = true;
        } catch (SecurityException ignored) {
            // A compatibility container may disallow the broadcast; calibrated key events still work.
        }
    }

    private void unregisterPenReceiver() {
        if (!penReceiverRegistered) return;
        penReceiverRegistered = false;
        unregisterReceiver(penReceiver);
    }

    private void observePen(String channel, MotionEvent event) {
        penTest.motion(channel, event);
        int tool = event.getPointerCount() > 0 ? event.getToolType(0) : MotionEvent.TOOL_TYPE_UNKNOWN;
        if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
            lastPenEvent = event.getEventTime();
        }
    }

    private void openPenShortcuts(InputDevice pen) {
        if (destroyed || !hasWindowFocus()) return;
        long now = SystemClock.uptimeMillis();
        // One pen gesture can arrive both as a broadcast and a key event.
        if (now - lastPenShortcut < 180) return;
        lastPenShortcut = now;
        emit("", "pen-shortcut", "");
        if (pen == null || pen.isVirtual() || !pen.supportsSource(InputDevice.SOURCE_STYLUS)
            || pen.supportsSource(InputDevice.SOURCE_TOUCHSCREEN)) return;
        // Only address the pen's own motor, if Android exposes it as a physical input device.
        try {
            Vibrator motor = pen.getVibrator();
            if (motor.hasVibrator()) motor.vibrate(VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (RuntimeException ignored) {
            // The menu still opens with the pen's built-in feedback on supported hardware.
        }
    }

    void emit(String id, String kind, String value) {
        String json = "{\"id\":" + JSONObject.quote(id) + ",\"kind\":" + JSONObject.quote(kind) +
            ",\"value\":" + JSONObject.quote(value) + "}";
        runOnUiThread(() -> {
            if (!destroyed && DeskAssets.isLocal(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) {
                view.evaluateJavascript("window.dispatchEvent(new CustomEvent('lecture-desk-native',{detail:" + json + "}));", null);
            }
        });
    }

    private void selectedBooks(Uri[] files) {
        ValueCallback<Uri[]> callback = picker;
        picker = null;
        if (callback != null) callback.onReceiveValue(files);
    }

    private static Uri[] pickedBookUris(Intent data) {
        if (data == null) return null;
        LinkedHashSet<Uri> files = new LinkedHashSet<>();
        ClipData selection = data.getClipData();
        if (selection != null) {
            for (int index = 0; index < selection.getItemCount(); index++) {
                Uri file = selection.getItemAt(index).getUri();
                if (file != null) files.add(file);
            }
        }
        if (data.getData() != null) files.add(data.getData());
        return files.isEmpty() ? null : files.toArray(new Uri[0]);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == DeskUpdater.ALLOW_INSTALL || request == DeskUpdater.INSTALL_UPDATE) {
            updater.onResult(request);
            return;
        }
        if (request == PICK_BOOK) {
            selectedBooks(result == RESULT_OK ? pickedBookUris(data) : null);
            return;
        }
        if (request != SAVE_FILE || saveJob == null) return;
        Uri file = result == RESULT_OK && data != null ? data.getData() : null;
        SaveJob job = saveJob;
        if (file == null) {
            saveJob = null;
            emit(job.id, "cancelled", "");
            return;
        }
        disk.execute(() -> {
            String event = "error";
            try (OutputStream out = getContentResolver().openOutputStream(file, "wt")) {
                if (out != null) {
                    out.write(Base64.decode(job.data, Base64.DEFAULT));
                    out.flush();
                    event = "saved";
                }
            } catch (Exception error) { event = "error"; }
            finally { saveJob = null; }
            emit(job.id, event, "");
        });
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == DeskSpeech.MICROPHONE_REQUEST) {
            speech.permissionResult(grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED);
        }
    }

    @Override public void onBackPressed() {
        if (penTest.back()) return;
        view.evaluateJavascript("(function(){const dialog=document.querySelector('dialog[open]');" +
            "if(dialog){dialog.close();return true;}const palette=document.querySelector('#pen-shortcuts:not([hidden]):not([inert])');" +
            "if(palette){document.getElementById('pen-shortcuts-open').click();return true;}const board=document.querySelector('#class-board:not([hidden])');" +
            "if(board){document.getElementById('board-close').click();return true;}const full=document.querySelector('#book-fullscreen[aria-pressed=true]');" +
            "if(full){full.click();return true;}return false;})()", handled -> {
                if (!"true".equals(handled)) moveTaskToBack(true);
            });
    }

    @Override protected void onStop() {
        unregisterPenReceiver();
        speech.stopCapture();
        super.onStop();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        unregisterPenReceiver();
        selectedBooks(null);
        network.close();
        speech.close();
        updater.close();
        penTest.stop();
        disk.shutdown();
        setContentView(new android.widget.FrameLayout(this));
        view.destroy();
        super.onDestroy();
    }

    private final class DeskBridge {
        private final DeskCredentials credentials = new DeskCredentials(MainActivity.this);

        @JavascriptInterface public void startPenInputTest() {
            runOnUiThread(() -> { if (!destroyed) penTest.start(); });
        }

        @JavascriptInterface public void stopPenInputTest() {
            runOnUiThread(() -> penTest.stop());
        }

        @JavascriptInterface public void bindLearnedDoubleTap() {
            runOnUiThread(() -> { if (!destroyed) penTest.bind(); });
        }

        @JavascriptInterface public void clearLearnedDoubleTap() {
            runOnUiThread(() -> { if (!destroyed) penTest.clearBinding(); });
        }

        @JavascriptInterface public void checkForUpdate() {
            runOnUiThread(() -> { if (!destroyed) updater.check(); });
        }

        @JavascriptInterface public String readDeepSeekKey() { return credentials.read(); }
        @JavascriptInterface public boolean saveDeepSeekKey(String value) { return credentials.save(value); }

        @JavascriptInterface public float penAtContact() {
            return SystemClock.uptimeMillis() - contactTime <= 240 ? contactPressure : -1;
        }

        @JavascriptInterface public boolean startHttp(String id, String url, String body, String auth, String type) {
            return !destroyed && network.start(id, url, body, auth, type);
        }
        @JavascriptInterface public void cancelHttp(String id) { network.cancel(id); }

        @JavascriptInterface public synchronized boolean saveDocument(String id, String name, String data) {
            if (destroyed || saveJob != null || id == null || !DeskNetwork.ID.matcher(id).matches() ||
                name == null || name.length() > 240 || !name.matches("[^<>:\"/\\\\|?*\\p{Cntrl}]+\\.(pdf|docx)") ||
                data == null || data.isEmpty() || data.length() > 139_810_136) return false;
            saveJob = new SaveJob(id, data);
            runOnUiThread(() -> {
                String type = name.endsWith(".pdf") ? "application/pdf"
                    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(type).putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(intent, SAVE_FILE); }
                catch (ActivityNotFoundException error) { saveJob = null; emit(id, "error", ""); }
            });
            return true;
        }
        @JavascriptInterface public void openLink(String url) {
            if (url == null || url.length() > 2000) return;
            Uri uri = Uri.parse(url);
            if ("https".equals(uri.getScheme()) && uri.getHost() != null && !DeskAssets.isLocal(uri)) {
                runOnUiThread(() -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) {}
                });
            }
        }
        @JavascriptInterface public boolean startCloudVoice(String request, String key) { return !destroyed && speech.start(request, key); }
        @JavascriptInterface public void finishVoice(String request) { runOnUiThread(() -> speech.finish(request)); }
        @JavascriptInterface public void cancelVoice(String request) { runOnUiThread(() -> speech.cancel(request)); }
    }
}
