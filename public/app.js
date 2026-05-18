const state = {
  user: null,
  token: localStorage.getItem('kinoordo_token') || '',
  movies: [],
  bookings: [],
  adminReservations: [],
  halls: [],
  selectedMovie: null,
  selectedShowtime: null,
  seatData: null,
  selectedSeatIds: new Set(),
  filters: { q: '', genre: 'all' },
  authMode: 'login',
};

const $ = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  return String(value || '').slice(0, 10);
}

function formatDateTime(value) {
  return String(value || '').replace('T', ' ').slice(0, 16);
}

function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(path, { ...options, headers }).then(async (res) => {
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || data || 'Request failed');
    return data;
  });
}

function posterMarkup(movie, large = false) {
  const title = escapeHtml(movie.title || 'KinoOrdo');
  const extra = movie.genre ? `${escapeHtml(movie.genre)} · ${movie.duration} min` : 'Cinema project';
  const cls = `poster ${large ? 'large' : ''}`;
  if (movie.posterUrl) {
    return `<div class="${cls}" style="background-image:url('${movie.posterUrl}')"><span class="poster-label">${title}<br><small>${escapeHtml(extra)}</small></span></div>`;
  }
  return `<div class="${cls}"><span class="poster-label">${title}<br><small>${escapeHtml(extra)}</small></span></div>`;
}

function populateSelect(select, items, valueKey, labelFn, includePlaceholder = false) {
  const previous = select.value;
  select.innerHTML = includePlaceholder ? '<option value="">Select one</option>' : '';
  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = labelFn(item);
    select.appendChild(option);
  });
  if (previous) select.value = previous;
}

function renderGenres() {
  const genres = ['all', ...new Set(state.movies.map((m) => m.genre))];
  const select = $('genreFilter');
  const current = select.value || 'all';
  select.innerHTML = genres.map((genre) => `<option value="${escapeHtml(genre)}">${genre === 'all' ? 'All genres' : escapeHtml(genre)}</option>`).join('');
  select.value = genres.includes(current) ? current : 'all';
}

function renderHero() {
  const heroPoster = $('heroPoster');
  if (!heroPoster) return;
  const featured = state.movies[0];
  if (!featured) {
    heroPoster.style.backgroundImage = '';
    heroPoster.classList.remove('has-image');
    heroPoster.innerHTML = `<div class="hero-poster-overlay"><span class="hero-title">KinoOrdo</span><span class="hero-subtitle">Browse movies, pick a showtime, and reserve seats.</span></div>`;
    return;
  }
  heroPoster.classList.toggle('has-image', Boolean(featured.posterUrl));
  heroPoster.style.backgroundImage = featured.posterUrl ? `url('${featured.posterUrl}')` : '';
  heroPoster.innerHTML = `
    <div class="hero-poster-overlay">
      <span class="hero-title">KinoOrdo</span>
      <span class="hero-subtitle">Browse movies, pick a showtime, and reserve seats.</span>
    </div>
  `;
}

function renderMovies() {
  const q = state.filters.q.trim().toLowerCase();
  const genre = state.filters.genre;
  const filtered = state.movies.filter((movie) => {
    const matchesQuery = !q || movie.title.toLowerCase().includes(q) || movie.description.toLowerCase().includes(q);
    const matchesGenre = genre === 'all' || movie.genre.toLowerCase() === genre.toLowerCase();
    return matchesQuery && matchesGenre;
  });

  $('movieCount').textContent = `${filtered.length} movie${filtered.length === 1 ? '' : 's'}`;
  $('movieGrid').innerHTML = filtered.map((movie) => `
    <article class="movie-card">
      ${posterMarkup(movie)}
      <div class="badge-row">
        <span class="badge">${escapeHtml(movie.genre)}</span>
        <span class="badge">${escapeHtml(movie.language)}</span>
        <span class="badge">${movie.showtimeCount} showtimes</span>
      </div>
      <div class="movie-title">${escapeHtml(movie.title)}</div>
      <div class="movie-desc">${escapeHtml(movie.description)}</div>
      <div class="movie-actions">
        <span class="price">Rating ${movie.rating}/10</span>
        <button type="button" class="open-movie-btn" data-movie-id="${movie.id}">View details</button>
      </div>
    </article>
  `).join('');

  document.querySelectorAll('.open-movie-btn').forEach((btn) => {
    btn.addEventListener('click', () => openMovie(Number(btn.dataset.movieId)));
  });
}

