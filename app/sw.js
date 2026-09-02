/* PressOn service worker — the app must work with no signal, but a fresh
 * deploy must also reach phones on the next load: network first, cache as
 * the fallback.  Bump CACHE on every deploy so old caches are dropped. */
var CACHE = 'presson-v2';
var ASSETS = ['./', './index.html', './style.css', './app.js', './estimator.js', './coach.js', './i18n.js', './audio.js',
  './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './selftest.html', './instructor.html'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // bypass the HTTP cache (GitHub Pages sends max-age=600)
    return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.indexOf('/api/') !== -1) return;   // never cache the instructor relay
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok && url.origin === location.origin) {
        var copy = res.clone();                                                    // clone before the body is consumed
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});
