// CardBreakPro Service Worker
const CACHE = 'cbp-v3';
const PRECACHE = [
  '/config.js',
  '/analytics.js',
  '/mobile.css',
  '/logo.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(PRECACHE).catch(function() {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('supabase.co') || url.includes('stripe.com') || url.includes('posthog.com') || url.includes('resend.com')) return;

  // HTML navigation: always go to network, only fall back to cache when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(e.request).then(function(cached) {
          if (cached) return cached;
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;text-align:center}.icon{font-size:3rem;margin-bottom:1rem}.title{font-size:1.3rem;font-weight:800;margin-bottom:0.5rem}.sub{color:#64748b;font-size:0.9rem;line-height:1.5;margin-bottom:1.5rem}.btn{background:#4f6ef7;color:#fff;border:none;border-radius:10px;padding:0.8rem 2rem;font-weight:700;font-size:1rem;cursor:pointer}</style></head><body><div class="icon">📡</div><div class="title">You\'re Offline</div><div class="sub">CardBreakPro can\'t connect right now.<br>Check your connection and try again.</div><button class="btn" onclick="location.reload()">Try Again</button></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
    );
    return;
  }

  // Static assets: cache-first, update in background
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var networkFetch = fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      });
      return cached || networkFetch;
    })
  );
});
