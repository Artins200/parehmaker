/* ============================================================
   booking.js — услуги, слоты, создание/отмена/завершение/оценка
   ============================================================ */
'use strict';

const Booking = (() => {

  /* ---------- услуги по умолчанию ---------- */
  const SERVICES = [
    { id: 1, name: 'Мужская стрижка',   price: 1500, duration: 60 },
    { id: 2, name: 'Стрижка машинкой',  price: 800,  duration: 30 },
    { id: 3, name: 'Стрижка бороды',    price: 700,  duration: 30 },
    { id: 4, name: 'Оформление усов',   price: 500,  duration: 20 },
    { id: 5, name: 'Стрижка + борода',  price: 2000, duration: 90 },
    { id: 6, name: 'Детская стрижка',   price: 1000, duration: 45 }
  ];

  /* ---------- рабочий день: 09:00 – 20:00, шаг 30 минут ---------- */
  const STEP = 30, OPEN = 9 * 60, CLOSE = 20 * 60;
  const ALL_SLOTS = (() => {
    const out = [];
    for (let m = OPEN; m < CLOSE; m += STEP) out.push(U.toTime(m));
    return out;
  })();

  const serviceById = (id) => SERVICES.find((s) => s.id === Number(id)) || null;
  const servicesOf = (barber) => (barber && barber.services ? barber.services : [])
    .map(serviceById).filter(Boolean);

  /* ---------- сколько получасовых слотов занимает услуга ---------- */
  const spanOf = (duration) => Math.max(1, Math.ceil((Number(duration) || STEP) / STEP));

  function spanTimes(time, duration) {
    const start = U.toMinutes(time);
    const out = [];
    for (let i = 0; i < spanOf(duration); i++) out.push(U.toTime(start + i * STEP));
    return out;
  }

  /* ---------- занятые слоты мастера на дату ---------- */
  function busyMap(barberId, date, exceptId) {
    const map = new Map();
    DB.getBookings().forEach((b) => {
      if (b.barberId !== barberId || b.date !== date) return;
      if (b.status === 'cancelled' || b.id === exceptId) return;
      spanTimes(b.time, b.duration).forEach((t) => map.set(t, b));
    });
    return map;
  }

  const bookingAt = (barberId, date, time, exceptId) => busyMap(barberId, date, exceptId).get(time) || null;

  /* ---------- график мастера ---------- */
  const availabilityOf = (barber, date) => ((barber && barber.availabilityByDate) || {})[date] || [];
  const worksOn = (barber, date) => availabilityOf(barber, date).length > 0;

  function hasAnyAvailability(barber, fromDate) {
    if (!barber || !barber.availabilityByDate) return false;
    const from = fromDate || U.today();
    return Object.keys(barber.availabilityByDate).some((d) => d >= from && barber.availabilityByDate[d].length);
  }

  /* время уже прошло (для сегодняшней даты) */
  function isPastSlot(date, time) {
    const now = new Date();
    const nowISO = U.iso(now);
    if (date < nowISO) return true;
    if (date > nowISO) return false;
    return U.toMinutes(time) <= (now.getHours() * 60 + now.getMinutes()) + 15;
  }

  /* слоты мастера на дату, которые ещё можно занять */
  function freeSlots(barberId, date) {
    const barber = Auth.findById(barberId);
    if (!barber) return [];
    const busy = busyMap(barberId, date);
    return availabilityOf(barber, date).filter((t) => !busy.has(t) && !isPastSlot(date, t));
  }

  /* все слоты дня, включая занятые/прошедшие (для отрисовки сетки) */
  function daySlots(barberId, date) {
    const barber = Auth.findById(barberId);
    if (!barber) return [];
    const busy = busyMap(barberId, date);
    return availabilityOf(barber, date)
      .slice()
      .sort((a, b) => U.toMinutes(a) - U.toMinutes(b))
      .map((t) => ({ time: t, busy: busy.has(t), past: isPastSlot(date, t) }));
  }

  /* первая дата, где есть свободное время (для «Записаться повторно») */
  function firstFreeDate(barberId, fromDate) {
    const barber = Auth.findById(barberId);
    if (!barber) return null;
    let date = fromDate || U.today();
    for (let i = 0; i < 120; i++) {
      if (freeSlots(barberId, date).length) return date;
      date = U.addDays(date, 1);
    }
    return null;
  }

  /* ============================================================
     СОЗДАНИЕ ЗАПИСИ
     ============================================================ */
  function create({ barberId, serviceId, date, time, guest, user }) {
    const barber = Auth.findById(barberId);
    const service = serviceById(serviceId);
    if (!barber) return { ok: false, error: 'Выберите барбера' };
    if (!service) return { ok: false, error: 'Выберите услугу' };
    if (!serviceIds(barber).includes(service.id)) return { ok: false, error: 'Барбер не оказывает эту услугу' };
    if (!date) return { ok: false, error: 'Выберите дату' };
    if (!time) return { ok: false, error: 'Выберите время' };
    if (U.isPastDate(date)) return { ok: false, error: 'Эта дата уже прошла' };
    if (isPastSlot(date, time)) return { ok: false, error: 'Это время уже прошло' };

    const works = availabilityOf(barber, date);
    if (!works.length) return { ok: false, error: 'В этот день барбер не работает' };
    if (!works.includes(time)) return { ok: false, error: 'Это время недоступно у барбера' };

    const busy = bookingAt(barberId, date, time);
    if (busy) return { ok: false, error: 'Это время уже занято' };

    const span = spanTimes(time, service.duration);
    const tail = span[span.length - 1];
    if (U.toMinutes(tail) + 30 > CLOSE) return { ok: false, error: 'Услуга не помещается в рабочий день' };
    if (span.some((t) => busyMap(barberId, date).has(t))) return { ok: false, error: 'Часть времени уже занята' };

    /* кто записывается */
    let ownerKey, userId, userName, userPhone, userEmail;
    if (user) {
      ownerKey = 'u_' + user.id;
      userId = user.id; userName = user.name; userPhone = user.phone; userEmail = user.email;
    } else {
      const name = Auth.norm(guest && guest.name);
      const phone = Auth.norm(guest && guest.phone);
      if (name.length < 2) return { ok: false, error: 'Укажите имя (минимум 2 символа)' };
      if (!U.phoneOk(phone)) return { ok: false, error: 'Укажите телефон (минимум 10 цифр)' };
      ownerKey = DB.guestKey();
      userId = null; userName = name; userPhone = phone; userEmail = '';
    }

    const booking = {
      id: DB.uid('bk'),
      ownerKey, userId, userName, userPhone, userEmail,
      barberId: barber.id, barberName: barber.name, barberPhoto: barber.photo || '',
      service: service.name, serviceId: service.id,
      price: service.price, duration: service.duration,
      date, time,
      status: 'active',
      rating: 0, ratedAt: null, completedAt: null, needsRating: false,
      createdAt: new Date().toISOString()
    };

    const list = DB.getBookings();
    list.push(booking);
    DB.setBookings(list);
    return { ok: true, booking };
  }

  const serviceIds = (barber) => (barber.services || []).map(Number);

  /* ============================================================
     СТАТУСЫ
     ============================================================ */
  function patch(id, changes) {
    const list = DB.getBookings();
    const b = list.find((x) => x.id === id);
    if (!b) return null;
    Object.assign(b, changes);
    DB.setBookings(list);
    return b;
  }

  const cancel = (id, reason) => patch(id, {
    status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason || 'Отменено'
  });

  const complete = (id) => patch(id, {
    status: 'completed', completedAt: new Date().toISOString(), needsRating: true
  });

  function rate(id, value) {
    const mark = Math.min(5, Math.max(1, Number(value) || 0));
    const b = patch(id, { rating: mark, ratedAt: new Date().toISOString(), needsRating: false });
    if (b) recomputeRating(b.barberId);
    return b;
  }

  function recomputeRating(barberId) {
    const marks = DB.getBookings()
      .filter((b) => b.barberId === barberId && b.rating > 0)
      .map((b) => b.rating);
    const count = marks.length;
    const avg = count ? Math.round((marks.reduce((a, v) => a + v, 0) / count) * 10) / 10 : 0;

    const list = DB.getUsers();
    const barber = list.find((u) => u.id === barberId);
    if (barber) {
      barber.rating = avg;
      barber.ratingsCount = count;
      DB.setUsers(list);
    }
    return { rating: avg, count };
  }

  /* ============================================================
     ВЫБОРКИ
     ============================================================ */
  const byDateTime = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

  const all = () => DB.getBookings().slice().sort(byDateTime);

  const forOwner = (ownerKey) => DB.getBookings()
    .filter((b) => b.ownerKey === ownerKey)
    .sort((a, b) => {
      const rank = { active: 0, completed: 1, cancelled: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return a.status === 'active' ? byDateTime(a, b) : byDateTime(b, a);
    });

  const forBarber = (barberId) => all().filter((b) => b.barberId === barberId)
    .sort((a, b) => {
      const rank = { active: 0, completed: 1, cancelled: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return a.status === 'active' ? byDateTime(a, b) : byDateTime(b, a);
    });

  /* запись, ожидающая оценки (для попапа при входе) */
  const pendingRating = (ownerKey) => DB.getBookings()
    .filter((b) => b.ownerKey === ownerKey && b.needsRating && b.status === 'completed')
    .sort(byDateTime)[0] || null;

  const pendingRatingCount = (ownerKey) => DB.getBookings()
    .filter((b) => b.ownerKey === ownerKey && b.needsRating).length;

  function stats(barberId) {
    const mine = DB.getBookings().filter((b) => b.barberId === barberId);
    const marks = mine.filter((b) => b.rating > 0).map((b) => b.rating);
    const barber = Auth.findById(barberId);
    return {
      avg: barber ? barber.rating || 0 : 0,
      count: barber ? barber.ratingsCount || 0 : marks.length,
      total: mine.length,
      active: mine.filter((b) => b.status === 'active').length,
      completed: mine.filter((b) => b.status === 'completed').length,
      cancelled: mine.filter((b) => b.status === 'cancelled').length
    };
  }

  const isRated = (b) => b.rating > 0;

  return {
    SERVICES, STEP, OPEN, CLOSE, ALL_SLOTS, spanOf, spanTimes,
    serviceById, servicesOf, serviceIds,
    availabilityOf, worksOn, hasAnyAvailability, isPastSlot,
    freeSlots, daySlots, busyMap, bookingAt, firstFreeDate,
    create, cancel, complete, rate, recomputeRating, patch,
    all, forOwner, forBarber, pendingRating, pendingRatingCount, stats, isRated
  };
})();
