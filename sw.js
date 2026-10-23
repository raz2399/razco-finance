// Razi-Nova service worker.
//
// Rule one: a deploy must always win. The store runs on whatever is live,
// and a cached old shell that outlives a fix is worse than no cache at all.
// So the page and its assets are network-first, and the cache is only ever
// a fallback for when the phone has no signal.
//
// Rule two: money is never cached. Every /.netlify/functions/ call goes to
// the network, full stop. A stale cash position is a wrong cash position.

var CACHE = 'razinova-v2';
var SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  // Take over straight away rather than waiting for every tab to close.
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () { /* a missing asset must not fail the install */ });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache anything that carries a number.
  if (url.pathname.indexOf('/.netlify/functions/') === 0) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('/index.html');
      });
    })
  );
});
