/* ============================================================
   app.js — весь UI: экраны, календарь, модалки, обработчики
   ============================================================ */
'use strict';

(() => {

  /* ============================================================
     ИКОНКИ — SVG-файлы подключаются как маски (никаких эмодзи)
     ============================================================ */
  const ICONS = ['calendar', 'list', 'home', 'user', 'scissors', 'pin', 'clock', 'phone',
    'star', 'star-filled', 'plus', 'edit', 'trash', 'check', 'chevron-left', 'chevron-right',
    'close', 'moon', 'sun', 'logout', 'download', 'info', 'users', 'chart', 'calendar-check',
    'card', 'mail', 'badge'];

  const iconStyle = document.createElement('style');
  iconStyle.textContent = ICONS.map((n) =>
    `.i-${n}{-webkit-mask-image:url("icons/${n}.svg");mask-image:url("icons/${n}.svg")}`).join('\n');
  document.head.appendChild(iconStyle);

  const ic = (name, cls) => `<i class="ic i-${name}${cls ? ' ' + cls : ''}"></i>`;

  /* ============================================================
     ССЫЛКИ НА DOM И СОСТОЯНИЕ
     ============================================================ */
  const view      = document.getElementById('view');
  const tabbar    = document.getElementById('tabbar');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  const titleEl   = document.getElementById('appbar-title');
  const themeBtn  = document.getElementById('theme-btn');

  const SCREENS = ['salon', 'book', 'bookings', 'account'];
  const TAB_LABELS = { salon: 'Салон', book: 'Записаться', bookings: 'Мои записи', account: 'Аккаунт' };

  const S = {
    screen: 'book',
    draft: { barberId: null, serviceId: null, date: null, time: null, guestName: '', guestPhone: '' },
    bookMonth: null,
    cabMonth: null, cabDate: null,                                   // кабинет барбера
    admMonth: null, admDate: null, admBarberId: null,                // доступность в админке
    admin: { tab: 'staff', form: null, filters: { barber: '', service: '', when: 'all' } },
    account: { tab: 'login', editing: false, error: '' },
    profile: null,
    rating: null
  };

  let lastScreen = null;         // чтобы анимировать только смену экрана
  let sheet = null;              // текущая модалка
  let confirmCb = null;          // подтверждение действия
  let deferredPrompt = null;     // установка PWA (Android/Chrome)

  const CAL = { book: 'bookMonth', cab: 'cabMonth', adm: 'admMonth' };
  const CAL_DATE = { cab: 'cabDate', adm: 'admDate' };

  /* ============================================================
     МЕЛОЧИ
     ============================================================ */
  function toast(text, iconName) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (iconName ? ic(iconName, 'ic-16 ic-green') : '') + `<span>${U.esc(text)}</span>`;
    toastRoot.appendChild(el);
    setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 280); }, 2600);
  }

  function setScreen(name, keepScroll) {
    if (!SCREENS.includes(name)) name = 'account';
    if (Auth.isStaff() && name !== 'account') {
      toast('Этот раздел доступен только клиентам', 'info');
      name = 'account';
    }
    S.screen = name;
    render();
    if (!keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const pad2 = U.pad;
  const avatarHTML = (person, cls) => {
    const photo = person && person.photo;
    return `<span class="avatar${cls ? ' ' + cls : ''}">` +
      `<span class="avatar__initials">${U.esc(U.initials(person && person.name))}</span>` +
      (photo ? `<img src="${U.esc(photo)}" alt="">` : '') +
      '</span>';
  };

  function starsHTML(value, cls) {
    const v = Math.round(Number(value) || 0);
    let out = `<span class="stars${cls ? ' ' + cls : ''}">`;
    for (let i = 1; i <= 5; i++) out += ic(i <= v ? 'star-filled' : 'star', 'ic-14');
    return out + '</span>';
  }

  function ratingHTML(barber, cls) {
    if (!barber || !barber.ratingsCount) return `<span class="rating-xs">Нет оценок</span>`;
    return `<span class="rating-xs${cls ? ' ' + cls : ''}">${ic('star-filled', 'ic-12')}${U.rating(barber.rating)}
            <span class="muted">(${barber.ratingsCount})</span></span>`;
  }

  /* аватар/аватарки ломаются — показываем инициалы */
  function afterRender() {
    view.querySelectorAll('.avatar img').forEach((img) => {
      img.addEventListener('error', () => img.remove(), { once: true });
    });
    view.querySelectorAll('.gallery__item img').forEach((img) => {
      img.addEventListener('error', () => img.remove(), { once: true });
    });
  }

  /* ============================================================
     КАЛЕНДАРЬ (общий компонент: запись, кабинет барбера, админ)
     ============================================================ */
  function calBarber(ctx) {
    if (ctx === 'book') return S.draft.barberId ? Auth.findById(S.draft.barberId) : null;
    if (ctx === 'cab')  { const me = Auth.me(); return me && me.role === 'barber' ? me : null; }
    return S.admBarberId ? Auth.findById(S.admBarberId) : null;
  }

  function calCursor(ctx) {
    const key = CAL[ctx];
    if (!S[key]) S[key] = U.today();
    return S[key];
  }

  function calSelected(ctx) {
    if (ctx === 'book') return S.draft.date;
    return S[CAL_DATE[ctx]];
  }

  function calendarHTML(ctx) {
    const barber = calBarber(ctx);
    const cursor = U.fromISO(calCursor(ctx));
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const lead = U.mondayIndex(new Date(y, m, 1));
    const total = new Date(y, m + 1, 0).getDate();
    const today = U.today();
    const selected = calSelected(ctx);
    const thisMonth = U.today().slice(0, 7);
    const prevOff = `${y}-${pad2(m + 1)}` <= thisMonth;

    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="cal__day is-out"></span>';
    for (let d = 1; d <= total; d++) {
      const date = `${y}-${pad2(m + 1)}-${pad2(d)}`;
      const works = barber ? Booking.worksOn(barber, date) : false;
      const free = barber ? Booking.freeSlots(barber.id, date).length : 0;
      const cls = ['cal__day'];
      if (date === today) cls.push('is-today');
      if (date === selected) cls.push('is-selected');
      if (works && !free) cls.push('is-full');
      cells += `<button type="button" class="${cls.join(' ')}" data-act="cal-day" data-ctx="${ctx}"
                 data-d="${date}" ${date < today ? 'disabled' : ''}
                 aria-label="${d}">${d}${works ? '<i class="cal__dot"></i>' : ''}</button>`;
    }

    return `
    <div class="cal">
      <div class="cal__head">
        <button type="button" class="cal__nav" data-act="cal-nav" data-ctx="${ctx}" data-dir="-1"
                ${prevOff ? 'disabled' : ''} aria-label="Предыдущий месяц">${ic('chevron-left', 'ic-18')}</button>
        <div class="cal__title">${U.MONTHS[m]} ${y}</div>
        <button type="button" class="cal__nav" data-act="cal-nav" data-ctx="${ctx}" data-dir="1"
                aria-label="Следующий месяц">${ic('chevron-right', 'ic-18')}</button>
      </div>
      <div class="cal__dow">${U.DOW.map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal__grid">${cells}</div>
      <div class="cal__legend">
        <div><i></i>Свободно</div>
        <div><i class="orange"></i>Всё занято</div>
        <div><i class="ring"></i>Сегодня</div>
      </div>
    </div>`;
  }

  function calNav(ctx, dir) {
    const c = U.fromISO(calCursor(ctx));
    const next = new Date(c.getFullYear(), c.getMonth() + Number(dir), 1);
    if (U.iso(next).slice(0, 7) < U.today().slice(0, 7)) return;
    S[CAL[ctx]] = U.iso(next);
    refresh(ctx);
  }

  function calPick(ctx, date) {
    if (ctx === 'book') {
      S.draft.date = date;
      const free = Booking.freeSlots(S.draft.barberId, date).map((s) => s);
      if (!free.includes(S.draft.time)) S.draft.time = null;
    } else {
      S[CAL_DATE[ctx]] = date;
    }
    refresh(ctx);
  }

  /* перерисовка нужной области: модалка или весь экран */
  function refresh(ctx) {
    if (ctx === 'adm' && sheet) renderSheet();
    else render();
  }

  /* ============================================================
     ЭКРАН «САЛОН»
     ============================================================ */
  const GALLERY = [
    { url: 'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?auto=format&fit=crop&w=900&q=70', cap: 'Основной зал' },
    { url: 'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=900&q=70', cap: 'Кресло мастера' },
    { url: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=900&q=70', cap: 'Инструменты барбера' }
  ];

  function screenSalon() {
    const barbers = Auth.listBarbers();

    const gallery = `<div class="hscroll hscroll--gallery">${GALLERY.map((g) => `
      <figure class="gallery__item"><img src="${g.url}" alt="${U.esc(g.cap)}" loading="lazy">
        <figcaption class="gallery__cap">${U.esc(g.cap)}</figcaption></figure>`).join('')}</div>`;

    const staff = barbers.length ? `<div class="card-list">${barbers.map((b) => `
      <button class="tile" data-act="salon-barber" data-id="${b.id}">
        ${avatarHTML(b, 'avatar--lg')}
        <span class="grow">
          <span class="tile__title ellipsis">${U.esc(b.name)}</span>
          <span class="tile__sub ellipsis">${U.esc(b.specialty || 'Барбер')}</span>
        </span>
        <span class="center">${ratingHTML(b)}</span>
      </button>`).join('')}</div>`
      : `<div class="empty">${ic('users', 'ic-44')}<div class="empty__title">Барберы ещё не добавлены</div></div>`;

    const services = `<div class="card-list card-list--2">${Booking.SERVICES.map((s) => `
      <div class="tile">
        <span class="tile__icon">${ic('scissors', 'ic-20 ic-grey')}</span>
        <span class="grow">
          <span class="tile__title">${U.esc(s.name)}</span>
          <span class="tile__sub row" style="gap:5px">${ic('clock', 'ic-12')}${s.duration} мин</span>
        </span>
        <span class="tile__value">${U.money(s.price)}</span>
      </div>`).join('')}</div>`;

    return `
    <section class="section">
      <div class="section__head"><h2 class="h2">Барбершоп «Джентльмен»</h2></div>
      ${gallery}
    </section>

    <section class="section">
      <div class="section__head"><h2 class="h2">Наши барберы</h2>
        <span class="muted">${barbers.length} ${U.plural(barbers.length, ['мастер', 'мастера', 'мастеров'])}</span></div>
      ${staff}
    </section>

    <section class="section">
      <div class="section__head"><h2 class="h2">Услуги и цены</h2></div>
      ${services}
    </section>

    <section class="section">
      <div class="section__head"><h2 class="h2">Контакты</h2></div>
      <div class="card-list">
        <div class="tile"><span class="tile__icon">${ic('pin', 'ic-20 ic-red')}</span>
          <span class="grow"><span class="tile__sub">Адрес</span><span class="tile__title">ул. Ленина, 15</span></span></div>
        <div class="tile"><span class="tile__icon">${ic('clock', 'ic-20 ic-green')}</span>
          <span class="grow"><span class="tile__sub">Часы работы</span><span class="tile__title">09:00 – 20:00, ежедневно</span></span></div>
        <a class="tile" href="tel:+79991234567"><span class="tile__icon">${ic('phone', 'ic-20 ic-blue')}</span>
          <span class="grow"><span class="tile__sub">Телефон</span><span class="tile__title">+7 999 123-45-67</span></span></a>
      </div>
    </section>`;
  }

  /* ============================================================
     ЭКРАН «ЗАПИСАТЬСЯ»
     ============================================================ */
  function barberStrip() {
    const barbers = Auth.activeBarbers();
    if (!barbers.length) {
      return `<div class="empty">${ic('scissors', 'ic-44')}
        <div class="empty__title">Нет доступных барберов</div>
        <p>Мастера ещё не выбрали услуги. Загляните позже.</p></div>`;
    }
    return `<div class="hscroll">${barbers.map((b) => `
      <button type="button" class="barber-card ${S.draft.barberId === b.id ? 'is-selected' : ''}"
              data-act="pick-barber" data-id="${b.id}">
        ${avatarHTML(b, 'avatar--lg')}
        <span class="barber-card__name">${U.esc(b.name.split(' ')[0])}</span>
        ${ratingHTML(b)}
      </button>`).join('')}</div>`;
  }

  function serviceList() {
    if (!S.draft.barberId) return `<div class="hint">${ic('user', 'ic-18 ic-purple')}Сначала выберите барбера</div>`;
    const barber = Auth.findById(S.draft.barberId);
    const list = Booking.servicesOf(barber);
    if (!list.length) {
      return `<div class="hint">${ic('info', 'ic-18 ic-blue')}Этот барбер пока не выбрал услуги. Выберите другого мастера.</div>`;
    }
    return `<div class="card-list">${list.map((s) => `
      <button type="button" class="service ${S.draft.serviceId === s.id ? 'is-selected' : ''}"
              data-act="pick-service" data-id="${s.id}">
        <span class="grow">
          <span class="service__name">${U.esc(s.name)}</span>
          <span class="service__meta">${ic('clock', 'ic-14 ic-green')}${s.duration} мин</span>
        </span>
        <span class="service__price">${U.money(s.price)}</span>
      </button>`).join('')}</div>`;
  }

  function timeSlots() {
    const d = S.draft;
    if (!d.barberId) return `<div class="hint">${ic('user', 'ic-18 ic-purple')}Сначала выберите барбера</div>`;
    const barber = Auth.findById(d.barberId);
    if (!barber || !Booking.hasAnyAvailability(barber)) {
      return `<div class="hint">${ic('info', 'ic-18 ic-blue')}У барбера пока нет доступных слотов. Выберите другого барбера</div>`;
    }
    if (!d.date) return `<div class="hint">${ic('calendar', 'ic-18 ic-blue')}Сначала выберите дату</div>`;

    const slots = Booking.daySlots(d.barberId, d.date);
    if (!slots.length) return `<div class="hint">${ic('info', 'ic-18 ic-blue')}В этот день барбер не работает</div>`;

    return `<div class="slots">${slots.map((s) => `
      <button type="button" class="slot ${d.time === s.time ? 'is-selected' : ''}"
              data-act="pick-slot" data-t="${s.time}" ${(s.busy || s.past) ? 'disabled' : ''}>${s.time}</button>`).join('')}</div>`;
  }

  function guestFields() {
    if (Auth.me()) return '';
    return `
    <section class="section">
      <div class="section__head"><h2 class="h2">Ваши данные</h2>
        <span class="muted">${ic('info', 'ic-14 ic-blue')} или войдите в аккаунт</span></div>
      <div class="card">
        <div class="form">
          <div class="field"><label for="g-name">Имя</label>
            <input class="input" id="g-name" type="text" placeholder="Иван" autocomplete="name"
                   data-field="draft.guestName" value="${U.esc(S.draft.guestName)}"></div>
          <div class="field"><label for="g-phone">Телефон</label>
            <input class="input" id="g-phone" type="tel" inputmode="tel" placeholder="+7 999 123-45-67"
                   data-field="draft.guestPhone" value="${U.esc(S.draft.guestPhone)}"></div>
        </div>
      </div>
    </section>`;
  }

  function screenBook() {
    const d = S.draft;
    const barber = d.barberId ? Auth.findById(d.barberId) : null;
    const ready = !!(d.barberId && d.serviceId && d.date && d.time);

    return `
    <section class="section">
      <div class="section__head"><h2 class="h2">Выберите барбера</h2></div>
      ${barberStrip()}
    </section>

    <section class="section">
      <div class="section__head"><h2 class="h2">Услуга</h2>
        ${barber ? `<span class="muted">${U.esc(barber.name)}</span>` : ''}</div>
      ${serviceList()}
    </section>

    <div class="grid-desktop">
      <section class="section">
        <div class="section__head"><h2 class="h2">Дата</h2></div>
        ${calendarHTML('book')}
      </section>

      <section class="section">
        <div class="section__head"><h2 class="h2">Время</h2>
          ${d.date ? `<span class="muted">${U.fmtDate(d.date)}</span>` : ''}</div>
        <div class="slot-wrap">${timeSlots()}</div>
      </section>
    </div>

    ${guestFields()}

    <form data-form="book" class="sticky-cta">
      <button type="submit" class="btn btn-primary btn-lg btn-block" ${ready ? '' : 'disabled'}>
        ${ic('calendar', 'ic-22')}Записаться
      </button>
    </form>`;
  }

  /* ============================================================
     ЭКРАН «МОИ ЗАПИСИ»
     ============================================================ */
  const STATUS = {
    active:    { label: 'Активна',   cls: 'badge--active',    icon: 'clock' },
    completed: { label: 'Выполнена', cls: 'badge--completed', icon: 'check' },
    cancelled: { label: 'Отменена',  cls: 'badge--cancelled', icon: 'close' }
  };

  function bookingCard(b, mode) {
    const st = STATUS[b.status] || STATUS.active;
    const rated = b.rating > 0;
    const mine = mode === 'owner';

    const buttons = [];
    if (mine) {
      buttons.push(`<button class="btn btn-soft btn-sm" data-act="repeat" data-id="${b.id}">
        ${ic('calendar', 'ic-16')}Записаться повторно</button>`);
      if (b.status === 'active') {
        buttons.push(`<button class="btn btn-danger btn-sm" data-act="cancel-booking" data-id="${b.id}">
          ${ic('trash', 'ic-16')}Отменить</button>`);
      }
      if (b.status === 'completed' && !rated) {
        buttons.push(`<button class="btn btn-primary btn-sm" data-act="rate-open" data-id="${b.id}">
          ${ic('star-filled', 'ic-16')}Оценить</button>`);
      }
    } else if (mode === 'barber') {
      if (b.status === 'active') {
        buttons.push(`<button class="btn btn-success btn-sm" data-act="complete" data-id="${b.id}">
          ${ic('check', 'ic-16')}Выполнено</button>`);
        buttons.push(`<button class="btn btn-danger btn-sm" data-act="cancel-booking" data-id="${b.id}">
          ${ic('trash', 'ic-16')}Отменить</button>`);
      }
    } else if (mode === 'admin' && b.status !== 'cancelled') {
      buttons.push(`<button class="btn btn-danger btn-sm" data-act="cancel-booking" data-id="${b.id}">
        ${ic('trash', 'ic-16')}Отменить</button>`);
    }

    const contact = mode === 'owner'
      ? `<div>${ic('user', 'ic-16 ic-purple')}${U.esc(b.barberName)}</div>`
      : `<div>${ic('user', 'ic-16 ic-purple')}${U.esc(b.userName)}</div>
         <div>${ic('phone', 'ic-16 ic-blue')}${U.esc(U.prettyPhone(b.userPhone))}</div>
         ${b.userEmail ? `<div>${ic('mail', 'ic-16 ic-grey')}${U.esc(b.userEmail)}</div>` : ''}
         <div>${ic('scissors', 'ic-16 ic-grey')}${U.esc(b.barberName)}</div>`;

    return `
    <div class="card booking${b.status === 'cancelled' ? ' is-cancelled' : ''}">
      <div class="booking__top">
        <span class="grow">
          <span class="booking__service">${U.esc(b.service)}</span>
          <span class="muted">${U.money(b.price)} · ${b.duration} мин</span>
        </span>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>

      <div class="booking__meta">
        ${contact}
        <div>${ic('calendar', 'ic-16 ic-blue')}${U.fmtDate(b.date)} в ${b.time}</div>
      </div>

      ${rated ? `<div class="row">${starsHTML(b.rating)}<span class="muted">Ваша оценка</span></div>` : ''}
      ${buttons.length ? `<div class="btn-row">${buttons.join('')}</div>` : ''}
    </div>`;
  }

  function screenBookings() {
    const user = Auth.me();
    const ownerKey = DB.userKey(user);
    const list = Booking.forOwner(ownerKey);
    const pending = Booking.pendingRatingCount(ownerKey);

    if (!list.length) {
      return `<div class="empty">
        ${ic('list', 'ic-44')}
        <div class="empty__title">Записей пока нет</div>
        <p>Выберите барбера, услугу и удобное время — займёт меньше минуты.</p>
        <button class="btn btn-primary" data-act="go" data-screen="book">${ic('calendar', 'ic-18')}Записаться</button>
      </div>` + (!user ? guestLoginNote() : '');
    }

    return `
    ${!user ? guestLoginNote() : ''}
    ${pending ? `<div class="note">${ic('star-filled', 'ic-20')}
      <span>Есть ${pending} ${U.plural(pending, ['неоценённый визит', 'неоценённых визита', 'неоценённых визитов'])}.
      Поставьте оценку мастеру — это помогает другим клиентам.</span></div>` : ''}
    <div class="card-list">${list.map((b) => bookingCard(b, 'owner')).join('')}</div>`;
  }

  const guestLoginNote = () => `<div class="note">${ic('info', 'ic-20 ic-blue')}
    <span>Записи сохранены на этом устройстве как гостевые.
    <b>Войдите или зарегистрируйтесь</b> — записи автоматически перенесутся в аккаунт.</span></div>`;

  /* ============================================================
     ЭКРАН «АККАУНТ» — гость
     ============================================================ */
  function authForms() {
    const tab = S.account.tab;
    const err = S.account.error ? `<div class="form-err">${U.esc(S.account.error)}</div>` : '';

    if (tab === 'login') {
      return `
      <form class="card form" data-form="login">
        <div class="field"><label for="l-id">Логин, email или телефон</label>
          <input class="input" id="l-id" type="text" autocomplete="username" placeholder="artem" data-field="login.identifier"></div>
        <div class="field"><label for="l-pass">Пароль</label>
          <input class="input" id="l-pass" type="password" autocomplete="current-password" placeholder="Минимум 4 символа" data-field="login.password"></div>
        ${err}
        <button type="submit" class="btn btn-primary btn-lg btn-block">${ic('user', 'ic-20')}Войти</button>
      </form>`;
    }

    return `
    <form class="card form" data-form="register">
      <div class="field"><label for="r-name">Имя</label>
        <input class="input" id="r-name" type="text" autocomplete="name" placeholder="Иван" data-field="register.name"></div>
      <div class="field"><label for="r-login">Логин</label>
        <input class="input" id="r-login" type="text" autocomplete="username" placeholder="ivan_92" data-field="register.login">
        <span class="form-hint">3–20 символов: латиница, цифры, точка, дефис, подчёркивание</span></div>
      <div class="field"><label for="r-email">Email</label>
        <input class="input" id="r-email" type="email" autocomplete="email" placeholder="ivan@mail.ru" data-field="register.email"></div>
      <div class="field"><label for="r-phone">Телефон</label>
        <input class="input" id="r-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67" data-field="register.phone"></div>
      <div class="field"><label for="r-pass">Пароль</label>
        <input class="input" id="r-pass" type="password" autocomplete="new-password" placeholder="Минимум 4 символа" data-field="register.password"></div>
        ${err}
      <button type="submit" class="btn btn-primary btn-lg btn-block">${ic('plus', 'ic-20')}Зарегистрироваться</button>
    </form>`;
  }

  function guestAccount() {
    return `
    ${authHintCard()}
    <section class="section">
      <div class="segmented">
        <button data-act="auth-tab" data-tab="login" class="${S.account.tab === 'login' ? 'is-active' : ''}">Вход</button>
        <button data-act="auth-tab" data-tab="register" class="${S.account.tab === 'register' ? 'is-active' : ''}">Регистрация</button>
      </div>
      ${authForms()}
    </section>
    ${commonBlocks(null)}`;
  }

  const authHintCard = () => `<div class="note">${ic('info', 'ic-20 ic-blue')}
    <span><b>Записаться можно и без регистрации</b> — оставьте имя и телефон на экране «Записаться».
    Гостевые записи сохранятся на устройстве и перенесутся в аккаунт при входе.</span></div>`;

  /* ============================================================
     ЭКРАН «АККАУНТ» — клиент
     ============================================================ */
  function clientAccount(user) {
    const bookings = Booking.forOwner('u_' + user.id);
    const active = bookings.filter((b) => b.status === 'active').length;

    const profileCard = S.account.editing ? `
      <form class="card form" data-form="profile">
        <div class="field"><label for="p-name">Имя</label>
          <input class="input" id="p-name" type="text" data-field="profile.name" value="${U.esc(S.profile.name)}"></div>
        <div class="field"><label for="p-login">Логин</label>
          <input class="input" id="p-login" type="text" value="${U.esc(user.login)}" disabled>
          <span class="form-hint">Логин изменить нельзя</span></div>
        <div class="field"><label for="p-email">Email</label>
          <input class="input" id="p-email" type="email" data-field="profile.email" value="${U.esc(S.profile.email)}"></div>
        <div class="field"><label for="p-phone">Телефон</label>
          <input class="input" id="p-phone" type="tel" inputmode="tel" data-field="profile.phone" value="${U.esc(S.profile.phone)}"></div>
        ${S.account.error ? `<div class="form-err">${U.esc(S.account.error)}</div>` : ''}
        <div class="row"><button type="submit" class="btn btn-primary grow">${ic('check', 'ic-18')}Сохранить</button>
          <button type="button" class="btn" data-act="profile-edit-off">Отмена</button></div>
      </form>`
      : `
      <div class="card">
        <div class="row" style="margin-bottom:6px">
          <span class="h3 grow">Профиль</span>
          <button class="btn btn-soft btn-sm" data-act="profile-edit-on">${ic('edit', 'ic-16')}Редактировать</button>
        </div>
        <dl style="margin:0">
          <div class="kv"><dt>Логин</dt><dd>${U.esc(user.login)}</dd></div>
          <div class="kv"><dt>Email</dt><dd>${U.esc(user.email)}</dd></div>
          <div class="kv"><dt>Телефон</dt><dd>${U.esc(U.prettyPhone(user.phone))}</dd></div>
          <div class="kv"><dt>Записей</dt><dd>${bookings.length}, активных ${active}</dd></div>
        </dl>
      </div>`;

    return `
    <div class="who">
      ${avatarHTML(user, 'avatar--lg')}
      <div class="grow">
        <div class="who__name">${U.esc(user.name)}</div>
        <div class="who__sub">${U.esc(user.email)}</div>
      </div>
      <span class="badge">Клиент</span>
    </div>
    ${profileCard}
    <section class="section">
      <div class="section__head"><h2 class="h2">Мои визиты</h2>
        <button class="btn btn-ghost btn-sm" data-act="go" data-screen="bookings">Все записи</button></div>
      <div class="card-list">
        ${bookings.slice(0, 2).map((b) => bookingCard(b, 'owner')).join('') ||
          `<div class="note">${ic('calendar', 'ic-20 ic-blue')}<span>Записей пока нет.
            <b>Выберите барбера</b> на экране «Записаться».</span></div>`}
      </div>
    </section>
    ${commonBlocks(user)}`;
  }

  /* ============================================================
     ЭКРАН «АККАУНТ» — барбер
     ============================================================ */
  function barberAccount(barber) {
    if (!S.cabDate || S.cabDate < U.today()) {            // стартовая дата панели доступности
      const dates = Object.keys(barber.availabilityByDate || {}).filter((d) => d >= U.today()).sort();
      S.cabDate = dates[0] || U.today();
      S.cabMonth = S.cabDate;
    }
    const services = Booking.SERVICES.map((s) => `
      <label class="check">
        <input type="checkbox" data-act="barber-service" data-id="${s.id}" ${Booking.serviceIds(barber).includes(s.id) ? 'checked' : ''}>
        <span class="check__box"></span>
        <span class="check__label">${U.esc(s.name)}</span>
        <span class="check__price">${U.money(s.price)}</span>
      </label>`).join('');

    const list = Booking.forBarber(barber.id);
    const stats = Booking.stats(barber.id);

    const availability = `
    <section class="section">
      <div class="section__head"><h2 class="h2">Моя доступность</h2>
        <span class="muted">${ic('info', 'ic-14 ic-blue')} сохраняется сразу</span></div>
      ${calendarHTML('cab')}
      ${availabilityPanel('cab', barber.id)}
    </section>`;

    return `
    <div class="who">
      ${avatarHTML(barber, 'avatar--lg')}
      <div class="grow">
        <div class="who__name">${U.esc(barber.name)}</div>
        <div class="who__sub">${U.esc(barber.specialty || 'Барбер')}</div>
      </div>
      <span class="badge">Барбер</span>
    </div>

    <div class="card">
      <div class="row">
        <div>
          <div class="rating-big">${barber.ratingsCount ? U.rating(barber.rating) : '—'}</div>
          ${starsHTML(barber.rating)}
        </div>
        <div class="grow center">
          <div class="h3">${barber.ratingsCount} ${U.plural(barber.ratingsCount, ['оценка', 'оценки', 'оценок'])}</div>
          <div class="muted">всего записей: ${stats.total}</div>
        </div>
        <div class="tile__icon">${ic('chart', 'ic-22 ic-orange')}</div>
      </div>
    </div>

    <section class="section">
      <div class="section__head"><h2 class="h2">Услуги, которые я оказываю</h2></div>
      <div class="card-list card-list--2">${services}</div>
      ${!Booking.serviceIds(barber).length
        ? `<div class="hint">${ic('info', 'ic-18 ic-blue')}Выберите хотя бы одну услугу, чтобы клиенты могли записаться</div>` : ''}
    </section>

    ${availability}

    <section class="section">
      <div class="section__head"><h2 class="h2">Мои записи</h2>
        <span class="muted">${list.filter((b) => b.status === 'active').length} активных</span></div>
      <div class="card-list">
        ${list.map((b) => bookingCard(b, 'barber')).join('') ||
          `<div class="note">${ic('calendar', 'ic-20 ic-blue')}<span>Записей пока нет. Проверьте, что выбраны услуги и открыта доступность.</span></div>`}
      </div>
    </section>

    ${commonBlocks(barber)}`;
  }

  /* панель слотов: кабинет барбера (inline) и админка (модалка) */
  function availabilityPanel(ctx, barberId) {
    const barber = Auth.findById(barberId);
    if (!barber) return '';
    const date = ctx === 'cab' ? S.cabDate : S.admDate;
    if (!date) {
      return `<div class="hint">${ic('calendar', 'ic-18 ic-blue')}Выберите дату в календаре, чтобы отметить рабочие часы</div>`;
    }

    const mine = Booking.availabilityOf(barber, date);
    const busy = Booking.busyMap(barberId, date);
    const past = U.isPastDate(date);

    const slots = Booking.ALL_SLOTS.map((t) => {
      const isBusy = busy.has(t);
      const cls = ['slot'];
      if (mine.includes(t)) cls.push('is-selected');
      if (isBusy) cls.push('is-booked');
      if (past) cls.push('is-past');
      return `<button type="button" class="${cls.join(' ')}" data-act="avail-slot" data-ctx="${ctx}"
        data-t="${t}" ${isBusy || past ? 'disabled' : ''}>${isBusy ? ic('user', 'ic-14') + ' ' : ''}${t}</button>`;
    }).join('');

    return `
    <div class="slot-wrap">
      <div class="row" style="margin-bottom:10px">
        <span class="h3 grow">${U.fmtDateLong(date)} — ${mine.length} ${U.plural(mine.length, ['слот', 'слота', 'слотов'])}</span>
        ${past ? `<span class="badge badge--cancelled">Дата прошла</span>` : ''}
      </div>
      <div class="slots">${slots}</div>
      <div class="row" style="margin-top:12px">
        <button type="button" class="btn btn-sm grow" data-act="avail-all" data-ctx="${ctx}"
          ${past ? 'disabled' : ''}>${ic('check', 'ic-16 ic-green')}Выбрать весь день</button>
        <button type="button" class="btn btn-sm grow" data-act="avail-none" data-ctx="${ctx}"
          ${past ? 'disabled' : ''}>${ic('close', 'ic-16')}Снять всё в дне</button>
      </div>
      ${busy.size ? `<div class="cal__legend"><div><i class="orange"></i>слот занят записью клиента — изменить нельзя</div></div>` : ''}
    </div>`;
  }

  /* ============================================================
     ЭКРАН «АККАУНТ» — админ
     ============================================================ */
  function staffForm() {
    const f = S.admin.form;
    if (!f) return '';
    const d = f.data;
    const isNew = f.id === 'new';

    return `
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <span class="h3 grow">${isNew ? 'Новый сотрудник' : 'Редактирование'}</span>
        <button class="btn btn-icon" data-act="staff-cancel" aria-label="Закрыть">${ic('close', 'ic-18')}</button>
      </div>
      <div class="form">
        <div class="field"><label for="s-name">Имя</label>
          <input class="input" id="s-name" type="text" data-field="staff.name" value="${U.esc(d.name)}" placeholder="Иван Петров"></div>
        <div class="field"><label for="s-login">Логин</label>
          <input class="input" id="s-login" type="text" data-field="staff.login" value="${U.esc(d.login)}"
                 placeholder="ivan" ${isNew ? '' : 'disabled'}>
          ${isNew ? '' : '<span class="form-hint">Логин изменить нельзя</span>'}</div>
        <div class="field"><label for="s-email">Email</label>
          <input class="input" id="s-email" type="email" data-field="staff.email" value="${U.esc(d.email)}" placeholder="ivan@barbershop.ru"></div>
        <div class="field"><label for="s-phone">Телефон</label>
          <input class="input" id="s-phone" type="tel" inputmode="tel" data-field="staff.phone" value="${U.esc(d.phone)}" placeholder="+7 999 123-45-67"></div>
        <div class="field"><label for="s-pass">Пароль</label>
          <input class="input" id="s-pass" type="text" data-field="staff.password" value="${U.esc(d.password)}" placeholder="Минимум 4 символа"></div>
        <div class="field"><label for="s-spec">Специальность</label>
          <input class="input" id="s-spec" type="text" data-field="staff.specialty" value="${U.esc(d.specialty)}" placeholder="Топ-барбер, фейды"></div>
        <div class="field"><label for="s-photo">URL фото</label>
          <input class="input" id="s-photo" type="url" data-field="staff.photo" value="${U.esc(d.photo)}" placeholder="https://..."></div>

        <div class="field"><label>Услуги мастера</label>
          <div class="card-list">${Booking.SERVICES.map((s) => `
            <label class="check">
              <input type="checkbox" data-act="staff-service" data-id="${s.id}" ${d.services.includes(s.id) ? 'checked' : ''}>
              <span class="check__box"></span>
              <span class="check__label">${U.esc(s.name)}</span>
              <span class="check__price">${U.money(s.price)}</span>
            </label>`).join('')}</div>
        </div>

        ${S.account.error ? `<div class="form-err">${U.esc(S.account.error)}</div>` : ''}
        <div class="row">
          <button type="button" class="btn btn-primary grow" data-act="staff-save">
            ${ic(isNew ? 'plus' : 'check', 'ic-18')}${isNew ? 'Создать' : 'Сохранить'}</button>
          <button type="button" class="btn" data-act="staff-cancel">Отмена</button>
        </div>
      </div>
    </div>`;
  }

  function staffList() {
    const barbers = Auth.listBarbers();
    if (!barbers.length) {
      return `<div class="empty">${ic('users', 'ic-44')}
        <div class="empty__title">Сотрудников пока нет</div>
        <p>Добавьте барбера, отметьте услуги и задайте доступность.</p></div>`;
    }
    return `<div class="card-list">${barbers.map((b) => {
      const days = Object.keys(b.availabilityByDate || {})
        .filter((d) => d >= U.today() && (b.availabilityByDate[d] || []).length).length;
      return `
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          ${avatarHTML(b, 'avatar--lg')}
          <span class="grow">
            <span class="tile__title ellipsis">${U.esc(b.name)}</span>
            <span class="tile__sub ellipsis">${U.esc(b.specialty || 'Барбер')}</span>
            <span class="tile__sub">логин: <b>${U.esc(b.login)}</b></span>
          </span>
          <span class="center">${ratingHTML(b)}</span>
        </div>
        <div class="booking__meta">
          <div>${ic('phone', 'ic-16 ic-blue')}${U.esc(U.prettyPhone(b.phone))}</div>
          <div>${ic('mail', 'ic-16 ic-grey')}${U.esc(b.email)}</div>
          <div>${ic('scissors', 'ic-16 ic-grey')}услуг: ${Booking.serviceIds(b).length} из ${Booking.SERVICES.length}</div>
          <div>${ic('calendar', 'ic-16 ic-blue')}рабочих дней: ${days}</div>
        </div>
        <div class="btn-row">
          <button class="btn btn-soft btn-sm" data-act="staff-edit" data-id="${b.id}">${ic('edit', 'ic-16')}Редактировать</button>
          <button class="btn btn-sm" data-act="staff-avail" data-id="${b.id}">${ic('calendar-check', 'ic-16')}Доступность</button>
          <button class="btn btn-danger btn-sm" data-act="staff-delete" data-id="${b.id}">${ic('trash', 'ic-16')}Удалить</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function adminBookings() {
    const f = S.admin.filters;
    let list = Booking.all();
    if (f.barber) list = list.filter((b) => b.barberId === f.barber);
    if (f.service) list = list.filter((b) => String(b.serviceId) === String(f.service) || b.service === f.service);
    const today = U.today();
    if (f.when === 'future') list = list.filter((b) => b.date >= today);
    if (f.when === 'past') list = list.filter((b) => b.date < today);
    list = list.reverse();       // свежие сверху

    const barbers = Auth.listBarbers();
    const counts = { all: Booking.all().length, future: 0, past: 0 };
    Booking.all().forEach((b) => (b.date >= today ? counts.future++ : counts.past++));

    return `
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="filters">
        <select class="input" data-act="filter-barber">
          <option value="">Все барберы</option>
          ${barbers.map((b) => `<option value="${b.id}" ${f.barber === b.id ? 'selected' : ''}>${U.esc(b.name)}</option>`).join('')}
        </select>
        <select class="input" data-act="filter-service">
          <option value="">Все услуги</option>
          ${Booking.SERVICES.map((s) => `<option value="${s.id}" ${String(f.service) === String(s.id) ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="segmented">
        <button data-act="filter-when" data-when="all" class="${f.when === 'all' ? 'is-active' : ''}">Все (${counts.all})</button>
        <button data-act="filter-when" data-when="future" class="${f.when === 'future' ? 'is-active' : ''}">Будущие (${counts.future})</button>
        <button data-act="filter-when" data-when="past" class="${f.when === 'past' ? 'is-active' : ''}">Прошедшие (${counts.past})</button>
      </div>
    </div>
    <div class="card-list">
      ${list.map((b) => bookingCard(b, 'admin')).join('') ||
        `<div class="empty">${ic('calendar-check', 'ic-44')}<div class="empty__title">Записей не найдено</div>
          <p>Измените фильтры или подождите новых заявок.</p></div>`}
    </div>`;
  }

  function adminRatings() {
    const barbers = Auth.listBarbers().slice().sort((a, b) =>
      (b.rating || 0) - (a.rating || 0) || (b.ratingsCount || 0) - (a.ratingsCount || 0));

    if (!barbers.length) {
      return `<div class="empty">${ic('chart', 'ic-44')}<div class="empty__title">Нет данных о рейтингах</div></div>`;
    }

    return `
    <div class="card-list">${barbers.map((b, i) => {
      const st = Booking.stats(b.id);
      const percent = Math.round(((b.rating || 0) / 5) * 100);
      return `
      <div class="card">
        <div class="row">
          <span class="tile__icon">${i === 0 && b.rating ? ic('star-filled', 'ic-22') : ic('user', 'ic-22 ic-purple')}</span>
          ${avatarHTML(b, 'avatar--xs')}
          <span class="grow">
            <span class="tile__title ellipsis">${U.esc(b.name)}</span>
            <span class="tile__sub ellipsis">${U.esc(b.specialty || 'Барбер')}</span>
          </span>
          <span class="row" style="gap:6px">
            ${b.ratingsCount ? `<span class="h2">${U.rating(b.rating)}</span>` : `<span class="muted">нет оценок</span>`}
            ${ic('star-filled', 'ic-22')}
          </span>
        </div>
        <div class="rating-row" style="margin-top:10px">
          <div class="rating-row__bar"><i style="width:${percent}%"></i></div>
          <span class="muted">${b.ratingsCount} ${U.plural(b.ratingsCount, ['оценка', 'оценки', 'оценок'])}</span>
        </div>
        <div class="booking__meta" style="margin-top:10px">
          <div>${ic('calendar-check', 'ic-16 ic-green')}записей: ${st.total}, выполнено: ${st.completed}</div>
          <div>${ic('clock', 'ic-16 ic-green')}активных: ${st.active}, отменено: ${st.cancelled}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function adminAccount() {
    const tabs = [
      { id: 'staff', label: 'Сотрудники', icon: 'users' },
      { id: 'bookings', label: 'Записи', icon: 'calendar-check' },
      { id: 'ratings', label: 'Рейтинги', icon: 'chart' }
    ];
    const tab = S.admin.tab;
    const body =
      tab === 'staff' ? `
        ${S.admin.form ? staffForm() : ''}
        <button class="btn btn-primary btn-block" data-act="staff-new" ${S.admin.form ? 'disabled' : ''}>
          ${ic('plus', 'ic-20')}Добавить сотрудника</button>
        ${staffList()}`
      : tab === 'bookings' ? adminBookings()
      : adminRatings();

    return `
    <div class="who">
      <span class="avatar avatar--lg"><span class="avatar__initials">${ic('scissors', 'ic-26')}</span></span>
      <div class="grow">
        <div class="who__name">Администратор</div>
        <div class="who__sub">${U.esc(Auth.ADMIN_LOGIN)} · полный доступ</div>
      </div>
      <span class="badge">Админ</span>
    </div>

    <div class="segmented">
      ${tabs.map((t) => `<button data-act="admin-tab" data-tab="${t.id}" class="${tab === t.id ? 'is-active' : ''}">
        ${ic(t.icon, 'ic-16')} ${t.label}</button>`).join('')}
    </div>

    <section class="section">${body}</section>

    <button class="switch-btn" data-act="reset-demo">
      ${ic('trash', 'ic-22 ic-red')}<span>Сбросить все данные приложения</span></button>
    ${commonBlocks(Auth.ADMIN)}`;
  }

  /* ============================================================
     ОБЩИЕ БЛОКИ: тема, установка, выход
     ============================================================ */
  function commonBlocks(user) {
    const theme = DB.getTheme();
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    const install = isStandalone ? '' : `
    <div class="note note--install">
      ${ic('download', 'ic-22 ic-blue')}
      <span><b>Установите приложение на телефон.</b><br>
        iPhone: «Поделиться» ${ic('chevron-right', 'ic-12')} «На экран “Домой”».<br>
        Android: меню браузера ${ic('chevron-right', 'ic-12')} «Установить приложение».</span>
    </div>
    ${deferredPrompt ? `<button class="btn btn-primary btn-block" data-act="install">${ic('download', 'ic-20')}Установить приложение</button>` : ''}`;

    return `
    <section class="section">
      <div class="section__head"><h2 class="h2">Настройки</h2></div>
      <button class="switch-btn" data-act="theme">
        ${ic(theme === 'dark' ? 'sun' : 'moon', 'ic-22')}
        <span>Тема оформления</span>
        <span class="switch-btn__state">${theme === 'dark' ? 'Тёмная' : 'Светлая'}</span>
      </button>
      ${install}
      ${user ? `<button class="btn btn-danger btn-block" data-act="logout">${ic('logout', 'ic-20')}Выйти из аккаунта</button>` : ''}
      <div class="muted center" style="padding-top:6px">Джентльмен · версия 1.0 · офлайн-режим включён</div>
    </section>`;
  }

  function screenAccount() {
    const user = Auth.me();
    if (!user) return guestAccount();
    if (user.role === 'admin') return adminAccount();
    if (user.role === 'barber') return barberAccount(user);
    return clientAccount(user);
  }

  /* ============================================================
     КАРКАС: заголовок и таб-бар
     ============================================================ */
  function renderChrome() {
    const user = Auth.me();
    const theme = DB.getTheme();

    /* тема на html + цвет статус-бара (iOS/Android) */
    document.documentElement.dataset.theme = theme;
    const barColor = theme === 'dark' ? '#0B0B0D' : '#F2F2F7';
    ['theme-color-light', 'theme-color-dark'].forEach((id) => {
      const meta = document.getElementById(id);
      if (meta) meta.setAttribute('content', barColor);
    });
    themeBtn.innerHTML = ic(theme === 'dark' ? 'sun' : 'moon', 'ic-22');
    themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');

    /* заголовок */
    const subtitles = {
      salon: 'ул. Ленина, 15 · 09:00–20:00',
      book: 'Выберите мастера, услугу и время',
      bookings: user && user.role === 'client' ? U.esc(user.name) : 'История ваших визитов',
      account: user ? (user.role === 'admin' ? 'Панель администратора' : user.role === 'barber' ? 'Кабинет барбера' : 'Ваш профиль') : 'Вход и регистрация'
    };
    titleEl.innerHTML = `${TAB_LABELS[S.screen]}<small>${subtitles[S.screen] || ''}</small>`;

    /* таб-бар: сотрудникам доступен только «Аккаунт» */
    const tabs = Auth.isStaff() ? ['account'] : SCREENS;
    const icons = { salon: ['home', 'ic-orange'], book: ['calendar', 'ic-blue'], bookings: ['list', 'ic-green'], account: ['user', 'ic-purple'] };
    tabbar.hidden = false;
    tabbar.innerHTML = tabs.map((t) => `
      <button class="tab ${S.screen === t ? 'is-active' : ''}" data-act="go" data-screen="${t}">
        ${ic(icons[t][0], 'ic-26 ' + icons[t][1])}
        <span>${TAB_LABELS[t]}</span>
      </button>`).join('');
  }

  /* ============================================================
     РЕНДЕР
     ============================================================ */
  function render() {
    /* сессия устарела (например, сотрудника удалили в другой вкладке) */
    if (DB.getCurrent() && !Auth.me()) DB.setCurrent(null);

    if (!SCREENS.includes(S.screen)) S.screen = 'book';
    if (Auth.isStaff() && S.screen !== 'account') S.screen = 'account';

    renderChrome();
    view.classList.toggle('view--enter', S.screen !== lastScreen);
    lastScreen = S.screen;
    view.innerHTML = S.screen === 'salon' ? screenSalon()
      : S.screen === 'book' ? screenBook()
      : S.screen === 'bookings' ? screenBookings()
      : screenAccount();
    afterRender();
  }

  /* ============================================================
     МОДАЛКИ
     ============================================================ */
  function openSheet(cfg) { sheet = cfg; renderSheet(); }
  function closeSheet() { sheet = null; confirmCb = null; modalRoot.innerHTML = ''; }

  function renderSheet() {
    if (!sheet) { modalRoot.innerHTML = ''; return; }
    const body = typeof sheet.body === 'function' ? sheet.body() : sheet.body;
    modalRoot.innerHTML = `
      <div class="overlay ${sheet.center ? 'overlay--center' : ''}" data-act="close-sheet">
        <div class="sheet" role="dialog" aria-modal="true">
          ${sheet.center ? '' : '<div class="sheet__grab"></div>'}
          <div class="sheet__head">
            <div class="sheet__title">${sheet.title || ''}</div>
            <button class="btn btn-icon" data-act="close-sheet" aria-label="Закрыть">${ic('close', 'ic-18')}</button>
          </div>
          <div class="sheet__body">${body}</div>
        </div>
      </div>`;
    modalRoot.querySelectorAll('.avatar img').forEach((img) =>
      img.addEventListener('error', () => img.remove(), { once: true }));
  }

  const confirmSheet = (title, text, confirmText, onConfirm) => {
    confirmCb = onConfirm;
    openSheet({
      center: true, title,
      body: `
        <p class="muted-2">${U.esc(text)}</p>
        <button class="btn btn-danger btn-block" data-act="confirm-ok">${U.esc(confirmText)}</button>
        <button class="btn btn-block" data-act="close-sheet">Отмена</button>`
    });
  };

  /* ---------- модалка доступности (админ) ---------- */
  function openAvailability(barberId) {
    const barber = Auth.findById(barberId);
    if (!barber) return;
    S.admBarberId = barberId;
    if (!S.admDate || S.admDate < U.today()) {
      S.admDate = Object.keys(barber.availabilityByDate || {}).filter((d) => d >= U.today()).sort()[0] || U.today();
      S.admMonth = S.admDate;
    }
    openSheet({
      title: `Доступность · ${U.esc(barber.name)}`,
      body: () => `
        <p class="muted">Отметьте рабочие часы мастера. Изменения сразу видны барберу и клиентам.</p>
        ${calendarHTML('adm')}
        ${availabilityPanel('adm', barberId)}`
    });
  }

  /* ---------- попап оценки ---------- */
  function openRatingPopup(booking) {
    S.rating = { booking, value: 0, done: false };
    openSheet({ center: true, title: 'Стрижка выполнена!', body: ratingBody });
  }

  function ratingBody() {
    const r = S.rating;
    if (!r) return '';
    const b = r.booking;

    if (r.done) {
      return `
      <div class="center" style="display:flex;flex-direction:column;gap:12px;align-items:center">
        ${ic('star-filled', 'ic-44')}
        <div class="h2">Спасибо за отзыв!</div>
        <p class="muted-2">Вы поставили ${r.value} из 5. Ваша оценка учтена в рейтинге мастера.</p>
        ${starsHTML(r.value)}
        <button class="btn btn-primary btn-block" data-act="close-sheet">Готово</button>
      </div>`;
    }

    return `
    <p class="muted-2">Ваша стрижка «${U.esc(b.service)}» была выполнена
      ${U.fmtDate(b.date)} в ${b.time}.<br>Барбер: <b>${U.esc(b.barberName)}</b>.</p>
    <div class="center h3">Поставьте оценку от 1 до 5</div>
    <div class="rate-stars">
      ${[1, 2, 3, 4, 5].map((v) => `
        <button type="button" data-act="rate-star" data-v="${v}" aria-label="Оценка ${v}">
          ${ic(v <= r.value ? 'star-filled' : 'star', 'ic-32')}
        </button>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" data-act="rate-submit" ${r.value ? '' : 'disabled'}>
      ${ic('check', 'ic-20')}Оценить</button>
    <button class="btn btn-ghost btn-block" data-act="rate-later">Позже</button>`;
  }

  function maybeShowRatingPopup() {
    if (sheet) return;                       // не перебиваем открытую модалку
    const user = Auth.me();
    if (!user || user.role !== 'client') return;
    const b = Booking.pendingRating('u_' + user.id);
    if (b) openRatingPopup(b);
  }

  /* ============================================================
     ДЕЙСТВИЯ
     ============================================================ */
  function toggleTheme() {
    const next = DB.getTheme() === 'dark' ? 'light' : 'dark';
    DB.setTheme(next);
    renderChrome();
    if (sheet) renderSheet();
  }

  function pickBarber(id) {
    const changed = S.draft.barberId !== id;
    S.draft.barberId = id;
    if (changed) {
      S.draft.date = null;
      S.draft.time = null;
      const barber = Auth.findById(id);
      if (barber && !Booking.serviceIds(barber).includes(S.draft.serviceId)) S.draft.serviceId = null;

      const first = Booking.firstFreeDate(id);
      S.bookMonth = first || U.today();                     // календарь прыгает к первой доступной дате
    }
    render();
  }

  function pickService(id) {
    S.draft.serviceId = Number(id);
    if (!Booking.freeSlots(S.draft.barberId, S.draft.date).includes(S.draft.time)) S.draft.time = null;
    render();
  }

  function repeatBooking(id) {
    const b = Booking.all().find((x) => x.id === id);
    if (!b) return;
    const barber = Auth.findById(b.barberId);
    if (!barber) return toast('Мастер больше не работает в салоне', 'info');

    S.draft.barberId = b.barberId;
    S.draft.serviceId = Booking.serviceIds(barber).includes(b.serviceId) ? b.serviceId : null;
    const first = Booking.firstFreeDate(b.barberId);
    S.draft.date = first;
    S.draft.time = null;
    S.bookMonth = first || U.today();
    setScreen('book');
    toast(first ? 'Выберите удобное время' : 'У мастера пока нет свободных слотов', first ? 'calendar' : 'info');
  }

  function submitBooking() {
    const d = S.draft;
    const user = Auth.me();
    const res = Booking.create({
      barberId: d.barberId, serviceId: d.serviceId, date: d.date, time: d.time,
      user: user && user.role === 'client' ? user : null,
      guest: { name: d.guestName, phone: d.guestPhone }
    });
    if (!res.ok) return toast(res.error, 'info');

    S.draft = { barberId: null, serviceId: null, date: null, time: null, guestName: '', guestPhone: '' };
    toast('Вы успешно записаны!', 'check');
    setScreen('bookings');
  }

  /* ============================================================
     ОБРАБОТЧИКИ
     ============================================================ */
  const CLICK = {
    go: (el) => setScreen(el.dataset.screen),
    theme: toggleTheme,
    'close-sheet': (el, e) => { if (e.target === el || el.tagName === 'BUTTON') closeSheet(); },
    'confirm-ok': () => { const cb = confirmCb; closeSheet(); if (cb) cb(); },

    'cal-nav': (el) => calNav(el.dataset.ctx, el.dataset.dir),
    'cal-day': (el) => calPick(el.dataset.ctx, el.dataset.d),

    'pick-barber': (el) => pickBarber(el.dataset.id),
    'pick-service': (el) => pickService(el.dataset.id),
    'pick-slot': (el) => { S.draft.time = el.dataset.t; render(); },

    repeat: (el) => repeatBooking(el.dataset.id),
    'cancel-booking': (el) => {
      const b = Booking.all().find((x) => x.id === el.dataset.id);
      if (!b) return;
      const byStaff = Auth.me() && Auth.me().role === 'barber';
      confirmSheet('Отменить запись?',
        `${b.service}, ${U.fmtDate(b.date)} в ${b.time}. ${byStaff ? 'Клиент не придёт.' : 'Мастер освободится, слот снова станет свободным.'}`,
        'Отменить запись', () => { Booking.cancel(b.id, byStaff ? 'Отменено барбером' : 'Отменено клиентом'); toast('Запись отменена', 'close'); render(); });
    },
    complete: (el) => {
      const b = Booking.all().find((x) => x.id === el.dataset.id);
      if (!b) return;
      confirmSheet('Отметить как выполненную?',
        `Клиент «${b.userName}» сможет поставить вам оценку.`,
        'Да, выполнено', () => { Booking.complete(b.id); toast('Запись выполнена', 'check'); render(); });
    },

    'rate-open': (el) => { const b = Booking.all().find((x) => x.id === el.dataset.id); if (b) openRatingPopup(b); },
    'rate-star': (el) => { S.rating.value = Number(el.dataset.v); renderSheet(); },
    'rate-submit': () => {
      const r = S.rating;
      if (!r || !r.value) return;
      Booking.rate(r.booking.id, r.value);
      r.done = true;
      renderSheet();
      toast('Спасибо за отзыв!', 'star-filled');
    },
    'rate-later': closeSheet,

    'auth-tab': (el) => { S.account.tab = el.dataset.tab; S.account.error = ''; render(); },
    'profile-edit-on': () => {
      const u = Auth.me();
      S.profile = { name: u.name, email: u.email, phone: u.phone };
      S.account.editing = true; S.account.error = ''; render();
    },
    'profile-edit-off': () => { S.account.editing = false; S.account.error = ''; render(); },
    logout: () => {
      confirmSheet('Выйти из аккаунта?', 'Гостевые записи на этом устройстве сохранятся.', 'Выйти', () => {
        Auth.logout(); S.account = { tab: 'login', editing: false, error: '' };
        S.draft = { barberId: null, serviceId: null, date: null, time: null, guestName: '', guestPhone: '' };
        toast('Вы вышли из аккаунта', 'logout'); setScreen('account');
      });
    },

    'admin-tab': (el) => { S.admin.tab = el.dataset.tab; S.account.error = ''; render(); },
    'staff-new': () => {
      S.admin.form = { id: 'new', data: { name: '', login: '', email: '', phone: '', password: '', specialty: '', photo: '', services: [] } };
      S.account.error = ''; render();
    },
    'staff-edit': (el) => {
      const b = Auth.findById(el.dataset.id);
      if (!b) return;
      S.admin.form = { id: b.id, data: {
        name: b.name, login: b.login, email: b.email, phone: b.phone, password: b.password,
        specialty: b.specialty || '', photo: b.photo || '', services: Booking.serviceIds(b)
      } };
      S.account.error = ''; render();
    },
    'staff-cancel': () => { S.admin.form = null; S.account.error = ''; render(); },
    'staff-save': () => {
      const f = S.admin.form;
      if (!f) return;
      const res = f.id === 'new'
        ? Auth.createBarber(f.data)
        : Auth.updateBarber(f.id, f.data, true);
      if (!res.ok) { S.account.error = res.error; render(); return toast(res.error, 'info'); }
      S.admin.form = null; S.account.error = '';
      toast(f.id === 'new' ? 'Сотрудник создан' : 'Данные сохранены', 'check');
      render();
    },
    'staff-delete': (el) => {
      const b = Auth.findById(el.dataset.id);
      if (!b) return;
      confirmSheet('Удалить сотрудника?',
        `${b.name} будет удалён. Активные записи к нему отменятся.`,
        'Удалить', () => { Auth.removeBarber(b.id); toast('Сотрудник удалён', 'trash'); render(); });
    },
    'staff-avail': (el) => openAvailability(el.dataset.id),

    'avail-slot': (el) => {
      const ctx = el.dataset.ctx;
      const barberId = ctx === 'cab' ? Auth.me().id : S.admBarberId;
      Auth.toggleSlot(barberId, ctx === 'cab' ? S.cabDate : S.admDate, el.dataset.t);
      ctx === 'cab' ? render() : renderSheet();
    },
    'avail-all': (el) => {
      const ctx = el.dataset.ctx;
      const barberId = ctx === 'cab' ? Auth.me().id : S.admBarberId;
      Auth.setDay(barberId, ctx === 'cab' ? S.cabDate : S.admDate, Booking.ALL_SLOTS);
      toast('Весь день открыт', 'check');
      ctx === 'cab' ? render() : renderSheet();
    },
    'avail-none': (el) => {
      const ctx = el.dataset.ctx;
      const barberId = ctx === 'cab' ? Auth.me().id : S.admBarberId;
      const date = ctx === 'cab' ? S.cabDate : S.admDate;
      const busy = Booking.busyMap(barberId, date);
      Auth.setDay(barberId, date, [...busy.keys()]);
      toast('Слоты сняты', 'close');
      ctx === 'cab' ? render() : renderSheet();
    },

    'filter-when': (el) => { S.admin.filters.when = el.dataset.when; render(); },
    'salon-barber': (el) => {
      const b = Auth.findById(el.dataset.id);
      if (b && !Booking.serviceIds(b).length) return toast('Мастер пока не выбрал услуги', 'info');
      pickBarber(el.dataset.id);
      setScreen('book');
    },
    install: async () => {
      if (!deferredPrompt) return toast('Установка недоступна в этом браузере', 'info');
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      render();
    },
    'reset-demo': () => confirmSheet('Сбросить все данные?',
      'Будут удалены все клиенты, сотрудники и записи. Приложение вернётся к демо-состоянию.',
      'Сбросить', () => {
        DB.resetAll();
        Auth.seedDemo(true);
        S.draft = { barberId: null, serviceId: null, date: null, time: null, guestName: '', guestPhone: '' };
        S.admin.form = null;
        toast('Данные сброшены', 'check');
        setScreen('book');
      })
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (!CLICK[act]) return;
    if (el.tagName === 'BUTTON' && el.disabled) return;
    e.preventDefault();
    CLICK[act](el, e);
  });

  /* ---------- поля ввода (состояние форм) ---------- */
  const LoginForm = { identifier: '', password: '' };
  const RegisterForm = { name: '', login: '', email: '', phone: '', password: '' };

  const BUCKETS = () => ({
    draft: S.draft,
    profile: S.profile,
    login: LoginForm,
    register: RegisterForm,
    staff: (S.admin.form && S.admin.form.data) || null
  });

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const [scope, key] = el.dataset.field.split('.');
    const bucket = BUCKETS()[scope];
    if (bucket) bucket[key] = el.value;
  });

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'barber-service' && el.type === 'checkbox') {
      const me = Auth.me();
      if (me) {
        Auth.toggleService(me.id, el.dataset.id, el.checked);
        toast(el.checked ? 'Услуга добавлена' : 'Услуга убрана', 'scissors');
        render();
      }
      return;
    }
    if (act === 'staff-service' && el.type === 'checkbox' && S.admin.form) {
      const id = Number(el.dataset.id);
      const set = new Set(S.admin.form.data.services.map(Number));
      el.checked ? set.add(id) : set.delete(id);
      S.admin.form.data.services = [...set].sort((a, b) => a - b);
      return;
    }
    if (act === 'filter-barber') { S.admin.filters.barber = el.value; render(); return; }
    if (act === 'filter-service') { S.admin.filters.service = el.value; render(); return; }
  });

  /* ---------- формы ---------- */
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;

    if (kind === 'book') { submitBooking(); return; }

    if (kind === 'login') {
      const res = Auth.login(LoginForm.identifier, LoginForm.password);
      if (!res.ok) { S.account.error = res.error; render(); return; }
      LoginForm.identifier = ''; LoginForm.password = '';
      welcome(res);
      return;
    }

    if (kind === 'register') {
      const res = Auth.register(RegisterForm);
      if (!res.ok) { S.account.error = res.error; render(); return; }
      Object.keys(RegisterForm).forEach((k) => (RegisterForm[k] = ''));
      welcome(res);
      return;
    }

    if (kind === 'profile') {
      const res = Auth.updateProfile(Auth.me().id, S.profile);
      if (!res.ok) { S.account.error = res.error; render(); return; }
      S.account.editing = false; S.account.error = '';
      toast('Профиль обновлён', 'check');
      render();
      return;
    }
  });

  function welcome(res) {
    const user = res.user;
    S.account.error = '';
    S.account.tab = 'login';
    toast(`Добро пожаловать, ${user.name.split(' ')[0]}!`, user.role === 'admin' ? 'chart' : 'user');
    if (res.moved) setTimeout(() => toast(`Записи перенесены в аккаунт: ${res.moved}`, 'check'), 700);
    setScreen(user.role === 'client' ? 'bookings' : 'account');
    if (user.role === 'client') setTimeout(maybeShowRatingPopup, res.moved ? 1100 : 350);
  }

  /* ---------- глобальные события ---------- */
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet) closeSheet(); });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (S.screen === 'account') render();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; toast('Приложение установлено', 'download'); });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeShowRatingPopup(); });

  window.addEventListener('storage', (e) => {                   // синхронизация между окнами
    if (e.key === DB.KEYS.bookings || e.key === DB.KEYS.users) render();
  });

  /* ============================================================
     СТАРТ
     ============================================================ */
  function boot() {
    document.documentElement.dataset.theme = DB.getTheme();
    document.querySelectorAll('[data-ic]').forEach((el) => el.classList.add('i-' + el.dataset.ic));

    Auth.seedDemo();
    DB.getGuestId();

    /* если мы вернулись барбером/админом — открываем «Аккаунт» */
    S.screen = Auth.isStaff() ? 'account' : 'book';

    /* первая доступная дата у первого барбера — чтобы календарь был осмысленным */
    const first = Auth.activeBarbers()[0];
    if (first) {
      const date = Booking.firstFreeDate(first.id);
      if (date) S.bookMonth = date;
    }

    /* ярлыки манифеста: ?screen=bookings */
    const wanted = new URLSearchParams(location.search).get('screen');
    if (wanted && SCREENS.includes(wanted) && !Auth.isStaff()) S.screen = wanted;

    render();
    setTimeout(maybeShowRatingPopup, 400);
    registerServiceWorker();
  }

  /* ---------- Service Worker (офлайн-режим) ---------- */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Доступна новая версия — перезапустите приложение', 'download');
            }
          });
        });
      }).catch((err) => console.warn('[sw] регистрация не удалась', err));
    });
  }

  boot();
})();