function renderMovieDetails(movie, showtimes) {
  $('movieTitle').textContent = movie.title;
  $('movieDescription').textContent = movie.description;
  $('movieMeta').innerHTML = `
    <div class="meta-item"><strong>Release date</strong>${escapeHtml(formatDate(movie.releaseDate))}</div>
    <div class="meta-item"><strong>Genre</strong>${escapeHtml(movie.genre)}</div>
    <div class="meta-item"><strong>Duration</strong>${movie.duration} min</div>
    <div class="meta-item"><strong>Language</strong>${escapeHtml(movie.language)}</div>
    <div class="meta-item"><strong>Rating</strong>${movie.rating}/10</div>
    <div class="meta-item"><strong>Showtimes</strong>${showtimes.length}</div>
  `;

  $('showtimesList').innerHTML = showtimes.map((showtime) => `
    <article class="showtime-card ${state.selectedShowtime?.id === showtime.id ? 'active' : ''}">
      <strong>${escapeHtml(showtime.hallName)}</strong>
      <div>${escapeHtml(formatDateTime(showtime.startTime))}</div>
      <div>${currency.format(showtime.price)}</div>
      <div>${showtime.availableSeats} seats left</div>
      <button type="button" class="choose-showtime-btn" data-showtime-id="${showtime.id}">Choose this showtime</button>
    </article>
  `).join('');

  document.querySelectorAll('.choose-showtime-btn').forEach((btn) => {
    btn.addEventListener('click', () => openSeatSelection(Number(btn.dataset.showtimeId)));
  });
}

function renderSeatGrid() {
  if (!state.seatData) return;
  const { showtime, seats } = state.seatData;
  const rows = [];
  const order = showtime.screenPosition === 'bottom'
    ? [...new Set(seats.map((seat) => seat.rowNumber))].sort((a, b) => b - a)
    : [...new Set(seats.map((seat) => seat.rowNumber))].sort((a, b) => a - b);

  order.forEach((rowNumber) => {
    const rowSeats = seats.filter((seat) => seat.rowNumber === rowNumber);
    rows.push(`<div class="seat-row-wrapper"><div class="row-label">Row ${rowNumber}</div><div class="seat-row">${rowSeats.map((seat) => {
      const selected = state.selectedSeatIds.has(seat.id);
      const classes = ['seat', seat.seatType, selected ? 'selected' : '', seat.reserved ? 'reserved' : 'free'].filter(Boolean).join(' ');
      const disabled = seat.reserved ? 'disabled' : '';
      return `<button type="button" class="${classes}" data-seat-id="${seat.id}" ${disabled}>${seat.seatNumber}</button>`;
    }).join('')}</div></div>`);
  });

  $('seatGrid').innerHTML = rows.join('');
  $('seatScreenTop').classList.toggle('hidden', showtime.screenPosition === 'bottom');
  $('seatScreenBottom').classList.toggle('hidden', showtime.screenPosition !== 'bottom');
  $('seatTitle').textContent = `${showtime.movieTitle} — ${showtime.hallName}`;

  document.querySelectorAll('.seat:not(.reserved)').forEach((seatBtn) => {
    seatBtn.addEventListener('click', () => {
      const seatId = Number(seatBtn.dataset.seatId);
      if (state.selectedSeatIds.has(seatId)) state.selectedSeatIds.delete(seatId);
      else state.selectedSeatIds.add(seatId);
      renderSeatGrid();
      updateSeatSummary();
    });
  });

  updateSeatSummary();
}

