/* ============================================================
   auth.js — авторизация, регистрация, сотрудники, доступность
   ============================================================ */
'use strict';

const Auth = (() => {

  /* ---------- вшитый администратор ---------- */
  const ADMIN_LOGIN = 'ADMIN777';
  const ADMIN_PASS  = '777';
  const ADMIN = {
    id: 'admin', role: 'admin', name: 'Администратор',
    login: ADMIN_LOGIN, email: 'admin@barbershop.ru', phone: '+7 (999) 000-00-01', specialty: 'Управление салоном'
  };

  /* ---------- валидация ---------- */
  const norm = (v) => String(v == null ? '' : v).trim();
  const lower = (v) => norm(v).toLowerCase();
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(norm(v));
  const isLogin = (v) => /^[A-Za-z0-9._-]{3,20}$/.test(norm(v));

  function uniqueError(field, value, exceptId) {
    const list = DB.getUsers().filter((u) => u.id !== exceptId);
    if (field === 'login') {
      if (lower(value) === lower(ADMIN_LOGIN)) return 'Логин занят, выберите другой';
      if (list.some((u) => lower(u.login) === lower(value))) return 'Логин уже используется';
    }
    if (field === 'email' && list.some((u) => lower(u.email) === lower(value))) return 'Email уже используется';
    if (field === 'phone') {
      const key = U.phoneKey(value);
      if (key && list.some((u) => U.phoneKey(u.phone) === key)) return 'Телефон уже используется';
    }
    return '';
  }

  /* проверка анкеты (регистрация клиента или создание сотрудника) */
  function validate(data, exceptId) {
    if (norm(data.name).length < 2) return 'Имя: минимум 2 символа';
    if (!isLogin(data.login)) return 'Логин: 3–20 символов, латиница, цифры, . _ -';
    if (!isEmail(data.email)) return 'Укажите корректный email';
    if (!U.phoneOk(data.phone)) return 'Телефон: минимум 10 цифр';
    if (norm(data.password).length < 4) return 'Пароль: минимум 4 символа';
    for (const f of ['login', 'email', 'phone']) {
      const err = uniqueError(f, data[f], exceptId);
      if (err) return err;
    }
    return '';
  }

  /* ---------- поиск ---------- */
  const findById = (id) => DB.getUsers().find((u) => u.id === id) || null;

  function findByLogin(identifier) {
    const id = norm(identifier);
    if (!id) return null;
    const key = U.phoneKey(id);
    return DB.getUsers().find((u) =>
      lower(u.login) === lower(id) ||
      lower(u.email) === lower(id) ||
      (key.length >= 10 && U.phoneKey(u.phone) === key)
    ) || null;
  }

  /* ---------- текущий пользователь ---------- */
  function me() {
    const s = DB.getCurrent();
    if (!s) return null;
    if (s.role === 'admin') return ADMIN;
    return findById(s.id);          // всегда свежие данные из bb_users
  }
  const isStaff = () => { const u = me(); return !!u && (u.role === 'admin' || u.role === 'barber'); };

  /* ---------- регистрация / вход / выход ---------- */
  function register(data) {
    const payload = {
      name: norm(data.name), login: norm(data.login), email: norm(data.email),
      phone: norm(data.phone), password: norm(data.password)
    };
    const err = validate(payload);
    if (err) return { ok: false, error: err };

    const user = {
      id: DB.uid('u'), role: 'client',
      name: payload.name, login: payload.login, email: payload.email, phone: payload.phone,
      password: payload.password, createdAt: new Date().toISOString()
    };
    const list = DB.getUsers();
    list.push(user);
    DB.setUsers(list);
    DB.setSession(user.id, user.role);
    const moved = DB.claimGuestBookings(user);
    return { ok: true, user, moved };
  }

  function login(identifier, password) {
    const id = norm(identifier);
    const pass = norm(password);
    if (!id || !pass) return { ok: false, error: 'Заполните логин и пароль' };

    if (lower(id) === lower(ADMIN_LOGIN)) {
      if (pass !== ADMIN_PASS) return { ok: false, error: 'Неверный пароль' };
      DB.setSession(ADMIN.id, 'admin');
      return { ok: true, user: ADMIN, moved: 0 };
    }

    const user = findByLogin(id);
    if (!user) return { ok: false, error: 'Пользователь не найден' };
    if (user.password !== pass) return { ok: false, error: 'Неверный пароль' };

    DB.setSession(user.id, user.role);
    const moved = user.role === 'client' ? DB.claimGuestBookings(user) : 0;
    return { ok: true, user, moved };
  }

  function logout() { DB.setCurrent(null); }

  /* ---------- профиль клиента ---------- */
  function updateProfile(id, patch) {
    const list = DB.getUsers();
    const user = list.find((u) => u.id === id);
    if (!user) return { ok: false, error: 'Пользователь не найден' };

    const next = {
      name: norm(patch.name) || user.name,
      email: norm(patch.email) || user.email,
      phone: norm(patch.phone) || user.phone
    };
    if (next.name.length < 2) return { ok: false, error: 'Имя: минимум 2 символа' };
    if (!isEmail(next.email)) return { ok: false, error: 'Укажите корректный email' };
    if (!U.phoneOk(next.phone)) return { ok: false, error: 'Телефон: минимум 10 цифр' };
    for (const f of ['email', 'phone']) {
      const err = uniqueError(f, next[f], id);
      if (err) return { ok: false, error: err };
    }

    Object.assign(user, next);
    DB.setUsers(list);

    /* данные подтягиваются во все записи клиента */
    const bookings = DB.getBookings();
    let touched = false;
    bookings.forEach((b) => {
      if (b.ownerKey === 'u_' + id) {
        b.userName = user.name; b.userPhone = user.phone; b.userEmail = user.email; touched = true;
      }
    });
    if (touched) DB.setBookings(bookings);

    return { ok: true, user };
  }

  /* ============================================================
     СОТРУДНИКИ (админ)
     ============================================================ */
  const listBarbers = () => DB.getUsers().filter((u) => u.role === 'barber');
  const activeBarbers = () => listBarbers().filter((b) => (b.services || []).length > 0);

  function blankBarber(data) {
    return {
      id: DB.uid('b'), role: 'barber',
      name: norm(data.name), login: norm(data.login), email: norm(data.email),
      phone: norm(data.phone), password: norm(data.password),
      specialty: norm(data.specialty) || 'Барбер',
      photo: norm(data.photo),
      services: (data.services || []).map(Number),
      rating: 0, ratingsCount: 0,
      availabilityByDate: data.availabilityByDate || {},
      createdAt: new Date().toISOString()
    };
  }

  function createBarber(data) {
    const err = validate(data);
    if (err) return { ok: false, error: err };

    const barber = blankBarber(data);
    const list = DB.getUsers();
    list.push(barber);
    DB.setUsers(list);
    return { ok: true, barber };
  }

  function updateBarber(id, data, keepAvailability) {
    const list = DB.getUsers();
    const barber = list.find((u) => u.id === id);
    if (!barber) return { ok: false, error: 'Сотрудник не найден' };

    if (norm(data.name).length < 2) return { ok: false, error: 'Имя: минимум 2 символа' };
    if (!isEmail(data.email)) return { ok: false, error: 'Укажите корректный email' };
    if (!U.phoneOk(data.phone)) return { ok: false, error: 'Телефон: минимум 10 цифр' };
    if (norm(data.password).length < 4) return { ok: false, error: 'Пароль: минимум 4 символа' };
    for (const f of ['email', 'phone']) {
      const err = uniqueError(f, data[f], id);
      if (err) return { ok: false, error: err };
    }

    barber.name = norm(data.name);
    barber.email = norm(data.email);
    barber.phone = norm(data.phone);
    barber.password = norm(data.password);
    barber.specialty = norm(data.specialty) || barber.specialty;
    barber.photo = norm(data.photo);
    barber.services = (data.services || []).map(Number);
    if (!keepAvailability) barber.availabilityByDate = barber.availabilityByDate || {};

    DB.setUsers(list);

    /* запомним имя/фото в существующих записях */
    const bookings = DB.getBookings();
    let touched = false;
    bookings.forEach((b) => {
      if (b.barberId === id) { b.barberName = barber.name; b.barberPhoto = barber.photo; touched = true; }
    });
    if (touched) DB.setBookings(bookings);

    return { ok: true, barber };
  }

  function removeBarber(id) {
    DB.setUsers(DB.getUsers().filter((u) => !(u.id === id && u.role === 'barber')));
    /* освобождаем слоты: активные записи удалённого мастера отменяем */
    const bookings = DB.getBookings();
    let touched = false;
    bookings.forEach((b) => {
      if (b.barberId === id && b.status === 'active') {
        b.status = 'cancelled'; b.cancelledAt = new Date().toISOString(); b.cancelReason = 'Сотрудник удалён';
        touched = true;
      }
    });
    if (touched) DB.setBookings(bookings);
  }

  /* ============================================================
     УСЛУГИ И ДОСТУПНОСТЬ БАРБЕРА
     ============================================================ */
  /* desired — необязательное желаемое состояние (берётся из чекбокса) */
  function toggleService(barberId, serviceId, desired) {
    const list = DB.getUsers();
    const barber = list.find((u) => u.id === barberId);
    if (!barber) return;
    const set = new Set((barber.services || []).map(Number));
    const id = Number(serviceId);
    const on = typeof desired === 'boolean' ? desired : !set.has(id);
    on ? set.add(id) : set.delete(id);
    barber.services = [...set].sort((a, b) => a - b);
    DB.setUsers(list);
  }

  /* включить/выключить один слот в конкретной дате */
  function toggleSlot(barberId, date, time, desired) {
    const list = DB.getUsers();
    const barber = list.find((u) => u.id === barberId);
    if (!barber) return [];
    const map = barber.availabilityByDate || (barber.availabilityByDate = {});
    const day = new Set(map[date] || []);
    const on = typeof desired === 'boolean' ? desired : !day.has(time);
    on ? day.add(time) : day.delete(time);
    if (day.size) map[date] = [...day].sort();
    else delete map[date];                  // пустой день убираем совсем
    DB.setUsers(list);
    return map[date] || [];
  }

  /* весь день / снять весь день (слоты вне рабочего графика игнорируем) */
  function setDay(barberId, date, slots) {
    const list = DB.getUsers();
    const barber = list.find((u) => u.id === barberId);
    if (!barber) return;
    const map = barber.availabilityByDate || (barber.availabilityByDate = {});
    if (slots && slots.length) map[date] = [...slots].sort();
    else delete map[date];
    DB.setUsers(list);
  }

  /* генератор графика для демо-данных */
  function genAvailability({ days = 21, from = 1, start = 10, end = 20, offDays = [0] } = {}) {
    const map = {};
    for (let i = from; i <= days; i++) {
      const date = U.addDays(U.today(), i);
      if (offDays.includes(U.fromISO(date).getDay())) continue;
      const slots = [];
      for (let m = start * 60; m < end * 60; m += 30) slots.push(U.toTime(m));
      map[date] = slots;
    }
    return map;
  }

  /* ============================================================
     ДЕМО-ДАННЫЕ
     ============================================================ */
  function seedDemo(force) {
    if (!force && DB.read(DB.KEYS.seeded, false)) return false;
    const list = DB.getUsers();
    if (force || !list.some((u) => u.role === 'barber')) {
      const demo = [
        { name: 'Артём Соколов', login: 'artem', email: 'artem@barbershop.ru', phone: '+7 (999) 123-45-11',
          specialty: 'Топ-барбер — фейды и борода', password: 'barber123', services: [1, 2, 3, 5],
          photo: Media.BARBER_PHOTOS.artem,
          availabilityByDate: genAvailability({ days: 24, start: 10, end: 20, offDays: [0] }) },
        { name: 'Данила Крылов', login: 'danila', email: 'danila@barbershop.ru', phone: '+7 (999) 123-45-12',
          specialty: 'Классические стрижки и усы', password: 'barber123', services: [1, 2, 4, 6],
          photo: Media.BARBER_PHOTOS.danila,
          availabilityByDate: genAvailability({ days: 18, start: 9, end: 18, offDays: [0, 6] }) },
        { name: 'Марк Ефимов', login: 'mark', email: 'mark@barbershop.ru', phone: '+7 (999) 123-45-13',
          specialty: 'Барбер-стилист, оформление бороды', password: 'barber123', services: [1, 3, 5],
          photo: Media.BARBER_PHOTOS.mark,
          availabilityByDate: genAvailability({ days: 27, start: 12, end: 21, offDays: [1] }) }
      ];
      demo.forEach((d) => list.push(blankBarber(d)));
      DB.setUsers(list);
    }
    DB.write(DB.KEYS.seeded, true);
    return true;
  }

  return {
    ADMIN_LOGIN, ADMIN_PASS, ADMIN,
    norm, lower, isEmail, isLogin, uniqueError, validate,
    me, isStaff, findById, findByLogin,
    register, login, logout, updateProfile,
    listBarbers, activeBarbers, createBarber, updateBarber, removeBarber,
    toggleService, toggleSlot, setDay, genAvailability, seedDemo
  };
})();
