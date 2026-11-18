/* AeroCallout service worker: network-first for the app shell (always fresh when online, works offline). */
const CACHE = 'ac-shell-v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'icon.svg', 'manifest.webmanifest',
  'js/geo.js', 'js/settings.js', 'js/gps.js', 'js/adsb.js', 'js/traffic-logic.js', 'js/terrain.js',
  'js/obstacles.js', 'js/weather.js', 'js/ahrs.js', 'js/android-tts.js', 'js/voice.js', 'js/sim.js', 'js/display.js', 'js/selftest.js', 'js/app.js', 'js/aircraftdb.js', 'js/alerttest.js', 'js/roads.js', 'js/car.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/proxy/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
