package app.margin.reader;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * What the page can ask the Android app (window.MarginAndroid). android-shim.js turns these into
 * the same calls the Windows app answers, so app.js needs almost no Android code of its own.
 */
public class Bridge {
    private final MainActivity a;
    private final SharedPreferences prefs;
    Uri shared;
    private String sharedName = "";

    Bridge(MainActivity a) {
        this.a = a;
        this.prefs = a.getSharedPreferences("margin", MainActivity.MODE_PRIVATE);
    }

    /* ---------------- the Windows-app calls ---------------- */

    @JavascriptInterface
    public String call(String name, String argsJson, String reqId) {
        try {
            JSONArray args = new JSONArray(argsJson == null ? "[]" : argsJson);
            switch (name) {
                case "SetPlaying":
                    PlaybackService.update(a, args.optBoolean(0), args.optString(1, ""));
                    if (args.optBoolean(0)) a.runOnUiThread(a::askNotifications);
                    return null;
                case "SetDark":
                    final boolean dark = args.optBoolean(0, true);
                    a.runOnUiThread(() -> a.setDark(dark));
                    return null;
                case "OpenExternal":
                    final String url = args.optString(0, "");
                    if (url.startsWith("http")) a.runOnUiThread(() -> a.openExternal(url));
                    return null;
                case "Version":
                    return JSONObject.quote(BuildConfig.VERSION_NAME);
                case "PickFolder":
                    a.runOnUiThread(() -> a.pickFolder(reqId));
                    return "\"__async\"";
                case "GetFolders":
                    return JSONObject.quote(String.join("\n", folders().keySet()));
                case "SetFolders":
                    setFolders(args.optString(0, ""));
                    return null;
                case "ScanBooks":
                    final String root = args.optString(0, ""), id = args.optString(1, "");
                    new Thread(() -> scan(root, id)).start();
                    return null;
                default: // ShowMain, StartMiniDrag...: nothing to do on a phone
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------------- book folders ----------------
       A folder is chosen with Android's folder picker; Margin keeps permission to read it.
       The page knows it by a readable name such as "Phone/Books"; paths inside look like
       "Phone/Books/History/Title.pdf" and are mapped back to the phone's document addresses. */

    private Map<String, String> folders() {
        Map<String, String> m = new HashMap<>();
        try {
            JSONObject o = new JSONObject(prefs.getString("folders", "{}"));
            for (Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); m.put(k, o.getString(k)); }
        } catch (Exception ignored) { }
        return m;
    }

    private void saveFolders(Map<String, String> m) {
        prefs.edit().putString("folders", new JSONObject(m).toString()).apply();
    }

    private void setFolders(String list) {
        Map<String, String> m = folders(), keep = new HashMap<>();
        for (String line : list.split("\n")) { String k = line.trim(); if (m.containsKey(k)) keep.put(k, m.get(k)); }
        for (Map.Entry<String, String> e : m.entrySet())
            if (!keep.containsKey(e.getKey()))
                try { a.getContentResolver().releasePersistableUriPermission(Uri.parse(e.getValue()), Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
        saveFolders(keep);
    }

    void folderPicked(String reqId, Uri tree) {
        String name = "";
        if (tree != null) {
            try {
                a.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                name = describe(tree);
                Map<String, String> m = folders();
                m.put(name, tree.toString());
                saveFolders(m);
            } catch (Exception e) { name = ""; toast("Margin could not use that folder."); }
        }
        a.js("window.__marginReply && __marginReply(" + JSONObject.quote(reqId) + "," + JSONObject.quote(JSONObject.quote(name)) + ")");
    }

    /** "primary:Books/History" becomes "Phone/Books/History"; a memory card's folders start "SD card" */
    private String describe(Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        int c = id.indexOf(':');
        String vol = c >= 0 ? id.substring(0, c) : "", rest = c >= 0 ? id.substring(c + 1) : id;
        String top = vol.equalsIgnoreCase("primary") ? "Phone" : vol.isEmpty() ? "Folder" : "SD card";
        if (!vol.equalsIgnoreCase("primary") && !vol.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) top = vol;
        String name = rest.isEmpty() ? top : top + "/" + rest;
        return name.replace('\\', '/').replaceAll("/+$", "");
    }

    private final Map<String, String> paths = new HashMap<>();
    private boolean pathsLoaded;

    private synchronized void loadPaths() {
        if (pathsLoaded) return;
        pathsLoaded = true;
        try {
            File f = new File(a.getFilesDir(), "paths.json");
            if (!f.exists()) return;
            JSONObject o = new JSONObject(new String(Server.readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
            for (Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); paths.put(k, o.getString(k)); }
        } catch (Exception ignored) { }
    }

    private synchronized void savePaths() {
        try (OutputStream out = new FileOutputStream(new File(a.getFilesDir(), "paths.json"))) {
            out.write(new JSONObject(paths).toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    /** the phone's address of a book, from the path the page uses */
    synchronized Uri docFor(String path) {
        if (path == null) return null;
        loadPaths();
        String d = paths.get(path);
        return d == null ? null : Uri.parse(d);
    }

    private void scan(String root, String id) {
        StringBuilder sb = new StringBuilder();
        String err = null;
        sb.append("{\"id\":").append(JSONObject.quote(id)).append(",\"files\":[");
        try {
            String treeStr = folders().get(root);
            if (treeStr == null) throw new Exception("Margin no longer has permission for " + root + ". Remove it and add it again.");
            Uri tree = Uri.parse(treeStr);
            Map<String, String> found = new HashMap<>();
            List<String> rows = new ArrayList<>();
            walk(a.getContentResolver(), tree, DocumentsContract.getTreeDocumentId(tree), root, found, rows, 0);
            sb.append(String.join(",", rows));
            synchronized (this) {
                loadPaths();
                Iterator<String> it = paths.keySet().iterator();
                while (it.hasNext()) if (it.next().startsWith(root + "/")) it.remove();
                paths.putAll(found);
            }
            savePaths();
        } catch (Exception e) { err = e.getMessage() == null ? e.toString() : e.getMessage(); }
        sb.append("],\"error\":").append(err == null ? "null" : JSONObject.quote(err)).append('}');
        a.js("window.__marginPost(" + JSONObject.quote(sb.toString()) + ")");
    }

    private void walk(ContentResolver cr, Uri tree, String docId, String prefix, Map<String, String> found, List<String> rows, int depth) {
        if (depth > 12) return;
        Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
        List<String[]> dirs = new ArrayList<>();
        try (Cursor c = cr.query(kids, cols, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0), name = c.getString(1), mt = c.getString(2);
                if (name == null || name.startsWith(".")) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mt)) { dirs.add(new String[] { id, name }); continue; }
                String low = name.toLowerCase(Locale.ROOT);
                if (!low.endsWith(".pdf") && !low.endsWith(".epub")) continue;
                String path = prefix + "/" + name;
                found.put(path, DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                rows.add("[" + JSONObject.quote(path) + "," + (c.isNull(3) ? 0 : c.getLong(3)) + "," + (c.isNull(4) ? 0 : c.getLong(4)) + "]");
            }
        } catch (Exception ignored) { }
        for (String[] d : dirs) walk(cr, tree, d[0], prefix + "/" + d[1], found, rows, depth + 1);
    }

    /* ---------------- a book opened with Margin from another app ---------------- */

    void setShared(Uri u) {
        shared = u;
        sharedName = "book";
        try (Cursor c = a.getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) sharedName = c.getString(0);
        } catch (Exception ignored) { }
        if (!sharedName.toLowerCase(Locale.ROOT).matches(".*\\.(pdf|epub)$")) {
            String t = a.getContentResolver().getType(u);
            if ("application/epub+zip".equals(t)) sharedName += ".epub"; else sharedName += ".pdf";
        }
    }

    @JavascriptInterface
    public String sharedName() {
        String n = shared == null ? "" : sharedName;
        return n;
    }

    /* ---------------- the phone's voices ---------------- */

    private TextToSpeech tts;
    private volatile boolean ttsReady;
    private final Map<String, Voice> voiceByName = new HashMap<>();

    @JavascriptInterface
    public void ttsInit() {
        a.runOnUiThread(() -> {
            if (tts != null) return;
            tts = new TextToSpeech(a, status -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (!ttsReady) return;
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { send(id, "start", 0); }
                    @Override public void onDone(String id) { send(id, "end", 0); }
                    @Override @SuppressWarnings("deprecation") public void onError(String id) { send(id, "error", 0); }
                    @Override public void onError(String id, int code) { send(id, "error", 0); }
                    @Override public void onStop(String id, boolean interrupted) { }
                    @Override public void onRangeStart(String id, int start, int end, int frame) { send(id, "word", start); }
                });
                a.js("window.__ttsVoices && __ttsVoices()");
            });
        });
    }

    private void send(String id, String type, int ch) {
        a.js("window.__tts && __tts(" + JSONObject.quote(id) + ",'" + type + "'," + ch + ")");
    }

    /** installed voices, named so they make sense in Margin's voice list */
    @JavascriptInterface
    public String ttsVoices() {
        JSONArray out = new JSONArray();
        if (!ttsReady) return out.toString();
        try {
            Set<Voice> vs = tts.getVoices();
            Voice def = tts.getDefaultVoice();
            List<Voice> list = new ArrayList<>(vs);
            list.sort((x, y) -> x.getName().compareTo(y.getName()));
            Map<String, Integer> count = new HashMap<>();
            for (Voice v : list) {
                if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                Locale l = v.getLocale();
                String lang = l.toLanguageTag();
                String base = l.getDisplayLanguage(Locale.ENGLISH) + (l.getCountry().isEmpty() ? "" : " (" + l.getDisplayCountry(Locale.ENGLISH) + ")");
                int n = count.containsKey(base) ? count.get(base) + 1 : 1;
                count.put(base, n);
                JSONObject o = new JSONObject();
                o.put("name", base + " " + n);
                o.put("lang", lang);
                o.put("voiceURI", v.getName());
                o.put("localService", !v.isNetworkConnectionRequired());
                o.put("default", def != null && def.getName().equals(v.getName()));
                out.put(o);
                voiceByName.put(v.getName(), v);
            }
        } catch (Exception ignored) { }
        return out.toString();
    }

    @JavascriptInterface
    public void ttsSpeak(String id, String text, String voice, float rate, float pitch) {
        if (!ttsReady) { send(id, "error", 0); return; }
        try {
            Voice v = voice == null || voice.isEmpty() ? null : voiceByName.get(voice);
            if (v != null) tts.setVoice(v);
            else if (tts.getDefaultVoice() != null) tts.setVoice(tts.getDefaultVoice());
            tts.setSpeechRate(rate > 0 ? rate : 1f);
            tts.setPitch(pitch > 0 ? pitch : 1f);
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id) != TextToSpeech.SUCCESS) send(id, "error", 0);
        } catch (Exception e) { send(id, "error", 0); }
    }

