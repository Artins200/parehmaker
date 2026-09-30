/* ============================================================
   storage.js — работа с localStorage, утилиты, миграция гостя
   ============================================================ */
'use strict';

/* ---------- ключи ---------- */
const DB = (() => {
  const KEYS = {
    users:    'bb_users',      // клиенты + барберы
    bookings: 'bb_bookings',   // все записи
    current:  'bb_current',    // текущий пользователь
    theme:    'bb_theme',      // 'light' | 'dark'
    guest:    'bb_guest',      // id гостя
    seeded:   'bb_seeded'      // демо-данные уже созданы
  };

  /* ---------- низкоуровневые операции ---------- */
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn('[storage] чтение', key, err);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[storage] запись', key, err);
      return false;
    }
  }

  function remove(key) { try { localStorage.removeItem(key); } catch (err) { /* noop */ } }

  /* ---------- пользователи ---------- */
  const getUsers    = () => read(KEYS.users, []);
  const setUsers    = (list) => write(KEYS.users, list);

  /* ---------- записи ---------- */
  const getBookings = () => read(KEYS.bookings, []);
  const setBookings = (list) => write(KEYS.bookings, list);

  /* ---------- текущий пользователь ---------- */
  const getCurrent  = () => read(KEYS.current, null);
  const setCurrent  = (user) => (user ? write(KEYS.current, user) : remove(KEYS.current));

  /* ---------- тема ---------- */
  function getTheme() {
    const saved = read(KEYS.theme, null);
    if (saved === 'light' || saved === 'dark') return saved;
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? 'dark' : 'light';
  }
  const setTheme = (theme) => write(KEYS.theme, theme);

  /* ---------- гость ---------- */
  function getGuestId() {
    let id = read(KEYS.guest, null);
    if (!id) { id = 'g' + Math.random().toString(36).slice(2, 9); write(KEYS.guest, id); }
    return id;
  }
  const guestKey = () => 'g_' + getGuestId();
  const userKey  = (user) => (user ? 'u_' + user.id : guestKey());

  /* ---------- идентификаторы ---------- */
  const uid = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- миграция гостевых записей в аккаунт ---------- */
  function claimGuestBookings(user) {
    if (!user) return 0;
    const list = getBookings();
    const gKey = guestKey();
    const phone = U.phoneKey(user.phone);
    let moved = 0;

    list.forEach((b) => {
      const isGuestOwner = b.ownerKey === gKey;
      const sameGuestPhone = !b.userId && phone && U.phoneKey(b.userPhone) === phone;
      if (isGuestOwner || sameGuestPhone) {
        b.ownerKey  = 'u_' + user.id;
        b.userId    = user.id;
        b.userName  = user.name;
        b.userPhone = user.phone;
        b.userEmail = user.email;
        moved++;
      }
    });

    if (moved) setBookings(list);
    return moved;
  }

  /* ---------- полный сброс демо-данных ---------- */
  function resetAll() {
    Object.values(KEYS).forEach(remove);
  }

  /* публичный след сессии: только id, остальное берём из bb_users */
  function setSession(id, role) { setCurrent({ id, role, at: Date.now() }); }

  return {
    KEYS, read, write, remove,
    getUsers, setUsers,
    getBookings, setBookings,
    getCurrent, setCurrent, setSession,
    getTheme, setTheme,
    getGuestId, guestKey, userKey,
    uid, claimGuestBookings, resetAll
  };
})();

/* ============================================================
   U — утилиты: даты, время, строки, телефон
   ============================================================ */
const U = (() => {
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- даты ---------- */
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => iso(new Date());
  function fromISO(s) {
    const p = String(s).split('-').map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
  }
  function addDays(dateStr, n) {
    const d = fromISO(dateStr);
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  function fmtDate(dateStr) {                      // 05.01.2026
    const p = String(dateStr).split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(dateStr);
  }
  function fmtDateLong(dateStr) {                  // 5 января
    const d = fromISO(dateStr);
    return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
  }
  function fmtStamp(ts) {                          // 05.01.2026 14:30
    if (!ts) return '';
    const d = new Date(ts);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const isPastDate = (dateStr) => dateStr < today();
  function mondayIndex(d) { return (d.getDay() + 6) % 7; }

  /* ---------- время ---------- */
  const toMinutes = (t) => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };
  const toTime = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);

  /* ---------- строки ---------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '??';
    const first = parts[0][0] || '';
    const second = (parts[1] || parts[0][1] || '')[0] || '';
    return (first + second).toUpperCase();
  }
  function plural(n, forms) {                      // plural(3, ['запись','записи','записей'])
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  /* ---------- телефон ---------- */
  const digits = (v) => String(v || '').replace(/\D/g, '');
  /* ключ сравнения: +7 999 111-22-33, 8 999 111 22 33 и 9991112233 — один номер */
  function phoneKey(v) {
    const d = digits(v);
    return d.length > 10 ? d.slice(-10) : d;
  }
  const phoneOk = (v) => digits(v).length >= 10;
  function prettyPhone(v) {
    const d = digits(v);
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) {
      return '+7 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
    }
    if (d.length === 10) {
      return '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 8) + '-' + d.slice(8);
    }
    return String(v || '').trim();
  }

  /* ---------- прочее ---------- */
  const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' \u20BD';
  const rating = (n) => (Math.round((+n || 0) * 10) / 10).toFixed(1);

  return { MONTHS, DOW, pad, iso, today, fromISO, addDays, fmtDate, fmtDateLong, fmtStamp,
           isPastDate, mondayIndex, toMinutes, toTime, esc, initials, plural, digits, phoneKey,
           phoneOk, prettyPhone, money, rating };
})();
