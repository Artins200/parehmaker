const { test, expect } = require('@playwright/test');

async function waitForWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function expectPhotos(locator, count) {
  await expect(locator).toHaveCount(count);
  for (const img of await locator.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
}

async function offerInstall(page, outcome = 'accepted', fail = false) {
  await page.evaluate(({ outcome, fail }) => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.promptCalls = 0;
    event.prompt = async () => {
      window.promptCalls++;
      if (fail) throw new Error('Browser prompt unavailable');
    };
    event.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(event);
  }, { outcome, fail });
}

test('mobile photos load without an external image service', async ({ page }) => {
  const errors = [];
  const externalPhotos = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/unsplash|pexels/.test(request.url())) externalPhotos.push(request.url());
  });
  await page.route(/https:\/\/images\./, (route) => route.abort());
  await page.goto('/');
  await expectPhotos(page.locator('.avatar img'), 3);
  await page.locator('[data-screen="salon"]').click();
  await expectPhotos(page.locator('.gallery__item img'), 3);
  await expectPhotos(page.locator('.avatar img'), 3);
  expect(externalPhotos).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const prefix of ['/', '/barber-app/']) {
  test(`unopened gallery, avatars and PWA shortcuts work offline at ${prefix}`, async ({ page, context }) => {
    await page.goto(prefix);
    await waitForWorker(page);
    await context.setOffline(true);
    await page.goto(prefix + 'index.html?src=pwa');
    await expectPhotos(page.locator('.avatar img'), 3);
    await page.locator('[data-screen="salon"]').click();
    await expectPhotos(page.locator('.gallery__item img'), 3);
    await expectPhotos(page.locator('.avatar img'), 3);
    await page.goto(prefix + 'index.html?screen=bookings');
    await expect(page.locator('#appbar-title')).toContainText('Мои записи');
    await page.locator('[data-screen="account"]').click();
    await expect(page.locator('[data-offline-status]')).toHaveText('Офлайн-режим готов');
  });
}

test('stored legacy photo URLs are migrated without resetting data or custom photos', async ({ page }) => {
  await page.goto('/');
  const previous = await page.evaluate(() => {
    const users = JSON.parse(localStorage.getItem('bb_users'));
    users[0].photo = 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400';
    users[1].photo = 'images/barber-danila.jpg?custom=true';
    users[0].rating = 4.5;
    users[0].ratingsCount = 2;
    localStorage.setItem('bb_users', JSON.stringify(users));
    const bookings = [{ id: 'existing-visit', barberId: users[0].id, barberPhoto: users[0].photo, status: 'active', date: '2026-12-05', time: '10:00', ownerKey: 'g_existing' }];
    localStorage.setItem('bb_bookings', JSON.stringify(bookings));
    return { users, bookings };
  });
  await page.reload();
  const current = await page.evaluate(() => ({
    users: JSON.parse(localStorage.getItem('bb_users')),
    bookings: JSON.parse(localStorage.getItem('bb_bookings'))
  }));
  expect(current.users).toEqual([{ ...previous.users[0], photo: 'images/barber-artem.jpg' }, ...previous.users.slice(1)]);
  expect(current.bookings).toEqual([{ ...previous.bookings[0], barberPhoto: 'images/barber-artem.jpg' }]);
  await expectPhotos(page.locator('.avatar img'), 3);
});

test('installation controls are available before beforeinstallprompt', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#install-btn')).toBeVisible();
  await page.locator('[data-screen="account"]').click();
  await expect(page.locator('[data-install-panel] [data-act="install"]')).toBeVisible();
  await page.locator('[data-install-panel] [data-act="install"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Установить приложение');
  await expect(page.getByRole('dialog')).not.toContainText('Установка недоступна в этом браузере');
});

