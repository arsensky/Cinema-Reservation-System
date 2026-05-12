const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DB_DIR = path.join(ROOT, 'db');
const DB_PATH = path.join(DB_DIR, 'cinema.db');
const SCHEMA_PATH = path.join(DB_DIR, 'schema.sql');
const SEED_PATH = path.join(DB_DIR, 'seed.sql');
const APP_VERSION = '6';

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function loadSQL(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function sanitizePosterFileName(fileName) {
  const raw = path.basename(String(fileName || '').trim());
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return safe || `poster-${Date.now()}.jpg`;
}

function savePosterAsset(posterDataUrl, posterName) {
  const source = String(posterDataUrl || '').trim();
  if (!source) return '';
  const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return '';
  const mimeType = match[1].toLowerCase();
  const base64 = match[2];
  const originalName = sanitizePosterFileName(posterName || `poster-${Date.now()}`);
  const ext = path.extname(originalName) || (mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg');
  const baseName = path.basename(originalName, path.extname(originalName));
  const finalName = sanitizePosterFileName(`${baseName}${ext}`).toLowerCase();
  const posterDir = path.join(UPLOADS_DIR, 'posters');
  fs.mkdirSync(posterDir, { recursive: true });
  const filePath = path.join(posterDir, finalName);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return `/uploads/posters/${finalName}`;
}

function initializeDatabase() {
  let currentVersion = null;
  try {
    currentVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value || null;
  } catch {
    currentVersion = null;
  }
  if (String(currentVersion) === APP_VERSION) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();
  for (const { name } of tables) {
    db.exec(`DROP TABLE IF EXISTS "${String(name).replace(/"/g, '""')}";`);
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(loadSQL(SCHEMA_PATH));
  db.exec(loadSQL(SEED_PATH));

  const hashPassword = (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  };

  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  insertUser.run('Administrator', 'admin@kinoordo.kg', hashPassword('Admin123'), 'admin');
  insertUser.run('User', 'user@kinoordo.kg', hashPassword('User123'), 'user');

  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('schema_version', APP_VERSION);
}

initializeDatabase();

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf-8');
      if (raw.length > 2e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.name, u.email, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return {
    token: row.token,
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  };
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return session.user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    jsonResponse(res, 403, { error: 'Admin access required' });
    return null;
  }
  return user;
}

function staticFilePath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return path.join(PUBLIC_DIR, 'index.html');
  if (urlPath === '/styles.css') return path.join(PUBLIC_DIR, 'styles.css');
  if (urlPath === '/app.js') return path.join(PUBLIC_DIR, 'app.js');
  if (urlPath.startsWith('/uploads/')) return path.join(ROOT, urlPath.slice(1));
  if (urlPath.startsWith('/posters/')) return path.join(PUBLIC_DIR, urlPath.slice(1));
  if (urlPath.startsWith('/screenshots/')) return path.join(ROOT, urlPath.slice(1));
  if (urlPath.startsWith('/slides/')) return path.join(ROOT, urlPath.slice(1));
  return null;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function movieCard(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    genre: row.genre,
    duration: row.duration,
    language: row.language,
    releaseDate: row.release_date,
    posterUrl: row.poster_url || '',
    rating: Number(row.rating),
    showtimeCount: Number(row.showtime_count || 0),
  };
}

function formatShowtime(row) {
  return {
    id: row.id,
    movieId: row.movie_id,
    hallId: row.hall_id,
    hallName: row.hall_name,
    hallRows: row.total_rows,
    hallColumns: row.total_columns,
    screenPosition: row.screen_position,
    startTime: row.start_time,
    price: Number(row.price),
    availableSeats: Number(row.available_seats),
  };
}

function formatReservation(row) {
  return {
    id: row.id,
    title: row.title,
    hallName: row.hall_name,
    startTime: row.start_time,
    seatLabels: row.seat_labels,
    totalPrice: Number(row.total_price),
    status: row.status,
    bookedAt: row.booked_at,
  };
}

function listMovies(filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const genre = String(filters.genre || 'all').trim().toLowerCase();

  let sql = `
    SELECT m.*, COUNT(s.id) AS showtime_count
    FROM movies m
    LEFT JOIN showtimes s ON s.movie_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (q) {
    const needle = `%${escapeLike(q)}%`;
    sql += ' AND (LOWER(m.title) LIKE ? ESCAPE "\\" OR LOWER(m.description) LIKE ? ESCAPE "\\")';
    params.push(needle, needle);
  }
  if (genre && genre !== 'all') {
    sql += ' AND LOWER(m.genre) = ?';
    params.push(genre);
  }

  sql += ' GROUP BY m.id ORDER BY m.release_date DESC, m.title ASC';
  return db.prepare(sql).all(...params).map(movieCard);
}

function movieDetail(movieId) {
  const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);
  if (!movie) return null;
  const showtimes = db.prepare(`
    SELECT s.*, h.hall_name, h.total_rows, h.total_columns, h.screen_position,
           (
             SELECT COUNT(*)
             FROM seats se
             WHERE se.hall_id = h.id
               AND se.id NOT IN (
                 SELECT rs.seat_id
                 FROM reservation_seats rs
                 JOIN reservations r ON r.id = rs.reservation_id
                 WHERE rs.showtime_id = s.id AND r.status <> 'cancelled'
               )
           ) AS available_seats
    FROM showtimes s
    JOIN halls h ON h.id = s.hall_id
    WHERE s.movie_id = ?
    ORDER BY s.start_time ASC
  `).all(movieId).map(formatShowtime);

  return { movie: movieCard({ ...movie, showtime_count: showtimes.length }), showtimes };
}

function sendSeatData(showtimeId) {
  const showtime = db.prepare(`
    SELECT s.id, s.movie_id, s.hall_id, s.start_time, s.price,
           h.hall_name, h.total_rows, h.total_columns, h.screen_position,
           m.title AS movie_title
    FROM showtimes s
    JOIN halls h ON h.id = s.hall_id
    JOIN movies m ON m.id = s.movie_id
    WHERE s.id = ?
  `).get(showtimeId);
  if (!showtime) return null;

  const seats = db.prepare(`
    SELECT se.id, se.row_number, se.seat_number, se.seat_type,
           CASE WHEN rs.seat_id IS NULL THEN 0 ELSE 1 END AS reserved
    FROM seats se
    LEFT JOIN reservation_seats rs ON rs.seat_id = se.id AND rs.showtime_id = ?
    LEFT JOIN reservations r ON r.id = rs.reservation_id AND r.status <> 'cancelled'
    WHERE se.hall_id = ?
    GROUP BY se.id
    ORDER BY se.row_number ASC, se.seat_number ASC
  `).all(showtimeId, showtime.hall_id).map((seat) => ({
    id: seat.id,
    rowNumber: seat.row_number,
    seatNumber: seat.seat_number,
    seatType: seat.seat_type,
    reserved: Boolean(seat.reserved),
  }));

  return {
    showtime: {
      id: showtime.id,
      movieId: showtime.movie_id,
      hallId: showtime.hall_id,
      hallName: showtime.hall_name,
      hallRows: showtime.total_rows,
      hallColumns: showtime.total_columns,
      screenPosition: showtime.screen_position,
      startTime: showtime.start_time,
      price: Number(showtime.price),
      movieTitle: showtime.movie_title,
    },
    seats,
  };
}

function readImageDataUrl(file) {
  if (!file) return '';
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = file.mimetype || 'image/png';
  const buffer = fs.readFileSync(file.path);
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;

  if (req.method === 'GET' && pathname === '/api/health') {
    return jsonResponse(res, 200, { ok: true, service: 'KinoOrdo' });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const session = getSession(req);
    return jsonResponse(res, 200, { user: session ? session.user : null });
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    try {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!name || !email || !password) return jsonResponse(res, 400, { error: 'Name, email and password are required' });
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
        return jsonResponse(res, 409, { error: 'Email already exists' });
      }
      const result = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(name, email, hashPassword(password), 'user');
      return jsonResponse(res, 201, { message: 'Registration successful', user: { id: result.lastInsertRowid, name, email, role: 'user' } });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const body = await parseBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return jsonResponse(res, 400, { error: 'Email and password are required' });
      const user = db.prepare('SELECT id, name, email, password_hash, role FROM users WHERE email = ?').get(email);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return jsonResponse(res, 401, { error: 'Invalid credentials' });
      }
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
      return jsonResponse(res, 200, { message: 'Login successful', token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    try {
      const body = await parseBody(req);
      const header = req.headers.authorization || '';
      const token = body.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return jsonResponse(res, 200, { message: 'Logged out' });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/movies') {
    return jsonResponse(res, 200, { movies: listMovies({ q: searchParams.get('q'), genre: searchParams.get('genre') }) });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/movies/')) {
    const movieId = Number(pathname.split('/').pop());
    const detail = movieDetail(movieId);
    if (!detail) return jsonResponse(res, 404, { error: 'Movie not found' });
    return jsonResponse(res, 200, detail);
  }

  if (req.method === 'GET' && pathname === '/api/seats') {
    const showtimeId = Number(searchParams.get('showtimeId'));
    const payload = sendSeatData(showtimeId);
    if (!payload) return jsonResponse(res, 404, { error: 'Showtime not found' });
    return jsonResponse(res, 200, payload);
  }

  if (req.method === 'POST' && pathname === '/api/reservations') {
    const user = requireAuth(req, res);
    if (!user) return;
    try {
      const body = await parseBody(req);
      const showtimeId = Number(body.showtimeId);
      const seatIds = Array.isArray(body.seatIds) ? body.seatIds.map(Number).filter(Boolean) : [];
      if (!showtimeId || seatIds.length === 0) return jsonResponse(res, 400, { error: 'Showtime and at least one seat are required' });

      const showtime = db.prepare('SELECT id, hall_id, price, available_seats FROM showtimes WHERE id = ?').get(showtimeId);
      if (!showtime) return jsonResponse(res, 404, { error: 'Showtime not found' });

      const placeholders = seatIds.map(() => '?').join(',');
      const seats = db.prepare(`SELECT id FROM seats WHERE id IN (${placeholders}) AND hall_id = ?`).all(...seatIds, showtime.hall_id);
      if (seats.length !== seatIds.length) return jsonResponse(res, 400, { error: 'One or more seats are invalid for this hall' });

      const reserved = db.prepare(`
        SELECT rs.seat_id
        FROM reservation_seats rs
        JOIN reservations r ON r.id = rs.reservation_id
        WHERE rs.showtime_id = ? AND rs.seat_id IN (${placeholders}) AND r.status <> 'cancelled'
      `).all(showtimeId, ...seatIds);
      if (reserved.length) return jsonResponse(res, 409, { error: 'One or more seats are already reserved' });

      db.exec('BEGIN IMMEDIATE');
      try {
        const totalPrice = Number(showtime.price) * seatIds.length;
        const reservation = db.prepare('INSERT INTO reservations (user_id, showtime_id, total_price, status) VALUES (?, ?, ?, ?)')
          .run(user.id, showtimeId, totalPrice, 'confirmed');
        const insertSeat = db.prepare('INSERT INTO reservation_seats (reservation_id, showtime_id, seat_id) VALUES (?, ?, ?)');
        seatIds.forEach((seatId) => insertSeat.run(reservation.lastInsertRowid, showtimeId, seatId));
        db.prepare('UPDATE showtimes SET available_seats = available_seats - ? WHERE id = ?').run(seatIds.length, showtimeId);
        db.exec('COMMIT');
        return jsonResponse(res, 201, { message: 'Reservation confirmed' });
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/reservations/me') {
    const user = requireAuth(req, res);
    if (!user) return;
    const reservations = db.prepare(`
      SELECT r.id, r.total_price, r.status, r.booked_at,
             m.title, h.hall_name, s.start_time,
             GROUP_CONCAT(se.row_number || '-' || se.seat_number, ', ') AS seat_labels
      FROM reservations r
      JOIN showtimes s ON s.id = r.showtime_id
      JOIN movies m ON m.id = s.movie_id
      JOIN halls h ON h.id = s.hall_id
      JOIN reservation_seats rs ON rs.reservation_id = r.id
      JOIN seats se ON se.id = rs.seat_id
      WHERE r.user_id = ?
      GROUP BY r.id
      ORDER BY r.booked_at DESC
    `).all(user.id).map(formatReservation);
    return jsonResponse(res, 200, { reservations });
  }

  if (req.method === 'GET' && pathname === '/api/admin/halls') {
    const user = requireAdmin(req, res);
    if (!user) return;
    const halls = db.prepare(`
      SELECT h.id, h.hall_name, h.total_rows, h.total_columns, h.screen_position, c.name AS cinema_name
      FROM halls h
      JOIN cinemas c ON c.id = h.cinema_id
      ORDER BY h.id ASC
    `).all();
    return jsonResponse(res, 200, { halls });
  }

  if (req.method === 'GET' && pathname === '/api/admin/movies') {
    const user = requireAdmin(req, res);
    if (!user) return;
    return jsonResponse(res, 200, { movies: listMovies() });
  }

  if (req.method === 'GET' && pathname === '/api/admin/reservations') {
    const user = requireAdmin(req, res);
    if (!user) return;
    const reservations = db.prepare(`
      SELECT r.id, r.total_price, r.status, r.booked_at,
             u.name AS user_name, u.email,
             m.title, h.hall_name, s.start_time,
             GROUP_CONCAT(se.row_number || '-' || se.seat_number, ', ') AS seat_labels
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN showtimes s ON s.id = r.showtime_id
      JOIN movies m ON m.id = s.movie_id
      JOIN halls h ON h.id = s.hall_id
      JOIN reservation_seats rs ON rs.reservation_id = r.id
      JOIN seats se ON se.id = rs.seat_id
      GROUP BY r.id
      ORDER BY r.booked_at DESC
    `).all();
    return jsonResponse(res, 200, { reservations });
  }

  if (req.method === 'POST' && pathname === '/api/admin/movies') {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const body = await parseBody(req);
      const posterUrl = savePosterAsset(body.posterDataUrl, body.posterName) || String(body.posterUrl || '').trim();
      const result = db.prepare(`
        INSERT INTO movies (title, description, genre, duration, language, release_date, poster_url, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(body.title || '').trim(),
        String(body.description || '').trim(),
        String(body.genre || '').trim(),
        Number(body.duration || 0),
        String(body.language || '').trim(),
        String(body.releaseDate || '').trim(),
        posterUrl,
        Number(body.rating || 0),
      );
      return jsonResponse(res, 201, { id: result.lastInsertRowid });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/admin/movies/')) {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const movieId = Number(pathname.split('/').pop());
      const body = await parseBody(req);
      const posterUrl = savePosterAsset(body.posterDataUrl, body.posterName) || String(body.posterUrl || '').trim();
      db.prepare('UPDATE movies SET poster_url = ? WHERE id = ?').run(posterUrl, movieId);
      return jsonResponse(res, 200, { message: 'Poster updated' });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/showtimes') {
    const user = requireAdmin(req, res);
    if (!user) return;
    try {
      const body = await parseBody(req);
      const movieId = Number(body.movieId);
      const hallId = Number(body.hallId);
      const startTime = String(body.startTime || '').trim();
      const price = Number(body.price || 0);
      if (!movieId || !hallId || !startTime) {
        return jsonResponse(res, 400, { error: 'Movie, hall and start time are required' });
      }
      const hall = db.prepare('SELECT total_rows, total_columns FROM halls WHERE id = ?').get(hallId);
      if (!hall) return jsonResponse(res, 404, { error: 'Hall not found' });
      const capacity = Number(hall.total_rows) * Number(hall.total_columns);
      db.prepare('INSERT INTO showtimes (movie_id, hall_id, start_time, price, available_seats) VALUES (?, ?, ?, ?, ?)')
        .run(movieId, hallId, startTime.includes('T') ? startTime.replace('T', ' ') + ':00' : startTime, price, capacity);
      return jsonResponse(res, 201, { message: 'Showtime saved' });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  return jsonResponse(res, 404, { error: 'Not found' });
}

function sendStatic(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
  };
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(data);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    if (urlObj.pathname.startsWith('/api/')) {
      return handleApi(req, res, urlObj);
    }
    const filePath = staticFilePath(urlObj.pathname);
    if (filePath && sendStatic(res, filePath)) return;
    textResponse(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    jsonResponse(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`KinoOrdo running at http://localhost:${PORT}`);
});
