package cn.lecturedesk.android;

import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.util.LinkedHashSet;

final class PenInputTest {
    private static final int CAPTURE_MS = 12000;
    private static final int MAX_EVENTS = 24;
    private final MainActivity activity;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> events = new LinkedHashSet<>();
    private boolean recording;
    private final Runnable begin = this::beginRecording;
    private final Runnable finish = this::finishRecording;

    PenInputTest(MainActivity activity) { this.activity = activity; }

    void start() {
        stop();
        clock.postDelayed(begin, 800);
    }

    void stop() {
        clock.removeCallbacks(begin);
        clock.removeCallbacks(finish);
        events.clear();
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
        stop();
        activity.emit("", "pen-test-result", report);
    }

    private void add(String line) {
        if (events.size() < MAX_EVENTS) events.add(line);
    }

    void key(KeyEvent event) {
        if (!recording || event.getRepeatCount() != 0) return;
        String action = event.getAction() == KeyEvent.ACTION_DOWN ? "DOWN" : "UP";
        add("KEY " + action + " " + KeyEvent.keyCodeToString(event.getKeyCode())
            + " source=0x" + Integer.toHexString(event.getSource()));
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
