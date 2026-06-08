package com.solarized.firedown.manager;

import android.net.Uri;
import android.text.TextUtils;
import android.util.Log;

import com.solarized.firedown.data.Download;
import com.solarized.firedown.utils.FileUriHelper;
import com.solarized.firedown.utils.MessageHelper;
import com.solarized.firedown.utils.WebUtils;

import org.apache.commons.io.FilenameUtils;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Mega.nz file download (from a folder link).
 *
 * <p>The captured synthetic URL —
 * {@code https://mega.nz/folder/<folder>/file/<node>?fk=<b64 node key>} — carries
 * the per-file 256-bit node key the {@link GeckoInspectTask} folder enumeration
 * already decrypted with the folder share key. This strategy:
 * <ol>
 *   <li>calls Mega's anonymous {@code g} API ({@code &n=<folder>} scopes it) for
 *       the temp download URL + size,</li>
 *   <li>streams that URL through AES-128-CTR, decrypting on the fly.</li>
 * </ol>
 * Pure JDK crypto — no ffmpeg, no native. The wire only ever sees ciphertext;
 * the plaintext is produced here, which is the whole reason a Mega mp4 can't be
 * grabbed by the generic catcher (it would save the undecrypted bytes).
 *
 * <p>Resume is intentionally not implemented: an interrupted download restarts
 * from byte 0 (a fresh {@code g} URL is minted each run). CTR resume would mean
 * seeking the keystream to a 16-byte-aligned offset; not worth it for the file
 * sizes here, and a re-tap is cheap.
 */
public class MegaStrategy implements DownloadStrategy {

    private static final String TAG = MegaStrategy.class.getSimpleName();
    private static final String MEGA_API = "https://g.api.mega.co.nz/cs";
    private static final int BYTE_SIZE = 8192;
    private static final long UPDATE_RATE = 1500;

    private volatile boolean stopped;
    private long lastUpdated;

    @Override
    public void execute(DownloadRequest request, DownloadContext context, DownloadCallback callback)
            throws IOException {

        // ====================================================================
        // 1. Parse the synthetic capture URL: folder handle, node handle, key.
        // ====================================================================
        Uri uri = Uri.parse(request.getUrl());
        String fk = uri.getQueryParameter("fk");
        List<String> seg = uri.getPathSegments(); // [folder, <handle>, file, <node>]
        String folderHandle = null;
        String nodeHandle = null;
        for (int i = 0; i + 1 < seg.size(); i++) {
            if ("folder".equals(seg.get(i))) folderHandle = seg.get(i + 1);
            else if ("file".equals(seg.get(i))) nodeHandle = seg.get(i + 1);
        }
        if (TextUtils.isEmpty(folderHandle) || TextUtils.isEmpty(nodeHandle) || TextUtils.isEmpty(fk)) {
            Log.e(TAG, "Mega: malformed capture URL: " + request.getUrl());
            callback.onError(MessageHelper.IOEXCEPTION);
            return;
        }

        byte[] nodeKey = MegaCrypto.b64(fk);
        if (nodeKey.length != 32) {
            Log.e(TAG, "Mega: node key is " + nodeKey.length + " bytes, expected 32");
            callback.onError(MessageHelper.IOEXCEPTION);
            return;
        }
        byte[] aesKey = MegaCrypto.fileAesKey(nodeKey);
        byte[] iv = MegaCrypto.fileCtrIv(nodeKey);

        // ====================================================================
        // 2. Resolve the temp download URL + size via the anonymous `g` API.
        // ====================================================================
        String body = "[{\"a\":\"g\",\"g\":1,\"ssl\":2,\"n\":\"" + nodeHandle + "\"}]";
        String api = MEGA_API + "?id=" + Math.abs(new SecureRandom().nextInt()) + "&n=" + folderHandle;
        String dlUrl = null;
        long size = 0;
        try {
            String resp = WebUtils.postContent(api, body, new HashMap<>());
            JSONArray arr = new JSONArray(resp.trim());
            Object first = arr.length() > 0 ? arr.get(0) : null;
            if (first instanceof JSONObject) {
                dlUrl = ((JSONObject) first).optString("g", null);
                size = ((JSONObject) first).optLong("s", 0);
            }
        } catch (Exception e) {
            Log.e(TAG, "Mega: `g` request failed", e);
        }
        if (TextUtils.isEmpty(dlUrl)) {
            Log.e(TAG, "Mega: no download URL (link expired, removed, or quota)");
            callback.onError(MessageHelper.IOEXCEPTION);
            return;
        }

        // ====================================================================
        // 3. Output file + mime.
        // ====================================================================
        String mimeType = request.getMimeType();
        if (TextUtils.isEmpty(mimeType)) mimeType = FileUriHelper.MIMETYPE_MP4;
        callback.onMimeResolved(mimeType);

        // The captured name is the decrypted Mega filename and is authoritative —
        // keep its extension. Only synthesise one from the mime if it has none.
        File file = context.getOutputFile();
        if (TextUtils.isEmpty(FilenameUtils.getExtension(file.getName()))) {
            String ext = FileUriHelper.getFileExtensionFromMimeType(mimeType);
            if (TextUtils.isEmpty(ext)) ext = "mp4";
            file = new File(file.getParent(),
                    FilenameUtils.getBaseName(file.getName()) + "." + ext);
        }
        String resolvedPath = callback.onFilePathResolved(file.getAbsolutePath());
        file = new File(resolvedPath);

        // ====================================================================
        // 4. Stream the ciphertext and AES-CTR decrypt it to disk.
        // ====================================================================
        Cipher cipher;
        try {
            cipher = Cipher.getInstance("AES/CTR/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aesKey, "AES"), new IvParameterSpec(iv));
        } catch (Exception e) {
            Log.e(TAG, "Mega: cipher init failed", e);
            callback.onError(MessageHelper.IOEXCEPTION);
            return;
        }

        Request httpReq = new Request.Builder().url(dlUrl).build();
        Response httpResp = null;
        ResponseBody rb = null;
        BufferedInputStream input = null;
        BufferedOutputStream output = null;
        long downloaded = 0;
        try {
            httpResp = context.getOkHttpClient().newCall(httpReq).execute();
            if (!httpResp.isSuccessful()) {
                Log.e(TAG, "Mega: download HTTP " + httpResp.code());
                callback.onError(httpResp.code());
                return;
            }
            rb = httpResp.body();
            if (rb == null) {
                callback.onError(MessageHelper.IOEXCEPTION);
                return;
            }
            long total = size > 0 ? size : rb.contentLength();
            input = new BufferedInputStream(rb.byteStream());
            output = new BufferedOutputStream(new FileOutputStream(file, false));

            reportProgress(callback, 0, total);
            byte[] data = new byte[BYTE_SIZE];
            int count;
            while ((count = input.read(data)) != -1) {
                if (stopped || context.isInterrupted()) {
                    Log.w(TAG, "Mega: aborted at " + downloaded + "/" + total);
                    return;
                }
                byte[] dec = cipher.update(data, 0, count);
                if (dec != null && dec.length > 0) output.write(dec);
                downloaded += count;
                reportProgress(callback, downloaded, total);
            }
            byte[] fin = cipher.doFinal();
            if (fin != null && fin.length > 0) output.write(fin);
            output.flush();

            if (FileUriHelper.isVideo(mimeType) || FileUriHelper.isImage(mimeType)) {
                callback.onImgResolved(file.getAbsolutePath());
            }
            callback.onProgress(100, file.length(), file.length());
            callback.onFileSizeKnown(file.length());
            callback.onStatusChanged(Download.FINISHED);

        } catch (Exception e) {
            if (stopped || context.isInterrupted()) return;
            Log.e(TAG, "Mega: download/decrypt failed at " + downloaded, e);
            throw new IOException("Mega download failed", e);
        } finally {
            closeQuietly(input, output, rb, httpResp);
        }
    }

    @Override
    public void stop() {
        stopped = true;
    }

    private void reportProgress(DownloadCallback callback, long downloaded, long total) {
        long now = System.currentTimeMillis();
        if (now - lastUpdated > UPDATE_RATE || downloaded == 0) {
            lastUpdated = now;
            int percent = total > 0 ? (int) ((downloaded * 100) / total) : 0;
            callback.onProgress(Math.min(percent, 100), downloaded, total);
        }
    }

    private static void closeQuietly(Closeable in, Closeable out, ResponseBody body, Response response) {
        try { if (in != null) in.close(); } catch (IOException ignored) {}
        try { if (out != null) out.close(); } catch (IOException ignored) {}
        if (body != null) body.close();
        if (response != null) response.close();
    }
}
