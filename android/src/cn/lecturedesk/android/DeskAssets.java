package cn.lecturedesk.android;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

final class DeskAssets extends WebViewClient {
    static final String ORIGIN = "https://lecture-desk.invalid";
    private static final Map<String, String> RESPONSE_HEADERS;
    static {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        RESPONSE_HEADERS = Collections.unmodifiableMap(headers);
    }
    private final AssetManager assets;

    DeskAssets(AssetManager assets) { this.assets = assets; }

    static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "lecture-desk.invalid".equals(uri.getEncodedAuthority());
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !isLocal(request.getUrl());
    }

    @Override public void onPageFinished(WebView view, String url) {
        if (isLocal(Uri.parse(url))) {
            view.evaluateJavascript("window.dispatchEvent(new Event('lecture-desk-native-ready'));", null);
        }
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!isLocal(uri)) {
            return "https".equals(uri.getScheme()) || "http".equals(uri.getScheme()) ? missing(403, "Forbidden") : null;
        }
        String method = request.getMethod();
        if (!"GET".equals(method) && !"HEAD".equals(method)) return missing(405, "Method Not Allowed");
        String path = uri.getPath();
        String file = path == null || path.length() <= 1 ? "index.html" : path.substring(1);
        if (!file.matches("[A-Za-z0-9._/-]+")) return missing(404, "Not Found");
        for (String part : file.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return missing(404, "Not Found");
        }
        String mime = getMime(file.substring(file.lastIndexOf('.') + 1));
        try {
            java.io.InputStream input = assets.open("desk/" + file);
            if ("HEAD".equals(method)) {
                input.close();
                input = new ByteArrayInputStream(new byte[0]);
            }
            String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.endsWith("json")
                ? "UTF-8" : null;
            return new WebResourceResponse(mime, encoding, 200, "OK", RESPONSE_HEADERS, input);
        } catch (IOException error) {
            return missing(404, "Not Found");
        }
    }

    private static WebResourceResponse missing(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, Collections.emptyMap(),
            new ByteArrayInputStream(new byte[0]));
    }

    private static String getMime(String extension) {
        switch (extension) {
            case "html": return "text/html";
            case "css": return "text/css";
            case "js":
            case "mjs": return "application/javascript";
            case "json": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "pdf": return "application/pdf";
            case "wasm": return "application/wasm";
            case "png": return "image/png";
            case "svg": return "image/svg+xml";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "gz": return "application/gzip";
            default: return "application/octet-stream";
        }
    }
}
