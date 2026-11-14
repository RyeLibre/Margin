// Margin.exe - Margin Reader as a Windows app: the reader page (web\index.html) in a window of its own,
// using Microsoft Edge WebView2 (built the same way as Shelf).
//  - its own window and taskbar button, with Previous / Play-Pause / Next in the taskbar preview
//  - a small always-on-top mini player, which also opens by itself when you minimize Margin while it reads
//  - books, notes and the voice are kept in %LOCALAPPDATA%\Margin, not inside a web browser
//  - the voice library is downloaded once and kept in %LOCALAPPDATA%\Margin\cache, so reading aloud works offline
//  - book folders (e.g. D:\8 BOOKS) are scanned for PDF and EPUB files, which are read where they are (never copied)
// Built by build.ps1 with the C# compiler that ships with Windows (.NET Framework 4.8, C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Margin
{
    static class Program
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Margin");

        [STAThread]
        static void Main()
        {
            // one Margin at a time: a second launch just brings the first one forward
            string key = "Margin." + StableHash(AppDir.ToLowerInvariant());
            bool first;
            var mutex = new Mutex(true, key + ".Instance", out first);
            var showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".Show");
            if (!first) { showSignal.Set(); return; }

            // modern HTTPS for downloading the voice library
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)12288 | SecurityProtocolType.Tls12; }
            catch { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new MainForm();
            var t = new Thread(() => { while (showSignal.WaitOne()) { try { form.BeginInvoke((Action)form.BringToFrontNow); } catch { } } });
            t.IsBackground = true;
            t.Start();
            Application.Run(form);
            GC.KeepAlive(mutex);
        }

        static string StableHash(string s)
        {
            uint h = 2166136261;
            foreach (char c in s) { h ^= c; h *= 16777619; }
            return h.ToString("x8");
        }
    }

    public class MainForm : Form
    {
        public const string Origin = "https://margin.example";
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); TitleBar.Apply(this); }
        // lets the voice use several CPU cores (the page must be "cross-origin isolated")
        const string Isolation = "\nCross-Origin-Opener-Policy: same-origin\nCross-Origin-Embedder-Policy: credentialless\nCross-Origin-Resource-Policy: same-origin";
        public WebView2 Web;
        CoreWebView2Environment env;
        readonly string webDir = PickWebDir();
        // the reader page comes from the app folder (web\), unless %LOCALAPPDATA%\Margin\webdir.txt names
        // another folder with index.html (e.g. the Margin Reader project folder): then changes there show
        // up the next time Margin opens (or with F5), without reinstalling
        static string PickWebDir()
        {
            try
            {
                string f = Path.Combine(Program.DataDir, "webdir.txt");
                if (File.Exists(f))
                {
                    string d = File.ReadAllText(f, Encoding.UTF8).Trim();
                    if (d.Length > 0 && File.Exists(Path.Combine(d, "index.html"))) return d;
                }
            }
            catch { }
            return Path.Combine(Program.AppDir, "web");
        }
        readonly string cacheDir = Path.Combine(Program.DataDir, "cache");
        readonly List<MiniForm> minis = new List<MiniForm>();
        public MiniForm[] Minis { get { return minis.ToArray(); } }
        readonly List<string> roots = new List<string>();      // book folders: the only places files are read from
        public readonly string FoldersFile = Path.Combine(Program.DataDir, "folders.txt");
        FormWindowState lastState = FormWindowState.Normal;
        bool fullscreen; FormWindowState preFullState; FormBorderStyle preFullBorder;

        public MainForm()
        {
            Text = "Margin";
            BackColor = TitleBar.Dark ? Color.FromArgb(11, 13, 13) : Color.FromArgb(233, 236, 234);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Directory.CreateDirectory(Program.DataDir);
            Directory.CreateDirectory(cacheDir);
            try { if (File.Exists(FoldersFile)) SetRoots(File.ReadAllText(FoldersFile, Encoding.UTF8).Split('\n')); } catch { }
            RestoreWindow();

            Web = new WebView2();
            Web.Dock = DockStyle.Fill;
            Web.DefaultBackgroundColor = BackColor;
            Controls.Add(Web);

            Load += async (s, e) => await InitWeb();
            FormClosing += (s, e) => { SaveWindow(); foreach (var m in minis.ToArray()) m.Close(); };
            // tell the page when Margin is minimized or comes back (it opens / closes the mini player)
            Resize += (s, e) =>
            {
                if (WindowState == lastState) return;
                if (WindowState == FormWindowState.Minimized) RunScript("window.marginHost && marginHost.minimized()");
                else if (lastState == FormWindowState.Minimized) RunScript("window.marginHost && marginHost.restored()");
                lastState = WindowState;
            };
        }

        static bool DarkMode()
        {
            try
            {
                object v = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                return v is int && (int)v == 0;
            }
            catch { return false; }
        }

        async Task InitWeb()
        {
            try
            {
                string args = "--autoplay-policy=no-user-gesture-required";
                string port = Environment.GetEnvironmentVariable("MARGIN_DEBUG_PORT"); // for testing only
                if (!string.IsNullOrEmpty(port)) args += " --remote-debugging-port=" + port;
                env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), new CoreWebView2EnvironmentOptions(args));
                await Web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Margin needs the Microsoft Edge WebView2 Runtime, which comes with Windows 11.\n\n" + ex.Message, "Margin", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            SetupView(Web.CoreWebView2);
            Web.CoreWebView2.AddHostObjectToScript("margin", new Bridge(this));
            Web.CoreWebView2.DocumentTitleChanged += (s, e) => { string t = Web.CoreWebView2.DocumentTitle; Text = string.IsNullOrEmpty(t) ? "Margin" : t; };
            Web.CoreWebView2.NewWindowRequested += OnNewWindow;
            Web.CoreWebView2.ContainsFullScreenElementChanged += (s, e) => SetFullscreen(Web.CoreWebView2.ContainsFullScreenElement);
            Web.CoreWebView2.Navigate(Origin + "/index.html");
        }

        // settings shared by the main window and the mini player
        void SetupView(CoreWebView2 core)
        {
            var st = core.Settings;
            st.IsStatusBarEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.AreDevToolsEnabled = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MARGIN_DEBUG_PORT"));
            core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("https://cdn.jsdelivr.net/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += Serve;
            // keep only text editing items in the built-in right-click menu (no Back / Reload / Print...)
            core.ContextMenuRequested += (s, e) =>
            {
                var keep = new HashSet<string> { "copy", "cut", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo" };
                for (int i = e.MenuItems.Count - 1; i >= 0; i--)
                    if (!keep.Contains(e.MenuItems[i].Name)) e.MenuItems.RemoveAt(i);
                if (e.MenuItems.Count == 0) e.Handled = true;
            };
            // links to other sites open in the normal browser
            core.NavigationStarting += (s, e) =>
            {
                if (e.Uri.StartsWith(Origin + "/") || e.Uri == "about:blank") return;
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
        }

        /* ---------- serving the reader and the voice library ---------- */
        void Serve(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri uri;
            try { uri = new Uri(e.Request.Uri); } catch { return; }
            if (uri.Host == "cdn.jsdelivr.net") { ServeCached(e, uri); return; }
            if (uri.AbsolutePath == "/book") { ServeBook(e, uri); return; }
            try
            {
                string rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                if (rel.Length == 0) rel = "index.html";
                string root = Path.GetFullPath(webDir).TrimEnd('\\') + "\\";
                string path = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\')));
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                {
                    e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                    return;
                }
                var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                e.Response = env.CreateWebResourceResponse(fs, 200, "OK",
                    "Content-Type: " + Mime(path) + "\nContent-Length: " + fs.Length + "\nCache-Control: no-cache" + Isolation);
            }
            catch (Exception ex)
            {
                e.Response = env.CreateWebResourceResponse(null, 500, "Error", "X-Error: " + ex.Message.Replace('\n', ' '));
            }
        }

        // a book in one of the book folders: https://margin.example/book?p=<full path>
        void ServeBook(CoreWebView2WebResourceRequestedEventArgs e, Uri uri)
        {
            try
            {
                string q = uri.Query.StartsWith("?p=") ? uri.Query.Substring(3) : "";
                string path = Uri.UnescapeDataString(q);
                if (!Allowed(path) || !File.Exists(path)) { e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
                var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                string type = path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase) ? "application/epub+zip" : "application/pdf";
                e.Response = env.CreateWebResourceResponse(fs, 200, "OK", "Content-Type: " + type + "\nContent-Length: " + fs.Length + "\nCache-Control: no-store" + Isolation);
            }
            catch (Exception ex) { e.Response = env.CreateWebResourceResponse(null, 500, "Error", "X-Error: " + ex.Message.Replace('\n', ' ')); }
        }

        public bool Allowed(string path)
        {
            string full;
            try { full = Path.GetFullPath(path); } catch { return false; }
            lock (roots)
                foreach (var r in roots)
                    if (full.StartsWith(r.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public void SetRoots(IEnumerable<string> list)
        {
            lock (roots)
            {
                roots.Clear();
                foreach (var r in list)
                {
                    if (r.Trim().Length == 0) continue;
                    try { roots.Add(Path.GetFullPath(r.Trim())); } catch { }
                }
            }
        }

        public void Post(string json)
        {
            if (Web.CoreWebView2 != null) Web.CoreWebView2.PostWebMessageAsJson(json);
        }

        /* ---------- folder picker (the standard Windows one) ---------- */
        public string PickFolder()
        {
            IFileOpenDialog dlg = null;
            try
            {
                dlg = (IFileOpenDialog)new FileOpenDialogRCW();
                dlg.SetOptions(0x20 | 0x40); // pick folders, file system only
                dlg.SetTitle("Choose a folder with books");
                Guid g = new Guid("3f0b6a52-2d7e-4f4a-9b8e-6c1d2e9a7b41");
                dlg.SetClientGuid(ref g);
                if (dlg.Show(Handle) != 0) return "";
                IShellItem item;
                dlg.GetResult(out item);
                IntPtr p;
                item.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
                string path = Marshal.PtrToStringUni(p);
                Marshal.FreeCoTaskMem(p);
                return path ?? "";
            }
            catch { return ""; }
            finally { if (dlg != null) Marshal.ReleaseComObject(dlg); }
        }

        // the voice library comes from cdn.jsdelivr.net: download each file once, then always use the saved copy
        void ServeCached(CoreWebView2WebResourceRequestedEventArgs e, Uri uri)
        {
            if (e.Request.Method != "GET") return;
            string url = uri.AbsoluteUri;
            string name = Hash(url);
            string body = Path.Combine(cacheDir, name + ".bin"), typeFile = Path.Combine(cacheDir, name + ".type");
            if (File.Exists(body) && File.Exists(typeFile))
            {
                try { e.Response = CachedResponse(body, File.ReadAllText(typeFile)); return; } catch { }
            }
            var deferral = e.GetDeferral();
            Task.Run(() =>
            {
                string type = null; Exception err = null;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.UserAgent = "Margin";
                    req.Timeout = 60000;
                    req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var s = res.GetResponseStream())
                    {
                        string tmp = body + "." + Guid.NewGuid().ToString("N") + ".part";
                        using (var f = File.Create(tmp)) s.CopyTo(f);
                        type = string.IsNullOrEmpty(res.ContentType) ? "application/octet-stream" : res.ContentType;
                        try { if (File.Exists(body)) File.Delete(body); File.Move(tmp, body); File.WriteAllText(typeFile, type); }
                        catch { if (!File.Exists(body)) throw; try { File.Delete(tmp); } catch { } }
                    }
                }
                catch (Exception ex) { err = ex; }
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            e.Response = err == null ? CachedResponse(body, type)
                                : env.CreateWebResourceResponse(null, 502, "Offline", "Access-Control-Allow-Origin: *\nCross-Origin-Resource-Policy: cross-origin");
                        }
                        catch { }
                        finally { deferral.Complete(); }
                    }));
                }
                catch { try { deferral.Complete(); } catch { } }
            });
        }

        CoreWebView2WebResourceResponse CachedResponse(string body, string type)
        {
            var fs = new FileStream(body, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return env.CreateWebResourceResponse(fs, 200, "OK",
                "Content-Type: " + type.Trim() + "\nContent-Length: " + fs.Length +
                "\nAccess-Control-Allow-Origin: *\nCross-Origin-Resource-Policy: cross-origin\nCache-Control: max-age=31536000");
        }

        static string Hash(string s)
        {
            using (var sha = SHA1.Create())
            {
                var sb = new StringBuilder();
                foreach (byte b in sha.ComputeHash(Encoding.UTF8.GetBytes(s))) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        static string Mime(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json";
                case ".webmanifest": return "application/manifest+json";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".wasm": return "application/wasm";
                case ".ttf": return "font/ttf";
                case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }

        public void RunScript(string js)
        {
            if (Web.CoreWebView2 != null) Web.CoreWebView2.ExecuteScriptAsync(js);
        }

        /* ---------- taskbar preview buttons ---------- */
        static readonly int WM_TASKBARBUTTONCREATED = RegisterWindowMessage("TaskbarButtonCreated");
        const int WM_COMMAND = 0x0111, THBN_CLICKED = 0x1800;
        const uint THB_ICON = 2, THB_TOOLTIP = 4, THB_FLAGS = 8;
        ITaskbarList3 taskbar;
        Icon icPrev, icPlay, icPause, icNext;
        bool playing;
        string tip = "Margin";

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_TASKBARBUTTONCREATED) AddThumbButtons();
            else if (m.Msg == WM_COMMAND && ((m.WParam.ToInt64() >> 16) & 0xffff) == THBN_CLICKED)
            {
                long id = m.WParam.ToInt64() & 0xffff;
                RunScript("window.marginHost && marginHost.cmd('" + (id == 1 ? "prev" : id == 2 ? "toggle" : "next") + "')");
            }
            base.WndProc(ref m);
        }

        void AddThumbButtons()
        {
            try
            {
                if (taskbar == null) { taskbar = (ITaskbarList3)new TaskbarListRCW(); taskbar.HrInit(); }
                if (icPrev == null) { icPrev = Glyph("prev"); icPlay = Glyph("play"); icPause = Glyph("pause"); icNext = Glyph("next"); }
                taskbar.ThumbBarAddButtons(Handle, 3, Buttons());
                taskbar.SetThumbnailTooltip(Handle, tip);
            }
            catch { }
        }

        THUMBBUTTON[] Buttons()
        {
            return new[] {
                new THUMBBUTTON { dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS, iId = 1, hIcon = icPrev.Handle, szTip = "Previous sentence" },
                new THUMBBUTTON { dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS, iId = 2, hIcon = (playing ? icPause : icPlay).Handle, szTip = playing ? "Pause" : "Listen" },
                new THUMBBUTTON { dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS, iId = 3, hIcon = icNext.Handle, szTip = "Next sentence" }
            };
        }

        public void SetPlaying(bool isPlaying, string tooltip)
        {
            playing = isPlaying;
            tip = string.IsNullOrEmpty(tooltip) ? "Margin" : (tooltip.Length > 250 ? tooltip.Substring(0, 250) : tooltip);
            if (taskbar == null || icPlay == null) return;
            try { taskbar.ThumbBarUpdateButtons(Handle, 3, Buttons()); taskbar.SetThumbnailTooltip(Handle, tip); } catch { }
        }

        // simple white transport icons, drawn instead of shipped as files
        static Icon Glyph(string kind)
        {
            const int s = 32;
            using (var bmp = new Bitmap(s, s))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    var b = Brushes.White;
                    switch (kind)
                    {
                        case "play": g.FillPolygon(b, new[] { new PointF(9, 5), new PointF(27, 16), new PointF(9, 27) }); break;
                        case "pause": g.FillRectangle(b, 8, 6, 6, 20); g.FillRectangle(b, 18, 6, 6, 20); break;
                        case "prev": g.FillRectangle(b, 6, 7, 4, 18); g.FillPolygon(b, new[] { new PointF(26, 7), new PointF(11, 16), new PointF(26, 25) }); break;
                        case "next": g.FillRectangle(b, 22, 7, 4, 18); g.FillPolygon(b, new[] { new PointF(6, 7), new PointF(21, 16), new PointF(6, 25) }); break;
                    }
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        /* ---------- mini player window (and links that open new windows) ---------- */
        async void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Uri) && e.Uri != "about:blank" && !e.Uri.StartsWith(Origin + "/"))
            {
                e.Handled = true; OpenExternal(e.Uri); return;
            }
            var deferral = e.GetDeferral();
            try
            {
                float k = DeviceDpi / 96f;
                int w = e.WindowFeatures.HasSize ? (int)e.WindowFeatures.Width : 360;
                int h = e.WindowFeatures.HasSize ? (int)e.WindowFeatures.Height : 140;
                var mini = new MiniForm(this, new Size((int)(w * k), (int)(h * k)), Path.Combine(Program.DataDir, "mini.txt"));
                mini.TopMost = true;
                mini.Show();
                await mini.Web.EnsureCoreWebView2Async(env);
                SetupView(mini.Web.CoreWebView2);
                mini.Web.CoreWebView2.WindowCloseRequested += (s, a) => mini.Close();
                e.NewWindow = mini.Web.CoreWebView2;
                e.Handled = true;
                minis.Add(mini);
                mini.FormClosed += (s, a) => { minis.Remove(mini); RunScript("window.marginHost && marginHost.miniClosed()"); };
            }
            catch { e.Handled = true; }
            finally { deferral.Complete(); }
        }

        /* ---------- window handling ---------- */
        // the page's full-screen button: fill the whole screen, without the title bar or taskbar
        void SetFullscreen(bool on)
        {
            if (on == fullscreen) return;
            fullscreen = on;
            if (on)
            {
                preFullState = WindowState; preFullBorder = FormBorderStyle;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                FormBorderStyle = preFullBorder;
                WindowState = preFullState;
            }
        }

        public void BringToFrontNow()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show();
            TopMost = true; TopMost = false;
            Activate();
        }

        void RestoreWindow()
        {
            StartPosition = FormStartPosition.CenterScreen;
            float k = DeviceDpi / 96f;
            Size = new Size((int)(1240 * k), (int)(820 * k));
            MinimumSize = new Size((int)(560 * k), (int)(420 * k));
            try
            {
                string[] p = File.ReadAllText(Path.Combine(Program.DataDir, "window.txt")).Split(',');
                var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                foreach (var scr in Screen.AllScreens)
                    if (scr.WorkingArea.IntersectsWith(r)) { StartPosition = FormStartPosition.Manual; Bounds = r; break; }
                if (p.Length > 4 && p[4] == "max") WindowState = FormWindowState.Maximized;
            }
            catch { }
        }

        void SaveWindow()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(Path.Combine(Program.DataDir, "window.txt"), r.X + "," + r.Y + "," + r.Width + "," + r.Height + (WindowState == FormWindowState.Maximized ? ",max" : ""));
            }
            catch { }
        }

        public static void OpenExternal(string url)
        {
            if (!(url.StartsWith("https://") || url.StartsWith("http://") || url.StartsWith("mailto:"))) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int RegisterWindowMessage(string msg);
    }

    // the small always-on-top window the mini player opens into
    public class MiniForm : Form
    {
        public WebView2 Web;
        readonly string posFile;

        public MiniForm(MainForm main, Size size, string posFile)
        {
            this.posFile = posFile;
            Text = "Margin";
            // no title bar: the player's controls sit at the very top; drag it by any empty space,
            // resize it from its thin edge
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            Padding = new Padding(Edge);
            BackColor = TitleBar.Dark ? Color.FromArgb(48, 48, 48) : Color.FromArgb(200, 205, 202);
            MinimumSize = new Size(220, 60);
            ClientSize = new Size(size.Width + 2 * Edge, size.Height + 2 * Edge);
            StartPosition = FormStartPosition.Manual;
            var wa = Screen.FromControl(main).WorkingArea;
            Location = new Point(wa.Right - Width - 24, wa.Bottom - Height - 24);
            try
            {
                string[] p = File.ReadAllText(posFile).Split(',');
                var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                foreach (var scr in Screen.AllScreens)
                    if (scr.WorkingArea.IntersectsWith(r)) { Bounds = r; break; }
            }
            catch { }
            Web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = main.BackColor };
            Controls.Add(Web);
            FormClosing += (s, e) => { try { File.WriteAllText(posFile, Left + "," + Top + "," + Width + "," + Height); } catch { } };
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); TitleBar.Apply(this); }

        const int Edge = 4;
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        // the page asks for this when the mouse goes down on empty space in the player
        public void StartDrag()
        {
            if (Control.MouseButtons != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
        }
        // resizing from the thin edge around the page
        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg != 0x84 /* WM_NCHITTEST */) return;
            var p = PointToClient(new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF)));
            int g = Edge + 3;
            bool l = p.X < g, r = p.X >= ClientSize.Width - g, t = p.Y < g, b = p.Y >= ClientSize.Height - g;
            if (t && l) m.Result = (IntPtr)13; else if (t && r) m.Result = (IntPtr)14;
            else if (b && l) m.Result = (IntPtr)16; else if (b && r) m.Result = (IntPtr)17;
            else if (l) m.Result = (IntPtr)10; else if (r) m.Result = (IntPtr)11;
            else if (t) m.Result = (IntPtr)12; else if (b) m.Result = (IntPtr)15;
        }
    }

    // black title bars when Margin's dark theme is on: dark mode for the caption (Windows 10 and 11), and on
    // Windows 11 an exact black caption with white text and a black border. The choice is kept in theme.txt
    // so the windows open the right colour before the page has loaded.
    public static class TitleBar
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        static string File_ { get { return Path.Combine(Program.DataDir, "theme.txt"); } }
        static bool? dark;
        public static bool Dark
        {
            get { if (dark == null) { try { dark = !File.Exists(File_) || File.ReadAllText(File_).Trim() != "light"; } catch { dark = true; } } return dark.Value; }
            set { dark = value; try { File.WriteAllText(File_, value ? "dark" : "light"); } catch { } foreach (Form f in Application.OpenForms) Apply(f); }
        }
        public static void Apply(Form f)
        {
            try
            {
                if (f is MiniForm) f.BackColor = Dark ? Color.FromArgb(48, 48, 48) : Color.FromArgb(200, 205, 202);
                if (!f.IsHandleCreated) return;
                int on = Dark ? 1 : 0, caption = Dark ? 0x000000 : unchecked((int)0xFFFFFFFF), text = Dark ? 0xFFFFFF : unchecked((int)0xFFFFFFFF);
                if (DwmSetWindowAttribute(f.Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(f.Handle, 19, ref on, 4);
                DwmSetWindowAttribute(f.Handle, 35, ref caption, 4); // caption colour (0xFFFFFFFF = Windows default)
                DwmSetWindowAttribute(f.Handle, 36, ref text, 4);    // caption text
                DwmSetWindowAttribute(f.Handle, 34, ref caption, 4); // border
                if (f.Visible) { f.Width += 1; f.Width -= 1; }        // Windows 10 repaints the caption only on a change
            }
            catch { }
        }
    }

    // what the page can ask Margin.exe to do (window.chrome.webview.hostObjects.margin)
    [ClassInterface(ClassInterfaceType.AutoDual)]
    [ComVisible(true)]
    public class Bridge
    {
        readonly MainForm f;
        public Bridge(MainForm f) { this.f = f; }
        public void SetPlaying(bool playing, string tooltip) { f.SetPlaying(playing, tooltip); }
        public void ShowMain() { f.BringToFrontNow(); }
        public void OpenExternal(string url) { MainForm.OpenExternal(url ?? ""); }
        public string Version() { return "1.2"; }
        public void StartMiniDrag() { f.BeginInvoke((Action)(() => { foreach (var m in f.Minis) m.StartDrag(); })); }
        public void SetDark(bool dark) { f.BeginInvoke((Action)(() => TitleBar.Dark = dark)); }

        /* book folders */
        public string PickFolder() { return f.PickFolder(); }
        public string GetFolders() { try { return File.Exists(f.FoldersFile) ? File.ReadAllText(f.FoldersFile, Encoding.UTF8) : ""; } catch { return ""; } }
        public void SetFolders(string newlineSeparated)
        {
            try { File.WriteAllText(f.FoldersFile, newlineSeparated ?? "", Encoding.UTF8); } catch { }
            f.SetRoots((newlineSeparated ?? "").Split('\n'));
        }

        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // lists every PDF and EPUB under a folder, in the background; the answer arrives as a
        // web message { id, files: [[fullPath, size, modifiedMs], ...], error }
        public void ScanBooks(string root, string id)
        {
            Task.Run(() =>
            {
                var sb = new StringBuilder();
                string err = null; int n = 0;
                sb.Append("{\"id\":").Append(J(id)).Append(",\"files\":[");
                try
                {
                    var top = new DirectoryInfo(root);
                    if (!top.Exists) throw new Exception("Folder not found: " + root);
                    var stack = new Stack<DirectoryInfo>();
                    stack.Push(top);
                    while (stack.Count > 0)
                    {
                        var d = stack.Pop();
                        FileSystemInfo[] items;
                        try { items = d.GetFileSystemInfos(); } catch { continue; }
                        foreach (var it in items)
                        {
                            if ((it.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                            var dir = it as DirectoryInfo;
                            if (dir != null) { if ((dir.Attributes & FileAttributes.ReparsePoint) == 0) stack.Push(dir); continue; }
                            var fi = (FileInfo)it;
                            string ext = fi.Extension.ToLowerInvariant();
                            if (ext != ".pdf" && ext != ".epub") continue;
                            if (n++ > 0) sb.Append(',');
                            sb.Append('[').Append(J(fi.FullName)).Append(',').Append(fi.Length).Append(',')
                              .Append((long)(fi.LastWriteTimeUtc - Epoch).TotalMilliseconds).Append(']');
                        }
                    }
                }
                catch (Exception ex) { err = ex.Message; }
                sb.Append("],\"error\":").Append(err == null ? "null" : J(err)).Append('}');
                string json = sb.ToString();
                try { f.BeginInvoke((Action)(() => f.Post(json))); } catch { }
            });
        }

        static string J(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c); break;
                }
            }
            return sb.Append('"').ToString();
        }
    }

    /* ---------- Windows COM interfaces ---------- */
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct THUMBBUTTON
    {
        public uint dwMask;
        public uint iId;
        public uint iBitmap;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szTip;
        public uint dwFlags;
    }

    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool full);
        void SetProgressValue(IntPtr hwnd, ulong done, ulong total);
        void SetProgressState(IntPtr hwnd, int flags);
        void RegisterTab(IntPtr tab, IntPtr main);
        void UnregisterTab(IntPtr tab);
        void SetTabOrder(IntPtr tab, IntPtr before);
        void SetTabActive(IntPtr tab, IntPtr main, uint reserved);
        [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint count, [MarshalAs(UnmanagedType.LPArray)] THUMBBUTTON[] buttons);
        [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint count, [MarshalAs(UnmanagedType.LPArray)] THUMBBUTTON[] buttons);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
        void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string tip);
        void SetThumbnailClip(IntPtr hwnd, IntPtr rect);
    }

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
    class TaskbarListRCW { }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"), ClassInterface(ClassInterfaceType.None)]
    class FileOpenDialogRCW { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int where);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IntPtr items);
        void GetSelectedItems(out IntPtr items);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint sigdn, out IntPtr name);
        void GetAttributes(uint mask, out uint attrs);
        void Compare(IShellItem other, uint hint, out int order);
    }
}
