const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appDir = path.join(__dirname, '..', 'barber-app');

function loadMedia(users = [], bookings = []) {
  let writes = 0;
  const listeners = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const context = vm.createContext({
    URL,
    document: {
      baseURI: 'https://example.test/parehmaker/barber-app/index.html',
      addEventListener: (type, cb, capture) => listeners.set(type, { cb, capture })
    },
    DB: {
      getUsers: () => clone(users),
      setUsers: (value) => { users = clone(value); writes++; },
      getBookings: () => clone(bookings),
      setBookings: (value) => { bookings = clone(value); writes++; }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(appDir, 'js/media.js'), 'utf8') + '\nthis.api = Media;', context);
  return { api: context.api, listeners, data: () => ({ users, bookings, writes }) };
}

test('all built-in photos are local JPEG files', () => {
  const { api } = loadMedia();
  const photos = [...Object.values(api.BARBER_PHOTOS), ...api.GALLERY.map((photo) => photo.url)];
  assert.equal(photos.length, 6);
  for (const photo of photos) {
    assert.ok(photo.startsWith('images/'));
    const bytes = fs.readFileSync(path.join(appDir, photo));
    assert.equal(bytes.readUInt16BE(0), 0xffd8, photo);
  }
});

test('legacy URLs map to local assets, preserving unrelated custom photos', () => {
  const { api } = loadMedia();
  assert.equal(api.photoURL('https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400'), 'images/barber-artem.jpg');
  assert.equal(api.photoURL('https://images.unsplash.com/photo-1622286342621-4bd786c2447c?crop=faces'), 'images/salon-chair.jpg');
  for (const value of [
    'https://other.test/photo-1500648767791-00dcc994a43e',
    'https://images.unsplash.com/photo-custom?w=200',
    'images/my-barber.jpg',
    'data:image/png;base64,abc'
  ]) assert.equal(api.photoURL(value), value);
  assert.equal(api.photoURL(null), '');
});

test('migration is idempotent and does not reset users or bookings', () => {
  const oldURL = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&w=400';
  const custom = 'https://example.test/my-photo.jpg';
  const users = [
    { id: 'b1', photo: oldURL, password: 'unchanged', availabilityByDate: { '2026-10-02': ['10:00'] } },
    { id: 'b2', photo: custom },
    { id: 'client', role: 'client' }
  ];
  const bookings = [{ id: 'booking', barberPhoto: oldURL, status: 'active', ownerKey: 'g_test', rating: null }];
  const { api, data } = loadMedia(users, bookings);
  api.migrateLegacyPhotos();
  assert.deepEqual(data().users, [{ ...users[0], photo: 'images/barber-mark.jpg' }, users[1], users[2]]);
  assert.deepEqual(data().bookings, [{ ...bookings[0], barberPhoto: 'images/barber-mark.jpg' }]);
  assert.equal(data().writes, 2);
  api.migrateLegacyPhotos();
  assert.equal(data().writes, 2);
});

test('capture-phase image fallback covers avatars in modals too', () => {
  const { listeners } = loadMedia();
  const listener = listeners.get('error');
  assert.equal(listener.capture, true);
  let removed = false;
  listener.cb({ target: { tagName: 'IMG', closest: (selector) => selector === '.avatar', remove: () => { removed = true; } } });
  assert.equal(removed, true);
});

test('gallery fallback is local and does not retry forever', () => {
  const { listeners } = loadMedia();
  const img = {
    tagName: 'IMG', src: 'https://broken.test/image.jpg',
    closest: (selector) => selector === '.gallery__item',
    remove: () => { img.removed = true; }
  };
  const onError = listeners.get('error').cb;
  onError({ target: img });
  assert.equal(img.src, 'https://example.test/parehmaker/barber-app/images/salon-main.jpg');
  onError({ target: img });
  assert.equal(img.removed, true);
});
