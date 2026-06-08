package com.solarized.firedown.manager;

import android.text.TextUtils;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Mega.nz folder-link cryptography.
 *
 * <p>Mega is <b>zero-knowledge</b>: the folder share key lives in the URL
 * fragment (after {@code #}) and is <b>never sent to the server</b>, so it can
 * only be read page-world. That share key decrypts every node's key; the node
 * key in turn decrypts that node's attributes (the filename) and the AES-CTR
 * file stream. The bytes a file's download URL serves are AES-128-CTR
 * ciphertext, which is exactly why the generic catcher can capture the URL but
 * the saved file is undecryptable garbage — the key has to travel with it.
 *
 * <p>All pure JDK crypto — no native, no ffmpeg. The key math mirrors MEGA's own
 * webclient:
 * <ul>
 *   <li>Node keys are decrypted in independent 16-byte AES-ECB blocks (so a
 *       32-byte file key is two ECB blocks, <b>not</b> CBC chaining — each
 *       16-byte block of a folder-link key is encrypted under the share key
 *       independently).</li>
 *   <li>A file's 16-byte AES key is the first four 32-bit words XOR'd with the
 *       last four; the 8-byte CTR nonce is words [4],[5].</li>
 *   <li>{@code a32} words are big-endian.</li>
 * </ul>
 */
public final class MegaCrypto {

    private MegaCrypto() {}

    // ---- Mega base64: URL-safe (-_), padding stripped ----------------------

    public static byte[] b64(String s) {
        if (TextUtils.isEmpty(s)) return new byte[0];
        String t = s.replace('-', '+').replace('_', '/');
        switch (t.length() % 4) {
            case 2: t += "=="; break;
            case 3: t += "="; break;
            default: break;
        }
        return Base64.decode(t, Base64.NO_WRAP);
    }

    public static String b64encode(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP | Base64.NO_PADDING)
                .replace('+', '-').replace('/', '_');
    }

    // ---- a32 (big-endian 32-bit word) <-> bytes ----------------------------

    private static int[] bytesToA32(byte[] b) {
        int len = (b.length + 3) / 4;
        int[] out = new int[len];
        for (int i = 0; i < b.length; i++) {
            out[i >> 2] |= (b[i] & 0xFF) << (24 - 8 * (i & 3));
        }
        return out;
    }

    private static byte[] a32ToBytes(int[] a) {
        byte[] out = new byte[a.length * 4];
        for (int i = 0; i < a.length; i++) {
            out[i * 4]     = (byte) (a[i] >>> 24);
            out[i * 4 + 1] = (byte) (a[i] >>> 16);
            out[i * 4 + 2] = (byte) (a[i] >>> 8);
            out[i * 4 + 3] = (byte) (a[i]);
        }
        return out;
    }

    // ---- Folder enumeration response ('f' command) -------------------------

    /** Pull the node array out of the cs {@code f} response: {@code [{"f":[ … ]}]}.
     *  Returns {@code null} on an API error response (a bare negative number). */
    public static JSONArray parseFolderNodes(String response) {
        if (TextUtils.isEmpty(response)) return null;
        try {
            JSONArray top = new JSONArray(response.trim());
            if (top.length() == 0) return null;
            Object first = top.get(0);
            if (!(first instanceof JSONObject)) return null; // a bare number = API error code
            return ((JSONObject) first).optJSONArray("f");
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * A node's {@code k} is {@code "<handle>:<b64key>"}. A folder link re-encrypts
     * every node key under the one share key, so there's normally a single entry;
     * multiple {@code /}-separated entries can appear, so take the first one with a
     * key part.
     */
    public static String shareKeyPart(String k) {
        if (TextUtils.isEmpty(k)) return null;
        for (String part : k.split("/")) {
            int c = part.indexOf(':');
            if (c >= 0 && c + 1 < part.length()) {
                return part.substring(c + 1);
            }
        }
        return null;
    }

    /**
     * Decrypt a node key with the 16-byte folder share key. AES-ECB over the
     * whole buffer (each 16-byte block independent — matches MEGA's per-block
     * decrypt), yielding 16 bytes (a sub-folder) or 32 bytes (a file).
     */
    public static byte[] decryptNodeKey(byte[] masterKey, String encKeyB64) {
        try {
            byte[] enc = b64(encKeyB64);
            if (enc.length == 0 || enc.length % 16 != 0) return null;
            Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(masterKey, "AES"));
            return c.doFinal(enc);
        } catch (Exception e) {
            return null;
        }
    }

    /** The 16-byte AES key for a file: words[0..3] XOR words[4..7]. */
    public static byte[] fileAesKey(byte[] nodeKey32) {
        int[] k = bytesToA32(nodeKey32);
        int[] aes = new int[] { k[0] ^ k[4], k[1] ^ k[5], k[2] ^ k[6], k[3] ^ k[7] };
        return a32ToBytes(aes);
    }

    /**
     * The 16-byte CTR initial counter block: the 8-byte nonce (words [4],[5])
     * followed by 8 zero bytes. javax increments the full 128-bit value as the
     * counter; with the low 64 bits starting at 0 there is no carry into the
     * nonce for any realistic file size, which matches MEGA's nonce||counter CTR.
     */
    public static byte[] fileCtrIv(byte[] nodeKey32) {
        int[] k = bytesToA32(nodeKey32);
        byte[] nonce = a32ToBytes(new int[] { k[4], k[5] }); // 8 bytes
        byte[] iv = new byte[16];
        System.arraycopy(nonce, 0, iv, 0, 8);
        return iv;
    }

    /**
     * Decrypt a node's attributes (AES-CBC, zero IV, the file's AES key) and pull
     * the filename. The plaintext is {@code "MEGA"} + a JSON object
     * {@code {"n":"…"}}, NUL-padded to a 16-byte boundary.
     */
    public static String decryptName(byte[] nodeKey32, String encAttrB64) {
        try {
            byte[] attr = b64(encAttrB64);
            if (attr.length == 0 || attr.length % 16 != 0) return null;
            byte[] aesKey = fileAesKey(nodeKey32);
            Cipher c = Cipher.getInstance("AES/CBC/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aesKey, "AES"),
                    new IvParameterSpec(new byte[16]));
            byte[] dec = c.doFinal(attr);
            String s = new String(dec, StandardCharsets.UTF_8);
            int nul = s.indexOf('\0');
            if (nul >= 0) s = s.substring(0, nul);
            if (!s.startsWith("MEGA")) return null;
            JSONObject obj = new JSONObject(s.substring(4));
            String name = obj.optString("n", null);
            return TextUtils.isEmpty(name) ? null : name;
        } catch (Exception e) {
            return null;
        }
    }
}
