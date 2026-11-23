var CACHE = 'efs-cache-v3';
var FILES = ['./', 'index.html', 'manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') { return; }
  var url = new URL(e.request.url);
  // Only handle this app's own files and the scanner library; never cache product lookups.
  if (url.origin !== self.location.origin && url.hostname !== 'cdn.jsdelivr.net') { return; }
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (r) { return r || caches.match('index.html'); });
    })
  );
});

/* ---------- Background expiry reminders ---------- */
function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('efs', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function readKey(k) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var g = db.transaction('kv', 'readonly').objectStore('kv').get(k);
      g.onsuccess = function () { res(g.result || null); db.close(); };
      g.onerror = function () { res(null); db.close(); };
    });
  }).catch(function () { return null; });
}
function writeKey(k, v) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = function () { res(); db.close(); };
      tx.onerror = function () { res(); db.close(); };
    });
  }).catch(function () {});
}
function daysLeft(exp) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exp || '');
  if (!m) { return null; }
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  var n = new Date();
  var t = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}
function checkAndNotify() {
  return readKey('data').then(function (d) {
    if (!d || !d.items) { return; }
    var n = d.notifyDays || 7, expired = 0, soon = [], i, x;
    for (i = 0; i < d.items.length; i++) {
      x = daysLeft(d.items[i].exp);
      if (x === null) { continue; }
      if (x < 0) { expired++; } else if (x <= n) { soon.push(d.items[i].name); }
    }
    if (!expired && !soon.length) { return; }
    var now = new Date();
    var today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    return readKey('last').then(function (last) {
      if (last === today) { return; }
      var parts = [];
      if (expired) { parts.push(expired + ' expired'); }
      if (soon.length) { parts.push(soon.length + ' expiring within ' + n + ' days: ' + soon.slice(0, 4).join(', ') + (soon.length > 4 ? '...' : '')); }
      return writeKey('last', today).then(function () {
        return self.registration.showNotification('Food stock reminder', { body: parts.join('. '), tag: 'efs-expiry' });
      });
    });
  });
}
self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'expiry-check') { e.waitUntil(checkAndNotify()); }
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) { return list[i].focus(); } }
    return self.clients.openWindow('./index.html');
  }));
});
