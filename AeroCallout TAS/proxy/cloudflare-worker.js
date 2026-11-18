// AeroCallout ADS-B proxy for Cloudflare Workers (adds CORS headers; only whitelisted hosts and simple paths).
// Deploy, then set "Proxy" in the app settings to the worker URL (e.g. https://aerocallout-proxy.<you>.workers.dev).
// URL scheme: {worker}/adsblol/v2/point/{lat}/{lon}/{radius}  or  {worker}/adsbfi/v2/lat/{lat}/lon/{lon}/dist/{radius}
const TARGETS = {
  adsblol: 'https://api.adsb.lol',
  adsbfi: 'https://opendata.adsb.fi/api',
};

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/(adsblol|adsbfi)\/([A-Za-z0-9/._-]+)$/);
    if (!m) return new Response('not found', { status: 404, headers: cors });
    const upstream = await fetch(`${TARGETS[m[1]]}/${m[2]}`, {
      headers: { 'User-Agent': 'AeroCallout/0.2 (open-source traffic awareness; proxy)' },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
