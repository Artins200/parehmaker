/* ============================================================
   sw.js — Service Worker: офлайн-режим, кэш barber-v2
   Меняйте CACHE_VERSION при обновлении файлов приложения.
   ============================================================ */
'use strict';

const CACHE_VERSION = 'barber-v1';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const IMAGE_CACHE   = CACHE_VERSION + '-img';

/* ---------- всё, что нужно для работы офлайн ---------- */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/storage.js',
  './js/auth.js',
  './js/booking.js',
  './js/app.js',
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

/* ---------- установка: кладём ассеты в кэш ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    /* addAll падает целиком при одной ошибке — кладём поштучно */
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    self.skipWaiting();
  })());
});

/* ---------- активация: чистим старые версии ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => !k.startsWith(CACHE_VERSION))
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) { /* noop */ }
    }
    await self.clients.claim();
  })());
});

/* ---------- стратегии ---------- */
const isImage = (url) => /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(url.pathname);
const isRemote = (url) => url.origin !== self.location.origin;

/* картинки: сначала кэш, иначе сеть с докладкой в кэш */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

/* код и стили: сначала сеть (свежая версия), при офлайне — кэш */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* навигация — отдаём оболочку приложения */
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }
  /* фото салона и аватары (Unsplash и любые внешние) */
  if (isRemote(url) || isImage(url)) {
    event.respondWith(cacheFirst(request, isImage(url) ? IMAGE_CACHE : STATIC_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, STATIC_CACHE));
});

/* ---------- сообщения от страницы (обновление / версия) ---------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