test('iPhone Safari gets Share / Add to Home Screen instructions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' });
  });
  await page.goto('/');
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toContainText('Safari');
  await expect(page.getByRole('dialog')).toContainText('Поделиться');
  await expect(page.getByRole('dialog')).toContainText('На экран «Домой»');
  await expect(page.getByRole('dialog')).toContainText('Добавить');
});

test('iPad desktop user agent still gets iOS instructions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15' });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await page.goto('/');
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toContainText('На экран «Домой»');
});

test('Android prompt is one-shot and does not reset focus or entered credentials', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-screen="account"]').click();
  const login = page.locator('[data-field="login.identifier"]');
  await login.fill('my-login');
  await offerInstall(page);
  await expect(login).toBeFocused();
  await expect(login).toHaveValue('my-login');
  await page.locator('[data-install-panel] [data-act="install"]').click();
  await expect.poll(() => page.evaluate(() => window.promptCalls)).toBe(1);
  await expect(page.locator('#toast-root')).toContainText('Установка запущена');
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => window.promptCalls)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('#install-btn')).toBeHidden();
  await expect(page.locator('[data-install-panel]')).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(login).toHaveValue('my-login');
});

test('cancellation and prompt failure leave working installation help', async ({ page }) => {
  await page.goto('/');
  await offerInstall(page, 'dismissed');
  await page.locator('#install-btn').click();
  await expect(page.locator('#toast-root')).toContainText('Установка отменена');
  await expect(page.locator('#install-btn')).toBeVisible();
  await offerInstall(page, 'accepted', true);
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#install-btn')).toBeEnabled();
});

test('HTTP/insecure context explains HTTPS instead of pretending installation is available', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await page.goto('/');
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toContainText('HTTPS');
  await expect(page.getByRole('dialog')).toContainText('владельцу сайта нужно включить HTTPS');
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((items) => items.length))).toBe(0);
});

test('embedded preview offers opening the same app in a top-level tab', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<iframe src="/barber-app/index.html" style="width:100%;height:800px"></iframe>');
  const frame = page.frameLocator('iframe');
  await frame.locator('#install-btn').click();
  await expect(frame.getByRole('dialog')).toContainText('отдельной вкладке');
  const link = frame.getByRole('link', { name: 'Открыть в отдельной вкладке' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:8080/barber-app/index.html');
});

test('in-app browser asks to open Safari/Chrome', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/130.0.0.0 Mobile Safari/537.36 Instagram'
  }));
  await page.goto('/');
  await page.locator('#install-btn').click();
  await expect(page.getByRole('dialog')).toContainText('мессенджера');
  await expect(page.getByRole('dialog')).toContainText('Chrome');
});

test('standalone launch hides all installation controls', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.goto('/');
  await expect(page.locator('#install-btn')).toBeHidden();
  await page.locator('[data-screen="account"]').click();
  await expect(page.locator('[data-install-panel]')).toBeHidden();
  await expect(page.locator('[data-install-panel] button')).toHaveCount(0);
});

test('broken custom avatar reveals initials even after a re-render', async ({ page }) => {
  await page.goto('/');
  await waitForWorker(page);
  await page.evaluate(() => {
    const users = JSON.parse(localStorage.getItem('bb_users'));
    users[0].photo = 'images/nonexistent.jpg';
    localStorage.setItem('bb_users', JSON.stringify(users));
  });
  await page.reload();
  await expect(page.locator('.barber-card').first().locator('img')).toHaveCount(0);
  await expect(page.locator('.barber-card').first().locator('.avatar__initials')).toHaveText('АС');
  await page.locator('[data-screen="salon"]').click();
  await expect(page.locator('[data-act="salon-barber"]').first().locator('img')).toHaveCount(0);
});

for (const prefix of ['/', '/barber-app/']) {
  test(`Chromium reports no PWA installability errors at ${prefix}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP installability diagnostics are Chromium-only');
    await page.goto(prefix);
    await waitForWorker(page);
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
  });
}

test('installation help fits a narrow 320px phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.locator('#install-btn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#install-btn').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
