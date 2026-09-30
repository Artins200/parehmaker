/* ============================================================
   media.js — встроенные фото без зависимости от внешнего CDN
   ============================================================ */
'use strict';

const Media = (() => {
  const BARBER_PHOTOS = Object.freeze({
    artem: 'images/barber-artem.jpg',
    danila: 'images/barber-danila.jpg',
    mark: 'images/barber-mark.jpg'
  });

  const GALLERY = Object.freeze([
    { url: 'images/salon-main.jpg', cap: 'Основной зал' },
    { url: 'images/salon-chair.jpg', cap: 'Кресло мастера' },
    { url: 'images/salon-tools.jpg', cap: 'Инструменты барбера' }
  ]);

  /* Старые демо-фото уже сохранены у пользователей в localStorage.
     Меняем только известные URL, не трогая собственные фото мастеров. */
  const LEGACY_PHOTOS = {
    'photo-1500648767791-00dcc994a43e': BARBER_PHOTOS.artem,
    'photo-1492562080023-ab3db95bfbce': BARBER_PHOTOS.danila,
    'photo-1507003211169-0a1dd7228f2d': BARBER_PHOTOS.mark,
    'photo-1585747860715-2ba37e788b70': GALLERY[0].url,
    'photo-1622286342621-4bd786c2447c': GALLERY[1].url,
    'photo-1503951914875-452162b0f3f1': GALLERY[2].url
  };

  function photoURL(value) {
    const photo = String(value || '').trim();
    if (!photo) return '';
    try {
      const url = new URL(photo, document.baseURI);
      if (url.hostname === 'images.unsplash.com') {
        const local = LEGACY_PHOTOS[url.pathname.slice(1)];
        if (local) return local;
      }
    } catch (err) { /* Некорректную ссылку обработает fallback изображения. */ }
    return photo;
  }

  function migrateLegacyPhotos() {
    for (const [read, write, field] of [
      [DB.getUsers, DB.setUsers, 'photo'],
      [DB.getBookings, DB.setBookings, 'barberPhoto']
    ]) {
      const list = read();
      let changed = false;
      list.forEach((item) => {
        const local = photoURL(item[field]);
        if (item[field] && local !== item[field]) {
          item[field] = local;
          changed = true;
        }
      });
      if (changed) write(list);
    }
  }

  /* Событие error у img не всплывает: перехватываем его и в экранах,
     и в модалках. В отличие от подписки после innerHTML нет гонки с кэшем. */
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.closest('.avatar')) {
      img.remove(); // Под фотографией уже находятся инициалы.
    } else if (img.closest('.gallery__item')) {
      const fallback = new URL(GALLERY[0].url, document.baseURI).href;
      if (img.src !== fallback) img.src = fallback;
      else img.remove(); // Не повторяем неудачный запрос бесконечно.
    }
  }, true);

  return { BARBER_PHOTOS, GALLERY, photoURL, migrateLegacyPhotos };
})();