function updateSeatSummary() {
  const count = state.selectedSeatIds.size;

  if (!count) {
    $('selectedSeatsLabel').textContent = 'No seats selected';
    $('selectedSeatsHint').textContent = 'Pick one or more seats to continue.';
    return;
  }

  const ticketPrice = Number(state.seatData?.showtime?.price || 0);
  const total = count * ticketPrice;

  $('selectedSeatsLabel').textContent =
    `${count} seat${count === 1 ? '' : 's'} selected`;

  $('selectedSeatsHint').textContent =
    `Total: ${currency.format(total)}`;
}

function renderBookings() {
  $('bookingCount').textContent = `${state.bookings.length} booking${state.bookings.length === 1 ? '' : 's'}`;
  $('bookingList').innerHTML = state.bookings.length
    ? state.bookings.map((booking) => `
      <article class="booking-card">
        <strong>${escapeHtml(booking.title)}</strong>
        <div>${escapeHtml(booking.hall_name)}</div>
        <div>${escapeHtml(formatDateTime(booking.startTime))}</div>
        <div>Seats: ${escapeHtml(booking.seat_labels)}</div>
        <div>Total: ${currency.format(Number(booking.total_price))}</div>
        <div>Status: ${escapeHtml(booking.status)}</div>
      </article>
    `).join('')
    : `<div class="booking-card">No bookings yet.</div>`;
}

function renderAdminSummary() {
  $('adminSummary').textContent = `${state.adminReservations.length} reservation${state.adminReservations.length === 1 ? '' : 's'}`;
  $('adminReservations').innerHTML = state.adminReservations.length
    ? state.adminReservations.map((reservation) => `
      <article class="admin-card">
        <strong>${escapeHtml(reservation.title)} — ${escapeHtml(reservation.user_name)}</strong>
        <div>${escapeHtml(reservation.email)}</div>
        <div>${escapeHtml(reservation.hall_name)}</div>
        <div>${escapeHtml(formatDateTime(reservation.start_time))}</div>
        <div>Seats: ${escapeHtml(reservation.seat_labels)}</div>
        <div>Total: ${currency.format(Number(reservation.total_price))}</div>
        <div>Status: ${escapeHtml(reservation.status)}</div>
      </article>
    `).join('')
    : `<div class="booking-card">No reservations yet.</div>`;
}

