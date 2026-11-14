package app.margin.reader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps Margin reading aloud with the screen off or while other apps are open, and puts
 * play / pause / previous / next on the lock screen, in the notification and on headphones.
 */
public class PlaybackService extends Service {
    static final String CHANNEL = "playback";
    static final int ID = 7;
    static PlaybackService running;
    private static boolean lastPlaying;
    private static String lastText = "";

    private MediaSessionCompat session;
    private PowerManager.WakeLock lock;
    private boolean playing;
    private String text = "";

    /** called by the page (SetPlaying) whenever reading aloud starts, pauses or moves on */
    static void update(Context c, boolean isPlaying, String tooltip) {
        lastPlaying = isPlaying;
        lastText = tooltip == null ? "" : tooltip;
        if (running != null) {
            final PlaybackService s = running;
            s.mainHandler().post(() -> s.apply(lastPlaying, lastText));
        } else if (isPlaying) {
            try { ContextCompat.startForegroundService(c, new Intent(c, PlaybackService.class)); } catch (Exception ignored) { }
        }
    }

    static void stop(Context c) {
        if (running != null) running.shutdown();
    }

    private android.os.Handler handler;
    private android.os.Handler mainHandler() {
        if (handler == null) handler = new android.os.Handler(android.os.Looper.getMainLooper());
        return handler;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Reading aloud", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Play, pause and skip while Margin reads to you");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "Margin");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { cmd("toggle"); }
            @Override public void onPause() { cmd("toggle"); }
            @Override public void onSkipToNext() { cmd("next"); }
            @Override public void onSkipToPrevious() { cmd("prev"); }
            @Override public void onStop() { cmd("stop"); }
        });
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Margin:reading");
        lock.setReferenceCounted(false);
        // must become a foreground service straight away
        startInForeground(build(lastPlaying, lastText));
        apply(lastPlaying, lastText);
    }

    private void startInForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(ID, n);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent == null ? null : intent.getAction();
        if ("close".equals(act)) { cmd("stop"); shutdown(); return START_NOT_STICKY; }
        if (act != null) cmd(act);
        return START_NOT_STICKY;
    }

    private void cmd(String c) {
        MainActivity m = MainActivity.current;
        if (m != null) m.js("window.marginHost && marginHost.cmd(" + org.json.JSONObject.quote(c) + ")");
        else if ("stop".equals(c) || "toggle".equals(c)) shutdown();
    }

    void apply(boolean isPlaying, String tooltip) {
        playing = isPlaying;
        text = tooltip == null ? "" : tooltip;
        if (playing) lock.acquire(3 * 60 * 60 * 1000L); else if (lock.isHeld()) lock.release();
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_STOP;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
        String[] parts = split(text);
        session.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, parts[1])
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, parts[0])
                .build());
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(ID, build(playing, text));
    }

    /** "Chapter 3 · the sentence being read" → { "Chapter 3", "the sentence…" } */
    private static String[] split(String t) {
        int i = t.indexOf(" · ");
        if (i < 0) return new String[] { "Margin", t.isEmpty() ? "Margin" : t };
        return new String[] { t.substring(0, i), t.substring(i + 3) };
    }

    private PendingIntent action(String a, int code) {
        Intent i = new Intent(this, PlaybackService.class).setAction(a);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build(boolean isPlaying, String tooltip) {
        String[] parts = split(tooltip == null ? "" : tooltip);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(parts[0])
                .setContentText(parts[1])
                .setContentIntent(content)
                .setOngoing(isPlaying)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setDeleteIntent(action("close", 5))
                .addAction(android.R.drawable.ic_media_previous, "Previous sentence", action("prev", 1))
                .addAction(isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, isPlaying ? "Pause" : "Play", action("toggle", 2))
                .addAction(android.R.drawable.ic_media_next, "Next sentence", action("next", 3))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", action("close", 4))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .build();
    }

    void shutdown() {
        if (lock != null && lock.isHeld()) lock.release();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = null;
        if (lock != null && lock.isHeld()) lock.release();
        if (session != null) session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
