/* ============================================================
   pwa.js — установка, окружение и регистрация Service Worker
   ============================================================ */
'use strict';

const PWA = (() => {
  const displayMode = window.matchMedia('(display-mode: standalone)');
  let deferredPrompt = null;
  let installed = isStandalone();
  let prompting = false;
  let workerStatus = 'idle';
  let registrationStarted = false;

  function isStandalone() {
    return displayMode.matches || navigator.standalone === true;
  }

  function notify() {
    window.dispatchEvent(new CustomEvent('pwa-statechange'));
  }

  function environment() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const safari = ios && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
    const inAppBrowser = /FBAN|FBAV|Instagram|\bwv\b|VKAndroidApp|VK-iPhone|Telegram|TikTok|MicroMessenger|Line\//i.test(ua);
    let embedded = false;
    try { embedded = window.self !== window.top; } catch (err) { embedded = true; }
    return { ios, android, safari, inAppBrowser, embedded, secure: window.isSecureContext === true };
  }

  function canPrompt() {
    const env = environment();
    return !!deferredPrompt && !prompting && !isInstalled() && env.secure && !env.embedded && !env.inAppBrowser;
  }

  function isInstalled() { return installed || isStandalone(); }

  /* prompt() должен вызываться непосредственно в обработчике нажатия.
     Событие одноразовое, поэтому убираем его до первого await. */
  async function install() {
    if (!canPrompt()) return 'unavailable';
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompting = true;
    notify();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      return choice.outcome;
    } catch (err) {
      console.warn('[pwa] установка не удалась', err);
      return 'error';
    } finally {
      prompting = false;
      notify();
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    notify();
  });

  const onDisplayChange = () => {
    if (isStandalone()) installed = true;
    notify();
  };
  if (displayMode.addEventListener) displayMode.addEventListener('change', onDisplayChange);
  else if (displayMode.addListener) displayMode.addListener(onDisplayChange);

  function registerServiceWorker() {
    if (registrationStarted) return;
    registrationStarted = true;
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      workerStatus = 'unsupported';
      notify();
      return;
    }

    const register = async () => {
      workerStatus = 'registering';
      notify();
      try {
        /* Относительные URL сохраняют работу и в /, и в /parehmaker/barber-app/. */
        const scriptURL = new URL('sw.js', document.baseURI);
        const scope = new URL('./', scriptURL).href;
        const reg = await navigator.serviceWorker.register(scriptURL.href, {
          scope, updateViaCache: 'none'
        });
        const watched = new WeakSet();
        const watchWorker = (worker) => {
          if (!worker || watched.has(worker)) return;
          watched.add(worker);
          const wasControlled = !!navigator.serviceWorker.controller;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && wasControlled) {
              window.dispatchEvent(new CustomEvent('pwa-updateavailable'));
            }
            if (worker.state === 'redundant' && !navigator.serviceWorker.controller) {
              workerStatus = 'error';
              notify();
            }
          });
        };
        watchWorker(reg.installing);
        reg.addEventListener('updatefound', () => watchWorker(reg.installing));
        await navigator.serviceWorker.ready;
        workerStatus = 'ready';
        notify();
      } catch (err) {
        workerStatus = 'error';
        notify();
        console.warn('[sw] регистрация не удалась', err);
      }
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  const statusText = () => {
    if (workerStatus === 'ready') return 'Офлайн-режим готов';
    if (workerStatus === 'unsupported') return 'Для офлайн-режима нужен браузер с поддержкой PWA и HTTPS';
    if (workerStatus === 'error') return 'Офлайн-режим недоступен — проверьте соединение и обновите страницу';
    return 'Подготовка офлайн-режима…';
  };

  return { environment, isStandalone, isInstalled, canPrompt, install,
    isPrompting: () => prompting, registerServiceWorker, statusText };
})();
