package org.aerocallout.app;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Surface;

import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.List;

/**
 * Car screen (Android Auto): TCAS-style traffic display in the look of the phone app, laid out for wide car
 * displays (e.g. VW ID.3, about 1920 x 720): rose centred over the full height, status on the left,
 * a column of app-style softkeys on the right (range, WX/terrain, sensitivity, sound), weather / terrain
 * picture underneath. About 10 updates per second from AC.Car.state() of the running app on the phone.
 */
public class CarTrafficScreen extends Screen implements SurfaceCallback, DefaultLifecycleObserver {

    private static final int CYAN = 0xFF00E5FF, AMBER = 0xFFFFB000, RED = 0xFFFF2B2B, GREEN = 0xFF2BFF4A,
            WHITE = 0xFFEEF2F5, GREY = 0xFF8A919C, MAGENTA = 0xFFFF4DFF, EARTH = 0xFFD9893A;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Surface surface;
    private int sw, sh;
    private Rect visible;
    private JSONObject state;
    private long lastState = 0;
    private boolean polling = false, muted = false, startTried = false;
    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

    // layout (computed per frame)
    private float u = 1, cx, cy, R;
    private final List<Key> keyRects = new ArrayList<>();
    private String pressedKey = null;
    private long pressedAt = 0;

    // weather / terrain picture
    private Bitmap under;
    private JSONObject underPose;
    private long lastUnderReq = 0;
    private boolean underBusy = false;

    private static class Key { String k; RectF r; }
    private final List<Object[]> hits = new ArrayList<>();   // drawn aircraft symbols: {hex, x, y}
    private RectF cardRect;

    // keys: full size after a touch, compact status chips after 8 s without interaction
    private long lastTouch = System.currentTimeMillis();
    private boolean expanded() { return System.currentTimeMillis() - lastTouch < 8000; }

