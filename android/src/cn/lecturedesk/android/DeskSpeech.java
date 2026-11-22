package cn.lecturedesk.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;

final class DeskSpeech {
    static final int MICROPHONE_REQUEST = 489;
    private final MainActivity activity;
    private SpeechRecognizer recognizer;
    private volatile String id;

    DeskSpeech(MainActivity activity) { this.activity = activity; }

    synchronized boolean start(String request) {
        if (request == null || id != null || !DeskNetwork.ID.matcher(request).matches()) return false;
        id = request;
        activity.runOnUiThread(() -> requestPermissionOrListen(request));
        return true;
    }

    private void requestPermissionOrListen(String request) {
        if (!request.equals(id)) return;
        if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) {
            complete(request, "voice-error", "这台设备暂不支持应用内离线听写，可用输入法的麦克风。");
        } else if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MICROPHONE_REQUEST);
        } else listen(request);
    }

    void permissionResult(boolean allowed) {
        String request = id;
        if (request == null) return;
        if (allowed) listen(request);
        else complete(request, "voice-error", "请在系统设置中允许讲课台使用麦克风。");
    }

    private void listen(String request) {
        if (!request.equals(id)) return;
        try {
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle values) { emit(request, "voice-start", ""); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float db) {}
                @Override public void onBufferReceived(byte[] data) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int event, Bundle values) {}
                @Override public void onPartialResults(Bundle partial) { emit(request, "voice-partial", text(partial)); }
                @Override public void onResults(Bundle result) {
                    emit(request, "voice-final", text(result));
                    complete(request, "voice-done", "");
                }
                @Override public void onError(int error) {
                    boolean empty = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
                    complete(request, empty ? "voice-done" : "voice-error",
                        empty ? "" : "普通话离线听写暂时不可用，可用输入法的麦克风。");
                }
            });
            Intent params = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            recognizer.startListening(params);
        } catch (RuntimeException failure) {
            complete(request, "voice-error", "无法启动普通话离线听写，可用输入法的麦克风。");
        }
    }

    private static String text(Bundle results) {
        ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return values == null || values.isEmpty() ? "" : values.get(0);
    }

    private void emit(String request, String kind, String value) {
        if (request.equals(id)) activity.emit(request, kind, value);
    }

    void finish(String request) {
        if (request == null || !request.equals(id)) return;
        if (recognizer == null) complete(request, "voice-done", "");
        else recognizer.stopListening();
    }

    void cancel(String request) {
        if (request != null && request.equals(id)) complete(request, null, "");
    }

    private void complete(String request, String event, String value) {
        if (!request.equals(id)) return;
        id = null;
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        if (event != null) activity.emit(request, event, value);
    }

    void close() { cancel(id); }
}
