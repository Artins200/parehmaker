const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appDir = path.join(__dirname, '..', 'barber-app');
const source = fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8');

/* Так ведёт себя реальный браузер: ответ, пришедший через редирект, нельзя отдать
   на открытие страницы (redirect mode 'manual'), иначе страница не открывается. */
function markRedirected(response) {
  Object.defineProperty(response, 'redirected', { value: true });
  const clone = response.clone.bind(response);
  response.clone = () => markRedirected(clone());
  return response;
}

function opaqueRedirect() {
  const response = new Response(null);
  Object.defineProperties(response, { type: { value: 'opaqueredirect' }, status: { value: 0 }, ok: { value: false } });
  return response;
}

function loadWorker(prefix = '/barber-app/') {
  const scope = `https://example.test${prefix}`;
  const listeners = new Map();
  const stores = new Map();
  const stats = {
    fetched: [], precached: [], skipped: 0, claimed: 0, phase: 'idle',
    missing: null,            // путь файла, которого нет на сервере (404 при установке)
    redirects: new Map(),     // путь → путь: сервер отвечает редиректом, как Cloudflare на /index.html
    redirectedSeen: 0,        // сколько ответов через редирект получил worker
    redirectedPuts: []        // что worker сохранил в кэш с признаком redirected
  };
  function key(value, ignoreSearch = false) {
    const url = new URL(typeof value === 'string' ? value : value.url, scope);
    if (ignoreSearch) url.search = '';
    return url.href;
  }
  function open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name);
    return Promise.resolve({
      async match(request, options = {}) {
        const item = [...data.entries()].find(([url]) => key(url, options.ignoreSearch) === key(request, options.ignoreSearch));
        return item && item[1].clone();
      },
      async put(request, response) {
        if (stats.failPut) throw new Error('Quota exceeded');
        if (response.redirected) stats.redirectedPuts.push(new URL(request.url).pathname);
        data.set(key(request), response.clone());
      }
    });
  }
  /* Статический хостинг: у адреса папки отдаётся index.html. */
  const servedPath = (pathname) => (pathname.endsWith('/') ? pathname + 'index.html' : pathname);
  const context = vm.createContext({
    URL, Request, Response, AbortController, setTimeout, clearTimeout,
    self: {
      location: new URL(scope + 'sw.js'),
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => { stats.skipped++; },
      clients: { claim: async () => { stats.claimed++; } }
    },
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name)
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const precache = stats.phase === 'install';
      if (precache) assert.equal(request.cache, 'reload', 'precache must bypass the HTTP cache');
      (precache ? stats.precached : stats.fetched).push(request.url);
      if (stats.offline) throw new Error('Offline');
      if (precache && stats.missing === url.pathname) return new Response('Not found', { status: 404 });
      const target = stats.redirects.get(url.pathname);
      if (target !== undefined) {
        stats.redirectedSeen++;
        if (request.mode === 'navigate') return opaqueRedirect();
        return markRedirected(new Response(precache ? 'cached ' + servedPath(target) : 'network ' + request.url));
      }
      const body = precache ? 'cached ' + servedPath(url.pathname) : 'network ' + request.url;
      return new Response(body, { status: stats.status || 200 });
    }
  });
  vm.runInContext(source + '\nthis.config = { PRECACHE, CACHE_VERSION, STATIC_CACHE, IMAGE_CACHE };', context);
  async function lifecycle(type) {
    let pending;
    stats.phase = type;
    try {
      listeners.get(type)({ waitUntil: (promise) => { pending = promise; } });
      return await pending;
    } finally { stats.phase = 'idle'; }
  }
  async function request(url, options = {}) {
    let pending;
    listeners.get('fetch')({
      request: { url: new URL(url, scope).href, method: options.method || 'GET', mode: options.mode || 'no-cors', destination: options.destination || '' },
      respondWith: (promise) => { pending = promise; }
    });
    const response = await pending;
    if (response && options.mode === 'navigate' && response.redirected) {
      throw new TypeError('a redirected response was used for a request whose redirect mode is not "follow"');
    }
    return response;
  }
  return { config: context.config, stats, stores, open, lifecycle, request };
}

