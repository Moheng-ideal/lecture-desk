package cn.lecturedesk.android;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.view.HapticFeedbackConstants;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

final class DeskSpeech {
    static final int MICROPHONE_REQUEST = 489;
    private static final int RATE = 16000;
    private static final int MAX_SECONDS = 30;
    private static final String ASR_URL = "https://api.deepseek.com/v1/tools/asr";
    private final MainActivity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Session active;

    private static final class Session {
        final String id;
        final String key;
        volatile boolean finish;
        volatile HttpURLConnection connection;
        boolean started;
        Session(String id, String key) { this.id = id; this.key = key; }
    }

    DeskSpeech(MainActivity activity) { this.activity = activity; }

    synchronized boolean start(String id, String key) {
        if (id == null || active != null || worker.isShutdown() || !DeskNetwork.ID.matcher(id).matches()
            || key == null || !key.matches("[A-Za-z0-9._~-]{1,180}")) return false;
        Session session = new Session(id, key);
        active = session;
        activity.runOnUiThread(() -> {
            if (active != session) return;
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MICROPHONE_REQUEST);
            } else enqueue(session);
        });
        return true;
    }

    void permissionResult(boolean allowed) {
        Session session = active;
        if (session == null) return;
        if (allowed) enqueue(session);
        else complete(session, "voice-error", "请在卓易通和系统设置中允许讲课台使用麦克风。");
    }

    private synchronized void enqueue(Session session) {
        if (active != session || session.started) return;
        session.started = true;
        worker.execute(() -> listen(session));
    }

    private void listen(Session session) {
        String error = "无法开启麦克风，请检查卓易通和系统的麦克风权限。";
        try {
            byte[] pcm = capture(session);
            if (active != session) return;
            if (pcm.length < RATE / 5) {
                complete(session, "voice-error", "录音太短，请按住按钮，看到正在录音后再说话。");
                return;
            }
            if (!session.finish) {
                activity.emit(session.id, "voice-limit", "");
                while (active == session && !session.finish) Thread.sleep(35);
                if (active != session) return;
            }
            activity.emit(session.id, "voice-processing", "");
            error = "DeepSeek 语音转写失败，请检查网络后重试。";
            String text = transcribe(session, pcm);
            if (active != session) return;
            if (!text.isEmpty()) activity.emit(session.id, "voice-final", text);
            complete(session, "voice-done", "");
        } catch (TranscriptionError failure) {
            complete(session, "voice-error", failure.getMessage());
        } catch (Exception failure) {
            complete(session, "voice-error", error);
        }
    }

    private byte[] capture(Session session) throws IOException, InterruptedException {
        if (active != session || session.finish) return new byte[0];
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) throw new IOException("Audio format unavailable");
        AudioRecord audio = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 6400));
        try {
            if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            if (active != session || session.finish) return new byte[0];
            audio.startRecording();
            if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Capture failed");
            activity.emit(session.id, "voice-start", "");
            activity.runOnUiThread(() -> {
                if (active == session && !session.finish) {
                    activity.getWindow().getDecorView().performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                }
            });
            int maxSize = RATE * 2 * MAX_SECONDS;
            long deadline = SystemClock.elapsedRealtime() + MAX_SECONDS * 1000L;
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            byte[] samples = new byte[3200];
            while (active == session && !session.finish && pcm.size() < maxSize
                && SystemClock.elapsedRealtime() < deadline) {
                int count = audio.read(samples, 0, Math.min(samples.length, maxSize - pcm.size()), AudioRecord.READ_NON_BLOCKING);
                if (count < 0) throw new IOException("Capture interrupted");
                if (count == 0) Thread.sleep(20);
                else pcm.write(samples, 0, count);
            }
            return pcm.toByteArray();
        } finally {
            try {
                if (audio.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) audio.stop();
            } finally { audio.release(); }
        }
    }

    private String transcribe(Session session, byte[] pcm) throws Exception {
        String boundary = UUID.randomUUID().toString();
        byte[] prefix = ("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"question.wav\"\r\n"
            + "Content-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] suffix = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] header = wavHeader(pcm.length);
        HttpURLConnection connection = (HttpURLConnection) new URL(ASR_URL).openConnection();
        session.connection = connection;
        try {
            if (active != session) return "";
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + session.key);
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setFixedLengthStreamingMode(prefix.length + header.length + pcm.length + suffix.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(prefix);
                out.write(header);
                out.write(pcm);
                out.write(suffix);
            }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new TranscriptionError("DeepSeek 验证失败，请检查设置里的 API Key。");
            if (status == 402) throw new TranscriptionError("DeepSeek 余额不足。");
            if (status == 429) throw new TranscriptionError("DeepSeek 请求过多，请稍后再试。");
            if (status != 200) throw new TranscriptionError("DeepSeek 语音转写失败（HTTP " + status + "）。");
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream result = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                for (int count; (count = in.read(buffer)) != -1;) {
                    if (result.size() + count > 65536) throw new IOException("Unexpected transcription size");
                    result.write(buffer, 0, count);
                }
                return new JSONObject(result.toString("UTF-8")).optString("text", "").trim();
            }
        } finally {
            connection.disconnect();
            session.connection = null;
        }
    }

    private static byte[] wavHeader(int size) {
        return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(size + 36)
            .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
            .putShort((short) 1).putShort((short) 1).putInt(RATE).putInt(RATE * 2)
            .putShort((short) 2).putShort((short) 16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(size).array();
    }

    private static final class TranscriptionError extends IOException {
        TranscriptionError(String message) { super(message); }
    }

    synchronized void finish(String id) {
        Session session = active;
        if (session == null || !session.id.equals(id)) return;
        session.finish = true;
        if (!session.started) complete(session, "voice-done", "");
    }

    synchronized void cancel(String id) {
        Session session = active;
        if (session == null || !session.id.equals(id)) return;
        active = null;
        HttpURLConnection connection = session.connection;
        if (connection != null) connection.disconnect();
    }

    synchronized void stopCapture() {
        Session session = active;
        if (session != null && session.started) {
            cancel(session.id);
            activity.emit(session.id, "voice-done", "");
        }
    }

    private synchronized void complete(Session session, String kind, String message) {
        if (active != session) return;
        active = null;
        activity.emit(session.id, kind, message);
    }

    synchronized void close() {
        if (active != null) cancel(active.id);
        worker.shutdownNow();
    }
}
