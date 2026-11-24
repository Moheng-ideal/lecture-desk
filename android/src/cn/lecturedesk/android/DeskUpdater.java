package cn.lecturedesk.android;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

final class DeskUpdater {
    static final int ALLOW_INSTALL = 490;
    static final int INSTALL_UPDATE = 491;
    private static final String REPOSITORY = "Moheng-ideal/lecture-desk";
    private static final String RELEASES = "https://github.com/" + REPOSITORY + "/releases";
    private static final String GITHUB_LATEST = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
    private static final String SERVER = "http://8.141.106.190/lecture-desk/";
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]?)\\.(0|[1-9][0-9]?)");
    private static final long MAX_APK = 128L * 1024 * 1024;
    private final MainActivity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean closed;
    private AlertDialog progress;
    private boolean installing;

    DeskUpdater(MainActivity activity) { this.activity = activity; }

    String currentVersion() {
        try { return installed(0).versionName; }
        catch (PackageManager.NameNotFoundException error) { return ""; }
    }

    void check() {
        if (closed || installing || progress != null) return;
        new AlertDialog.Builder(activity)
            .setTitle("选择更新来源")
            .setItems(new String[]{"从服务器下载", "从 GitHub 下载"},
                (dialog, index) -> check(Source.values()[index]))
            .setNegativeButton("取消", null)
            .show();
    }

    private void check(Source source) {
        if (closed || installing || progress != null) return;
        showProgress("正在从 " + source.label + " 检查更新…");
        worker.execute(() -> {
            try {
                Release release = latest(source);
                if (release.versionCode <= installed(0).versionCode) {
                    finishProgress(() -> message("当前版本无需更新",
                        "已安装 v" + currentVersion() + "，" + source.label + " 上的版本为 v" + release.version + "。", source));
                } else {
                    finishProgress(() -> new AlertDialog.Builder(activity)
                        .setTitle("发现新版 v" + release.version)
                        .setMessage("当前版本 v" + currentVersion() + "。下载后按系统提示覆盖安装，保留课本、批注和问答。")
                        .setNegativeButton("稍后", null)
                        .setPositiveButton("从 " + source.label + " 下载", (dialog, button) -> download(source, release))
                        .show());
                }
            } catch (UpdateError error) {
                finishProgress(() -> message("无法检查更新", error.getMessage(), source));
            } catch (Exception error) {
                finishProgress(() -> message("无法检查更新", "暂时无法读取 " + source.label + " 的更新信息。", source));
            }
        });
    }

    private void download(Source source, Release release) {
        if (closed || progress != null || installing) return;
        String status = "正在从 " + source.label + " 下载 APK…";
        showProgress(status);
        worker.execute(() -> {
            File staged = null;
            try {
                staged = File.createTempFile("lecture-desk-update-", ".apk", activity.getCacheDir());
                downloadApk(source, release, staged, status);
                validateApk(release, staged);
                File apk = UpdateApkProvider.apk(activity);
                if (closed) return;
                Files.move(staged.toPath(), apk.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                finishProgress(this::install);
            } catch (UpdateError error) {
                finishProgress(() -> message("更新文件未通过校验", error.getMessage(), source));
            } catch (Exception error) {
                finishProgress(() -> message("下载失败", "请检查网络连接和设备剩余空间后重试。", source));
            } finally {
                if (staged != null && staged.exists()) staged.delete();
            }
        });
    }

    private Release latest(Source source) throws Exception {
        if (source == Source.SERVER) {
            JSONObject json = readMetadata(source, SERVER + "latest.json", "application/json");
            String version = json.optString("version");
            int code = versionCode(version);
            if (json.optInt("versionCode", -1) != code || !apkName(version).equals(json.optString("file"))) {
                throw new UpdateError("服务器上的版本信息有误。");
            }
            return checkedRelease(version, code, SERVER + apkName(version), json.optString("sha256"), json.optLong("size"));
        }

        JSONObject json = readMetadata(source, GITHUB_LATEST, "application/vnd.github+json");
        String tag = json.optString("tag_name");
        if (json.optBoolean("draft") || json.optBoolean("prerelease") || !tag.startsWith("v") || !tag.endsWith("-android")) {
            throw new UpdateError("GitHub 最新发布中暂无正式安卓版。");
        }
        String version = tag.substring(1, tag.length() - "-android".length());
        int code = versionCode(version);
        if (code <= installed(0).versionCode) return new Release(version, code, "", "", 0);
        String name = apkName(version);
        String url = RELEASES + "/download/" + tag + "/" + name;
        JSONArray assets = json.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!name.equals(asset.optString("name")) || !url.equals(asset.optString("browser_download_url"))) continue;
            String checksum = asset.optString("digest");
            if (checksum.startsWith("sha256:")) {
                return checkedRelease(version, code, url, checksum.substring(7), asset.optLong("size"));
            }
        }
        throw new UpdateError("这个版本缺少可校验的安卓版安装包。");
    }

    private static int versionCode(String version) throws UpdateError {
        Matcher match = VERSION.matcher(version);
        if (!match.matches()) throw new UpdateError("更新来源返回的版本号无效。");
        return Integer.parseInt(match.group(1)) * 10000 + Integer.parseInt(match.group(2)) * 100
            + Integer.parseInt(match.group(3));
    }

    private static String apkName(String version) { return "lecture-desk-android-" + version + ".apk"; }

    private static Release checkedRelease(String version, int code, String url, String digest, long size) throws UpdateError {
        if (!digest.matches("[0-9a-f]{64}") || size <= 0 || size > MAX_APK) {
            throw new UpdateError("这个版本缺少可校验的安卓版安装包。");
        }
        return new Release(version, code, url, digest, size);
    }

    private JSONObject readMetadata(Source source, String address, String accept) throws Exception {
        HttpURLConnection connection = open(source, address, accept);
        try {
            int status = connection.getResponseCode();
            if (status == 403 || status == 429) throw new UpdateError(source.label + " 请求暂时受限，请稍后再试。");
            if (status == 404) throw new UpdateError(source.label + " 暂无可访问的公开版本。");
            if (status != 200) throw new IOException("Release request failed");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            long deadline = SystemClock.elapsedRealtime() + 20000;
            try (InputStream in = connection.getInputStream()) {
                for (int count; (count = in.read(chunk)) != -1;) {
                    if (closed || SystemClock.elapsedRealtime() > deadline || buffer.size() + count > 524288) {
                        throw new IOException("Release metadata exceeds limits");
                    }
                    buffer.write(chunk, 0, count);
                }
            }
            return new JSONObject(buffer.toString("UTF-8"));
        } finally { connection.disconnect(); }
    }

    private static HttpURLConnection open(Source source, String address, String accept) throws IOException {
        URL url = new URL(address);
        java.util.List<String> hosts = Arrays.asList("api.github.com", "github.com", "release-assets.githubusercontent.com",
            "objects.githubusercontent.com");
        boolean allowed = source == Source.SERVER ? address.startsWith(SERVER)
            : "https".equals(url.getProtocol()) && hosts.contains(url.getHost()) && url.getUserInfo() == null
                && (url.getPort() == -1 || url.getPort() == 443);
        if (!allowed) throw new IOException("Unexpected update URL");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(9000);
        connection.setReadTimeout(12000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("User-Agent", "LectureDesk-Android-Updater");
        connection.setRequestProperty("Accept", accept);
        return connection;
    }

    private void downloadApk(Source source, Release release, File staged, String progressText) throws Exception {
        String url = release.url;
        for (int redirect = 0; redirect < 5; redirect++) {
            if (closed) throw new IOException("Activity closed");
            HttpURLConnection connection = open(source, url, "application/octet-stream");
            try {
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    if (source == Source.SERVER) throw new IOException("Unexpected update server redirect");
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("Missing redirect");
                    url = new URL(new URL(url), location).toString();
                    continue;
                }
                if (status != 200) throw new IOException("Asset request failed");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long deadline = SystemClock.elapsedRealtime() + 120000;
                long size = 0;
                int shown = 0;
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(staged)) {
                    byte[] buffer = new byte[65536];
                    for (int count; (count = in.read(buffer)) != -1;) {
                        size += count;
                        if (closed || SystemClock.elapsedRealtime() > deadline) throw new IOException("Download interrupted");
                        if (size > release.size) throw new UpdateError("安装包大小与发布记录不一致。");
                        digest.update(buffer, 0, count);
                        out.write(buffer, 0, count);
                        int percent = (int) (size * 100 / release.size);
                        if (percent >= shown + 5) {
                            shown = percent;
                            activity.runOnUiThread(() -> {
                                if (progress != null) progress.setMessage(progressText + " " + percent + "%");
                            });
                        }
                    }
                }
                byte[] expected = new byte[32];
                for (int i = 0; i < expected.length; i++) {
                    expected[i] = (byte) Integer.parseInt(release.digest.substring(i * 2, i * 2 + 2), 16);
                }
                if (size != release.size || !MessageDigest.isEqual(digest.digest(), expected)) {
                    throw new UpdateError("APK 完整性校验失败，请重新下载。");
                }
                return;
            } finally { connection.disconnect(); }
        }
        throw new IOException("Too many redirects");
    }

    private void validateApk(Release release, File apk) throws Exception {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = installed(flags);
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(apk.getPath(), flags);
        if (candidate == null || !current.packageName.equals(candidate.packageName)
            || candidate.versionCode != release.versionCode || candidate.versionCode <= current.versionCode
            || !release.version.equals(candidate.versionName)) {
            throw new UpdateError("安装包的应用标识或版本与更新记录不符。");
        }
        Set<Signature> expected = signers(current);
        if (expected.isEmpty() || !expected.equals(signers(candidate))) {
            throw new UpdateError("安装包签名与已安装的讲课台不同，覆盖安装已停止。");
        }
    }

    private static Set<Signature> signers(PackageInfo info) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
            ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        return signatures == null ? Collections.emptySet() : new HashSet<>(Arrays.asList(signatures));
    }

    private PackageInfo installed(int flags) throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), flags);
    }

    private void install() {
        if (closed || installing) return;
        if (!UpdateApkProvider.apk(activity).isFile()) {
            message("无法安装", "本机的更新文件已失效，请重新检查更新。", null);
            return;
        }
        try {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(settings, ALLOW_INSTALL);
                installing = true;
                return;
            }
            Uri uri = UpdateApkProvider.uri(activity);
            Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, UpdateApkProvider.MIME_TYPE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.setClipData(ClipData.newRawUri("Lecture Desk APK", uri));
            activity.startActivityForResult(install, INSTALL_UPDATE);
            installing = true;
        } catch (RuntimeException error) {
            message("无法打开系统安装器", "可手动下载新版 APK，并在卓易通或系统文件管理器中打开安装。", null);
        }
    }

    void onResult(int request) {
        installing = false;
        if (closed || request != ALLOW_INSTALL) return;
        if (activity.getPackageManager().canRequestPackageInstalls()) install();
        else message("尚未获得安装权限", "请在系统设置允许讲课台安装应用，再重新检查更新。", null);
    }

    private void showProgress(String text) {
        progress = new AlertDialog.Builder(activity).setMessage(text).setCancelable(false).show();
    }

    private void finishProgress(Runnable next) {
        activity.runOnUiThread(() -> {
            if (closed) return;
            if (progress != null) progress.dismiss();
            progress = null;
            next.run();
        });
    }

    private void message(String title, String text, Source source) {
        AlertDialog.Builder dialog = new AlertDialog.Builder(activity)
            .setTitle(title).setMessage(text).setPositiveButton("确定", null);
        if (source != null) {
            Source alternative = source == Source.SERVER ? Source.GITHUB : Source.SERVER;
            dialog.setNeutralButton("改用" + alternative.label, (view, button) -> check(alternative));
        }
        dialog.show();
    }

    void close() {
        closed = true;
        if (progress != null) progress.dismiss();
        worker.shutdownNow();
    }

    private enum Source {
        SERVER("服务器"), GITHUB("GitHub");
        final String label;
        Source(String label) { this.label = label; }
    }

    private static final class Release {
        final String version;
        final int versionCode;
        final String url;
        final String digest;
        final long size;
        Release(String version, int versionCode, String url, String digest, long size) {
            this.version = version;
            this.versionCode = versionCode;
            this.url = url;
            this.digest = digest;
            this.size = size;
        }
    }

    private static final class UpdateError extends IOException {
        UpdateError(String message) { super(message); }
    }
}
