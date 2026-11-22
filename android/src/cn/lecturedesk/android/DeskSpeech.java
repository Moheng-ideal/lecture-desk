package cn.lecturedesk.android;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;

final class DeskSpeech {
    static final int MICROPHONE_REQUEST = 489;
    private static final int RATE = 16000;
    private static final String MODEL_NAME = "vosk-model-small-cn-0.22";
    private final MainActivity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Session active;
    private Model model;

    private static final class Session {
        final String id;
        volatile boolean finish;
        boolean started;
        Session(String id) { this.id = id; }
    }

    DeskSpeech(MainActivity activity) { this.activity = activity; }

    synchronized boolean start(String id) {
        if (id == null || active != null || worker.isShutdown() || !DeskNetwork.ID.matcher(id).matches()) return false;
        Session session = new Session(id);
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

    private void enqueue(Session session) {
        if (active != session || session.started) return;
        session.started = true;
        worker.execute(() -> listen(session));
    }

    private void listen(Session session) {
        String error = "无法加载离线普通话识别引擎，请重新打开讲课台。";
        AudioRecord audio = null;
        try {
            if (active != session || session.finish) return;
            if (model == null) model = new Model(unpack().getPath());
            if (active != session || session.finish) return;
            error = "无法开启麦克风，请检查卓易通的麦克风权限，或关闭正在录音的应用。";
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) throw new IOException("Audio format unavailable");
            audio = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 6400));
            if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            try (Recognizer recognizer = new Recognizer(model, RATE)) {
                audio.startRecording();
                if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Capture failed");
                emit(session, "voice-start", "");
                short[] samples = new short[1600];
                String partial = "";
                while (active == session && !session.finish) {
                    int count = audio.read(samples, 0, samples.length, AudioRecord.READ_NON_BLOCKING);
                    if (count < 0) throw new IOException("Capture interrupted");
                    if (count == 0) {
                        Thread.sleep(20);
                        continue;
                    }
                    if (recognizer.acceptWaveForm(samples, count)) {
                        emit(session, "voice-final", transcript(recognizer.getResult(), "text"));
                        partial = "";
                    } else {
                        String next = transcript(recognizer.getPartialResult(), "partial");
                        if (!next.equals(partial)) emit(session, "voice-partial", next);
                        partial = next;
                    }
                }
                if (active == session) emit(session, "voice-final", transcript(recognizer.getFinalResult(), "text"));
            }
        } catch (Exception | LinkageError failure) {
            complete(session, "voice-error", error);
        } finally {
            if (audio != null) {
                try {
                    if (audio.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) audio.stop();
                } catch (IllegalStateException ignored) {
                    // A recorder disconnected by the system may already be stopped.
                } finally {
                    audio.release();
                }
            }
            complete(session, "voice-done", "");
        }
    }

    private File unpack() throws IOException {
        File parent = activity.getNoBackupFilesDir();
        File directory = new File(parent, MODEL_NAME);
        File ready = new File(directory, ".extracted");
        if (ready.isFile()) return directory;
        String expected = directory.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(activity.getAssets().open("voice/" + MODEL_NAME + ".zip"))) {
            byte[] buffer = new byte[65536];
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (entry.isDirectory()) continue;
                File output = new File(parent, entry.getName()).getCanonicalFile();
                if (!output.getPath().startsWith(expected)) throw new IOException("Invalid bundled model");
                File folder = output.getParentFile();
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Cannot create model directory");
                try (FileOutputStream stream = new FileOutputStream(output)) {
                    for (int count; (count = zip.read(buffer)) != -1;) stream.write(buffer, 0, count);
                }
            }
        }
        if (!new File(directory, "am/final.mdl").isFile() || !ready.createNewFile()) throw new IOException("Incomplete model");
        return directory;
    }

    private static String transcript(String json, String key) throws Exception {
        return new JSONObject(json).optString(key).trim().replaceAll("(?<=[\\u3400-\\u9fff])\\s+(?=[\\u3400-\\u9fff])", "");
    }

    private void emit(Session session, String kind, String value) {
        if (active == session) activity.emit(session.id, kind, value);
    }

    void finish(String id) {
        Session session = active;
        if (session == null || !session.id.equals(id)) return;
        session.finish = true;
        if (!session.started) complete(session, "voice-done", "");
    }

    synchronized void cancel(String id) {
        if (active != null && active.id.equals(id)) active = null;
    }

    synchronized void stopCapture() {
        if (active != null && active.started) complete(active, "voice-done", "");
    }

    private synchronized void complete(Session session, String kind, String message) {
        if (active != session) return;
        active = null;
        activity.emit(session.id, kind, message);
    }

    synchronized void close() {
        active = null;
        worker.execute(() -> { if (model != null) model.close(); });
        worker.shutdown();
    }
}
