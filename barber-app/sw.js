/* ============================================================
   sw.js — Service Worker: оболочка и встроенные фото офлайн
   Меняйте CACHE_VERSION при обновлении файлов приложения.
   ============================================================ */
'use strict';

const CACHE_VERSION = 'barber-v2';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const IMAGE_CACHE   = CACHE_VERSION + '-img';

/* ---------- всё, что нужно для работы офлайн ---------- */
const PRECACHE = [
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/storage.js',
  './js/media.js',
  './js/pwa.js',
  './js/auth.js',
  './js/booking.js',
  './js/app.js',
  './images/barber-artem.jpg',
  './images/barber-danila.jpg',
  './images/barber-mark.jpg',
  './images/salon-main.jpg',
  './images/salon-chair.jpg',
  './images/salon-tools.jpg',
  './icons/calendar.svg',
  './icons/list.svg',
  './icons/home.svg',
  './icons/user.svg',
  './icons/scissors.svg',
  './icons/pin.svg',
  './icons/clock.svg',
  './icons/phone.svg',
  './icons/star.svg',
  './icons/star-filled.svg',
  './icons/plus.svg',
  './icons/edit.svg',
  './icons/trash.svg',
  './icons/check.svg',
  './icons/chevron-left.svg',
  './icons/chevron-right.svg',
  './icons/close.svg',
  './icons/moon.svg',
  './icons/sun.svg',
  './icons/logout.svg',
  './icons/download.svg',
  './icons/info.svg',
  './icons/users.svg',
  './icons/chart.svg',
  './icons/calendar-check.svg',
  './icons/card.svg',
  './icons/mail.svg',
  './icons/badge.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

/* Не активируем неполный офлайн-кэш, если один из файлов не загрузился. */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(PRECACHE.map((url) => new Request(new URL(url, self.location.href), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => /^barber-v\d+-(static|img)$/.test(key) && key !== STATIC_CACHE && key !== IMAGE_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const isImage = (url) => /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(url.pathname);

/* Ошибка/переполнение кэша не должны мешать загрузке файла из сети. */
async function save(cache, request, response) {
  try { await cache.put(request, response.clone()); }
  catch (err) { /* Ответ всё равно отдаём странице. */ }
}

async function cacheFirst(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const local = new URL(request.url).origin === self.location.origin;
  let hit = await cache.match(request);
  if (!hit && local) {
    /* Встроенные фото и иконки лежат в precache, а не runtime-кэше. */
    const precache = await caches.open(STATIC_CACHE);
    hit = await precache.match(request, { ignoreSearch: true });
  }
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') await save(cache, request, response);
    return response;
  } catch (err) {
    return Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const controller = new AbortController();
  /* При слабой мобильной сети не заставляем ждать оболочку бесконечно. */
  const timeout = request.mode === 'navigate' ? setTimeout(() => controller.abort(), 7000) : null;
  let response;
  try {
    response = await fetch(request, { signal: controller.signal });
    if (response.ok) {
      await save(cache, request, response);
      return response;
    }
  } catch (err) { /* Офлайн или таймаут — пробуем кэш. */ }
  finally { if (timeout !== null) clearTimeout(timeout); }

  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') {
    const shell = await cache.match(new URL('./index.html', self.location.href).href);
    if (shell) return shell;
  }
  return response || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else if (request.destination === 'image' || isImage(url)) {
    event.respondWith(cacheFirst(request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