function updateAuthUi() {
  const authActions = $('authActions');
  const logoutBtn = $('logoutBtn');
  const adminNavBtn = $('adminNavBtn');

  if (state.user) {
    authActions.classList.add('logged-in');
    logoutBtn.classList.remove('hidden');
    $('showLoginBtn').classList.add('hidden');
    $('showRegisterBtn').classList.add('hidden');
    $('authCard').classList.add('hidden');
    adminNavBtn.classList.toggle('hidden', state.user.role !== 'admin');
    $('authStatus').textContent = `Signed in as ${state.user.name} (${state.user.role})`;
  } else {
    authActions.classList.remove('logged-in');
    logoutBtn.classList.add('hidden');
    $('showLoginBtn').classList.remove('hidden');
    $('showRegisterBtn').classList.remove('hidden');
    adminNavBtn.classList.add('hidden');
    $('authStatus').textContent = 'You are browsing as a guest.';
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const card = $('authCard');
  card.classList.remove('hidden');
  $('authPanelTitle').textContent = mode === 'login' ? 'Log in' : 'Sign in';
  $('loginForm').classList.toggle('hidden', mode !== 'login');
  $('registerForm').classList.toggle('hidden', mode !== 'register');
  (mode === 'login' ? $('loginEmail') : $('registerName')).focus();
}

function hideAuthCard() {
  $('authCard').classList.add('hidden');
}

async function loadInitialData() {
  const [meData, moviesData] = await Promise.all([
    api('/api/me').catch(() => ({ user: null })),
    api('/api/movies'),
  ]);

  state.user = meData.user;
  state.movies = moviesData.movies || [];
  renderGenres();
  renderMovies();
  renderHero();
  updateAuthUi();
  populateAdminSelects();
  await refreshBookings();
  if (state.user?.role === 'admin') await refreshAdminData();
}

function populateAdminSelects() {
  populateSelect($('showtimeMovieSelect'), state.movies, 'id', (movie) => movie.title, true);
  populateSelect($('posterMovieSelect'), state.movies, 'id', (movie) => movie.title, true);
}

async function refreshBookings() {
  if (!state.user) {
    state.bookings = [];
    renderBookings();
    return;
  }
  const data = await api('/api/reservations/me');
  state.bookings = data.reservations || [];
  renderBookings();
}

async function refreshAdminData() {
  const [reservationsData, hallsData, moviesData] = await Promise.all([
    api('/api/admin/reservations'),
    api('/api/admin/halls'),
    api('/api/admin/movies'),
  ]);
  state.adminReservations = reservationsData.reservations || [];
  state.halls = hallsData.halls || [];
  state.movies = moviesData.movies || state.movies;
  renderAdminSummary();
  populateSelect($('hallSelect'), state.halls, 'id', (hall) => `${hall.hall_name} (${hall.cinema_name})`, true);
  populateAdminSelects();
}

async function openMovie(movieId) {
  const detail = await api(`/api/movies/${movieId}`);
  state.selectedMovie = detail.movie;
  state.selectedShowtime = null;
  state.seatData = null;
  state.selectedSeatIds.clear();
  renderMovieDetails(detail.movie, detail.showtimes || []);
  $('detailsSection').classList.remove('hidden');
  $('seatSection').classList.add('hidden');
  $('detailsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openSeatSelection(showtimeId) {
  const data = await api(`/api/seats?showtimeId=${showtimeId}`);
  state.selectedShowtime = data.showtime;
  state.seatData = data;
  state.selectedSeatIds.clear();
  $('seatSection').classList.remove('hidden');
  renderSeatGrid();
  $('seatSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function confirmReservation() {
  if (!state.user) {
    alert('Please log in first.');
    setAuthMode('login');
    return;
  }
  if (!state.selectedShowtime || state.selectedSeatIds.size === 0) {
    alert('Pick at least one seat.');
    return;
  }

  await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({
      showtimeId: state.selectedShowtime.id,
      seatIds: [...state.selectedSeatIds],
    }),
  });

  alert('Reservation confirmed!');
  state.selectedSeatIds.clear();
  $('seatSection').classList.add('hidden');
  await openSeatSelection(state.selectedShowtime.id);
  await refreshBookings();
  if (state.user?.role === 'admin') await refreshAdminData();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('loginEmail').value,
        password: $('loginPassword').value,
      }),
    });
    state.user = data.user;
    state.token = data.token;
    localStorage.setItem('kinoordo_token', data.token);
    $('loginForm').reset();
    updateAuthUi();
    hideAuthCard();
    await refreshBookings();
    if (state.user.role === 'admin') await refreshAdminData();
  } catch (error) {
    alert(error.message);
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  try {
    await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: $('registerName').value,
        email: $('registerEmail').value,
        password: $('registerPassword').value,
      }),
    });
    $('registerForm').reset();
    alert('Registration successful. Please log in.');
    setAuthMode('login');
  } catch (error) {
    alert(error.message);
  }
}

async function handleLogout() {
  if (state.token) {
    await api('/api/logout', { method: 'POST', body: JSON.stringify({ token: state.token }) }).catch(() => null);
  }
  state.user = null;
  state.token = '';
  localStorage.removeItem('kinoordo_token');
  state.bookings = [];
  state.adminReservations = [];
  updateAuthUi();
  renderBookings();
  renderAdminSummary();
  renderMovies();
}