test('precache includes every script, app icon and built-in photo; all paths exist', () => {
  const { config } = loadWorker();
  const urls = [...config.PRECACHE];
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(urls.includes('./' + match[1]), match[1]);
  for (const photo of fs.readdirSync(path.join(appDir, 'images')).filter((name) => name.endsWith('.jpg'))) {
    assert.ok(urls.includes('./images/' + photo));
  }
  for (const url of urls) assert.ok(fs.existsSync(path.join(appDir, url)), url);
  assert.ok(urls.includes('./') && urls.includes('./index.html'), 'the shell is cached under both its canonical and file URL');
  assert.ok(Number(config.CACHE_VERSION.replace('barber-v', '')) >= 3, 'cache version was bumped with the redirect fix');
  assert.notEqual(config.CACHE_VERSION, 'barber-v1');
});

test('manifest is installable at root and nested deployment paths with real PNG icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  for (const prefix of ['/', '/parehmaker/barber-app/']) {
    const base = `https://example.test${prefix}manifest.json`;
    /* Cloudflare Workers/Pages перенаправляют /index.html на /, поэтому запускаем приложение с адреса папки. */
    assert.equal(new URL(manifest.start_url, base).pathname, prefix);
    assert.equal(new URL(manifest.start_url, base).searchParams.get('src'), 'pwa');
    assert.ok(new URL(manifest.start_url, base).href.startsWith(new URL(manifest.scope, base).href));
    for (const shortcut of manifest.shortcuts) {
      assert.equal(new URL(shortcut.url, base).pathname, prefix);
      assert.ok(new URL(shortcut.url, base).searchParams.has('screen'));
    }
  }
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(appDir, icon.src));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
});

test('worker refuses to activate an incomplete precache', async () => {
  const missing = loadWorker();
  missing.stats.missing = '/barber-app/js/app.js';
  await assert.rejects(missing.lifecycle('install'), /js\/app\.js.*404/);
  assert.equal(missing.stats.skipped, 0);
  const offline = loadWorker();
  offline.stats.offline = true;
  await assert.rejects(offline.lifecycle('install'), /Offline/);
  assert.equal(offline.stats.skipped, 0);
});

for (const prefix of ['/', '/parehmaker/barber-app/']) {
  test(`pre-cached photos and icons load offline without opening them first (${prefix})`, async () => {
    const worker = loadWorker(prefix);
    await worker.lifecycle('install');
    assert.equal(worker.stats.skipped, 1);
    worker.stats.offline = true;
    for (const asset of ['images/barber-artem.jpg', 'images/salon-chair.jpg', 'icons/icon-192.png', 'icons/calendar.svg']) {
      const response = await worker.request(asset, { destination: 'image' });
      assert.equal(response.ok, true);
      assert.equal(await response.text(), 'cached ' + prefix + asset);
    }
    assert.equal(worker.stats.fetched.length, 0);
  });

  test(`offline PWA launch and shortcut query parameters return the cached shell (${prefix})`, async () => {
    const worker = loadWorker(prefix);
    await worker.lifecycle('install');
    worker.stats.offline = true;
    for (const url of ['./', './?src=pwa', './?screen=bookings', './index.html?src=pwa', './index.html?screen=bookings']) {
      const response = await worker.request(url, { mode: 'navigate' });
      assert.equal(response.ok, true);
      assert.equal(await response.text(), 'cached ' + prefix + 'index.html');
    }
  });
}

/* Cloudflare Workers/Pages отвечают на /index.html редиректом на /. Без «чистых» копий
   приложение с домашнего экрана не открывалось вообще: net::ERR_FAILED. */
for (const prefix of ['/', '/parehmaker/']) {
  test(`host redirecting /index.html to / cannot break the installed app, online or offline (${prefix})`, async () => {
    const worker = loadWorker(prefix);
    worker.stats.redirects.set(prefix + 'index.html', prefix);
    await worker.lifecycle('install');
    assert.ok(worker.stats.redirectedSeen > 0, 'the redirect must really be exercised');
    assert.deepEqual(worker.stats.redirectedPuts, [], 'redirected copies must never reach the cache');
    assert.equal(worker.stats.skipped, 1);

    /* Офлайн: кэш отдаёт и старый адрес запуска, и новый (request() отклоняет redirected-ответы, как браузер). */
    worker.stats.offline = true;
    for (const url of ['./', './?src=pwa', './index.html?src=pwa', './index.html?screen=bookings']) {
      const response = await worker.request(url, { mode: 'navigate' });
      assert.equal(response.ok, true, url);
      assert.equal(response.redirected, false, url);
      assert.equal(await response.text(), 'cached ' + prefix + 'index.html', url);
    }
  });

  test(`online redirect of a launch URL is handed to the browser, not replaced by the cache (${prefix})`, async () => {
    const worker = loadWorker(prefix);
    await worker.lifecycle('install');
    worker.stats.redirects.set(prefix + 'index.html', prefix);
    const response = await worker.request('./index.html?src=pwa', { mode: 'navigate' });
    assert.equal(response.type, 'opaqueredirect');
    assert.equal(worker.stats.fetched.length, 1);
    assert.deepEqual(worker.stats.redirectedPuts, []);
  });
}

