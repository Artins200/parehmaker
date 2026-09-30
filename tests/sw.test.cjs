const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appDir = path.join(__dirname, '..', 'barber-app');
const source = fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8');

function loadWorker(prefix = '/barber-app/') {
  const scope = `https://example.test${prefix}`;
  const listeners = new Map();
  const stores = new Map();
  const stats = { fetched: [], skipped: 0, claimed: 0, failPrecache: false, failPut: false };
  function key(value, ignoreSearch = false) {
    const url = new URL(typeof value === 'string' ? value : value.url, scope);
    if (ignoreSearch) url.search = '';
    return url.href;
  }
  function open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name);
    return Promise.resolve({
      async addAll(requests) {
        if (stats.failPrecache) throw new Error('Incomplete assets');
        for (const request of requests) {
          assert.equal(request.cache, 'reload');
          data.set(key(request), new Response('cached ' + new URL(request.url).pathname));
        }
      },
      async match(request, options = {}) {
        const item = [...data.entries()].find(([url]) => key(url, options.ignoreSearch) === key(request, options.ignoreSearch));
        return item && item[1].clone();
      },
      async put(request, response) {
        if (stats.failPut) throw new Error('Quota exceeded');
        data.set(key(request), response.clone());
      }
    });
  }
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
      stats.fetched.push(request.url);
      if (stats.offline) throw new Error('Offline');
      return new Response('network ' + request.url, { status: stats.status || 200 });
    }
  });
  vm.runInContext(source + '\nthis.config = { PRECACHE, CACHE_VERSION, STATIC_CACHE, IMAGE_CACHE };', context);
  async function lifecycle(type) {
    let pending;
    listeners.get(type)({ waitUntil: (promise) => { pending = promise; } });
    return pending;
  }
  async function request(url, options = {}) {
    let pending;
    listeners.get('fetch')({
      request: { url: new URL(url, scope).href, method: options.method || 'GET', mode: options.mode || 'no-cors', destination: options.destination || '' },
      respondWith: (promise) => { pending = promise; }
    });
    return pending;
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
  assert.notEqual(config.CACHE_VERSION, 'barber-v1');
});

test('manifest is installable at root and nested deployment paths with real PNG icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  for (const prefix of ['/', '/parehmaker/barber-app/']) {
    const base = `https://example.test${prefix}manifest.json`;
    assert.equal(new URL(manifest.start_url, base).pathname, prefix + 'index.html');
    assert.ok(new URL(manifest.start_url, base).href.startsWith(new URL(manifest.scope, base).href));
    for (const shortcut of manifest.shortcuts) assert.ok(new URL(shortcut.url, base).pathname.startsWith(prefix));
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
  const worker = loadWorker();
  worker.stats.failPrecache = true;
  await assert.rejects(worker.lifecycle('install'), /Incomplete assets/);
  assert.equal(worker.stats.skipped, 0);
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
    for (const url of ['./', './index.html?src=pwa', './index.html?screen=bookings']) {
      const response = await worker.request(url, { mode: 'navigate' });
      assert.equal(response.ok, true);
      assert.equal(await response.text(), 'cached ' + prefix + 'index.html');
    }
  });
}

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
