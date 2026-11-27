package cn.lecturedesk.android;

import android.util.Base64;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONObject;

final class DeskNetwork {
    static final Pattern ID = Pattern.compile("[a-fA-F0-9-]{32,36}");
    private static final String FEISHU = "https://open.feishu.cn/open-apis";
    private static final String GENIOS = "https://coze.nankai.edu.cn/api/proxy/api/v1/";
    private static final String ZHIPU = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
    private static final String UPLOAD = FEISHU + "/drive/v1/files/upload_all";
    private static final String MEDIA_UPLOAD = FEISHU + "/drive/v1/medias/upload_all";
    private static final Pattern IMAGE_BLOCK = Pattern.compile(Pattern.quote(FEISHU) +
        "/docx/v1/documents/[A-Za-z0-9]{1,100}/blocks/[A-Za-z0-9]{1,100}");
    private static final Pattern BLOCKS = Pattern.compile(Pattern.quote(FEISHU) +
        "/docx/v1/documents/[A-Za-z0-9]{1,100}/blocks/[A-Za-z0-9]{1,100}/children\\?client_token=[0-9a-f-]{36}");
    private static final Pattern MULTIPART = Pattern.compile("multipart/form-data; boundary=[A-Za-z0-9-]{1,80}");
    private final MainActivity activity;
    private final ExecutorService worker = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    private static class Call {
        volatile HttpURLConnection connection;
        volatile boolean cancelled;
        void cancel() {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
        }
    }

    DeskNetwork(MainActivity activity) { this.activity = activity; }

    boolean start(String id, String url, String body, String auth, String contentType) {
        if (id == null || url == null || body == null || auth == null || contentType == null) return false;
        boolean upload = UPLOAD.equals(url) || MEDIA_UPLOAD.equals(url);
        boolean allowed = upload ? MULTIPART.matcher(contentType).matches() : isJsonEndpoint(url);
        if (!allowed || body.isEmpty() || body.length() > (upload ? 28_000_000 : 4_000_000) ||
            auth.length() > 5000 || auth.indexOf('\r') >= 0 || auth.indexOf('\n') >= 0 ||
            !ID.matcher(id).matches() || calls.size() >= 6) return false;
        Call call = new Call();
        if (calls.putIfAbsent(id, call) != null) return false;
        try {
            worker.execute(() -> send(id, url, body, auth, upload ? contentType : "application/json", upload, call));
            return true;
        } catch (RuntimeException rejected) {
            calls.remove(id, call);
            return false;
        }
    }

    private static boolean isJsonEndpoint(String url) {
        return url.equals("https://api.deepseek.com/chat/completions") ||
            url.equals(ZHIPU) ||
            (url.startsWith(GENIOS) && (url.endsWith("/create_conversation") ||
                url.endsWith("/chat_query_v2"))) ||
            url.equals(FEISHU + "/auth/v3/tenant_access_token/internal") ||
            url.equals(FEISHU + "/docx/v1/documents") || BLOCKS.matcher(url).matches() || IMAGE_BLOCK.matcher(url).matches();
    }

    private void send(String id, String url, String body, String auth, String type, boolean upload, Call call) {
        try {
            if (call.cancelled) return;
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            call.connection = connection;
            if (call.cancelled) return;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(110000);
            connection.setRequestMethod(IMAGE_BLOCK.matcher(url).matches() ? "PATCH" : "POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", type);
            if (!auth.isEmpty()) {
                // NK-GeniOS authenticates with the `Apikey` header; the JS bridge
                // carries the key in the auth slot. DeepSeek/Feishu/Zhipu use Bearer.
                if (url.startsWith(GENIOS)) connection.setRequestProperty("Apikey", auth);
                else connection.setRequestProperty("Authorization", auth);
            }
            byte[] data = upload ? Base64.decode(body, Base64.DEFAULT) : body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(data); }
            int status = connection.getResponseCode();
            String responseType = connection.getContentType();
            if (call.cancelled) return;
            activity.emit(id, "headers", new JSONObject().put("Content-Type",
                responseType == null ? "application/json" : responseType).toString());
            activity.emit(id, "status", String.valueOf(status));
            try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                if (input != null) {
                    byte[] buffer = new byte[8192];
                    int size;
                    while (!call.cancelled && (size = input.read(buffer)) != -1) {
                        activity.emit(id, "data", Base64.encodeToString(buffer, 0, size, Base64.NO_WRAP));
                    }
                }
            }
            if (!call.cancelled) activity.emit(id, "end", "");
        } catch (Exception error) {
            if (!call.cancelled) activity.emit(id, "error", "");
        } finally {
            calls.remove(id, call);
            call.cancel();
        }
    }

    void cancel(String id) {
        if (id == null) return;
        Call call = calls.remove(id);
        if (call != null) call.cancel();
    }

    void close() {
        calls.values().forEach(Call::cancel);
        calls.clear();
        worker.shutdownNow();
    }
}
