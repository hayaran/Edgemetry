/**
 * The client snippet.
 *
 * The endpoint is not hardcoded — it is derived from wherever the script itself
 * was served. Request `/abc.js` and the script posts to `/abc`. That means each
 * deployment can pick its own path, so a blocklist entry for one instance's
 * path does nothing to anybody else's. Serving from the site's own domain
 * already defeats host-based blocking; this covers the path-based rules too.
 */

const TRACKER_SOURCE = `(function(){
  var script = document.currentScript;
  if (!script) return;
  var endpoint = new URL(script.src.replace(/\\.js(\\?.*)?$/, ''), location.href).href;
  var domain = script.getAttribute('data-domain') || location.hostname;
  var allowLocal = script.getAttribute('data-local') === 'true';
  var lastPath = null;

  function isLocal() {
    return location.protocol === 'file:' ||
      /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname) ||
      location.hostname.indexOf('.') === -1;
  }

  function ignored() {
    if (window.__ma_disable) return true;
    // Set from your own browser's console on your own site. localStorage is
    // per-origin, so this cannot be flipped for you from the dashboard.
    try { return localStorage.getItem('em-ignore') === '1'; } catch (e) { return false; }
  }

  function send(name) {
    if (!allowLocal && isLocal()) return;
    if (ignored()) return;
    var body = JSON.stringify({
      n: name,
      d: domain,
      u: location.href,
      r: document.referrer || '',
      // Bucketed to one of four ranges server-side and never stored exactly.
      w: window.innerWidth || 0
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, body);
        return;
      }
    } catch (e) {}
    fetch(endpoint, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' })
      .catch(function(){});
  }

  function pageview() {
    // A SPA can fire the same route twice; only the real transitions count.
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    send('pageview');
  }

  window.edgemetry = function(name) { send(String(name || 'event')); };

  var history = window.history;
  if (history.pushState) {
    var push = history.pushState;
    history.pushState = function() {
      push.apply(this, arguments);
      pageview();
    };
    window.addEventListener('popstate', pageview);
  }

  if (document.visibilityState === 'prerender') {
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') pageview();
    });
  } else {
    pageview();
  }
})();`;

export function trackerScript(): string {
  return TRACKER_SOURCE;
}

export function trackerResponse(): Response {
  return new Response(TRACKER_SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // Long cache with revalidation: the script almost never changes and the
      // fewer script requests we serve, the more of the 100k/day request budget
      // is left for actual pageviews.
      'cache-control': 'public, max-age=86400, must-revalidate',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
