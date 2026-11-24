package cn.lecturedesk.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import org.json.JSONObject;

final class PenInputTest {
    private static final int CAPTURE_MS = 12000;
    private static final int MAX_EVENTS = 24;
    private static final String BINDING_KEY = "penSqueeze";
    private static final long MIN_REPEAT_MS = 220;
    private static final long RECENT_PEN_MS = 15000;
    private final MainActivity activity;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> events = new LinkedHashSet<>();
    private final Map<String, ReleaseSample> releases = new LinkedHashMap<>();
    private boolean recording;
    private String candidate;
    private String mapping;
    private SharedPreferences preferences;
    private final Runnable begin = this::beginRecording;
    private final Runnable finish = this::finishRecording;

    private static final class ReleaseSample {
        long lastTime = -MIN_REPEAT_MS;
        int count;
    }

    PenInputTest(MainActivity activity) { this.activity = activity; }

    void load() {
        preferences = activity.getSharedPreferences("penShortcuts", Context.MODE_PRIVATE);
        mapping = preferences.getString(BINDING_KEY, null);
    }

    private static boolean unknownRelease(KeyEvent event) {
        return event.getKeyCode() == KeyEvent.KEYCODE_UNKNOWN && event.getAction() == KeyEvent.ACTION_UP
            && event.getRepeatCount() == 0 && !event.isCanceled();
    }

    private static String fingerprint(KeyEvent event) {
        InputDevice device = event.getDevice();
        String descriptor = device == null ? null : device.getDescriptor();
        String identity = descriptor == null || descriptor.isEmpty() ? "device:" + event.getDeviceId() : descriptor;
        return event.getSource() + "/" + event.getScanCode() + "/" + identity;
    }

    boolean matches(KeyEvent event, long lastPenEvent) {
        if (recording || mapping == null || !unknownRelease(event)) return false;
        long sincePen = event.getEventTime() - lastPenEvent;
        if (event.getScanCode() == 0 && (lastPenEvent < 0 || sincePen < 0 || sincePen > RECENT_PEN_MS)) return false;
        return mapping.equals(fingerprint(event));
    }

    void bind() {
        if (candidate == null) {
            activity.emit("", "pen-test-binding", "请重新校准后再绑定。");
            return;
        }
        mapping = candidate;
        preferences.edit().putString(BINDING_KEY, mapping).apply();
        candidate = null;
        activity.emit("", "pen-test-binding", "轻捏快捷键已保存。关闭设置后试一下。");
    }

    void clearBinding() {
        stop();
        mapping = null;
        preferences.edit().remove(BINDING_KEY).apply();
        activity.emit("", "pen-test-binding", "已清除轻捏绑定。");
    }

    void start() {
        stop();
        clock.postDelayed(begin, 800);
    }

    void stop() {
        clock.removeCallbacks(begin);
        clock.removeCallbacks(finish);
        events.clear();
        releases.clear();
        candidate = null;
        recording = false;
    }

    private void beginRecording() {
        recording = true;
        activity.emit("", "pen-test-ready", "");
        clock.postDelayed(finish, CAPTURE_MS);
    }

    private void finishRecording() {
        String report = events.isEmpty()
            ? "测试期间没有收到按键、触控或窗口焦点事件。"
            : String.join("\n", events);
        String match = null;
        int repeatedKeys = 0;
        for (Map.Entry<String, ReleaseSample> entry : releases.entrySet()) {
            if (entry.getValue().count < 2) continue;
            repeatedKeys++;
            match = entry.getKey();
        }
        stop();
        if (repeatedKeys == 1) candidate = match;
        String payload = "{\"log\":" + JSONObject.quote(report) + ",\"canBind\":" + (candidate != null) + "}";
        activity.emit("", "pen-test-result", payload);
    }

    private void add(String line) {
        if (events.size() < MAX_EVENTS) events.add(line);
    }

    void key(KeyEvent event) {
        if (!recording || event.getRepeatCount() != 0) return;
        String action = event.getAction() == KeyEvent.ACTION_DOWN ? "DOWN" : "UP";
        add("KEY " + action + " " + KeyEvent.keyCodeToString(event.getKeyCode())
            + " source=0x" + Integer.toHexString(event.getSource()) + " scan=" + event.getScanCode()
            + " device=" + event.getDeviceId());
        if (!unknownRelease(event)) return;
        String key = fingerprint(event);
        ReleaseSample sample = releases.get(key);
        if (sample == null && releases.size() < MAX_EVENTS) {
            sample = new ReleaseSample();
            releases.put(key, sample);
        }
        if (sample != null && event.getEventTime() - sample.lastTime >= MIN_REPEAT_MS) {
            sample.lastTime = event.getEventTime();
            sample.count++;
        }
    }

    void motion(String channel, MotionEvent event) {
        if (!recording) return;
        int action = event.getActionMasked();
        int changedButton = action == MotionEvent.ACTION_BUTTON_PRESS || action == MotionEvent.ACTION_BUTTON_RELEASE
            ? event.getActionButton() : 0;
        int tool = event.getPointerCount() > 0 ? event.getToolType(0) : MotionEvent.TOOL_TYPE_UNKNOWN;
        add(channel + " " + MotionEvent.actionToString(action)
            + " tool=" + tool + " source=0x" + Integer.toHexString(event.getSource())
            + " buttons=0x" + Integer.toHexString(event.getButtonState())
            + " actionButton=0x" + Integer.toHexString(changedButton));
    }

    boolean back() {
        if (!recording) return false;
        add("BACK callback");
        return true;
    }

    void focus(boolean focused) {
        if (recording) add(focused ? "FOCUS gained" : "FOCUS lost");
    }
}
