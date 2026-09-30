const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadPWA(options = {}) {
  const window = new EventTarget();
  const display = new EventTarget();
  display.matches = options.standalone || false;
  window.matchMedia = () => display;
  window.isSecureContext = options.secure !== false;
  window.self = window;
  window.top = options.embedded ? {} : window;
  const registration = new EventTarget();
  registration.installing = new EventTarget();
  const calls = [];
  const navigator = {
    userAgent: options.ua || 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: options.platform || 'Linux',
    maxTouchPoints: options.touchPoints || 0,
    standalone: options.iosStandalone || false,
    serviceWorker: {
      controller: options.controlled ? {} : null,
      register: async (...args) => {
        calls.push(args);
        if (options.registrationError) throw new Error('Registration failed');
        return registration;
      },
      ready: Promise.resolve(registration)
    }
  };
  if (options.noServiceWorker) delete navigator.serviceWorker;
  const context = vm.createContext({
    window, navigator, URL, CustomEvent,
    document: {
      readyState: options.loading ? 'loading' : 'complete',
      baseURI: options.baseURI || 'https://example.test/parehmaker/barber-app/index.html?src=pwa'
    },
    console: { warn() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../barber-app/js/pwa.js'), 'utf8') + '\nthis.api = PWA;', context);
  return { api: context.api, window, navigator, calls, registration, display };
}

function offer(window, outcome = 'accepted', promptFn = async () => {}) {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  event.prompt = promptFn;
  event.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('native prompt is prevented, invoked synchronously once and consumed', async () => {
  const { api, window } = loadPWA();
  let calls = 0;
  let finish;
  const event = offer(window, 'accepted', () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(api.canPrompt(), true);
  const first = api.install();
  assert.equal(calls, 1);
  assert.equal(api.isPrompting(), true);
  assert.equal(await api.install(), 'unavailable');
  finish();
  assert.equal(await first, 'accepted');
  assert.equal(api.isPrompting(), false);
  assert.equal(api.canPrompt(), false);
});

test('dismissed/error prompt leaves a usable manual installation path', async () => {
  const { api, window } = loadPWA();
  offer(window, 'dismissed');
  assert.equal(await api.install(), 'dismissed');
  assert.equal(api.isInstalled(), false);
  offer(window, 'accepted', async () => { throw new Error('Browser refused prompt'); });
  assert.equal(await api.install(), 'error');
  assert.equal(api.isPrompting(), false);
});

test('appinstalled and standalone display suppress installation controls', async () => {
  const { api, window } = loadPWA();
  offer(window);
  window.dispatchEvent(new Event('appinstalled'));
  assert.equal(api.isInstalled(), true);
  assert.equal(api.canPrompt(), false);
  assert.equal(loadPWA({ standalone: true }).api.isInstalled(), true);
  assert.equal(loadPWA({ iosStandalone: true }).api.isInstalled(), true);
  const changed = loadPWA();
  changed.display.matches = true;
  changed.display.dispatchEvent(new Event('change'));
  assert.equal(changed.api.isInstalled(), true);
});

test('iPhone Safari, iOS Chrome, desktop-mode iPad and Android webview are distinguished', () => {
  const safari = loadPWA({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' }).api.environment();
  assert.equal(safari.ios, true);
  assert.equal(safari.safari, true);
  assert.equal(safari.android, false);
  const iosChrome = loadPWA({ ua: 'Mozilla/5.0 (iPhone) CriOS/130.0 Mobile/15E148 Safari/604.1' }).api.environment();
  assert.equal(iosChrome.ios, true);
  assert.equal(iosChrome.safari, false);
  assert.equal(loadPWA({ ua: 'Mozilla/5.0 (Macintosh) Version/18 Safari/605.1', platform: 'MacIntel', touchPoints: 5 }).api.environment().ios, true);
  assert.equal(loadPWA({ ua: 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/130 Mobile Safari/537.36' }).api.environment().inAppBrowser, true);
});

test('insecure, embedded and in-app contexts never attempt native installation', async () => {
  for (const options of [{ secure: false }, { embedded: true }, { ua: 'Mozilla/5.0 (Android; wv) Chrome/130 Mobile Safari/537.36' }]) {
    const { api, window } = loadPWA(options);
    let prompts = 0;
    offer(window, 'accepted', () => { prompts++; });
    assert.equal(api.canPrompt(), false);
    assert.equal(await api.install(), 'unavailable');
    assert.equal(prompts, 0);
  }
});

test('service worker uses the app directory at both root and nested URLs, bypassing HTTP cache', async () => {
  for (const prefix of ['/', '/parehmaker/barber-app/']) {
    const { api, calls } = loadPWA({ baseURI: `https://example.test${prefix}index.html?src=pwa` });
    api.registerServiceWorker();
    api.registerServiceWorker();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `https://example.test${prefix}sw.js`);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { scope: `https://example.test${prefix}`, updateViaCache: 'none' });
    assert.equal(api.statusText(), 'Офлайн-режим готов');
  }
});

test('registration works both before and after window load', async () => {
  const { api, window, calls } = loadPWA({ loading: true });
  api.registerServiceWorker();
  assert.equal(calls.length, 0);
  window.dispatchEvent(new Event('load'));
  await flush();
  assert.equal(calls.length, 1);
  window.dispatchEvent(new Event('load'));
  assert.equal(calls.length, 1);
});

test('offline status reflects unsupported browsers and registration failures', async () => {
  for (const options of [{ secure: false }, { noServiceWorker: true }]) {
    const { api, calls } = loadPWA(options);
    api.registerServiceWorker();
    assert.equal(calls.length, 0);
    assert.match(api.statusText(), /HTTPS/);
  }
  const { api } = loadPWA({ registrationError: true });
  api.registerServiceWorker();
  await flush();
  assert.match(api.statusText(), /недоступен/);
});

test('worker updates notify the UI without re-registering', async () => {
  const { api, window, registration } = loadPWA({ controlled: true });
  let updates = 0;
  window.addEventListener('pwa-updateavailable', () => updates++);
  api.registerServiceWorker();
  await flush();
  registration.dispatchEvent(new Event('updatefound')); // The same worker must not be watched twice.
  registration.installing.state = 'installed';
  registration.installing.dispatchEvent(new Event('statechange'));
  assert.equal(updates, 1);
});
