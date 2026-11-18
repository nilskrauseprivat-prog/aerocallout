package org.aerocallout.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * AeroCallout for Android: hosts the AeroCallout web app (packaged in the APK) in a WebView and adds
 *  - native text-to-speech (Android voices, offline), exposed to JavaScript as window.AndroidTTS
 *  - a built-in ADS-B proxy (the open ADS-B APIs send no CORS headers, a native request does not need them)
 *  - GPS permission handling and keep-screen-on.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/www/index.html";
    private static final int REQ_LOCATION = 1;
    private static final Pattern SAFE_PATH = Pattern.compile("^[A-Za-z0-9/._-]+$");
    private static final Map<String, String> PROXY = new HashMap<>();
    static {
        PROXY.put("adsblol", "https://api.adsb.lol");
        PROXY.put("adsbfi", "https://opendata.adsb.fi/api");
    }

    private WebView web;
    private volatile int insetL = 0, insetR = 0, insetB = 0;   // system bar areas (px), see onCreate
    /** The running app (for the Android Auto screen, which reads its state from the web app). */
    static volatile MainActivity current;

    /** Run JavaScript in the web app; result (JSON string) is delivered on the main thread, null if not running. */
    static void evalJs(String js, android.webkit.ValueCallback<String> cb) {
        MainActivity a = current;
        if (a == null || a.web == null) { if (cb != null) cb.onReceiveValue(null); return; }
        a.ui.post(() -> { if (a.web != null) a.web.evaluateJavascript(js, cb); else if (cb != null) cb.onReceiveValue(null); });
    }

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // Native GNSS (more reliable than the WebView geolocation API: 1-2 Hz, speed/bearing from Doppler, satellites)
    private LocationManager lm;
    private boolean gpsWanted = false;
    private boolean gpsRunning = false;
    private volatile int satsUsed = 0;
    private volatile int satsVisible = 0;
    private volatile long lastGnssFix = 0;
    private final LocationListener locListener = this::pushFix;

    // Motion / environment sensors (averaged to 10 Hz for the attitude filter in JavaScript)
    private SensorManager sm;
    private boolean sensorsRunning = false;
    private final Object sensorLock = new Object();
    private final float[] gyroSum = new float[3];
    private final float[] gyroSysBias = new float[3];
    private final float[] accSum = new float[3];
    private int gyroN = 0, accN = 0;
    private float[] rotVec = null;
    private float pressure = Float.NaN;
    private volatile float declination = 0f;
    private volatile boolean hasDeclination = false;
    private final SensorEventListener sensorListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent e) {
            synchronized (sensorLock) {
                switch (e.sensor.getType()) {
                    case Sensor.TYPE_GYROSCOPE_UNCALIBRATED:   // raw rates (rad/s) + Android's own drift estimate
                        for (int i = 0; i < 3; i++) { gyroSum[i] += e.values[i]; gyroSysBias[i] = e.values[3 + i]; }
                        gyroN++;
                        break;
                    case Sensor.TYPE_GYROSCOPE:                // fallback if no uncalibrated gyro exists
                        if (sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE_UNCALIBRATED) == null) {
                            for (int i = 0; i < 3; i++) gyroSum[i] += e.values[i];
                            gyroN++;
                        }
                        break;
                    case Sensor.TYPE_ACCELEROMETER:
                        for (int i = 0; i < 3; i++) accSum[i] += e.values[i];
                        accN++;
                        break;
                    case Sensor.TYPE_ROTATION_VECTOR:
                        rotVec = e.values.clone();
                        break;
                    case Sensor.TYPE_PRESSURE:
                        pressure = e.values[0];
                        break;
                    default:
                        break;
                }
            }
        }
        @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }
    };
    private long lastPump = 0;
    private final Runnable sensorPump = new Runnable() {
        @Override
        public void run() {
            if (!sensorsRunning) return;
            long now = System.currentTimeMillis();
            try {
                JSONObject o = new JSONObject();
                synchronized (sensorLock) {
                    o.put("dt", lastPump == 0 ? 0.05 : (now - lastPump) / 1000.0);
                    if (gyroN > 0) o.put("g", new JSONArray(new double[]{gyroSum[0] / gyroN, gyroSum[1] / gyroN, gyroSum[2] / gyroN}));
                    o.put("gb", new JSONArray(new double[]{gyroSysBias[0], gyroSysBias[1], gyroSysBias[2]}));
                    if (accN > 0) o.put("a", new JSONArray(new double[]{accSum[0] / accN, accSum[1] / accN, accSum[2] / accN}));
                    if (rotVec != null) {
                        float[] r = new float[9];
                        SensorManager.getRotationMatrixFromVector(r, rotVec);   // device -> world (east, north, up), magnetic north
                        double[] rd = new double[9];
                        for (int i = 0; i < 9; i++) rd[i] = r[i];
                        o.put("rm", new JSONArray(rd));
                    }
                    if (!Float.isNaN(pressure)) o.put("p", pressure);
                    gyroSum[0] = gyroSum[1] = gyroSum[2] = 0; accSum[0] = accSum[1] = accSum[2] = 0;
                    gyroN = 0; accN = 0;
                }
                if (hasDeclination) o.put("decl", declination);
                o.put("t", now);
                lastPump = now;
                final String js = "window.__imu && window.__imu(" + o + ")";
                if (web != null) web.evaluateJavascript(js, null);
            } catch (Exception ignored) { }
            ui.postDelayed(this, 50);   // 20 Hz: smooth heading / attitude on the display
        }
    };
    private final GnssStatus.Callback gnssCallback = new GnssStatus.Callback() {
        @Override
        public void onSatelliteStatusChanged(GnssStatus status) {
            int used = 0;
            for (int i = 0; i < status.getSatelliteCount(); i++) if (status.usedInFix(i)) used++;
            satsUsed = used;
            satsVisible = status.getSatelliteCount();
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Screen: kept on or allowed to sleep (setting in the app, see PowerBridge.setKeepScreenOn).
        // The activity may be shown over the lock screen, so a warning can be seen without unlocking.
        setShowWhenLocked(true);
        // Allow inspection with Chrome DevTools in debug builds only.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // The page must keep working when the app is not on screen (phone locked, other app, Android Auto):
        // a WebView whose window is hidden gets its page frozen (no timers, no network results). So the WebView
        // always reports its window as visible; drawing still stops by itself while nothing is on screen.
        web = new WebView(this) {
            @Override
            protected void onWindowVisibilityChanged(int visibility) {
                super.onWindowVisibilityChanged(View.VISIBLE);
            }
        };
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        // Areas covered by system bars even in immersive mode (e.g. the gesture / navigation area at the bottom in
        // landscape): reported to the web app (AndroidPower.insets()), which keeps its content out of them.
        web.setOnApplyWindowInsetsListener((v, ins) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = ins.getInsetsIgnoringVisibility(android.view.WindowInsets.Type.navigationBars());
                insetL = i.left; insetR = i.right; insetB = i.bottom;
            } else {
                insetL = ins.getStableInsetLeft(); insetR = ins.getStableInsetRight(); insetB = ins.getStableInsetBottom();
            }
            return v.onApplyWindowInsets(ins);
        });
        web.setBackgroundColor(0xFF0B0D10);
        setContentView(web);
        current = this;

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost()) && uri.getPath() != null && uri.getPath().startsWith("/www/proxy/")) {
                    return proxy(uri.getPath().substring("/www/proxy/".length()));
                }
                return assets.shouldInterceptRequest(uri);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());   // stay inside the app
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestLocationPermission();
                }
            }
        });

        web.addJavascriptInterface(new TtsBridge(), "AndroidTTS");
        web.addJavascriptInterface(new GpsBridge(), "AndroidGPS");
        web.addJavascriptInterface(new SensorBridge(), "AndroidSensors");
        web.addJavascriptInterface(new PowerBridge(), "AndroidPower");
        initTts();

        if (!hasLocationPermission()) requestLocationPermission();
        web.loadUrl(START_URL);
    }

    // ------------------------------------------------------------------ location permission

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestLocationPermission() {
        requestPermissions(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
        }
        if (requestCode == REQ_LOCATION && gpsWanted && hasLocationPermission()) startGps();
    }

    // ------------------------------------------------------------------ native GNSS

    @SuppressLint("MissingPermission")
    private void startGps() {
        gpsWanted = true;
        if (gpsRunning) return;
        if (!hasLocationPermission()) { requestLocationPermission(); return; }
        if (lm == null) lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 500, 0f, locListener, Looper.getMainLooper());
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2000, 0f, locListener, Looper.getMainLooper());
            }
            lm.registerGnssStatusCallback(gnssCallback, ui);
            Location last = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) last = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (last != null && System.currentTimeMillis() - last.getTime() < 120000) pushFix(last);
            gpsRunning = true;
        } catch (Exception ignored) { }
    }

    private void stopGps() {
        gpsWanted = false;
        if (lm != null && gpsRunning) {
            lm.removeUpdates(locListener);
            lm.unregisterGnssStatusCallback(gnssCallback);
        }
        gpsRunning = false;
    }

    private void pushFix(Location l) {
        boolean gnss = LocationManager.GPS_PROVIDER.equals(l.getProvider());
        long now = System.currentTimeMillis();
        try {   // magnetic declination at the current position (for true heading from the compass)
            GeomagneticField gf = new GeomagneticField((float) l.getLatitude(), (float) l.getLongitude(), (float) l.getAltitude(), now);
            declination = gf.getDeclination();
            hasDeclination = true;
        } catch (Exception ignored) { }
        if (gnss) lastGnssFix = now;
        else if (now - lastGnssFix < 5000) return;   // a real GNSS fix is available: ignore network positions
        try {
            JSONObject o = new JSONObject();
            o.put("lat", l.getLatitude());
            o.put("lon", l.getLongitude());
            if (l.hasAltitude()) o.put("alt", l.getAltitude());           // metres above WGS-84 ellipsoid
            if (l.hasAccuracy()) o.put("acc", l.getAccuracy());
            if (l.hasVerticalAccuracy()) o.put("altAcc", l.getVerticalAccuracyMeters());
            if (l.hasSpeed()) o.put("speed", l.getSpeed());
            if (l.hasBearing()) o.put("bearing", l.getBearing());
            o.put("t", l.getTime());
            o.put("provider", gnss ? "gnss" : "network");
            o.put("sats", satsUsed);
            o.put("satsVisible", satsVisible);
            final String js = "window.__gpsFix && window.__gpsFix(" + o + ")";
            ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ background operation, screen wake

    private boolean resumed = false;
    private boolean tickerRunning = false;
    private android.os.PowerManager.WakeLock screenLock;

    /** The app logic is clocked from here (2 Hz) - also while the screen is off, where browser timers are throttled. */
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (!tickerRunning) return;
            if (web != null) web.evaluateJavascript("window.AC && AC.App && AC.App.tick && AC.App.tick()", null);
            ui.postDelayed(this, 500);
        }
    };

    @Override protected void onResume() { super.onResume(); resumed = true; }
    @Override protected void onPause() { super.onPause(); resumed = false; }

    private void startMonitoring() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2);
        }
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception ignored) { }
        startForegroundService(new Intent(this, MonitorService.class));
    }

    private void stopMonitoring() {
        stopService(new Intent(this, MonitorService.class));
    }

    /**
     * Wake the screen for an alert and show the app (also over the lock screen).
     * If the app is not in front, a full-screen notification brings it up.
     */
    @SuppressWarnings("deprecation")
    private void wakeForAlert(String text) {
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean screenOn = pm.isInteractive();
        if (screenOn && resumed && !km.isKeyguardLocked()) return;   // already visible
        setTurnScreenOn(true);
        setShowWhenLocked(true);
        if (screenLock == null) {
            screenLock = pm.newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                    | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP | android.os.PowerManager.ON_AFTER_RELEASE, "AeroCallout:alert");
            screenLock.setReferenceCounted(false);
        }
        screenLock.acquire(30000);      // screen stays on 30 s per alert, then normal timeout
        if (!resumed) {
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(this, MonitorService.CHANNEL_ALERT)
                    .setContentTitle("AeroCallout")
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setFullScreenIntent(pi, true)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setTimeoutAfter(20000)
                    .build();
            getSystemService(NotificationManager.class).notify(2, n);
            try { startActivity(open); } catch (Exception ignored) { }
        }
    }

    /** JavaScript interface: window.AndroidPower */
    private class PowerBridge {
        @JavascriptInterface
        public void startTicker() { ui.post(() -> { if (!tickerRunning) { tickerRunning = true; ui.postDelayed(ticker, 500); } }); }

        @JavascriptInterface
        public void startMonitoring() { ui.post(MainActivity.this::startMonitoring); }

        @JavascriptInterface
        public void stopMonitoring() { ui.post(MainActivity.this::stopMonitoring); }

        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            ui.post(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void wake(String text) { ui.post(() -> wakeForAlert(text)); }

        /** System bar areas covering the page, in CSS px: {"l":..,"r":..,"b":..}. */
        @JavascriptInterface
        public String insets() {
            float d = getResources().getDisplayMetrics().density;
            return "{\"l\":" + Math.round(insetL / d) + ",\"r\":" + Math.round(insetR / d) + ",\"b\":" + Math.round(insetB / d) + "}";
        }

        @JavascriptInterface
        public String state() {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            JSONObject o = new JSONObject();
            try {
                o.put("screenOn", pm.isInteractive());
                o.put("locked", km.isKeyguardLocked());
                o.put("resumed", resumed);
                o.put("batteryExempt", pm.isIgnoringBatteryOptimizations(getPackageName()));
            } catch (Exception ignored) { }
            return o.toString();
        }
    }

    // ------------------------------------------------------------------ motion sensors

    private void startSensors() {
        if (sensorsRunning) return;
        sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        int[] fast = {Sensor.TYPE_GYROSCOPE_UNCALIBRATED, Sensor.TYPE_GYROSCOPE, Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_ROTATION_VECTOR};
        for (int type : fast) {
            Sensor s = sm.getDefaultSensor(type);
            if (s != null) sm.registerListener(sensorListener, s, SensorManager.SENSOR_DELAY_GAME);
        }
        Sensor p = sm.getDefaultSensor(Sensor.TYPE_PRESSURE);
        if (p != null) sm.registerListener(sensorListener, p, SensorManager.SENSOR_DELAY_UI);
        sensorsRunning = true;
        lastPump = 0;
        ui.postDelayed(sensorPump, 50);
    }

    private void stopSensors() {
        if (sm != null) sm.unregisterListener(sensorListener);
        sensorsRunning = false;
    }

    /** JavaScript interface: window.AndroidSensors */
    private class SensorBridge {
        @JavascriptInterface
        public void start() { ui.post(MainActivity.this::startSensors); }

        @JavascriptInterface
        public void stop() { ui.post(MainActivity.this::stopSensors); }

        @JavascriptInterface
        public String available() {
            JSONObject o = new JSONObject();
            try {
                SensorManager m = (SensorManager) getSystemService(SENSOR_SERVICE);
                o.put("gyro", m.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null);
                o.put("gyroRaw", m.getDefaultSensor(Sensor.TYPE_GYROSCOPE_UNCALIBRATED) != null);
                o.put("accel", m.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null);
                o.put("mag", m.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null);
                o.put("baro", m.getDefaultSensor(Sensor.TYPE_PRESSURE) != null);
            } catch (Exception ignored) { }
            return o.toString();
        }
    }

    /** JavaScript interface: window.AndroidGPS */
    private class GpsBridge {
        @JavascriptInterface
        public void start() { ui.post(MainActivity.this::startGps); }

        @JavascriptInterface
        public void stop() { ui.post(MainActivity.this::stopGps); }

        @JavascriptInterface
        public String status() {
            JSONObject o = new JSONObject();
            try {
                LocationManager m = (LocationManager) getSystemService(LOCATION_SERVICE);
                o.put("permission", hasLocationPermission());
                o.put("gpsEnabled", m.isProviderEnabled(LocationManager.GPS_PROVIDER));
                o.put("networkEnabled", m.isProviderEnabled(LocationManager.NETWORK_PROVIDER));
                o.put("running", gpsRunning);
                o.put("sats", satsUsed);
                o.put("satsVisible", satsVisible);
                o.put("lastGnssFixAgeMs", lastGnssFix == 0 ? -1 : System.currentTimeMillis() - lastGnssFix);
            } catch (Exception ignored) { }
            return o.toString();
        }
    }

    // ------------------------------------------------------------------ ADS-B proxy

    private WebResourceResponse proxy(String path) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        int slash = path.indexOf('/');
        String base = slash > 0 ? PROXY.get(path.substring(0, slash)) : null;
        String rest = slash > 0 ? path.substring(slash + 1) : "";
        if (base == null || !SAFE_PATH.matcher(rest).matches()) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        }
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/" + rest).openConnection();
            c.setConnectTimeout(7000);
            c.setReadTimeout(7000);
            c.setRequestProperty("User-Agent", "AeroCallout/0.3 (open-source traffic awareness; Android)");
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] body = in != null ? readAll(in) : new byte[0];
            String reason = c.getResponseMessage() != null ? c.getResponseMessage() : (code < 400 ? "OK" : "Error");
            return new WebResourceResponse("application/json", "utf-8", code, reason, headers, new ByteArrayInputStream(body));
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", headers, new ByteArrayInputStream(new byte[0]));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    // ------------------------------------------------------------------ text to speech

    private static final android.media.AudioAttributes CALLOUT_AUDIO = new android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    private android.media.AudioFocusRequest focusReq;

    /** Short audio focus for one callout (music is lowered meanwhile; in the car this routes the speech). */
    private void requestFocus() {
        try {
            android.media.AudioManager am = getSystemService(android.media.AudioManager.class);
            if (focusReq == null) {
                focusReq = new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(CALLOUT_AUDIO).build();
            }
            am.requestAudioFocus(focusReq);
        } catch (Exception ignored) { }
    }

    private void releaseFocus() {
        try {
            if (focusReq != null) getSystemService(android.media.AudioManager.class).abandonAudioFocusRequest(focusReq);
        } catch (Exception ignored) { }
    }

    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                // Callouts are navigation-guidance speech: Android Auto plays them through the car speakers
                // (and ducks music), on the phone they use the normal speaker as before.
                tts.setAudioAttributes(CALLOUT_AUDIO);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { jsEvent(id, "start", ""); }
                    @Override public void onDone(String id) { releaseFocus(); jsEvent(id, "done", ""); }
                    @Override public void onError(String id) { releaseFocus(); jsEvent(id, "error", "synthesis-failed"); }
                    @Override public void onError(String id, int code) { releaseFocus(); jsEvent(id, "error", "synthesis-failed-" + code); }
                    @Override public void onStop(String id, boolean interrupted) { releaseFocus(); jsEvent(id, "error", "interrupted"); }
                });
            }
            jsEvent("", "voices", "");
        });
    }

    private void jsEvent(String id, String type, String err) {
        final String js = "window.__ttsEvent && window.__ttsEvent(" + JSONObject.quote(id) + "," +
                JSONObject.quote(type) + "," + JSONObject.quote(err) + ")";
        ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    /** JavaScript interface: window.AndroidTTS */
    private class TtsBridge {
        @JavascriptInterface
        public boolean ready() { return ttsReady; }

        @JavascriptInterface
        public String voices() {
            JSONArray arr = new JSONArray();
            if (!ttsReady) return arr.toString();
            try {
                Set<Voice> vs = tts.getVoices();
                if (vs == null) return arr.toString();
                for (Voice v : vs) {
                    String lang = v.getLocale().getLanguage();
                    if (!"en".equals(lang) && !"de".equals(lang)) continue;
                    if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("network", v.isNetworkConnectionRequired());
                    arr.put(o);
                }
            } catch (Exception ignored) { }
            return arr.toString();
        }

        @JavascriptInterface
        public boolean speak(String text, String voiceName, String lang, float rate, float pitch, float volume, String id) {
            if (!ttsReady) return false;
            Voice chosen = null;
            if (voiceName != null && !voiceName.isEmpty() && tts.getVoices() != null) {
                for (Voice v : tts.getVoices()) if (v.getName().equals(voiceName)) { chosen = v; break; }
            }
            if (chosen != null) tts.setVoice(chosen);
            else if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate > 0 ? rate : 1f);
            tts.setPitch(pitch > 0 ? pitch : 1f);
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, Math.max(0f, Math.min(1f, volume)));
            requestFocus();
            return tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) == TextToSpeech.SUCCESS;
        }

        @JavascriptInterface
        public void stop() {
            if (ttsReady) tts.stop();
        }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        tickerRunning = false;
        stopMonitoring();
        stopGps();
        stopSensors();
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            // Immersive full screen (status and navigation bar hidden, swipe from the edge shows them).
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
