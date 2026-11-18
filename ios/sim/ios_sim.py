"""
AeroCallout iPhone simulator for Windows (no Mac needed).

Runs the bundled web app in WebKit (the engine of WKWebView) with an iPhone 15 screen, injects the real
ios/AeroCallout/bridge.js exactly like the app does (document start) and answers it the way the native Swift
code does (WebViewController / Speech / Sensors / SchemeHandler):

  * prompt('__ac__...') round trips  -> answered here (WKUIDelegate)
  * webkit.messageHandlers.ac        -> handled here (WKScriptMessageHandler)
  * AVSpeechSynthesizer              -> Windows voices (System.Speech), same start/done/interrupted events
  * CoreLocation                     -> simulated circuit flight (or static / denied), iOS fix format
  * CoreMotion / CMAltimeter         -> 20 Hz samples in Android convention, like Sensors.swift
  * 0.5 s native ticker, safe-area insets, app state, background / foreground
  * aerocallout://app/www/proxy/...  -> local ADS-B proxy (same hosts and path filter)

Usage:  python ios_sim.py [--gps flight|static|denied] [--center 49.96,8.64] [--landscape] [--headless]
        [--selftest SECONDS] [--shots DIR]
Console commands while running: bg, fg, land, port, gps flight|static|denied, shot, tick, quit
"""
import argparse
import asyncio
import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
WEB = os.path.join(REPO, 'AeroCallout TAS')
BRIDGE = os.path.join(REPO, 'ios', 'AeroCallout', 'bridge.js')
# Only what the iOS build bundles into the app (see .github/workflows/ios.yml)
BUNDLED = ('index.html', 'css/', 'js/', 'icon.svg', 'manifest.webmanifest')
PROXY = {'adsblol': 'https://api.adsb.lol', 'adsbfi': 'https://opendata.adsb.fi/api'}
MIME = {'html': 'text/html', 'js': 'text/javascript', 'css': 'text/css', 'json': 'application/json',
        'webmanifest': 'application/manifest+json', 'svg': 'image/svg+xml', 'png': 'image/png'}
ALLOWED = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-')

# iPhone 15: points, safe areas (status bar hidden, Dynamic Island, home indicator)
SCREEN = (393, 852)
SAFE_PORTRAIT = {'t': 59, 'l': 0, 'r': 0, 'b': 34}
SAFE_LANDSCAPE = {'t': 0, 'l': 59, 'r': 59, 'b': 21}

# Typical iOS voices (English / German, like Speech.voicesJSON) -> Windows voice language used to speak them
IOS_VOICES = [('Anna', 'de-DE'), ('Helena', 'de-DE'), ('Martin', 'de-DE'), ('Daniel', 'en-GB'), ('Arthur', 'en-GB'),
              ('Martha', 'en-GB'), ('Samantha', 'en-US'), ('Fred', 'en-US'), ('Karen', 'en-AU'), ('Moira', 'en-IE')]

T0 = time.time()


def log(kind, msg):
    print(f'[{time.time() - T0:7.1f}s] {kind:6s} {msg}', flush=True)


# ------------------------------------------------------------------ SchemeHandler (files + ADS-B proxy)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, ctype, data):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        for pre in ('/www/proxy/', '/proxy/'):
            if path.startswith(pre):
                return self.proxy(path[len(pre):])
        if not path.startswith('/www/'):
            return self.send(404, 'text/plain', b'')
        rel = path[5:] or 'index.html'
        if '..' in rel or not any(rel == b or (b.endswith('/') and rel.startswith(b)) for b in BUNDLED):
            return self.send(404, 'text/plain', b'')
        f = os.path.join(WEB, rel.replace('/', os.sep))
        if not os.path.isfile(f):
            return self.send(404, 'text/plain', b'')
        with open(f, 'rb') as fh:
            data = fh.read()
        if rel.endswith('.css'):
            # WKWebView fills env(safe-area-inset-*) itself (viewport-fit=cover); desktop WebKit reports 0,
            # so the simulator maps them to the iPhone 15 values set by OVERLAY_JS.
            for side, v in (('top', 'sat'), ('bottom', 'sab'), ('left', 'sal'), ('right', 'sar')):
                data = data.replace(f'env(safe-area-inset-{side}'.encode(), f'var(--sim-{v}'.encode())
        self.send(200, MIME.get(rel.rsplit('.', 1)[-1].lower(), 'application/octet-stream'), data)

    def proxy(self, rest):
        src, _, sub = rest.partition('/')
        base = PROXY.get(src)
        if not base or not sub or not set(sub) <= ALLOWED:
            return self.send(404, 'text/plain', b'')
        req = urllib.request.Request(f'{base}/{sub}', headers={'User-Agent': 'AeroCallout/0.3 (open-source traffic awareness; iOS)'})
        try:
            with urllib.request.urlopen(req, timeout=7) as r:
                self.send(r.status, 'application/json', r.read())
        except urllib.error.HTTPError as e:
            self.send(e.code, 'application/json', e.read() or b'')
        except Exception:
            self.send(502, 'text/plain', b'')


