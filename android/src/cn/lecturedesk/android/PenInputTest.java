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
    private static final int LAST_PHASE = 4;
    private static final int CONTROL_PHASES = 0b11;
    private static final int MAX_EVENTS = 48;
    private static final int HUAWEI_PEN_KEY = 718;
    private static final int HUAWEI_PEN_SCAN = 190;
    private static final String BINDING_KEY = "penDoubleTap";
    private static final long MIN_REPEAT_MS = 220;
    private static final long RECENT_PEN_MS = 15000;
    private final MainActivity activity;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> events = new LinkedHashSet<>();
    private final Map<String, KeyLog> keyEvents = new LinkedHashMap<>();
    private final Map<String, KeySample> keys = new LinkedHashMap<>();
    private int phase = -1;
    private int doubleTapPhases;
    private boolean needsHover;
    private boolean overlapsSqueeze;
    private String candidate;
    private String mapping;
    private String previousSqueeze;
    private SharedPreferences preferences;
    private final Runnable advance = this::advancePhase;

    private static final class KeyLog {
        int count;
        long lastTime;
        final StringBuilder intervals = new StringBuilder();

        void observe(long time) {
            if (count > 0 && count <= 6) {
                if (count > 1) intervals.append(", ");
                intervals.append(time - lastTime);
            }
            lastTime = time;
            count++;
        }
    }

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
        previousSqueeze = preferences.getString("penSqueeze", "");
        if (previousSqueeze.startsWith("up:")) previousSqueeze = previousSqueeze.substring(3);
        else if (previousSqueeze.startsWith("down:")) previousSqueeze = previousSqueeze.substring(5);
    }

    private static boolean learnableKey(KeyEvent event) {
        int code = event.getKeyCode();
        boolean huaweiPen = code == HUAWEI_PEN_KEY && event.getScanCode() == HUAWEI_PEN_SCAN
            && event.getSource() == InputDevice.SOURCE_KEYBOARD;
        boolean stylusKey = huaweiPen || code == KeyEvent.KEYCODE_UNKNOWN || code == KeyEvent.KEYCODE_STYLUS_BUTTON_PRIMARY
            || code == KeyEvent.KEYCODE_STYLUS_BUTTON_SECONDARY || code == KeyEvent.KEYCODE_STYLUS_BUTTON_TERTIARY;
        return stylusKey && (event.getAction() == KeyEvent.ACTION_UP || event.getAction() == KeyEvent.ACTION_DOWN)
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
        return phase < 0 && mapping != null && learnableKey(event) && nearPen(event, lastPenEvent)
            && mapping.equals(actionPrefix(event) + event.getKeyCode() + "/" + fingerprint(event));
    }

    void bind() {
        if (candidate == null) {
            activity.emit("", "pen-test-binding", "请重新校准后再绑定。");
            return;
        }
        mapping = candidate;
        preferences.edit().putString(BINDING_KEY, mapping).apply();
        candidate = null;
        activity.emit("", "pen-test-binding", "双击快捷键已保存。关闭设置后双击笔身虚拟键。");
    }

    void clearBinding() {
        stop();
        mapping = null;
        preferences.edit().remove(BINDING_KEY).apply();
        activity.emit("", "pen-test-binding", "已清除双击绑定。");
    }

    void start() {
        stop();
        clock.postDelayed(advance, 800);
    }

    void stop() {
        clock.removeCallbacks(advance);
        events.clear();
        keyEvents.clear();
        keys.clear();
        candidate = null;
        phase = -1;
        doubleTapPhases = 0;
        needsHover = false;
        overlapsSqueeze = false;
    }

    private void advancePhase() {
        if (++phase > LAST_PHASE) {
            finishRecording();
            return;
        }
        activity.emit("", "pen-test-step", Integer.toString(phase));
        clock.postDelayed(advance, phase == 1 ? 5000 : PHASE_MS);
    }

    private static boolean followsPrompts(int phases) {
        return (phases & CONTROL_PHASES) == 0 && Integer.bitCount(phases) >= 2;
    }

    private void finishRecording() {
        StringBuilder report = new StringBuilder();
        if (events.isEmpty() && keyEvents.isEmpty()) report.append("测试期间没有收到按键、触控或窗口焦点事件。");
        for (Map.Entry<String, KeyLog> entry : keyEvents.entrySet()) {
            KeyLog log = entry.getValue();
            report.append(entry.getKey()).append(" ×").append(log.count);
            if (log.intervals.length() > 0) report.append("，间隔 ").append(log.intervals).append(" ms");
            if (log.count > 7) report.append("…");
            report.append('\n');
        }
        if (!events.isEmpty()) report.append(String.join("\n", events));
        String match = null;
        int distinctKeys = 0;
        boolean direct = followsPrompts(doubleTapPhases);
        boolean sharedSignal = overlapsSqueeze;
        for (Map.Entry<String, KeySample> entry : keys.entrySet()) {
            KeySample key = entry.getValue();
            int phases = key.downPhases | key.upPhases;
            if ((phases & CONTROL_PHASES) != 0) {
                sharedSignal |= (phases & ~CONTROL_PHASES) != 0;
                continue;
            }
            if (followsPrompts(key.upPhases)) match = "up:" + entry.getKey();
            else if (followsPrompts(key.downPhases)) match = "down:" + entry.getKey();
            else continue;
            distinctKeys++;
        }
        if (needsHover) report.append("\n有零扫描码按键缺少同期触控笔悬停信号。");
        if (overlapsSqueeze) report.append("\n双击阶段有按键与上次保存的轻捏信号相同。");
        if (distinctKeys > 1) report.append("\n发现多个与双击提示同步的按键信号。");
        stop();
        if (!direct && distinctKeys == 1) candidate = match;
        String payload = "{\"log\":" + JSONObject.quote(report.toString())
            + ",\"direct\":" + direct + ",\"sharedSignal\":" + sharedSignal + ",\"canBind\":" + (candidate != null) + "}";
        activity.emit("", "pen-test-result", payload);
    }

    private String phaseLabel() {
        return phase == 0 ? "悬停" : phase == 1 ? "轻捏对照" : "双击 " + (phase - 1);
    }

    private void add(String line) {
        if (events.size() < MAX_EVENTS) events.add(phaseLabel() + " | " + line);
    }

    boolean doubleTapBroadcast() {
        if (phase < 0) return false;
        doubleTapPhases |= 1 << phase;
        add("收到华为笔身双击广播");
        return true;
    }

    void key(KeyEvent event, long lastPenEvent) {
        if (phase < 0 || event.getRepeatCount() != 0) return;
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        String action = down ? "DOWN" : event.getAction() == KeyEvent.ACTION_UP ? "UP" : "MULTIPLE";
        String label = phaseLabel() + " | KEY " + action + " " + KeyEvent.keyCodeToString(event.getKeyCode())
            + " source=0x" + Integer.toHexString(event.getSource()) + " scan=" + event.getScanCode()
            + " device=" + event.getDeviceId();
        if (keyEvents.size() < MAX_EVENTS || keyEvents.containsKey(label)) {
            keyEvents.computeIfAbsent(label, ignored -> new KeyLog()).observe(event.getEventTime());
        }
        if (!learnableKey(event)) return;
        if (phase >= 2 && !nearPen(event, lastPenEvent)) {
            needsHover = true;
            return;
        }
        String fingerprint = fingerprint(event);
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_UNKNOWN && fingerprint.equals(previousSqueeze)) {
            overlapsSqueeze |= phase >= 2;
            return;
        }
        String key = code + "/" + fingerprint;
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