    @JavascriptInterface
    public void ttsStop() {
        if (tts != null) try { tts.stop(); } catch (Exception ignored) { }
    }

    /* ---------------- saving files into Downloads/Margin ---------------- */

    private final Map<String, Object[]> saves = new HashMap<>();
    private int saveSeq;

    @JavascriptInterface
    public String saveBegin(String name, String mime) {
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name.replaceAll("[\\\\/:*?\"<>|]+", " ").trim());
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Margin");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri u = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (u == null) return "";
            OutputStream os = a.getContentResolver().openOutputStream(u);
            String id = "s" + (++saveSeq);
            synchronized (saves) { saves.put(id, new Object[] { u, os, name }); }
            return id;
        } catch (Exception e) { return ""; }
    }

    @JavascriptInterface
    public void saveChunk(String id, String b64) {
        Object[] s; synchronized (saves) { s = saves.get(id); }
        if (s == null) return;
        try { ((OutputStream) s[1]).write(Base64.decode(b64, Base64.DEFAULT)); } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public void saveEnd(String id) {
        Object[] s; synchronized (saves) { s = saves.remove(id); }
        if (s == null) return;
        try {
            ((OutputStream) s[1]).close();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            a.getContentResolver().update((Uri) s[0], v, null, null);
            toast("Saved in Downloads/Margin: " + s[2]);
        } catch (Exception e) { toast("Could not save " + s[2]); }
    }

    @JavascriptInterface
    public void toast(final String msg) {
        a.runOnUiThread(() -> Toast.makeText(a, msg, Toast.LENGTH_LONG).show());
    }

    void close() {
        if (tts != null) try { tts.shutdown(); } catch (Exception ignored) { }
        tts = null;
    }
}
