package app.margin.reader;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/** Margin on Android: the same pages as the Windows app, shown in a WebView. */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://margin.example";
    static MainActivity current;

    WebView web;
    Bridge bridge;
    ValueCallback<Uri[]> fileCallback;
    String folderRequest;
    View fullView;
    WebChromeClient.CustomViewCallback fullCallback;
    boolean dark = true;

    static final int REQ_FILE = 1, REQ_FOLDER = 2, REQ_NOTIFY = 3;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        bridge = new Bridge(this);
        setDark(getSharedPreferences("margin", MODE_PRIVATE).getBoolean("dark", true));

        web = new WebView(this);
        web.setBackgroundColor(dark ? Color.BLACK : Color.rgb(233, 236, 234));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " MarginAndroid/" + BuildConfig.VERSION_NAME);
        // keep reading aloud with the screen off: the page must not be put to sleep
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(bridge, "MarginAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return Server.handle(MainActivity.this, r);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith(ORIGIN + "/")) return false;
                openExternal(u.toString());
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String accept = String.join(",", p.getAcceptTypes()).toLowerCase();
                if (accept.contains("pdf") || accept.contains("epub"))
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/pdf", "application/epub+zip", "application/octet-stream" });
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(i, REQ_FILE); }
                catch (Exception e) { fileCallback = null; return false; }
                return true;
            }

            // the page's full-screen button
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (fullView != null) { cb.onCustomViewHidden(); return; }
                fullView = view; fullCallback = cb;
                ((FrameLayout) getWindow().getDecorView()).addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideBars(true);
            }

            @Override
            public void onHideCustomView() {
                if (fullView == null) return;
                ((FrameLayout) getWindow().getDecorView()).removeView(fullView);
                fullView = null;
                hideBars(false);
                if (fullCallback != null) fullCallback.onCustomViewHidden();
                fullCallback = null;
            }
        });

        setContentView(web);
        takeShared(getIntent());
        web.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (takeShared(intent)) js("window.__marginOpenShared && __marginOpenShared()");
    }

    /** a PDF or EPUB opened with Margin from another app (Files, Telegram, Drive...) */
    boolean takeShared(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return false;
        bridge.setShared(intent.getData());
        return true;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            Uri[] picked = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    picked = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < picked.length; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) picked = new Uri[] { data.getData() };
            }
            if (fileCallback != null) fileCallback.onReceiveValue(picked);
            fileCallback = null;
        } else if (req == REQ_FOLDER) {
            String id = folderRequest; folderRequest = null;
            bridge.folderPicked(id, res == RESULT_OK && data != null ? data.getData() : null);
        }
    }

    void pickFolder(String id) {
        if (folderRequest != null) bridge.folderPicked(folderRequest, null);
        folderRequest = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        try { startActivityForResult(i, REQ_FOLDER); }
        catch (Exception e) { folderRequest = null; bridge.folderPicked(id, null); }
    }

    @Override
    public void onBackPressed() {
        if (fullView != null) { js("document.fullscreenElement && document.exitFullscreen()"); return; }
        // the page goes back a step (dialog, page, book); at the top, Margin goes to the background
        // (it is not closed, so reading aloud carries on)
        web.evaluateJavascript("(window.marginHost && marginHost.back) ? marginHost.back() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (isFinishing()) PlaybackService.stop(this);
        bridge.close();
        web.destroy();
        super.onDestroy();
    }

    void js(String script) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(script, null); });
    }

    void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFY);
    }

    void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    @SuppressWarnings("deprecation")
    void setDark(boolean on) {
        dark = on;
        getSharedPreferences("margin", MODE_PRIVATE).edit().putBoolean("dark", on).apply();
        Window w = getWindow();
        int bar = on ? Color.BLACK : Color.rgb(233, 236, 234);
        w.setStatusBarColor(bar);
        w.setNavigationBarColor(bar);
        View d = w.getDecorView();
        int f = d.getSystemUiVisibility();
        if (on) f &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        else f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        d.setSystemUiVisibility(f);
        if (web != null) web.setBackgroundColor(bar);
    }

    @SuppressWarnings("deprecation")
    void hideBars(boolean on) {
        View d = getWindow().getDecorView();
        if (on) d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        else { d.setSystemUiVisibility(0); setDark(dark); }
    }
}