    // coarse road map (metres around a reference point, y = south so it matches screen orientation)
    private final Path[] roadPaths = {new Path(), new Path(), new Path(), new Path()};   // motorway, trunk, primary, runway
    private double roadLat, roadLon;
    private int roadsVer = -1;
    private boolean roadsBusy = false, haveRoads = false;
    private final Path tmpPath = new Path();

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!polling) return;
            MainActivity.evalJs("window.AC && AC.Car ? AC.Car.state() : null", (res) -> {
                try {
                    Object v = res == null ? null : new JSONTokener(res).nextValue();
                    if (v instanceof String) { state = new JSONObject((String) v); lastState = System.currentTimeMillis(); }
                } catch (Exception ignored) { }
                if (state != null && state.optBoolean("muted") != muted) { muted = state.optBoolean("muted"); invalidate(); }
                draw();
                if (state != null && "boot".equals(state.optString("phase"))) {
                    JSONObject info = state.optJSONObject("selftest");
                    if (info != null && "post".equals(info.optString("stage"))) startAnimIfNeeded();
                    else requestBootFrame();                                  // test pattern / result pages
                } else { bootBmp = null; requestUnderlay(); requestRoads(); }
            });
            if (MainActivity.current == null && !startTried) {
                // the phone app is not running: try to open it (needed for GPS, ADS-B and the callouts)
                startTried = true;
                try {
                    getCarContext().startActivity(new Intent(getCarContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) { }
            }
            ui.postDelayed(this, 100);
        }
    };

    public CarTrafficScreen(@NonNull CarContext ctx) {
        super(ctx);
        getLifecycle().addObserver(this);
        ctx.getCarService(AppManager.class).setSurfaceCallback(this);
    }

    @Override public void onStart(@NonNull LifecycleOwner o) { polling = true; ui.post(poll); }
    @Override public void onStop(@NonNull LifecycleOwner o) { polling = false; }

    // ---------------------------------------------------------------- template
    @NonNull
    @Override
    public Template onGetTemplate() {
        // The softkeys are drawn on the map surface; the action strip (required) holds the sound key.
        ActionStrip strip = new ActionStrip.Builder()
                .addAction(new Action.Builder().setTitle(muted ? "TON AN" : "TON AUS")
                        .setOnClickListener(() -> key("mute")).build())
                .build();
        return new NavigationTemplate.Builder().setActionStrip(strip).build();
    }

    private void key(String k) {
        pressedKey = k; pressedAt = System.currentTimeMillis();
        MainActivity.evalJs("window.AC && AC.Car && AC.Car.key('" + k + "')", null);
        lastUnderReq = 0;   // settings may have changed: new weather / terrain picture soon
        draw();
    }

    // ---------------------------------------------------------------- surface + touch
    @Override
    public void onSurfaceAvailable(@NonNull SurfaceContainer c) {
        surface = c.getSurface();
        sw = c.getWidth(); sh = c.getHeight();
        if (visible == null) visible = new Rect(0, 0, sw, sh);
        draw();
    }

    @Override public void onVisibleAreaChanged(@NonNull Rect r) { visible = new Rect(r); lastUnderReq = 0; draw(); }
    @Override public void onStableAreaChanged(@NonNull Rect r) { }
    @Override public void onSurfaceDestroyed(@NonNull SurfaceContainer c) { surface = null; }

    // ---------------------------------------------------------------- self test: check list (native, ~30 fps)
    private boolean animating = false;
    private JSONObject lastPost;
    private long lastPostT;
    private final Runnable anim = new Runnable() {
        @Override public void run() {
            JSONObject st = state;
            JSONObject info = st == null ? null : st.optJSONObject("selftest");
            boolean post = polling && st != null && "boot".equals(st.optString("phase")) && info != null && "post".equals(info.optString("stage"));
            if (!post) { animating = false; return; }
            draw();
            ui.postDelayed(this, 33);
        }
    };

    private void startAnimIfNeeded() {
        JSONObject st = state;
        JSONObject info = st == null ? null : st.optJSONObject("selftest");
        if (!animating && st != null && "boot".equals(st.optString("phase")) && info != null && "post".equals(info.optString("stage"))) {
            animating = true;
            ui.post(anim);
        }
    }

    /** Same layout and timing as SelfTest.postRuns() in the web app. */
    private void drawPost(Canvas c, Rect v, JSONObject info, long t) {
        c.drawColor(Color.BLACK);
        float uu = Math.min(v.width(), v.height()) / 500f;
        float fs = Math.round(15 * uu), lh = fs * 1.55f;
        float x0 = v.left + v.width() * 0.08f, y0 = v.top + v.height() * 0.16f;
        p.setTypeface(Typeface.MONOSPACE); p.setTextSize(fs);
        float cw = p.measureText("M");
        int lineDt = info.optInt("lineDt", 300), typeMs = info.optInt("typeMs", 230), resX = info.optInt("resX", 23);
        String head = "AEROCALLOUT TAS-1    SW 0.3.0", title = "POWER ON SELF TEST";
        text(c, head, x0, y0, WHITE, fs, Paint.Align.LEFT, false);
        int titleN = (int) Math.min(title.length(), Math.floor(t / (double) typeMs * title.length() / 1.2));
        text(c, title.substring(0, Math.max(0, titleN)), x0, y0 + 1.4f * lh, GREEN, fs, Paint.Align.LEFT, true);
        float curX = -1, curRow = -1;
        if (titleN < title.length()) { curX = titleN; curRow = 1.4f; }
        JSONArray items = info.optJSONArray("items");
        boolean anyPend = false;
        int n = items == null ? 0 : items.length();
        for (int i = 0; i < n; i++) {
            JSONObject it = items.optJSONObject(i);
            String label = it.optString("label"), res = it.optString("res");
            if ("PEND".equals(res)) anyPend = true;
            long tLine = t - (long) lineDt * (i + 1);
            if (tLine < 0) continue;
            float row = 2.6f + i * 1.05f, y = y0 + row * lh;
            int k = (int) Math.min(label.length(), Math.floor(tLine / (double) typeMs * label.length()));
            text(c, label.substring(0, Math.max(0, k)), x0, y, GREEN, fs, Paint.Align.LEFT, false);
            if (k < label.length()) { curX = k; curRow = row; continue; }
            if ("PEND".equals(res)) {
                String dots = "....".substring(0, 1 + (int) ((t / 160) % 4));
                text(c, dots, x0 + resX * cw, y, AMBER, fs, Paint.Align.LEFT, true);
            } else {
                boolean good = "PASS".equals(res) || "SIM".equals(res) || "OFF".equals(res);
                text(c, res, x0 + resX * cw, y, good ? GREEN : "FAIL".equals(res) ? RED : AMBER, fs, Paint.Align.LEFT, true);
            }
            if (i == n - 1) { curX = -1; }
            else if (t - (long) lineDt * (i + 2) < 0) { curX = 0; curRow = row + 1.05f; }
        }
        boolean allTyped = t >= (long) lineDt * (n + 1) + typeMs;
        if (allTyped && anyPend) {
            long left = Math.max(0, (long) Math.ceil((info.optLong("postMax", 15000) - t) / 1000.0));
            text(c, "WAITING FOR CHECKS ... " + left + " s", x0, y0 + (2.6f + n * 1.05f + 0.6f) * lh, AMBER, Math.round(12 * uu), Paint.Align.LEFT, false);
        }
        if (curX >= 0 && (t / 260) % 2 == 0) text(c, "█", x0 + curX * cw, y0 + curRow * lh, GREEN, fs, Paint.Align.LEFT, false);
    }

    // ---------------------------------------------------------------- self test pictures (about 4 per second)
    private Bitmap bootBmp;
    private long lastBootReq = 0;
    private boolean bootBusy = false;

    private void requestBootFrame() {
        long now = System.currentTimeMillis();
        if (bootBusy || visible == null || now - lastBootReq < 250) return;
        lastBootReq = now;
        bootBusy = true;
        int w = Math.max(2, visible.width() / 2), h = Math.max(2, visible.height() / 2);
        MainActivity.evalJs("window.AC && AC.Car ? AC.Car.bootFrame(" + w + "," + h + ") : ''", (res) -> {
            bootBusy = false;
            try {
                Object v = res == null ? null : new JSONTokener(res).nextValue();
                if (!(v instanceof String) || ((String) v).isEmpty()) return;
                String img = (String) v;
                byte[] b = Base64.decode(img.substring(img.indexOf(',') + 1), Base64.DEFAULT);
                Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
                if (bm != null) { bootBmp = bm; draw(); }
            } catch (Exception ignored) { }
        });
    }

    @Override
    public void onClick(float x, float y) {
        if (state != null && "boot".equals(state.optString("phase"))) {   // tap skips the self test (as on the phone)
            MainActivity.evalJs("window.AC && AC.SelfTest && AC.SelfTest.skip()", null);
            return;
        }
        // 1) a key (when the keys are shown)
        if (expanded()) {
            for (Key k : keyRects) {
                if (k.r.contains(x, y)) { lastTouch = System.currentTimeMillis(); key(k.k); return; }
            }
        }
        // 2) an aircraft symbol: open its info card (nearest symbol within ~30 px design units)
        String best = null; double bd = 30 * u;
        for (Object[] h : hits) {
            double d = Math.hypot((float) h[1] - x, (float) h[2] - y);
            if (d < bd) { bd = d; best = (String) h[0]; }
        }
        if (best != null) {
            MainActivity.evalJs("window.AC && AC.Car && AC.Car.select('" + best.replaceAll("[^A-Za-z0-9~]", "") + "')", null);
            return;
        }
        // 3) the open card: close it
        if (cardRect != null) {
            MainActivity.evalJs("window.AC && AC.Car && AC.Car.select(null)", null);
            cardRect = null;
            return;
        }
        // 4) anywhere else: show the keys
        lastTouch = System.currentTimeMillis();
        draw();
    }

    // ---------------------------------------------------------------- road map
    private Path[] loadingPaths;
    private int loadingVer = -1;
    private JSONArray loadingAp, airports;   // aerodrome markers [x, y, code, big] in metres around the road reference

    /** Fetch the road map chunk by chunk; the finished map replaces the old one in one step. */
    private void requestRoads() {
        JSONObject st = state;
        int want = st == null ? 0 : st.optInt("roadsVer", 0);
        if (st == null || roadsBusy || want == 0 || want == roadsVer) return;
        if (loadingVer != want) { loadingVer = want; loadingPaths = new Path[]{new Path(), new Path(), new Path(), new Path()}; loadingAp = null; loadChunk(0); }
    }

    private void loadChunk(int chunk) {
        roadsBusy = true;
        MainActivity.evalJs("window.AC && AC.Car ? AC.Car.roads(" + chunk + ") : null", (res) -> {
            try {
                Object v = res == null ? null : new JSONTokener(res).nextValue();
                if (!(v instanceof String)) { roadsBusy = false; loadingVer = -1; return; }
                JSONObject o = new JSONObject((String) v);
                if (o.optInt("ver") != loadingVer) { roadsBusy = false; loadingVer = -1; return; }   // data changed meanwhile
                int n = o.optInt("n");
                String d = o.optString("d", "");
                JSONArray ap = o.optJSONArray("ap");
                if (ap != null) loadingAp = ap;
                if (!d.isEmpty()) {
                    for (String way : d.split(";")) {
                        int colon = way.indexOf(':');
                        if (colon < 1) continue;
                        Path path = loadingPaths[Math.max(0, Math.min(3, Integer.parseInt(way.substring(0, colon))))];
                        String[] nums = way.substring(colon + 1).split(",");
                        float x = 0, y = 0;
                        for (int j = 0; j + 1 < nums.length; j += 2) {
                            x += Integer.parseInt(nums[j]) * 10f;
                            y += Integer.parseInt(nums[j + 1]) * 10f;
                            if (j == 0) path.moveTo(x, -y); else path.lineTo(x, -y);
                        }
                    }
                }
                if (chunk + 1 < n) { loadChunk(chunk + 1); return; }
                JSONObject ref = o.getJSONObject("ref");
                for (int i = 0; i < 4; i++) roadPaths[i].set(loadingPaths[i]);
                airports = loadingAp;
                roadLat = ref.getDouble("lat"); roadLon = ref.getDouble("lon");
                roadsVer = loadingVer;
                haveRoads = true;
            } catch (Exception ignored) { loadingVer = -1; }
            roadsBusy = false;
        });
    }

    /** Faint radar-style road lines, moved / turned with the own position and track. */
    private void drawRoads(Canvas c, Rect v, JSONObject st, float right) {
        if (!haveRoads || !st.has("lat")) return;
        double lat0 = st.optDouble("lat"), lon0 = st.optDouble("lon"), trk = st.optDouble("trk");
        double k = R / st.optDouble("rangeM", 1);
        double kLat = 6371008.8 * Math.PI / 180, kLon = kLat * Math.cos(Math.toRadians(roadLat));
        float ox = (float) ((lon0 - roadLon) * kLon), oy = (float) -((lat0 - roadLat) * kLat);
        Matrix m = new Matrix();
        m.setTranslate(-ox, -oy);
        m.postRotate((float) -trk);
        m.postScale((float) k, (float) k);
        m.postTranslate(cx, cy);
        // map settings from the app: mode (on / with terrain only / off), style (dark / light), opacity
        JSONObject ms = st.optJSONObject("map");
        String mode = ms == null ? "on" : ms.optString("mode", "on");
        if ("off".equals(mode) || ("terr".equals(mode) && !st.optBoolean("terr"))) return;
        float al = ms == null ? 0.6f : (float) ms.optDouble("alpha", 0.6);
        boolean light = ms != null && "light".equals(ms.optString("style"));
        int[] rgb = light ? new int[]{0xECF0F4, 0xD6DCE2, 0xBEC5CD} : new int[]{0x46D1A0, 0x38B88A, 0x2F9C76};
        float[] base = {0.75f, 0.6f, 0.45f};
        int[] col = new int[3];
        for (int i = 0; i < 3; i++) col[i] = ((int) (255 * Math.min(1, base[i] * al / 0.6f * 0.75f)) << 24) | rgb[i];
        float[] wid = {2.6f, 2.0f, 1.4f};
        c.save();
        c.clipRect(v.left, v.top, right, v.bottom);
        p.setStyle(Paint.Style.STROKE); p.setStrokeJoin(Paint.Join.ROUND); p.setStrokeCap(Paint.Cap.ROUND); p.setPathEffect(null); p.setShader(null);
        for (int i = 2; i >= 0; i--) {
            roadPaths[i].transform(m, tmpPath);
            p.setColor(col[i]); p.setStrokeWidth(wid[i] * u);
            c.drawPath(tmpPath, p);
        }
        // runways: short bright bars (like an approach chart), aerodromes: small ring + ICAO code
        roadPaths[3].transform(m, tmpPath);
        p.setStrokeCap(Paint.Cap.BUTT); p.setColor(0xD2C8D4DE); p.setStrokeWidth(3.6f * u);
        c.drawPath(tmpPath, p);
        JSONArray ap = airports;
        if (ap != null) {
            float[] pt = new float[2];
            for (int i = 0; i < ap.length(); i++) {
                JSONArray a = ap.optJSONArray(i);
                if (a == null) continue;
                pt[0] = (float) a.optDouble(0); pt[1] = (float) -a.optDouble(1);
                m.mapPoints(pt);
                if (pt[0] < v.left || pt[0] > right || pt[1] < v.top || pt[1] > v.bottom) continue;
                boolean big = a.optInt(3) == 1;
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.6f * u); p.setColor(0xB4AFC4D2);
                c.drawCircle(pt[0], pt[1], (big ? 9 : 6) * u, p);
                String code = a.optString(2);
                if (!code.isEmpty()) text(c, code, pt[0] + (big ? 12 : 9) * u, pt[1] - 6 * u, 0xD0AFC4D2, (big ? 12 : 10.5f) * u, Paint.Align.LEFT, big);
                p.setStyle(Paint.Style.STROKE);
            }
        }
        p.setStrokeCap(Paint.Cap.BUTT);
        c.restore();
    }

    // ---------------------------------------------------------------- weather / terrain picture
    private int underId = 0;

    /**
     * The web app renders a square picture around the ownship (covers the display at any heading) in the
     * background; it is requested about every 1.5 s and fetched when a new one is ready (underId).
     */
    private boolean prevWx = false, prevTerr = false;

    private void requestUnderlay() {
        JSONObject st = state;
        if (st == null || visible == null) return;
        // weather switched on / off (e.g. hidden during an alert): new picture right away
        if (st.optBoolean("wx") != prevWx || st.optBoolean("terr") != prevTerr) {
            prevWx = st.optBoolean("wx"); prevTerr = st.optBoolean("terr"); lastUnderReq = 0;
            if (!prevWx && prevTerr) under = null;     // the old picture may still contain weather
        }
        if (!st.optBoolean("wx") && !st.optBoolean("terr")) { under = null; return; }
        long now = System.currentTimeMillis();
        if (now - lastUnderReq > 1500 && !st.optBoolean("underBusy")) {
            lastUnderReq = now;
            // square = twice the distance from the rose centre to the farthest display corner (+5 %), 1/3 resolution
            float far = 0;
            float[][] corners = {{visible.left, visible.top}, {visible.right, visible.top}, {visible.left, visible.bottom}, {visible.right, visible.bottom}};
            for (float[] k : corners) far = Math.max(far, (float) Math.hypot(k[0] - cx, k[1] - cy));
            int size = (int) Math.ceil(far * 2.1f / 3f);
            MainActivity.evalJs(String.format(java.util.Locale.US, "window.AC && AC.Car && AC.Car.underlayReq(%d,%.1f)", size, R / 3f), null);
        }
        int id = st.optInt("underId", 0);
        if (id != 0 && id != underId && !underBusy) {
            underBusy = true;
            MainActivity.evalJs("window.AC && AC.Car ? AC.Car.underlayGet() : null", (res) -> {
                underBusy = false;
                try {
                    Object v = res == null ? null : new JSONTokener(res).nextValue();
                    if (!(v instanceof String)) return;
                    JSONObject o = new JSONObject((String) v);
                    String img = o.optString("img", "");
                    if (img.isEmpty()) return;
                    byte[] b = Base64.decode(img.substring(img.indexOf(',') + 1), Base64.DEFAULT);
                    Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
                    if (bm != null) { under = bm; underPose = o.getJSONObject("pose"); underId = o.optInt("id", id); }
                } catch (Exception ignored) { }
            });
        }
    }

    /** Draw the picture moved / rotated to the current position and track (same as applyPose in the web app). */
    private void drawUnderlay(Canvas c, JSONObject st) {
        Bitmap bm = under;
        JSONObject pz = underPose;
        if (bm == null || pz == null || !st.has("lat") || !(st.optBoolean("wx") || st.optBoolean("terr"))) return;
        double lat0 = st.optDouble("lat"), lon0 = st.optDouble("lon"), trk0 = st.optDouble("trk");
        double k0 = R / st.optDouble("rangeM", 1);
        double latp = pz.optDouble("lat"), lonp = pz.optDouble("lon"), trkp = pz.optDouble("trk"), kp = pz.optDouble("k");
        double kLat = 6371008.8 * Math.PI / 180, kLon = kLat * Math.cos(Math.toRadians(lat0));
        double x = (lonp - lon0) * kLon, y = (latp - lat0) * kLat;
        double t = Math.toRadians(trk0), cs = Math.cos(t), sn = Math.sin(t);
        float sx = (float) (cx + (x * cs - y * sn) * k0), sy = (float) (cy - (x * sn + y * cs) * k0);
        Matrix m = new Matrix();
        m.setTranslate((float) -pz.optDouble("cx"), (float) -pz.optDouble("cy"));
        m.postScale((float) (k0 / kp), (float) (k0 / kp));
        m.postRotate((float) (trkp - trk0));
        m.postTranslate(sx, sy);
        Paint bp = new Paint(Paint.FILTER_BITMAP_FLAG);
        c.save();
        c.clipRect(visible);
        c.drawBitmap(bm, m, bp);
        c.restore();
    }

    // ---------------------------------------------------------------- drawing
    private void draw() {
        Surface s = surface;
        if (s == null || !s.isValid()) return;
        Canvas cv;
        try { cv = s.lockCanvas(null); } catch (Exception e) { return; }
        try { paint(cv); } catch (Exception ignored) { } finally { s.unlockCanvasAndPost(cv); }
    }

    private float areaRight;          // right edge of the radar area (left of the key / status column)
    private boolean wasExpanded = true;

    private void layout(Rect v) {
        u = v.height() / 480f;                                   // design unit: 480 px high reference
        boolean ex = expanded();
        float colW = ex ? 118 * u : 96 * u, gap = 10 * u;
        // The map uses the whole display; keys / info chips float over its right edge.
        // areaRight = left edge of that column (texts and edge symbols stay left of it).
        areaRight = v.right - colW - 2 * gap;
        R = Math.min(v.height() * 0.40f, v.width() * 0.30f);
        cx = v.centerX();
        cy = v.top + v.height() * 0.53f;
        if (ex != wasExpanded) { wasExpanded = ex; lastUnderReq = 0; }   // rose moved: new picture soon
        keyRects.clear();
        if (!ex) return;
        String[] keys = {"rngUp", "rngDn", "terr", "sens", "carAlt", "mute"};   // same order as AC.Car.keys()
        float top = v.top + gap, kh = (v.height() - gap * (keys.length + 1)) / keys.length;
        for (int i = 0; i < keys.length; i++) {
            Key k = new Key();
            k.k = keys[i];
            k.r = new RectF(v.right - gap - colW, top + i * (kh + gap), v.right - gap, top + i * (kh + gap) + kh);
            keyRects.add(k);
        }
    }

    /** Compact status chips (keys hidden): range, overlay, sensitivity, sound. Tap anywhere to show the keys. */
    private void chips(Canvas c, Rect v, JSONObject st) throws Exception {
        JSONArray ks = st.optJSONArray("keys");
        if (ks == null) return;
        float gap = 10 * u, w = 96 * u, h = 46 * u, x0 = v.right - gap - w, y = v.top + gap;
        String[][] rows = new String[5][];
        boolean auto = st.optBoolean("autoRng");
        rows[0] = new String[]{auto ? "RNG · AUTO" : "RNG", st.optString("rng").replace("RNG ", ""), ks.getJSONObject(0).optString("c"), auto ? "2" : "0"};
        rows[1] = new String[]{"WX/TERR", ks.getJSONObject(2).optString("s"), ks.getJSONObject(2).optString("c"), ks.getJSONObject(2).optBoolean("on") ? "1" : "0"};
        rows[2] = new String[]{"SENS", ks.getJSONObject(3).optString("s"), ks.getJSONObject(3).optString("c"), "0"};
        rows[3] = new String[]{"HÖHE", ks.getJSONObject(4).optString("s"), ks.getJSONObject(4).optString("c"), ks.getJSONObject(4).optBoolean("on") ? "1" : "0"};
        rows[4] = new String[]{"TON", ks.getJSONObject(5).optString("s"), ks.getJSONObject(5).optString("c"), ks.getJSONObject(5).optBoolean("warn") ? "2" : "0"};
        for (String[] r : rows) {
            RectF rr = new RectF(x0, y, x0 + w, y + h);
            int col = Color.parseColor(r[2]);
            p.setShader(null); p.setStyle(Paint.Style.FILL); p.setColor(0xD81A1D22);
            c.drawRoundRect(rr, 7 * u, 7 * u, p);
            p.setColor(col);
            c.drawRect(rr.left, rr.top + 5 * u, rr.left + 4 * u, rr.bottom - 5 * u, p);
            text(c, r[0], rr.left + 11 * u, rr.top + 17 * u, 0xFFB4BCC6, 11.5f * u, Paint.Align.LEFT, false);
            int vc = "2".equals(r[3]) ? AMBER : "1".equals(r[3]) ? col : WHITE;
            text(c, r[1], rr.left + 11 * u, rr.top + 37 * u, vc, 15 * u, Paint.Align.LEFT, true);
            y += h + 7 * u;
        }
        text(c, "Tippen: Tasten", x0 + w / 2, y + 14 * u, GREY, 11 * u, Paint.Align.CENTER, false);
    }

    private void paint(Canvas c) throws Exception {
        c.drawColor(Color.BLACK);
        Rect v = visible != null ? visible : new Rect(0, 0, sw, sh);
        layout(v);
        JSONObject st = state;
        boolean fresh = st != null && System.currentTimeMillis() - lastState < 3000;
        JSONObject stInfo = fresh && "boot".equals(st.optString("phase")) ? st.optJSONObject("selftest") : null;
        if (stInfo != null && "post".equals(stInfo.optString("stage"))) {
            // power-on self test, check list: drawn natively at full frame rate (typed lines, running dots, cursor)
            long tl = stInfo.optLong("t") + (System.currentTimeMillis() - lastState);
            lastPost = stInfo; lastPostT = tl; bootBmp = null;
            drawPost(c, v, stInfo, tl);
            return;
        }
        if (stInfo != null && bootBmp == null && lastPost != null) {   // until the first test-pattern picture arrives
            drawPost(c, v, lastPost, lastPostT);
            return;
        }
        if (fresh && "boot".equals(st.optString("phase")) && bootBmp != null) {
            // power-up self test, same pictures as on the phone
            c.drawBitmap(bootBmp, null, new RectF(v), new Paint(Paint.FILTER_BITMAP_FLAG));
            return;
        }
        if (!fresh || !"run".equals(st.optString("phase"))) {
            String msg = MainActivity.current == null ? "AeroCallout auf dem Handy öffnen"
                    : (fresh && "boot".equals(st.optString("phase")) ? "Selbsttest läuft …" : "AeroCallout startet …");
            text(c, msg, v.centerX(), v.centerY(), AMBER, 22 * u, Paint.Align.CENTER, true);
            return;
        }
        float pad = 10 * u, fs = 17 * u, sm = 13 * u;
        double trk = st.optDouble("trk", 0);

        drawUnderlay(c, st);
        drawRoads(c, v, st, v.right);
        rings(c, v, st);
        rose(c, trk, st);

        if (st.optBoolean("noPos")) {
            text(c, "NO POSITION", cx, cy + 46 * u, AMBER, 20 * u, Paint.Align.CENTER, true);
        } else {
            JSONArray items = st.optJSONArray("items");
            hits.clear();
            if (items != null) {
                String[] order = {"other", "prox", "ta", "warn"};
                for (String lv : order) {
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject it = items.getJSONObject(i);
                        if (lv.equals(it.optString("lv"))) traffic(c, it, v);
                    }
                }
            }
        }
        obstacles(c, st);
        ownship(c);

        // left column: traffic system state
        float lx = v.left + pad, y = v.top + pad + fs;
        String tfc = st.optString("tfc");
        if ("red".equals(tfc)) box(c, "TFC", lx, y - fs, RED, fs, true, Paint.Align.LEFT);
        else text(c, "off".equals(tfc) ? "TFC OFF" : "TFC", lx, y, "green".equals(tfc) ? GREEN : AMBER, fs, Paint.Align.LEFT, true);
        y += fs * 1.3f;
        text(c, "TA ONLY", lx, y, WHITE, sm, Paint.Align.LEFT, false);
        y += sm * 1.35f;
        text(c, st.optString("sl"), lx, y, CYAN, sm, Paint.Align.LEFT, false);
        y += sm * 1.35f;
        text(c, "CAR · ALT IGN", lx, y, GREY, sm, Paint.Align.LEFT, false);
        if (st.optBoolean("sim")) { y += sm * 1.35f; text(c, "SIM", lx, y, MAGENTA, sm, Paint.Align.LEFT, true); }
        if (!st.optString("test").isEmpty()) { y += sm * 1.35f; text(c, st.optString("test"), lx, y, 0xCCFF4DFF, sm, Paint.Align.LEFT, false); }
        if (!st.optString("testStep").isEmpty()) { y += sm * 1.35f; text(c, st.optString("testStep"), lx, y, 0xCCFF4DFF, sm, Paint.Align.LEFT, false); }

        // right of the rose: overlay state
        float rx = areaRight - pad, ry = v.top + pad + fs;
        if (st.optBoolean("wx")) {
            text(c, st.optBoolean("wxLoading") ? "WX LOADING" : "WX", rx, ry, st.optBoolean("wxLoading") ? AMBER : GREEN, fs, Paint.Align.RIGHT, true);
            ry += fs * 1.3f;
        }
        if (st.optBoolean("terr")) { text(c, "TERR", rx, ry, EARTH, fs, Paint.Align.RIGHT, true); ry += fs * 1.3f; }

        // bottom left: data age, range
        float by = v.bottom - pad;
        boolean auto = st.optBoolean("autoRng");
        text(c, st.optString("rng"), lx, by, auto ? AMBER : CYAN, fs, Paint.Align.LEFT, true);
        int al = st.optInt("ageLvl");
        String age = st.optString("age");
        float ay = by - fs * 1.35f;
        if (al >= 2) box(c, age, lx, ay - sm * 1.1f, RED, sm, true, Paint.Align.LEFT);
        else text(c, age, lx, ay, al == 1 ? AMBER : GREEN, sm, Paint.Align.LEFT, true);
        // weather picture age (timer like ADS-B): green < 15 min, white < 20, amber < 30, red (blinking) from 30 min
        ay -= sm * 1.55f;
        String wxAge = st.optString("wxAge");
        if (!wxAge.isEmpty()) {
            int wl = st.optInt("wxAgeLvl");
            if (wl == 3) box(c, wxAge, lx, ay - sm * 1.1f, RED, sm, (System.currentTimeMillis() / 500) % 2 == 0, Paint.Align.LEFT);
            else if (wl == 2) box(c, wxAge, lx, ay - sm * 1.1f, AMBER, sm, true, Paint.Align.LEFT);
            else text(c, wxAge, lx, ay, wl == -1 ? MAGENTA : wl == 1 ? WHITE : GREEN, sm, Paint.Align.LEFT, true);
            ay -= sm * 1.55f;
        }
        // auto range active (the display zoomed to the alerting traffic / terrain / obstacle by itself)
        if (auto) box(c, "AUTO RNG", lx, ay - sm * 1.25f, AMBER, sm, false, Paint.Align.LEFT);
        // bottom right (left of keys): ground speed, faults
        text(c, st.optString("gs"), rx, by, WHITE, sm, Paint.Align.RIGHT, false);
        JSONArray faults = st.optJSONArray("faults");
        if (faults != null) {
            float fy = by - sm * 1.7f;
            for (int i = faults.length() - 1; i >= 0; i--) {
                box(c, faults.getString(i), rx, fy - sm * 1.35f, AMBER, sm, false, Paint.Align.RIGHT);
                fy -= sm * 1.9f;
            }
        }

        // main alert: two identical boxes left and right of the track box (as on the phone)
        JSONObject a = st.optJSONObject("alert");
        if (a != null && trkBox != null) {
            boolean red = a.optBoolean("red");
            boolean blink = red && (System.currentTimeMillis() / 500) % 2 == 0;
            int col = red ? RED : AMBER;
            float big = 20 * u, gap = 10 * u;
            float by2 = trkBox.centerY() - big * 1.35f / 2;
            box(c, a.optString("label"), trkBox.left - gap, by2, col, big, blink, Paint.Align.RIGHT);
            String lower = a.optString("lower");
            box(c, lower.isEmpty() ? a.optString("label") : lower, trkBox.right + gap, by2, col, big, blink && lower.isEmpty(), Paint.Align.LEFT);
        }
        card(c, v, st.optJSONObject("card"));
        if (expanded()) keys(c, st); else chips(c, v, st);
        // warning: pulsing red frame around the WHOLE display (drawn last, so it also encloses keys / chips)
        if (a != null && a.optBoolean("red")) {
            float pulse = 0.55f + 0.45f * (float) Math.abs(Math.sin(System.currentTimeMillis() / 280.0));
            p.setShader(null); p.setPathEffect(null);
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(7 * u); p.setColor(RED); p.setAlpha((int) (255 * pulse));
            c.drawRect(v.left + 3.5f * u, v.top + 3.5f * u, v.right - 3.5f * u, v.bottom - 3.5f * u, p);
            p.setAlpha(255);
        }
    }

    /** Info card of the tapped aircraft (floating panel on the left, like the key chips). */
    private void card(Canvas c, Rect v, JSONObject cd) {
        if (cd == null) { cardRect = null; return; }
        float pad = 12 * u, x0 = v.left + 10 * u, w = 330 * u, y = v.top + v.height() * 0.30f;
        String[][] lines = {
            {cd.optString("airline"), "13", "W"},
            {cd.optString("type"), "13", "W"},
            {cd.optString("route"), "17", "C"},
            {cd.optString("routeNames"), "11.5", "G"},
            {cd.optString("alt"), "13", "W"},
            {cd.optString("speed"), "13", "W"},
            {cd.optString("pos"), "12", "G"},
        };
        float h = pad + 22 * u;
        for (String[] l : lines) if (!l[0].isEmpty()) h += Float.parseFloat(l[1]) * u * 1.45f;
        h += pad * 0.5f;
        RectF r = new RectF(x0, y, x0 + w, y + h);
        cardRect = r;
        p.setShader(null); p.setPathEffect(null); p.setStyle(Paint.Style.FILL); p.setColor(0xE614171B);
        c.drawRoundRect(r, 10 * u, 10 * u, p);
        p.setColor(CYAN); c.drawRect(r.left, r.top + 8 * u, r.left + 4 * u, r.bottom - 8 * u, p);
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.2f * u); p.setColor(0xFF2A2F37);
        c.drawRoundRect(r, 10 * u, 10 * u, p);
        float tx = r.left + pad + 4 * u, ty = r.top + pad + 16 * u;
        text(c, cd.optString("title"), tx, ty, CYAN, 20 * u, Paint.Align.LEFT, true);
        String badge = cd.optString("badge");
        if (!badge.isEmpty()) {
            p.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)); p.setTextSize(20 * u);
            float bx = tx + p.measureText(cd.optString("title")) + 10 * u;
            int bc = "MIL".equals(badge) || "UAV".equals(badge) ? 0xFFE8D870 : "SIM".equals(badge) ? MAGENTA : WHITE;
            box(c, badge, bx, ty - 15 * u, bc, 11 * u, false, Paint.Align.LEFT);
        }
        text(c, "✕", r.right - pad, ty, GREY, 15 * u, Paint.Align.RIGHT, false);
        ty += 8 * u;
        for (String[] l : lines) {
            if (l[0].isEmpty()) continue;
            float fz = Float.parseFloat(l[1]) * u;
            ty += fz * 1.45f;
            int col = "C".equals(l[2]) ? WHITE : "G".equals(l[2]) ? 0xFFB4BCC6 : 0xFFDDE3E9;
            text(c, l[0], tx, ty, col, fz, Paint.Align.LEFT, "C".equals(l[2]));
        }
    }

    /** Obstacle causing an alert: chart-style tower symbol with pulsing ring and top altitude. */
    private void obstacles(Canvas c, JSONObject st) throws Exception {
        JSONArray obs = st.optJSONArray("obs");
        if (obs == null) return;
        for (int i = 0; i < obs.length(); i++) {
            JSONObject o = obs.getJSONObject(i);
            float x = cx + (float) o.optDouble("x") * R, y = cy - (float) o.optDouble("y") * R;
            int col = o.optBoolean("red") ? RED : AMBER;
            float sz = 1.6f * u;
            p.setShader(null); p.setPathEffect(null);
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(2.8f * u); p.setColor(col);
            Path t = new Path();
            t.moveTo(x - 5 * sz, y + 4 * sz); t.lineTo(x, y - 8 * sz); t.lineTo(x + 5 * sz, y + 4 * sz);
            c.drawPath(t, p);
            p.setStyle(Paint.Style.FILL); c.drawCircle(x, y + 4 * sz, 1.8f * sz, p);
            float f = (System.currentTimeMillis() % 900) / 900f;
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(2 * u); p.setAlpha((int) (255 * (1 - f)));
            c.drawCircle(x, y, 12 * u + f * 24 * u, p);
            p.setAlpha(255);
            text(c, o.optString("lbl"), x + 14 * u, y - 10 * u, col, 13 * u, Paint.Align.LEFT, true);
        }
    }

    private RectF trkBox;

    private void rose(Canvas c, double trk, JSONObject st) {
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.6f * u); p.setColor(WHITE); p.setPathEffect(null);
        c.drawCircle(cx, cy, R, p);
        for (int h = 0; h < 360; h += 5) {
            double a = Math.toRadians(h - trk);
            float len = (h % 10 == 0 ? 10 : 5) * u;
            float sx = (float) Math.sin(a), sy = (float) -Math.cos(a);
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.6f * u); p.setColor(WHITE);
            c.drawLine(cx + sx * R, cy + sy * R, cx + sx * (R - len), cy + sy * (R - len), p);
            if (h % 30 == 0) {
                String l = h == 0 ? "N" : h == 90 ? "E" : h == 180 ? "S" : h == 270 ? "W" : String.valueOf(h / 10);
                float lr = R - 24 * u;
                c.save();
                c.translate(cx + sx * lr, cy + sy * lr);
                c.rotate((float) (h - trk));
                text(c, l, 0, 5.5f * u, WHITE, 15 * u, Paint.Align.CENTER, true);
                c.restore();
            }
        }
        p.setStyle(Paint.Style.FILL); p.setColor(WHITE);
        for (int i = 0; i < 12; i++) {
            double a = Math.toRadians(i * 30);
            c.drawCircle(cx + (float) Math.sin(a) * R / 2, cy - (float) Math.cos(a) * R / 2, 2.2f * u, p);
        }
        // half-range label
        String rng = st.optString("rng").replace("RNG ", "");
        String[] rp = rng.split(" ");
        try {
            double half = Double.parseDouble(rp[0]) / 2;
            String hl = half == Math.floor(half) ? String.valueOf((int) half) : String.valueOf(half);
            text(c, hl, cx - R * 0.36f - 4 * u, cy - R * 0.36f, CYAN, 13 * u, Paint.Align.RIGHT, false);
        } catch (Exception ignored) { }
        // heading pointer + track box
        Path tri = new Path();
        tri.moveTo(cx, cy - R + 1); tri.lineTo(cx - 7 * u, cy - R - 11 * u); tri.lineTo(cx + 7 * u, cy - R - 11 * u); tri.close();
        p.setStyle(Paint.Style.FILL); p.setColor(WHITE); c.drawPath(tri, p);
        float hb = 17 * u;
        p.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)); p.setTextSize(hb);
        String box = st.optString("trkTxt");
        float bw = p.measureText(box) + 14 * u, bh = hb * 1.45f;
        trkBox = new RectF(cx - bw / 2, cy - R - 14 * u - bh, cx + bw / 2, cy - R - 14 * u);
        p.setColor(Color.BLACK); c.drawRect(trkBox, p);
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.3f * u); p.setColor(WHITE); c.drawRect(trkBox, p);
        text(c, box, cx, trkBox.centerY() + hb * 0.36f, GREEN, hb, Paint.Align.CENTER, true);
    }

    /** Dashed range rings beyond the rose (traffic is shown on the whole display, as on the phone). */
    private void rings(Canvas c, Rect v, JSONObject st) {
        float right = v.right;
        double rng;
        try { rng = Double.parseDouble(st.optString("rng").replace("RNG ", "").split(" ")[0]); } catch (Exception e) { return; }
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.2f * u); p.setColor(0x8C8A919C);
        p.setPathEffect(new DashPathEffect(new float[]{3 * u, 7 * u}, 0));
        c.save();
        c.clipRect(v.left, v.top, right, v.bottom);
        float far = (float) Math.hypot(Math.max(cx - v.left, right - cx), Math.max(cy - v.top, v.bottom - cy));
        for (float f : new float[]{1.5f, 2f, 3f}) {
            float r = R * f;
            if (r > far) break;
            c.drawCircle(cx, cy, r, p);
            double lv = Math.round(rng * f * 10) / 10.0;
            String lbl = lv == Math.floor(lv) ? String.valueOf((int) lv) : String.valueOf(lv);
            float lxp = cx + r * (float) Math.sin(Math.toRadians(-60)), lyp = cy - r * (float) Math.cos(Math.toRadians(-60));
            if (lxp > v.left + 20 * u && lyp > v.top + 20 * u) {
                p.setPathEffect(null);
                text(c, lbl, lxp, lyp, CYAN, 12 * u, Paint.Align.CENTER, false);
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.2f * u); p.setColor(0x8C8A919C);
                p.setPathEffect(new DashPathEffect(new float[]{3 * u, 7 * u}, 0));
            }
        }
        c.restore();
        p.setPathEffect(null);
    }

    private void traffic(Canvas c, JSONObject it, Rect v) {
        String lv = it.optString("lv");
        boolean alert = lv.equals("ta") || lv.equals("warn");
        float x = cx + (float) it.optDouble("x") * R, y = cy - (float) it.optDouble("y") * R;
        float m = 14 * u, right = areaRight - 4 * u;   // off-scale alerts are pinned left of the key column
        boolean off = x < v.left + m || x > v.right - m || y < v.top + m || y > v.bottom - m;
        if (off) {
            if (!alert) return;
            x = Math.max(v.left + m, Math.min(right - m, x));
            y = Math.max(v.top + m, Math.min(v.bottom - m, y));
        }
        int col = lv.equals("warn") ? RED : lv.equals("ta") ? AMBER : CYAN;
        int alpha = it.optBoolean("stale") ? 115 : 255;
        float s = 9 * u;
        hits.add(new Object[]{it.optString("hex"), x, y});              // for tapping an aircraft
        if (it.optBoolean("selected")) {                                 // selected aircraft: white ring
            p.setShader(null); p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(2 * u); p.setColor(WHITE);
            p.setPathEffect(new DashPathEffect(new float[]{5 * u, 4 * u}, 0));
            c.drawCircle(x, y, s * 2.1f, p);
            p.setPathEffect(null);
        }
        p.setColor(col); p.setAlpha(alpha);
        if (!it.isNull("dir") && !off) {
            // direction line, length grows with ground speed: ~16 px at 50 kt ... ~100 px at 500 kt (design units)
            double d = Math.toRadians(it.optDouble("dir"));
            float len = Math.max(8, Math.min(100, 8 + it.optInt("kt") * 0.18f)) * u * (alert ? 1.15f : 1f);
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth((alert ? 3.2f : 1.6f) * u);
            c.drawLine(x + (float) Math.sin(d) * s, y - (float) Math.cos(d) * s,
                    x + (float) Math.sin(d) * (s + len), y - (float) Math.cos(d) * (s + len), p);
        }
        p.setStrokeWidth(2 * u);
        String kind = it.optString("kind");
        if ("uav".equals(kind)) {
            // drone: four rotors around a centre (filled centre for proximate / advisory / warning)
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.8f * u);
            float o = s * 0.62f, rr = s * 0.36f;
            c.drawLine(x - o, y - o, x + o, y + o, p); c.drawLine(x - o, y + o, x + o, y - o, p);
            for (int i = 0; i < 4; i++) c.drawCircle(x + (i < 2 ? -o : o), y + (i % 2 == 0 ? -o : o), rr, p);
            p.setStyle(lv.equals("other") ? Paint.Style.STROKE : Paint.Style.FILL);
            if (lv.equals("warn")) c.drawRect(x - s * 0.35f, y - s * 0.35f, x + s * 0.35f, y + s * 0.35f, p);
            else c.drawCircle(x, y, s * 0.3f, p);
        } else {
            switch (lv) {
                case "warn": p.setStyle(Paint.Style.FILL); c.drawRect(x - s * 0.8f, y - s * 0.8f, x + s * 0.8f, y + s * 0.8f, p); break;
                case "ta": p.setStyle(Paint.Style.FILL); c.drawCircle(x, y, s * 0.8f, p); break;
                default:
                    Path path = new Path();
                    path.moveTo(x, y - s); path.lineTo(x + s * 0.75f, y); path.lineTo(x, y + s); path.lineTo(x - s * 0.75f, y); path.close();
                    p.setStyle(lv.equals("prox") ? Paint.Style.FILL : Paint.Style.STROKE);
                    c.drawPath(path, p);
            }
            if ("mil".equals(kind)) {
                // military: second (outer) contour of the same symbol
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.5f * u);
                float k2 = 1.55f;
                if (lv.equals("warn")) c.drawRect(x - s * 0.8f * k2, y - s * 0.8f * k2, x + s * 0.8f * k2, y + s * 0.8f * k2, p);
                else if (lv.equals("ta")) c.drawCircle(x, y, s * 0.8f * k2, p);
                else {
                    Path o2 = new Path();
                    o2.moveTo(x, y - s * k2); o2.lineTo(x + s * 0.75f * k2, y); o2.lineTo(x, y + s * k2); o2.lineTo(x - s * 0.75f * k2, y); o2.close();
                    c.drawPath(o2, p);
                }
            }
        }
        float tfs = 14 * u;
        String tag = it.optString("tag");
        if (!tag.isEmpty()) text(c, tag, x, it.optBoolean("above") ? y - s - 4 * u : y + s + tfs, col, tfs, Paint.Align.CENTER, true, alpha);
        int vs = it.optInt("vs");
        if (vs != 0) {
            float ax = x + s * 1.5f;
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(2 * u); p.setColor(col); p.setAlpha(alpha);
            c.drawLine(ax, y + (vs > 0 ? s : -s), ax, y + (vs > 0 ? -s : s), p);
            Path ah = new Path();
            float tip = y + (vs > 0 ? -s - 2 : s + 2);
            ah.moveTo(ax, tip); ah.lineTo(ax - s * 0.45f, tip + (vs > 0 ? s * 0.6f : -s * 0.6f)); ah.lineTo(ax + s * 0.45f, tip + (vs > 0 ? s * 0.6f : -s * 0.6f)); ah.close();
            p.setStyle(Paint.Style.FILL); c.drawPath(ah, p);
        }
        // data block right of the symbol: flight number / registration, then type + ground speed (+ closure for alerts)
        if (!off || alert) {
            float lx = x + s * 1.7f + (vs != 0 ? s : 0), fz = (alert ? 13 : 11.5f) * u;
            int lc = alert ? col : (alpha < 255 ? 0x998A919C : 0xFFB8E6EE);
            float ly = y - s * 0.15f;
            String lbl = it.optString("lbl"), info = it.optString("info"), cl = it.optString("cl");
            if (!lbl.isEmpty()) { text(c, lbl, lx, ly, lc, fz, Paint.Align.LEFT, alert); ly += fz * 1.15f; }
            if (!info.isEmpty()) {
                int ic = "mil".equals(kind) || "uav".equals(kind) ? (alert ? col : 0xFFE8D870) : lc;
                text(c, info, lx, ly, ic, fz * 0.92f, Paint.Align.LEFT, false); ly += fz * 1.1f;
            }
            if (alert && !cl.isEmpty()) text(c, cl, lx, ly, col, fz, Paint.Align.LEFT, true);
        }
        // simulated (test) aircraft: small, unobtrusive marker below-left of the symbol
        if (it.optBoolean("sim")) text(c, "SIM", x - s * 1.2f, y + s * 2.0f, 0xB4FF4DFF, 10 * u, Paint.Align.RIGHT, false);
        p.setAlpha(255);
    }

    private void ownship(Canvas c) {
        float k = 1.2f * u;
        Path a = new Path();
        a.moveTo(cx, cy - 12 * k); a.lineTo(cx + 2 * k, cy - 4 * k); a.lineTo(cx + 11 * k, cy + 1 * k); a.lineTo(cx + 11 * k, cy + 3 * k);
        a.lineTo(cx + 2 * k, cy + 1 * k); a.lineTo(cx + 1.5f * k, cy + 7 * k); a.lineTo(cx + 4.5f * k, cy + 10 * k); a.lineTo(cx + 4.5f * k, cy + 11.5f * k);
        a.lineTo(cx, cy + 10.5f * k); a.lineTo(cx - 4.5f * k, cy + 11.5f * k); a.lineTo(cx - 4.5f * k, cy + 10 * k); a.lineTo(cx - 1.5f * k, cy + 7 * k);
        a.lineTo(cx - 2 * k, cy + 1 * k); a.lineTo(cx - 11 * k, cy + 3 * k); a.lineTo(cx - 11 * k, cy + 1 * k); a.lineTo(cx - 2 * k, cy - 4 * k); a.close();
        p.setStyle(Paint.Style.FILL); p.setColor(WHITE); p.setAlpha(255);
        c.drawPath(a, p);
    }

    /** App-style softkeys: dark gradient, coloured top cap, bold label, state line. */
    private void keys(Canvas c, JSONObject st) throws Exception {
        JSONArray ks = st.optJSONArray("keys");
        if (ks == null) return;
        for (int i = 0; i < keyRects.size() && i < ks.length(); i++) {
            JSONObject k = ks.getJSONObject(i);
            RectF r = keyRects.get(i).r;
            int col = Color.parseColor(k.optString("c", "#c9d1da"));
            boolean pressed = k.optString("k").equals(pressedKey) && System.currentTimeMillis() - pressedAt < 250;
            float rad = 9 * u;
            p.setStyle(Paint.Style.FILL);
            p.setShader(new LinearGradient(0, r.top, 0, r.bottom, new int[]{0xFF50565E, 0xFF2E3238, 0xFF26292E}, new float[]{0, 0.7f, 1}, Shader.TileMode.CLAMP));
            if (pressed) p.setAlpha(170);
            c.drawRoundRect(r, rad, rad, p);
            p.setShader(null); p.setAlpha(255);
            // glow when active
            if (k.optBoolean("on") || k.optBoolean("warn")) {
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(2.5f * u); p.setColor(k.optBoolean("warn") ? AMBER : col); p.setAlpha(150);
                c.drawRoundRect(r, rad, rad, p);
                p.setAlpha(255);
            }
            // coloured top cap
            c.save();
            c.clipRect(r.left, r.top, r.right, r.top + 5 * u);
            p.setStyle(Paint.Style.FILL); p.setColor(col);
            c.drawRoundRect(r, rad, rad, p);
            c.restore();
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.2f * u); p.setColor(0xFF0D0E10);
            c.drawRoundRect(r, rad, rad, p);
            float ls = 17 * u, ss = 12.5f * u;
            text(c, k.optString("t"), r.centerX(), r.centerY() - 1 * u, WHITE, ls, Paint.Align.CENTER, true);
            int scol = k.optBoolean("warn") ? AMBER : k.optBoolean("on") ? col : 0xFFB4BCC6;
            text(c, k.optString("s"), r.centerX(), r.centerY() + ss * 1.3f, scol, ss, Paint.Align.CENTER, k.optBoolean("on") || k.optBoolean("warn"));
        }
    }

    // ---------------------------------------------------------------- text helpers (dark halo like the phone display)
    private void text(Canvas c, String s, float x, float y, int col, float size, Paint.Align al, boolean bold) {
        text(c, s, x, y, col, size, al, bold, 255);
    }

    private void text(Canvas c, String s, float x, float y, int col, float size, Paint.Align al, boolean bold, int alpha) {
        if (s == null || s.isEmpty()) return;
        p.setPathEffect(null); p.setShader(null);
        p.setTypeface(bold ? Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) : Typeface.MONOSPACE);
        p.setTextSize(size); p.setTextAlign(al);
        if (col != Color.BLACK) {
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(Math.max(2.5f, size * 0.3f)); p.setStrokeJoin(Paint.Join.ROUND);
            p.setColor(Color.BLACK); p.setAlpha((int) (alpha * 0.9f));
            c.drawText(s, x, y, p);
        }
        p.setStyle(Paint.Style.FILL); p.setColor(col); p.setAlpha(alpha);
        c.drawText(s, x, y, p);
        p.setAlpha(255);
    }

    /** Text in a box: filled (black text on colour) or outlined on a dark backing. y = top edge. */
    private void box(Canvas c, String s, float x, float y, int col, float size, boolean filled, Paint.Align al) {
        if (s == null || s.isEmpty()) return;
        p.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        p.setTextSize(size);
        float w = p.measureText(s) + size * 0.7f, h = size * 1.35f;
        float x0 = al == Paint.Align.CENTER ? x - w / 2 : al == Paint.Align.RIGHT ? x - w : x;
        RectF r = new RectF(x0, y, x0 + w, y + h);
        p.setStyle(Paint.Style.FILL);
        p.setColor(filled ? col : 0xB8000000);
        c.drawRect(r, p);
        if (!filled) { p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.5f * u); p.setColor(col); c.drawRect(r, p); }
        text(c, s, x0 + w / 2, y + h / 2 + size * 0.35f, filled ? Color.BLACK : col, size, Paint.Align.CENTER, true);
    }
}
