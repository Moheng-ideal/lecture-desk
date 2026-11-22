package cn.lecturedesk.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class DeskCredentials {
    private static final String ALIAS = "lecture-desk-deepseek-v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private final SharedPreferences preferences;

    DeskCredentials(Context context) {
        preferences = context.getSharedPreferences("desk_credentials", Context.MODE_PRIVATE);
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null || !create) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build());
        return generator.generateKey();
    }

    synchronized String read() {
        String encoded = preferences.getString("deepseek", "");
        if (encoded.isEmpty()) return "";
        try {
            String[] parts = encoded.split("\\.", 2);
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception invalid) {
            return null;
        }
    }

    synchronized boolean save(String value) {
        if (value == null || value.length() > 180) return false;
        try {
            SharedPreferences.Editor edit = preferences.edit();
            if (value.isEmpty()) return edit.remove("deepseek").commit();
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            return edit.putString("deepseek", iv + "." + encrypted).commit();
        } catch (Exception failure) {
            return false;
        }
    }
}
