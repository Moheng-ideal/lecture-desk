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
    private static final int PHASE_MS = 3000;
    private static final int SQUEEZE_PHASES = 3;
    private static final int CONTROL = 1;
    private static final int MAX_EVENTS = 48;
    private static final String BINDING_KEY = "penSqueeze";
    private static final long MIN_REPEAT_MS = 220;
    private static final long RECENT_PEN_MS = 15000;
    private final MainActivity activity;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> events = new LinkedHashSet<>();
    private final Map<String, KeySample> keys = new LinkedHashMap<>();
    private int phase = -1;
    private int standardButtonPhases;
    private boolean needsHover;
    private String candidate;
    private String mapping;
    private SharedPreferences preferences;
    private final Runnable advance = this::advancePhase;

    private static final class KeySample {
        int downPhases;
        int upPhases;
        long lastDown = -MIN_REPEAT_MS;
        long lastUp = -MIN_REPEAT_MS;

        void observe(boolean down, int phase, long time) {
            if (down && time - lastDown >= MIN_REPEAT_MS) {
                lastDown = time;
                downPhases |= 1 << phase;
            } else if (!down && time - lastUp >= MIN_REPEAT_MS) {
                lastUp = time;
                upPhases |= 1 << phase;
            }
        }
    }

    PenInputTest(MainActivity activity) { this.activity = activity; }

    void load() {
        preferences = activity.getSharedPreferences("penShortcuts", Context.MODE_PRIVATE);
        mapping = preferences.getString(BINDING_KEY, null);
        if (mapping != null && !mapping.startsWith("up:") && !mapping.startsWith("down:")) mapping = "up:" + mapping;
    }

    private static boolean unknownKey(KeyEvent event) {
        return event.getKeyCode() == KeyEvent.KEYCODE_UNKNOWN
            && (event.getAction() == KeyEvent.ACTION_UP || event.getAction() == KeyEvent.ACTION_DOWN)
            && event.getRepeatCount() == 0 && !event.isCanceled();
    }

    private static String actionPrefix(KeyEvent event) {
        return event.getAction() == KeyEvent.ACTION_DOWN ? "down:" : "up:";
    }

    private static String fingerprint(KeyEvent event) {
        InputDevice device = event.getDevice();
        String descriptor = device == null ? null : device.getDescriptor();
        String identity = descriptor == null || descriptor.isEmpty() ? "device:" + event.getDeviceId() : descriptor;
        return event.getSource() + "/" + event.getScanCode() + "/" + identity;
    }

    private static boolean nearPen(KeyEvent event, long lastPenEvent) {
        if (event.getScanCode() != 0) return true;
        long sincePen = event.getEventTime() - lastPenEvent;
        return lastPenEvent >= 0 && sincePen >= 0 && sincePen <= RECENT_PEN_MS;
    }

    boolean matches(KeyEvent event, long lastPenEvent) {
        return phase < 0 && mapping != null && unknownKey(event) && nearPen(event, lastPenEvent)
            && mapping.equals(actionPrefix(event) + fingerprint(event));
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
        clock.postDelayed(advance, 800);
    }

    void stop() {
        clock.removeCallbacks(advance);
        events.clear();
        keys.clear();
        candidate = null;
        phase = -1;
        standardButtonPhases = 0;
        needsHover = false;
    }

    private void advancePhase() {
        if (++phase > SQUEEZE_PHASES) {
            finishRecording();
            return;
        }
        activity.emit("", "pen-test-step", Integer.toString(phase));
        clock.postDelayed(advance, PHASE_MS);
    }

    private static boolean followsPrompts(int phases) {
        return (phases & CONTROL) == 0 && Integer.bitCount(phases) >= 2;
    }

    private void finishRecording() {
        StringBuilder report = new StringBuilder();
        if (events.isEmpty()) report.append("测试期间没有收到按键、触控或窗口焦点事件。");
        else report.append(String.join("\n", events));
        String match = null;
        int distinctKeys = 0;
        boolean direct = followsPrompts(standardButtonPhases);
        for (Map.Entry<String, KeySample> entry : keys.entrySet()) {
            KeySample key = entry.getValue();
            if (((key.downPhases | key.upPhases) & CONTROL) != 0) continue;
            if (followsPrompts(key.upPhases)) match = "up:" + entry.getKey();
            else if (followsPrompts(key.downPhases)) match = "down:" + entry.getKey();
            else continue;
            distinctKeys++;
        }
        if (needsHover) report.append("\n有零扫描码按键缺少同期触控笔悬停信号。");
        if (distinctKeys > 1) report.append("\n发现多个与提示同步的未知按键。");
        stop();
        if (!direct && distinctKeys == 1) candidate = match;
        String payload = "{\"log\":" + JSONObject.quote(report.toString())
            + ",\"direct\":" + direct + ",\"canBind\":" + (candidate != null) + "}";
        activity.emit("", "pen-test-result", payload);
    }

    private void add(String line) {
        if (events.size() < MAX_EVENTS) events.add((phase == 0 ? "悬停" : "轻捏 " + phase) + " | " + line);
    }

    boolean standardButton() {
        if (phase < 0) return false;
        standardButtonPhases |= 1 << phase;
        add("检测到标准笔身按键");
        return true;
    }

    void key(KeyEvent event, long lastPenEvent) {
        if (phase < 0 || event.getRepeatCount() != 0) return;
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        String action = down ? "DOWN" : event.getAction() == KeyEvent.ACTION_UP ? "UP" : "MULTIPLE";
        add("KEY " + action + " " + KeyEvent.keyCodeToString(event.getKeyCode())
            + " source=0x" + Integer.toHexString(event.getSource()) + " scan=" + event.getScanCode()
            + " device=" + event.getDeviceId());
        if (!unknownKey(event)) return;
        if (phase > 0 && !nearPen(event, lastPenEvent)) {
            needsHover = true;
            return;
        }
        String key = fingerprint(event);
        if (keys.size() < MAX_EVENTS || keys.containsKey(key)) {
            keys.computeIfAbsent(key, ignored -> new KeySample()).observe(down, phase, event.getEventTime());
        }
    }

    void motion(String channel, MotionEvent event) {
        if (phase < 0) return;
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
        if (phase < 0) return false;
        add("BACK callback");
        return true;
    }

    void focus(boolean focused) {
        if (phase >= 0) add(focused ? "FOCUS gained" : "FOCUS lost");
    }
}