def start_server():
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


# ------------------------------------------------------------------ Speech (AVSpeechSynthesizer -> Windows voices)

SAPI_PS = r'''
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToDefaultAudioDevice()
$in = [Console]::In
$task = $in.ReadLineAsync()
$cur = ''
while ($true) {
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($line -eq $null) { break }
    $task = $in.ReadLineAsync()
    $p = $line.Split([char]9)
    if ($p[0] -eq 'stop') { $s.SpeakAsyncCancelAll(); continue }
    if ($p[0] -eq 'speak') {
      $s.SpeakAsyncCancelAll()
      $cur = $p[1]
      try { $s.SelectVoiceByHints('NotSet', 'NotSet', 0, [Globalization.CultureInfo]::GetCultureInfo($p[2])) } catch {}
      $s.Rate = [int]$p[3]; $s.Volume = [int]$p[4]
      [void]$s.SpeakAsync($p[5])
      Start-Sleep -Milliseconds 30
    }
  }
  if ($cur -ne '' -and $s.State -eq 'Ready') { [Console]::Out.WriteLine('done' + [char]9 + $cur); [Console]::Out.Flush(); $cur = '' }
  Start-Sleep -Milliseconds 20
}
'''


class Speech:
    def __init__(self, emit, audio=True):
        self.emit = emit                  # (id, type, err) -> page
        self.current = None
        self.proc = None
        self.speaking_since = 0
        if audio:
            try:
                self.proc = subprocess.Popen(['powershell', '-NoProfile', '-Command', SAPI_PS], stdin=subprocess.PIPE,
                                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', bufsize=1)
                threading.Thread(target=self._reader, daemon=True).start()
            except Exception as e:
                log('tts', f'Windows-Sprachausgabe nicht verfuegbar: {e}')
                self.proc = None

    def _reader(self):
        for line in self.proc.stdout:
            kind, _, uid = line.rstrip('\n').partition('\t')
            if kind == 'done' and uid == self.current:
                self.current = None
                self.emit(uid, 'done', '')

    def voices_json(self):
        return json.dumps([{'name': f'{n} ({l})', 'lang': l, 'network': False} for n, l in IOS_VOICES])

    def speak(self, text, voice, lang, rate, pitch, volume, uid):
        if self.current:                                    # iOS: stopSpeaking -> didCancel of the previous one
            prev, self.current = self.current, None
            self.emit(prev, 'error', 'interrupted')
        v = next((l for n, l in IOS_VOICES if f'{n} ({l})' == voice or n == voice), None)
        lang = v or lang or 'en-US'
        log('SPEAK', f'"{text}"  [{voice or lang}, rate {rate:g}, vol {volume:g}]')
        self.current = uid or None
        if uid:
            self.emit(uid, 'start', '')
        if self.proc:
            r = max(-10, min(10, round((max(0.3, min(rate, 2.5)) - 1) * 6)))
            self.proc.stdin.write(f'speak\t{uid}\t{lang}\t{r}\t{round(max(0, min(volume, 1)) * 100)}\t{text.replace(chr(9), " ").replace(chr(10), " ")}\n')
            self.proc.stdin.flush()
        elif uid:
            dur = 0.35 + 0.075 * len(text) / max(0.3, rate)
            threading.Timer(dur, lambda: self._fake_done(uid)).start()
        return True

    def _fake_done(self, uid):
        if self.current == uid:
            self.current = None
            self.emit(uid, 'done', '')

    def stop(self):
        if self.current:
            prev, self.current = self.current, None
            self.emit(prev, 'error', 'interrupted')
        if self.proc:
            self.proc.stdin.write('stop\n')
            self.proc.stdin.flush()


# ------------------------------------------------------------------ CoreLocation / CoreMotion

class Flight:
    """Simulated ownship: left-hand circuit around a centre point at 2500 ft MSL, 100 kt."""

    def __init__(self, lat, lon, mode):
        self.lat0, self.lon0, self.mode = lat, lon, mode
        self.radius = 3000.0
        self.speed = 100 * 0.514444
        self.alt_msl = 2500 * 0.3048
        self.geoid = 47.0

    def at(self, t):
        if self.mode == 'static':
            return dict(lat=self.lat0, lon=self.lon0, alt=110 + self.geoid, speed=0.0, bearing=None, turn=0.0, msl=110)
        w = self.speed / self.radius                       # rad/s, counter-clockwise seen from above
        a = w * t
        x, y = self.radius * math.cos(a), self.radius * math.sin(a)
        lat = self.lat0 + y / 111320.0
        lon = self.lon0 + x / (111320.0 * math.cos(math.radians(self.lat0)))
        vx, vy = -self.radius * w * math.sin(a), self.radius * w * math.cos(a)
        brg = (math.degrees(math.atan2(vx, vy)) + 360) % 360
        msl = self.alt_msl + 30 * math.sin(t / 40)
        return dict(lat=lat, lon=lon, alt=msl + self.geoid, speed=self.speed, bearing=brg, turn=w, msl=msl)


# ------------------------------------------------------------------ the "app"

class IOSApp:
    def __init__(self, args):
        self.args = args
        self.page = None
        self.loop = None
        self.landscape = args.landscape
        self.background = False
        self.monitoring = False
        self.ticker = None
        self.gps_on = False
        self.motion_on = False
        self.last_fix = None
        self.keep_on = False
        self.flight = Flight(*args.center, args.gps if args.gps != 'denied' else 'static')
        self.gps_mode = args.gps
        self.t_start = time.time()
        self.speech = Speech(self.emit_tts, audio=not args.mute)
        self.counts = {}
        self.errors = []
        self.snapshot = {}

    # ---- JS helpers
    def js(self, src):
        if self.page and self.loop:
            asyncio.run_coroutine_threadsafe(self._js(src), self.loop)

    async def _js(self, src):
        try:
            await self.page.evaluate(src)
        except Exception:
            pass

    def emit_tts(self, uid, typ, err):
        self.js(f'window.__ttsEvent && window.__ttsEvent({json.dumps(uid)},{json.dumps(typ)},{json.dumps(err)})')

    def count(self, k):
        self.counts[k] = self.counts.get(k, 0) + 1

    # ---- WKScriptMessageHandler
    def on_post(self, _source, raw):
        m = json.loads(raw)
        o, meth, a = m.get('o'), m.get('m'), m.get('a') or []
        self.count(f'{o}.{meth}')
        if (o, meth) == ('tts', 'stop'):
            self.speech.stop()
        elif (o, meth) == ('gps', 'start'):
            if not self.gps_on:
                log('native', 'CoreLocation start' + (' (Berechtigung verweigert)' if self.gps_mode == 'denied' else ''))
            self.gps_on = True
        elif (o, meth) == ('gps', 'stop'):
            self.gps_on = False
            log('native', 'CoreLocation stop')
        elif (o, meth) == ('sensors', 'start'):
            if not self.motion_on:
                log('native', 'CoreMotion start')
            self.motion_on = True
        elif (o, meth) == ('sensors', 'stop'):
            self.motion_on = False
            log('native', 'CoreMotion stop')
        elif (o, meth) == ('power', 'startTicker'):
            if not self.ticker:
                self.ticker = asyncio.ensure_future(self.tick_loop())
        elif (o, meth) == ('power', 'startMonitoring'):
            self.monitoring = True
            log('native', 'Monitoring an (Hintergrund-Ortung erlaubt, blauer Balken)')
        elif (o, meth) == ('power', 'stopMonitoring'):
            self.monitoring = False
            log('native', 'Monitoring aus')
        elif (o, meth) == ('power', 'setKeepScreenOn'):
            on = bool(a and a[0])
            if on != self.keep_on:
                log('native', f'isIdleTimerDisabled = {on}')
            self.keep_on = on
        elif (o, meth) == ('power', 'wake'):
            if self.background and a and a[0]:
                log('NOTIFY', f'Mitteilung: AeroCallout - {a[0]}')
        else:
            log('native', f'unbekannte Nachricht {o}.{meth}')

    # ---- WKUIDelegate prompt round trip
    def sync(self, payload):
        m = json.loads(payload)
        o, meth, a = m.get('o'), m.get('m'), m.get('a') or []
        self.count(f'{o}.{meth}')
        s = lambda i: a[i] if i < len(a) and isinstance(a[i], str) else ''
        n = lambda i: float(a[i]) if i < len(a) and isinstance(a[i], (int, float)) else 1.0
        if (o, meth) == ('tts', 'ready'):
            return 'true'
        if (o, meth) == ('tts', 'voices'):
            return self.speech.voices_json()
        if (o, meth) == ('tts', 'speak'):
            return 'true' if self.speech.speak(s(0), s(1), s(2), n(3), n(4), n(5), s(6)) else 'false'
        if (o, meth) == ('gps', 'status'):
            age = int((time.time() - self.last_fix) * 1000) if self.last_fix else -1
            return json.dumps({'permission': self.gps_mode != 'denied', 'gpsEnabled': True, 'networkEnabled': True,
                               'running': self.gps_on, 'lastGnssFixAgeMs': age})
        if (o, meth) == ('sensors', 'available'):
            return json.dumps({'gyro': True, 'gyroRaw': False, 'accel': True, 'mag': True, 'baro': True})
        if (o, meth) == ('power', 'insets'):
            i = SAFE_LANDSCAPE if self.landscape else SAFE_PORTRAIT
            return json.dumps({'l': i['l'], 'r': i['r'], 'b': i['b']})
        if (o, meth) == ('power', 'state'):
            return json.dumps({'screenOn': not self.background, 'locked': self.background,
                               'resumed': not self.background, 'batteryExempt': True})
        log('native', f'unbekannter Aufruf {o}.{meth}')
        return ''

    async def on_dialog(self, d):
        msg = d.message
        if d.type == 'prompt' and msg.startswith('__ac__'):
            try:
                r = self.sync(msg[6:])
            except Exception as e:
                log('ERROR', f'bridge: {e}')
                r = ''
            await d.accept(r)
            return
        log('dialog', f'{d.type}: {msg[:200]} -> OK')
        if d.type == 'prompt':
            await d.accept(d.default_value)
        else:
            await d.accept()

    # ---- native loops
    async def tick_loop(self):
        n = 0
        while True:
            await asyncio.sleep(0.5)
            if self.background:
                continue                                   # page suspended by iOS
            await self._js('window.AC && AC.App && AC.App.tick && AC.App.tick()')
            n += 1
            if n % 10 == 0:
                await self.take_snapshot()

    async def take_snapshot(self):
        try:
            r = await self.page.evaluate("window.__acSnapshot ? window.__acSnapshot() : '{}'")
            self.snapshot = json.loads(r)
        except Exception:
            pass

    async def gps_loop(self):
        while True:
            await asyncio.sleep(1.0)
            if not self.gps_on or self.gps_mode == 'denied':
                continue
            p = self.flight.at(time.time() - self.t_start)
            fix = {'lat': p['lat'], 'lon': p['lon'], 'acc': 4.7, 't': int(time.time() * 1000), 'provider': 'gnss',
                   'alt': p['alt'], 'altAcc': 6.0}
            if p['speed'] > 0:
                fix['speed'] = p['speed']
            if p['bearing'] is not None:
                fix['bearing'] = p['bearing']
            self.last_fix = time.time()
            self.last_fix_json = fix
            if self.background:                            # CoreLocation keeps running, the page does not
                continue
            self.count('gps.fix')
            await self._js(f'window.__gpsFix && window.__gpsFix({json.dumps(fix)})')

    async def motion_loop(self):
        last = None
        while True:
            await asyncio.sleep(0.05)
            if not self.motion_on or self.background:
                last = None
                continue
            now = time.time()
            p = self.flight.at(now - self.t_start)
            psi = math.radians(p['bearing'] or 0)
            bank = math.atan(p['speed'] * p['turn'] / 9.80665) if p['speed'] else 0.0
            # phone lying flat in the cockpit, top pointing forward; coordinated turn: load factor along z
            o = {'dt': (now - last) if last else 0.05, 'gb': [0.0, 0.0, 0.0], 't': int(now * 1000),
                 'g': [0.0, 0.0, -p['turn'] if p['speed'] else 0.0],
                 'a': [0.0, 0.0, 9.80665 / math.cos(bank)],
                 'rm': [math.cos(psi), math.sin(psi), 0, -math.sin(psi), math.cos(psi), 0, 0, 0, 1],
                 'p': 1013.25 * (1 - 2.25577e-5 * p['msl']) ** 5.25588, 'decl': 3.6}
            last = now
            self.count('imu')
            await self._js(f'window.__imu && window.__imu({json.dumps(o)})')

    # ---- lifecycle
    async def set_background(self, on):
        if on == self.background:
            return
        if on:
            await self.take_snapshot()                      # willResignActive
            self.background = True
            log('native', 'App im Hintergrund (Seite pausiert). Snapshot fuer den nativen Warner:')
            log('native', '  ' + json.dumps(self.snapshot))
            if self.monitoring:
                log('native', '  -> BackgroundWarner uebernimmt (nur auf dem echten iPhone)')
            else:
                log('native', '  -> Monitoring aus: keine Warnungen im Hintergrund')
        else:
            self.background = False
            log('native', 'App wieder im Vordergrund')
            fix = getattr(self, 'last_fix_json', None)     # willEnterForeground: current position first
            if fix and self.last_fix and time.time() - self.last_fix < 3:
                await self._js(f'window.__gpsFix && window.__gpsFix({json.dumps(fix)})')
            await self._js('window.AC && AC.App && AC.App.tick && AC.App.tick()')

    async def set_orientation(self, land):
        self.landscape = land
        w, h = SCREEN
        await self.page.set_viewport_size({'width': h, 'height': w} if land else {'width': w, 'height': h})
        await self._js('window.__simSafe && window.__simSafe(%s)' % ('true' if land else 'false'))
        log('native', 'Querformat' if land else 'Hochformat')

    async def shot(self, name):
        os.makedirs(self.args.shots, exist_ok=True)
        f = os.path.join(self.args.shots, name + '.png')
        await self.page.screenshot(path=f)
        log('shot', f)
        return f


# Shows where the Dynamic Island and the home indicator cover the page (status bar hidden, like the app),
# and provides env(safe-area-inset-*) values the way WKWebView does with viewport-fit=cover.
OVERLAY_JS = r'''
(function () {
  const ins = { p: %s, l: %s };
  function apply(land) {
    const i = land ? ins.l : ins.p;
    let st = document.getElementById('__simSafeCss');
    if (!st) { st = document.createElement('style'); st.id = '__simSafeCss'; (document.head || document.documentElement).appendChild(st); }
    st.textContent = `:root{--sim-sat:${i.t}px;--sim-sab:${i.b}px;--sim-sal:${i.l}px;--sim-sar:${i.r}px}`;
    let o = document.getElementById('__simIsland');
    if (!o) {
      o = document.createElement('div'); o.id = '__simIsland';
      o.style.cssText = 'position:fixed;z-index:2147483647;background:#000;border-radius:20px;pointer-events:none;outline:1px solid rgba(255,80,80,.7)';
      document.documentElement.appendChild(o);
      const h = document.createElement('div'); h.id = '__simHome';
      h.style.cssText = 'position:fixed;z-index:2147483647;height:5px;border-radius:3px;background:rgba(255,255,255,.85);pointer-events:none;left:50%%;transform:translateX(-50%%)';
      document.documentElement.appendChild(h);
    }
    if (land) Object.assign(o.style, { top: '50%%', left: '11px', width: '37px', height: '126px', transform: 'translateY(-50%%)' });
    else Object.assign(o.style, { top: '11px', left: '50%%', width: '126px', height: '37px', transform: 'translateX(-50%%)' });
    const h = document.getElementById('__simHome');
    Object.assign(h.style, { bottom: '8px', width: land ? '200px' : '134px' });
  }
  window.__simSafe = apply;
  const go = () => apply(innerWidth > innerHeight);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
'''

WEBKIT_SHIM = r'''
(function () {
  // WKWebView provides window.webkit.messageHandlers.<name>; here it forwards to the simulator.
  try {
    const h = { ac: { postMessage: (m) => window.__nativePost(JSON.stringify(m)) } };
    if (!window.webkit) Object.defineProperty(window, 'webkit', { value: { messageHandlers: h }, configurable: true });
    else Object.defineProperty(window.webkit, 'messageHandlers', { value: h, configurable: true });
  } catch (e) { console.error('sim shim', e); }
})();
'''


async def stdin_commands(app, stop):
    loop = asyncio.get_running_loop()
    q = queue.Queue()
    threading.Thread(target=lambda: [q.put(l.strip()) for l in sys.stdin], daemon=True).start()
    while not stop.is_set():
        await asyncio.sleep(0.2)
        while not q.empty():
            c = q.get().split()
            if not c:
                continue
            if c[0] == 'bg':
                await app.set_background(True)
            elif c[0] == 'fg':
                await app.set_background(False)
            elif c[0] == 'land':
                await app.set_orientation(True)
            elif c[0] == 'port':
                await app.set_orientation(False)
            elif c[0] == 'gps' and len(c) > 1:
                app.gps_mode = c[1]
                app.flight.mode = 'static' if c[1] == 'denied' else c[1]
                log('native', f'GPS-Modus {c[1]}')
            elif c[0] == 'shot':
                await app.shot(time.strftime('shot-%H%M%S'))
            elif c[0] == 'quit':
                stop.set()
    del loop


async def selftest(app, page, secs):
    """Scripted run: start, fly with live traffic, self test warnings, landscape, background / foreground."""
    async def click_text(t):
        try:
            await page.get_by_text(t, exact=False).first.click(timeout=3000)
            log('touch', t)
        except Exception as e:
            log('touch', f'{t}: nicht gefunden ({str(e).splitlines()[0]})')
    await asyncio.sleep(3)
    await app.shot('01-start')
    await click_text('Verstanden')
    await asyncio.sleep(max(8, secs))
    await app.shot('02-flight')
    state = await page.evaluate('''() => { const A = AC.App || {}, G = AC.Gps || {}, H = AC.Ahrs || {};
        return { phase: A.phase, gps: G.status, own: G.state && { lat: +G.state.lat.toFixed(4), lon: +G.state.lon.toFixed(4),
        gsKt: Math.round(G.state.gs / 0.514444), trk: Math.round(G.state.trk), altFt: G.state.altMSL && Math.round(G.state.altMSL / 0.3048), gnss: G.state.gnss },
        traffic: (A.tfc || []).length, adsb: AC.Adsb && Object.fromEntries(Object.entries(AC.Adsb.src || {}).map(([k, s]) => [k, s.status])),
        voices: speechSynthesis.getVoices().length, android: !!window.AC_ANDROID, ios: !!window.AC_IOS }; }''')
    log('state', json.dumps(state))
    # live test scenario at the simulated position: head-on traffic -> TA and warning callouts
    await page.evaluate('''() => { const b = document.querySelector('[data-scen="headon"]'); if (b) b.click(); }''')
    log('touch', 'Szenario "Frontal, gleiche Hoehe"')
    await asyncio.sleep(30)
    await app.shot('03-traffic-alert')
    await app.set_orientation(True)
    await asyncio.sleep(3)
    await app.shot('04-landscape')
    await app.set_orientation(False)
    await app.set_background(True)
    await asyncio.sleep(8)
    await app.set_background(False)
    await asyncio.sleep(2)
    await app.shot('05-resumed')


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gps', default='flight', choices=['flight', 'static', 'denied'])
    ap.add_argument('--center', default='49.9608,8.6436', help='lat,lon of the simulated circuit (default EDFE)')
    ap.add_argument('--landscape', action='store_true')
    ap.add_argument('--headless', action='store_true')
    ap.add_argument('--mute', action='store_true', help='no Windows speech output')
    ap.add_argument('--selftest', type=float, default=0, help='run automatically for N seconds, then report and exit')
    ap.add_argument('--shots', default=os.path.join(HERE, 'shots'))
    ap.add_argument('--fresh', action='store_true', help='start with empty app storage (first launch)')
    args = ap.parse_args()
    args.center = tuple(float(x) for x in args.center.split(','))

    port = start_server()
    app = IOSApp(args)
    with open(BRIDGE, encoding='utf-8') as f:
        bridge = f.read()

    async with async_playwright() as pw:
        dev = dict(pw.devices.get('iPhone 15') or pw.devices['iPhone 14'])
        dev.pop('default_browser_type', None)
        w, h = SCREEN
        dev['viewport'] = {'width': h, 'height': w} if args.landscape else {'width': w, 'height': h}
        dev['screen'] = {'width': w, 'height': h}
        # WKWebView user agent: like Safari, without "Version/.. Safari/.."
        dev['user_agent'] = dev['user_agent'].split(' Version/')[0].replace('Safari', '').strip() or dev['user_agent']
        browser = await pw.webkit.launch(headless=args.headless)
        profile = os.path.join(HERE, '.profile-state.json')
        state = profile if (os.path.exists(profile) and not args.fresh) else None
        ctx = await browser.new_context(**dev, storage_state=state, locale='de-DE', timezone_id='Europe/Berlin')
        await ctx.expose_binding('__nativePost', app.on_post)
        await ctx.add_init_script(WEBKIT_SHIM)
        await ctx.add_init_script(bridge)                   # WKUserScript, injectionTime .atDocumentStart
        await ctx.add_init_script(OVERLAY_JS % (json.dumps(SAFE_PORTRAIT), json.dumps(SAFE_LANDSCAPE)))
        page = await ctx.new_page()
        app.page, app.loop = page, asyncio.get_running_loop()
        page.on('dialog', lambda d: asyncio.ensure_future(app.on_dialog(d)))
        page.on('console', lambda m: log('js-' + m.type[:3], m.text[:300]) if m.type in ('error', 'warning', 'log') else None)

        def perr(e):
            app.errors.append(str(e))
            log('ERROR', f'Seitenfehler: {e}')
        page.on('pageerror', perr)
        page.on('requestfailed', lambda r: log('net', f'fehlgeschlagen: {r.url} {r.failure}') if '/proxy/' not in r.url else None)

        tasks = [asyncio.ensure_future(app.gps_loop()), asyncio.ensure_future(app.motion_loop())]
        await page.goto(f'http://127.0.0.1:{port}/www/index.html')
        await app._js("window.__ttsEvent && window.__ttsEvent('','voices','')")    # webView(didFinish:)
        log('native', f'App geladen (WebKit, iPhone 15 {"quer" if args.landscape else "hoch"}), GPS: {args.gps}')

        stop = asyncio.Event()
        if args.selftest:
            await selftest(app, page, args.selftest)
        else:
            print('Befehle: bg, fg, land, port, gps flight|static|denied, shot, quit  (oder Fenster schliessen)', flush=True)
            page.on('close', lambda _: stop.set())
            await stdin_commands(app, stop)

        try:
            await ctx.storage_state(path=profile)
        except Exception:
            pass
        for t in tasks + ([app.ticker] if app.ticker else []):
            t.cancel()
        if args.selftest:
            print(json.dumps({'counts': app.counts, 'errors': app.errors}, indent=1), flush=True)
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
