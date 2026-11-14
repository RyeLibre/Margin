package app.margin.reader;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves Margin's pages at https://margin.example/ from the app's assets, as the Windows app does,
 * with the headers that let the neural voice use every CPU core. Also:
 *   /book?p=PATH  a book from a chosen folder on the phone
 *   /shared       a book opened with Margin from another app
 * and keeps a copy of the voice program files from cdn.jsdelivr.net, so the voice works offline.
 */
final class Server {
    private Server() { }

    static WebResourceResponse handle(MainActivity a, WebResourceRequest r) {
        Uri u = r.getUrl();
        String url = u.toString();
        try {
            if (url.startsWith(MainActivity.ORIGIN + "/")) {
                String path = u.getPath() == null ? "/" : u.getPath();
                if (path.equals("/book")) {
                    String p = u.getQueryParameter("p");
                    Uri doc = a.bridge.docFor(p);
                    if (doc == null) return text(404, "Not found");
                    return ok(mime(p), a.getContentResolver().openInputStream(doc));
                }
                if (path.equals("/shared")) {
                    Uri doc = a.bridge.shared;
                    if (doc == null) return text(404, "Nothing shared");
                    String type = a.getContentResolver().getType(doc);
                    return ok(type != null ? type : "application/octet-stream", a.getContentResolver().openInputStream(doc));
                }
                if (path.equals("/")) path = "/index.html";
                if (path.contains("..")) return text(403, "No");
                String asset = path.equals("/android-shim.js") ? "android-shim.js" : "www" + path;
                InputStream in;
                try { in = a.getAssets().open(asset); }
                catch (Exception e) { return text(404, "Not found"); }
                if (path.equals("/index.html")) {
                    String html = new String(readAll(in), StandardCharsets.UTF_8);
                    html = html.replaceFirst("<head>", "<head>\n<script src=\"android-shim.js\"></script>");
                    in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
                }
                return ok(mime(path), in);
            }
            if ("cdn.jsdelivr.net".equals(u.getHost()) && "GET".equals(r.getMethod())) return cdn(a, url);
        } catch (Exception e) {
            return text(500, String.valueOf(e.getMessage()));
        }
        return null;
    }

    /** voice program files: kept in the app's storage after the first download */
    private static WebResourceResponse cdn(MainActivity a, String url) {
        File dir = new File(a.getFilesDir(), "cdn");
        if (!dir.exists()) dir.mkdirs();
        String key = sha1(url);
        File body = new File(dir, key), type = new File(dir, key + ".type");
        try {
            if (!body.exists()) {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                if (c.getResponseCode() != 200) { c.disconnect(); return null; }
                File tmp = new File(dir, key + ".part");
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) { copy(in, out); }
                String ct = c.getContentType();
                try (OutputStream out = new FileOutputStream(type)) { out.write((ct == null ? "application/octet-stream" : ct).getBytes(StandardCharsets.UTF_8)); }
                if (!tmp.renameTo(body)) return null;
            }
            String ct = type.exists() ? new String(readAll(new FileInputStream(type)), StandardCharsets.UTF_8) : mime(url);
            String mt = ct.split(";")[0].trim();
            WebResourceResponse w = new WebResourceResponse(mt, mt.startsWith("text/") || mt.contains("javascript") || mt.contains("json") ? "utf-8" : null, new FileInputStream(body));
            Map<String, String> h = new HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cross-Origin-Resource-Policy", "cross-origin");
            h.put("Cache-Control", "max-age=31536000");
            w.setResponseHeaders(h);
            w.setStatusCodeAndReasonPhrase(200, "OK");
            return w;
        } catch (Exception e) {
            return null; // let the WebView try the network itself
        }
    }

    private static WebResourceResponse ok(String mime, InputStream in) {
        String mt = mime.split(";")[0];
        WebResourceResponse w = new WebResourceResponse(mt, mt.startsWith("text/") || mt.contains("javascript") || mt.contains("json") ? "utf-8" : null, in);
        Map<String, String> h = new HashMap<>();
        h.put("Cross-Origin-Opener-Policy", "same-origin");
        h.put("Cross-Origin-Embedder-Policy", "credentialless");
        h.put("Cross-Origin-Resource-Policy", "same-origin");
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", MainActivity.ORIGIN);
        w.setResponseHeaders(h);
        w.setStatusCodeAndReasonPhrase(200, "OK");
        return w;
    }

    private static WebResourceResponse text(int code, String msg) {
        WebResourceResponse w = new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(msg.getBytes(StandardCharsets.UTF_8)));
        w.setStatusCodeAndReasonPhrase(code, code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Error");
        return w;
    }

    static String mime(String path) {
        String p = path == null ? "" : path.toLowerCase(Locale.ROOT);
        int q = p.indexOf('?'); if (q >= 0) p = p.substring(0, q);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".pdf")) return "application/pdf";
        if (p.endsWith(".epub")) return "application/epub+zip";
        if (p.endsWith(".txt") || p.endsWith(".ftl")) return "text/plain";
        return "application/octet-stream";
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        try (InputStream i = in) { ByteArrayOutputStream b = new ByteArrayOutputStream(); copy(i, b); return b.toByteArray(); }
    }

    static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[65536]; int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) { return Integer.toHexString(s.hashCode()); }
    }
}