test('responses that arrive through a redirect are stored as clean copies at runtime too', async () => {
  const worker = loadWorker();
  worker.stats.redirects.set('/barber-app/js/extra.js', '/barber-app/js/extra.js');
  worker.stats.redirects.set('/barber-app/images/extra.png', '/barber-app/images/extra.png');
  for (const [url, options] of [['js/extra.js', {}], ['images/extra.png', { destination: 'image' }]]) {
    const response = await worker.request(url, options);
    assert.equal(response.ok, true, url);
  }
  assert.deepEqual(worker.stats.redirectedPuts, []);
  worker.stats.offline = true;
  assert.equal((await worker.request('js/extra.js')).ok, true);
  assert.equal((await worker.request('images/extra.png', { destination: 'image' })).ok, true);
});

test('a deleted or unreachable site still opens the installed app from the cache', async () => {
  const worker = loadWorker();
  await worker.lifecycle('install');
  for (const dead of [{ status: 404 }, { status: 503 }, { offline: true }]) {
    Object.assign(worker.stats, { status: 0, offline: false }, dead);
    for (const url of ['./?src=pwa', './index.html?src=pwa', './some/unknown/page']) {
      const response = await worker.request(url, { mode: 'navigate' });
      assert.equal(response.ok, true, JSON.stringify(dead) + ' ' + url);
      assert.equal(await response.text(), 'cached /barber-app/index.html');
    }
  }
});

test('activation deletes old app caches, not other apps on the same origin', async () => {
  const worker = loadWorker();
  for (const name of ['barber-v1-static', 'barber-v1-img', 'another-app-v1-static', worker.config.STATIC_CACHE]) {
    await worker.open(name);
  }
  await worker.lifecycle('activate');
  assert.deepEqual([...worker.stores.keys()].sort(), ['another-app-v1-static', worker.config.STATIC_CACHE].sort());
  assert.equal(worker.stats.claimed, 1);
});

test('remote image transformation queries are separate cache keys', async () => {
  const worker = loadWorker();
  const small = 'https://custom.test/photo.jpg?w=100';
  const large = 'https://custom.test/photo.jpg?w=900';
  assert.equal(await (await worker.request(small, { destination: 'image' })).text(), 'network ' + small);
  assert.equal(await (await worker.request(large, { destination: 'image' })).text(), 'network ' + large);
  assert.equal(worker.stats.fetched.length, 2);
  worker.stats.offline = true;
  assert.equal(await (await worker.request(small, { destination: 'image' })).text(), 'network ' + small);
});

test('HTTP errors fall back to cached application files', async () => {
  const worker = loadWorker();
  await worker.lifecycle('install');
  worker.stats.status = 503;
  const response = await worker.request('js/app.js');
  assert.equal(response.ok, true);
  assert.equal(await response.text(), 'cached /barber-app/js/app.js');
});

test('quota errors do not break successful network responses', async () => {
  const worker = loadWorker();
  worker.stats.failPut = true;
  assert.equal((await worker.request('js/app.js')).ok, true);
  assert.equal((await worker.request('https://custom.test/photo.jpg', { destination: 'image' })).ok, true);
});

test('non-GET and unrelated remote requests are not intercepted', async () => {
  const worker = loadWorker();
  assert.equal(await worker.request('./api', { method: 'POST' }), undefined);
  assert.equal(await worker.request('https://other.test/data.json'), undefined);
  assert.equal(await worker.request('data:image/png;base64,abc', { destination: 'image' }), undefined);
});

test('local runtime image queries are separate cache keys too', async () => {
  const worker = loadWorker();
  for (const url of ['images/custom.jpg?w=100', 'images/custom.jpg?w=900']) {
    assert.equal((await worker.request(url, { destination: 'image' })).ok, true);
  }
  assert.equal(worker.stats.fetched.length, 2);
});
