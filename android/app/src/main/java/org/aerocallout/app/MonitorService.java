package org.aerocallout.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground service: keeps AeroCallout (GPS, sensors, ADS-B, alerts, speech) running while the screen
 * is off or the phone is locked. Shows a permanent notification and holds a partial wake lock (CPU on).
 */
public class MonitorService extends Service {
    static final String CHANNEL = "monitor";
    static final String CHANNEL_ALERT = "alerts";
    private PowerManager.WakeLock cpuLock;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Überwachung", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERT, "Verkehrs- und Geländewarnungen", NotificationManager.IMPORTANCE_HIGH);
        alerts.setSound(null, null);   // the spoken callout is the sound
        nm.createNotificationChannel(alerts);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("AeroCallout überwacht")
                .setContentText("Verkehr, Gelände und Hindernisse – Warnungen auch bei ausgeschaltetem Bildschirm")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(1, n);
        }
        if (cpuLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AeroCallout:monitor");
            cpuLock.setReferenceCounted(false);
        }
        if (!cpuLock.isHeld()) cpuLock.acquire();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