async function handleMovieSubmit(event) {
  event.preventDefault();
  if (state.user?.role !== 'admin') return;
  const form = event.currentTarget;
  const file = form.posterFile.files[0];
  const posterDataUrl = file ? await fileToDataUrl(file) : '';
  const posterName = file ? file.name : '';

  await api('/api/admin/movies', {
    method: 'POST',
    body: JSON.stringify({
      title: form.title.value,
      description: form.description.value,
      genre: form.genre.value,
      duration: form.duration.value,
      language: form.language.value,
      releaseDate: form.releaseDate.value,
      rating: form.rating.value || 0,
      posterDataUrl,
      posterName,
    }),
  });

  form.reset();
  await reloadMovies();
  alert('Movie saved.');
}

async function handlePosterSubmit(event) {
  event.preventDefault();
  if (state.user?.role !== 'admin') return;
  const form = event.currentTarget;
  const movieId = Number(form.movieId.value);
  const file = form.posterFile.files[0];
  if (!movieId || !file) return;
  const posterDataUrl = await fileToDataUrl(file);

  await api(`/api/admin/movies/${movieId}`, {
    method: 'PUT',
    body: JSON.stringify({ posterDataUrl, posterName: file.name }),
  });

  form.reset();
  await reloadMovies();
  alert('Poster uploaded.');
}

async function handleShowtimeSubmit(event) {
  event.preventDefault();
  if (state.user?.role !== 'admin') return;
  const form = event.currentTarget;
  await api('/api/admin/showtimes', {
    method: 'POST',
    body: JSON.stringify({
      movieId: Number(form.movieId.value),
      hallId: Number(form.hallId.value),
      startTime: form.startTime.value,
      price: Number(form.price.value),
    }),
  });

  form.reset();
  await reloadMovies();
  if (state.user?.role === 'admin') await refreshAdminData();
  alert('Showtime saved.');
}

async function reloadMovies() {
  const moviesData = await api('/api/movies');
  state.movies = moviesData.movies || [];
  renderGenres();
  renderMovies();
  renderHero();
  populateAdminSelects();
}

function wireEvents() {
  $('searchInput').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    renderMovies();
  });
  $('genreFilter').addEventListener('change', (e) => {
    state.filters.genre = e.target.value;
    renderMovies();
  });
  $('resetFilters').addEventListener('click', () => {
    state.filters = { q: '', genre: 'all' };
    $('searchInput').value = '';
    $('genreFilter').value = 'all';
    renderMovies();
  });

  $('browseBtn').addEventListener('click', () => $('moviesSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('myBookingsBtn').addEventListener('click', () => $('bookingsSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('closeDetailsBtn').addEventListener('click', () => $('detailsSection').classList.add('hidden'));
  $('closeSeatBtn').addEventListener('click', () => $('seatSection').classList.add('hidden'));
  $('confirmReservationBtn').addEventListener('click', confirmReservation);

  $('showLoginBtn').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('login');
  });
  $('showRegisterBtn').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('register');
  });
  $('closeAuthBtn').addEventListener('click', hideAuthCard);
  $('logoutBtn').addEventListener('click', handleLogout);

  $('loginForm').addEventListener('submit', handleLoginSubmit);
  $('registerForm').addEventListener('submit', handleRegisterSubmit);
  $('movieForm').addEventListener('submit', handleMovieSubmit);
  $('posterForm').addEventListener('submit', handlePosterSubmit);
  $('showtimeForm').addEventListener('submit', handleShowtimeSubmit);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (btn.dataset.target === 'adminSection' && state.user?.role === 'admin') {
        await refreshAdminData();
      }
    });
  });
}

async function init() {
  wireEvents();
  hideAuthCard();
  try {
    await loadInitialData();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

init();
