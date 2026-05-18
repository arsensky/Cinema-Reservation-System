const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DB_DIR = path.join(ROOT, 'db');
const SCHEMA_PATH = path.join(DB_DIR, 'schema.sql');
const SEED_PATH = path.join(DB_DIR, 'seed.sql');

const DEFAULT_DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cinema_reservation_system';
const DATABASE_URL = DEFAULT_DATABASE_URL;

let pool = null;

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function loadSQL(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendFile(res, filePath) {
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
    '.pdf': 'application/pdf'
  };
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(data);
  return true;
}

function staticFilePath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return path.join(PUBLIC_DIR, 'index.html');
  if (urlPath === '/styles.css') return path.join(PUBLIC_DIR, 'styles.css');
  if (urlPath === '/app.js') return path.join(PUBLIC_DIR, 'app.js');
  if (urlPath.startsWith('/uploads/')) return path.join(ROOT, urlPath.slice(1));
  if (urlPath.startsWith('/screenshots/')) return path.join(ROOT, urlPath.slice(1));
  if (urlPath.startsWith('/slides/')) return path.join(ROOT, urlPath.slice(1));
  return null;
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

function toMovieCard(row) {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    genre: row.genre,
    duration: Number(row.duration),
    language: row.language,
    releaseDate: row.release_date,
    posterUrl: row.poster_url || '',
    rating: Number(row.rating),
    showtimeCount: Number(row.showtime_count || 0)
  };
}

function formatShowtime(row) {
  return {
    id: Number(row.id),
    movieId: Number(row.movie_id),
    hallId: Number(row.hall_id),
    hallName: row.hall_name,
    startTime: row.start_time,
    price: Number(row.price),
    availableSeats: Number(row.available_seats)
  };
}

function formatSeat(row, reservedSet) {
  return {
    id: Number(row.id),
    rowNumber: Number(row.row_number),
    seatNumber: Number(row.seat_number),
    seatType: row.seat_type,
    reserved: reservedSet.has(Number(row.id)),
    label: `R${row.row_number}S${row.seat_number}`
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function getDbNameFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  return decodeURIComponent(url.pathname.replace(/^\//, '')) || 'cinema_reservation_system';
}

function buildMaintenanceUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function ensureTargetDatabase() {
  const dbName = getDbNameFromUrl(DATABASE_URL);
  const maintenanceUrl = buildMaintenanceUrl(DATABASE_URL);
  const adminPool = new Pool({ connectionString: maintenanceUrl });

  try {
    const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      const quotedName = `"${dbName.replace(/"/g, '""')}"`;
      await adminPool.query(`CREATE DATABASE ${quotedName}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function seedIfNeeded() {
  await pool.query(loadSQL(SCHEMA_PATH));

  const cinemaCount = await pool.query('SELECT COUNT(*)::int AS count FROM cinemas');
  if (cinemaCount.rows[0].count === 0) {
    await pool.query('BEGIN');
    try {
      await pool.query(loadSQL(SEED_PATH));

      const insertUser = `
        INSERT INTO users (name, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
      `;

      await pool.query(insertUser, ['Admin User', 'admin@kinoordo.kg', hashPassword('Admin123'), 'admin']);
      await pool.query(insertUser, ['Regular User', 'user@kinoordo.kg', hashPassword('User123'), 'user']);

      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } else {
    const adminExists = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        ['admin@kinoordo.kg']
    );

    if (adminExists.rows.length === 0) {
      await pool.query(
          'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
          [
            'Admin User',
            'admin@kinoordo.kg',
            hashPassword('Admin123'),
            'admin'
          ]
      );
    }

    const userExists = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      ['user@kinoordo.kg']
    );

    if (userExists.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [
          'Regular User',
          'user@kinoordo.kg',
          hashPassword('User123'),
          'user'
        ]
      );
    }
  }
}

async function initializeDatabase() {
  await ensureTargetDatabase();
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('SELECT 1');
  await seedIfNeeded();
}

async function getSessionFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const result = await pool.query(
    `SELECT s.token, s.expires_at::text AS expires_at, u.id, u.name, u.email, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }

  return {
    token: row.token,
    user: {
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role
    }
  };
}

async function requireAuth(req, res) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return session.user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    jsonResponse(res, 403, { error: 'Admin access required' });
    return null;
  }
  return user;
}

async function listMovies(filters = {}) {
  const q = String(filters.q || '').trim();
  const genre = String(filters.genre || 'all').trim();

  const conditions = [];
  const params = [];

  if (q) {
    params.push(`%${escapeLike(q)}%`);
    conditions.push(`(m.title ILIKE $${params.length} OR m.description ILIKE $${params.length})`);
  }

  if (genre && genre.toLowerCase() !== 'all') {
    params.push(genre.toLowerCase());
    conditions.push(`LOWER(m.genre) = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT m.id, m.title, m.description, m.genre, m.duration, m.language,
            m.release_date::text AS release_date, m.poster_url, m.rating,
            COUNT(s.id)::int AS showtime_count
     FROM movies m
     LEFT JOIN showtimes s ON s.movie_id = m.id
     ${where}
     GROUP BY m.id, m.title, m.description, m.genre, m.duration, m.language, m.release_date, m.poster_url, m.rating
     ORDER BY m.release_date DESC, m.title ASC`,
    params
  );

  return result.rows.map(toMovieCard);
}

async function movieDetail(movieId) {
  const movieResult = await pool.query(
    `SELECT id, title, description, genre, duration, language,
            release_date::text AS release_date, poster_url, rating
     FROM movies
     WHERE id = $1`,
    [movieId]
  );

  if (!movieResult.rows.length) return null;
  const movie = movieResult.rows[0];

  const showtimeResult = await pool.query(
    `SELECT s.id, s.movie_id, s.hall_id, h.hall_name, s.start_time::text AS start_time,
            s.price, s.available_seats
     FROM showtimes s
     JOIN halls h ON h.id = s.hall_id
     WHERE s.movie_id = $1
     ORDER BY s.start_time ASC`,
    [movieId]
  );

  return {
    movie: {
      id: Number(movie.id),
      title: movie.title,
      description: movie.description,
      genre: movie.genre,
      duration: Number(movie.duration),
      language: movie.language,
      releaseDate: movie.release_date,
      posterUrl: movie.poster_url || '',
      rating: Number(movie.rating),
      showtimeCount: showtimeResult.rows.length
    },
    showtimes: showtimeResult.rows.map(formatShowtime)
  };
}

async function sendSeatData(showtimeId) {
  const showtimeResult = await pool.query(
    `SELECT s.id, s.movie_id, s.hall_id, s.start_time::text AS start_time, s.price,
            h.hall_name, h.total_rows, h.total_columns, h.screen_position, s.available_seats,
            m.title AS movie_title
     FROM showtimes s
     JOIN halls h ON h.id = s.hall_id
     JOIN movies m ON m.id = s.movie_id
     WHERE s.id = $1`,
    [showtimeId]
  );

  if (!showtimeResult.rows.length) return null;
  const showtime = showtimeResult.rows[0];

  const reservedResult = await pool.query(
    `SELECT rs.seat_id
     FROM reservation_seats rs
     JOIN reservations r ON r.id = rs.reservation_id
     WHERE rs.showtime_id = $1 AND r.status <> 'cancelled'`,
    [showtimeId]
  );
  const reservedSet = new Set(reservedResult.rows.map((row) => Number(row.seat_id)));

  const seatsResult = await pool.query(
    `SELECT id, row_number, seat_number, seat_type
     FROM seats
     WHERE hall_id = $1
     ORDER BY row_number ASC, seat_number ASC`,
    [showtime.hall_id]
  );

  return {
    showtime: {
      id: Number(showtime.id),
      movieId: Number(showtime.movie_id),
      hallId: Number(showtime.hall_id),
      hallName: showtime.hall_name,
      startTime: showtime.start_time,
      price: Number(showtime.price),
      screenPosition: showtime.screen_position,
      availableSeats: Number(showtime.available_seats),
      movieTitle: showtime.movie_title
    },
    seats: seatsResult.rows.map((row) => formatSeat(row, reservedSet))
  };
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;

  if (req.method === 'GET' && pathname === '/api/health') {
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const session = await getSessionFromRequest(req);
    return jsonResponse(res, 200, { user: session ? session.user : null });
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    try {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!name || !email || !password) {
        return jsonResponse(res, 400, { error: 'Name, email and password are required' });
      }

      const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (exists.rows.length) {
        return jsonResponse(res, 409, { error: 'Email already exists' });
      }

      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'user')
         RETURNING id`,
        [name, email, hashPassword(password)]
      );

      return jsonResponse(res, 201, {
        message: 'Registration successful',
        user: { id: Number(result.rows[0].id), name, email, role: 'user' }
      });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const body = await parseBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!email || !password) {
        return jsonResponse(res, 400, { error: 'Email and password are required' });
      }

      const userResult = await pool.query(
        `SELECT id, name, email, password_hash, role
         FROM users
         WHERE email = $1`,
        [email]
      );

      if (!userResult.rows.length) {
        return jsonResponse(res, 401, { error: 'Invalid credentials' });
      }

      const user = userResult.rows[0];
      if (!verifyPassword(password, user.password_hash)) {
        return jsonResponse(res, 401, { error: 'Invalid credentials' });
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await pool.query(
        `INSERT INTO sessions (token, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [token, user.id, expiresAt]
      );

      return jsonResponse(res, 200, {
        message: 'Login successful',
        token,
        user: { id: Number(user.id), name: user.name, email: user.email, role: user.role }
      });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    try {
      const body = await parseBody(req);
      const token = body.token || (req.headers.authorization || '').replace('Bearer ', '');
      if (token) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      }
      return jsonResponse(res, 200, { message: 'Logged out' });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/movies') {
    const movies = await listMovies({ q: searchParams.get('q'), genre: searchParams.get('genre') });
    return jsonResponse(res, 200, { movies });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/movies/')) {
    const movieId = Number(pathname.split('/').pop());
    if (!movieId) return jsonResponse(res, 400, { error: 'Invalid movie id' });

    const detail = await movieDetail(movieId);
    if (!detail) return jsonResponse(res, 404, { error: 'Movie not found' });

    return jsonResponse(res, 200, detail);
  }

  if (req.method === 'GET' && pathname === '/api/seats') {
    const showtimeId = Number(searchParams.get('showtimeId'));
    if (!showtimeId) return jsonResponse(res, 400, { error: 'showtimeId is required' });

    const payload = await sendSeatData(showtimeId);
    if (!payload) return jsonResponse(res, 404, { error: 'Showtime not found' });

    return jsonResponse(res, 200, payload);
  }

  if (req.method === 'POST' && pathname === '/api/reservations') {
    const user = await requireAuth(req, res);
    if (!user) return;

    try {
      const body = await parseBody(req);
      const showtimeId = Number(body.showtimeId);
      const seatIds = Array.isArray(body.seatIds) ? body.seatIds.map(Number).filter(Boolean) : [];

      if (!showtimeId || seatIds.length === 0) {
        return jsonResponse(res, 400, { error: 'showtimeId and seatIds are required' });
      }

      const seatPlaceholders = seatIds.map((_, index) => `$${index + 1}`).join(', ');
      const showtimeResult = await pool.query(
        `SELECT s.id, s.movie_id, s.hall_id, s.price, s.available_seats,
                m.title AS movie_title
         FROM showtimes s
         JOIN movies m ON m.id = s.movie_id
         WHERE s.id = $1`,
        [showtimeId]
      );

      if (!showtimeResult.rows.length) {
        return jsonResponse(res, 404, { error: 'Showtime not found' });
      }

      const showtime = showtimeResult.rows[0];

      const seatsResult = await pool.query(
        `SELECT id, hall_id, row_number, seat_number, seat_type
         FROM seats
         WHERE id IN (${seatPlaceholders})`,
        seatIds
      );

      if (seatsResult.rows.length !== seatIds.length) {
        return jsonResponse(res, 400, { error: 'One or more seats are invalid' });
      }

      if (seatsResult.rows.some((seat) => Number(seat.hall_id) !== Number(showtime.hall_id))) {
        return jsonResponse(res, 400, { error: 'Selected seats do not belong to this hall' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const reservedResult = await client.query(
          `SELECT rs.seat_id
           FROM reservation_seats rs
           JOIN reservations r ON r.id = rs.reservation_id
           WHERE rs.showtime_id = $1 AND rs.seat_id = ANY($2::int[]) AND r.status <> 'cancelled'`,
          [showtimeId, seatIds]
        );

        if (reservedResult.rows.length) {
          await client.query('ROLLBACK');
          return jsonResponse(res, 409, { error: 'One or more seats are already reserved' });
        }

        const totalPrice = seatsResult.rows.reduce((sum, seat) => {
          const modifier = seat.seat_type === 'vip' ? 1.25 : 1;
          return sum + Number(showtime.price) * modifier;
        }, 0);

        const reservationResult = await client.query(
          `INSERT INTO reservations (user_id, showtime_id, total_price, status)
           VALUES ($1, $2, $3, 'confirmed')
           RETURNING id, booked_at`,
          [user.id, showtimeId, totalPrice]
        );

        const reservationId = Number(reservationResult.rows[0].id);
        const insertSeatQuery = `INSERT INTO reservation_seats (reservation_id, showtime_id, seat_id) VALUES ($1, $2, $3)`;

        for (const seatId of seatIds) {
          await client.query(insertSeatQuery, [reservationId, showtimeId, seatId]);
        }

        await client.query(
          `UPDATE showtimes
           SET available_seats = available_seats - $1
           WHERE id = $2`,
          [seatIds.length, showtimeId]
        );

        await client.query('COMMIT');

        const seatLabels = seatsResult.rows
          .map((seat) => `R${seat.row_number}S${seat.seat_number}`)
          .join(', ');

        return jsonResponse(res, 201, {
          message: 'Reservation created successfully',
          reservation: {
            id: reservationId,
            movieTitle: showtime.movie_title,
            seatLabels,
            totalPrice: Number(totalPrice.toFixed(2))
          }
        });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        if (String(err.code) === '23505') {
          return jsonResponse(res, 409, { error: 'One or more seats are already reserved' });
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/reservations/me') {
    const user = await requireAuth(req, res);
    if (!user) return;

    const result = await pool.query(
      `SELECT r.id, r.total_price, r.status, r.booked_at::text AS booked_at,
              m.title, h.hall_name, s.start_time::text AS start_time,
              STRING_AGG(se.row_number::text || '-' || se.seat_number::text, ', ' ORDER BY se.row_number, se.seat_number) AS seat_labels
       FROM reservations r
       JOIN showtimes s ON s.id = r.showtime_id
       JOIN movies m ON m.id = s.movie_id
       JOIN halls h ON h.id = s.hall_id
       JOIN reservation_seats rs ON rs.reservation_id = r.id
       JOIN seats se ON se.id = rs.seat_id
       WHERE r.user_id = $1
       GROUP BY r.id, r.total_price, r.status, r.booked_at, m.title, h.hall_name, s.start_time
       ORDER BY r.booked_at DESC`,
      [user.id]
    );

    return jsonResponse(res, 200, { reservations: result.rows });
  }

  if (req.method === 'GET' && pathname === '/api/admin/halls') {
    const user = await requireAdmin(req, res);
    if (!user) return;

    const result = await pool.query(
      `SELECT h.id, h.hall_name, h.total_rows, h.total_columns, c.name AS cinema_name
       FROM halls h
       JOIN cinemas c ON c.id = h.cinema_id
       ORDER BY h.id ASC`
    );

    return jsonResponse(res, 200, { halls: result.rows });
  }

  if (req.method === 'GET' && pathname === '/api/admin/movies') {
    const user = await requireAdmin(req, res);
    if (!user) return;

    const movies = await listMovies();
    return jsonResponse(res, 200, { movies });
  }

  if (req.method === 'GET' && pathname === '/api/admin/reservations') {
    const user = await requireAdmin(req, res);
    if (!user) return;

    const result = await pool.query(
      `SELECT r.id, r.total_price, r.status, r.booked_at::text AS booked_at,
              u.name AS name, u.email AS email,
              m.title AS title, h.hall_name, s.start_time::text AS start_time,
              STRING_AGG(se.row_number::text || '-' || se.seat_number::text, ', ' ORDER BY se.row_number, se.seat_number) AS seat_labels
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN showtimes s ON s.id = r.showtime_id
       JOIN movies m ON m.id = s.movie_id
       JOIN halls h ON h.id = s.hall_id
       JOIN reservation_seats rs ON rs.reservation_id = r.id
       JOIN seats se ON se.id = rs.seat_id
       GROUP BY r.id, r.total_price, r.status, r.booked_at, u.name, u.email, m.title, h.hall_name, s.start_time
       ORDER BY r.booked_at DESC`
    );

    return jsonResponse(res, 200, { reservations: result.rows });
  }

  if (req.method === 'POST' && pathname === '/api/admin/movies') {
    const user = await requireAdmin(req, res);
    if (!user) return;

    try {
      const body = await parseBody(req);
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const genre = String(body.genre || '').trim();
      const duration = Number(body.duration || 0);
      const language = String(body.language || '').trim();
      const releaseDate = String(body.releaseDate || '').trim();
      const rating = Number(body.rating || 0);

      if (!title || !description || !genre || !duration || !language || !releaseDate) {
        return jsonResponse(res, 400, { error: 'All movie fields are required' });
      }

      const result = await pool.query(
        `INSERT INTO movies (title, description, genre, duration, language, release_date, poster_url, rating)
         VALUES ($1, $2, $3, $4, $5, $6, '', $7)
         RETURNING id`,
        [title, description, genre, duration, language, releaseDate, rating]
      );

      return jsonResponse(res, 201, { message: 'Movie created', movieId: Number(result.rows[0].id) });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/admin/movies/')) {
    const user = await requireAdmin(req, res);
    if (!user) return;

    try {
      const movieId = Number(pathname.split('/').pop());
      const body = await parseBody(req);
      const posterUrl = String(body.posterUrl || '').trim();

      await pool.query('UPDATE movies SET poster_url = $1 WHERE id = $2', [posterUrl, movieId]);
      return jsonResponse(res, 200, { message: 'Poster updated' });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/showtimes') {
    const user = await requireAdmin(req, res);
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

      const hallResult = await pool.query('SELECT total_rows, total_columns FROM halls WHERE id = $1', [hallId]);
      if (!hallResult.rows.length) {
        return jsonResponse(res, 404, { error: 'Hall not found' });
      }

      const capacity = Number(hallResult.rows[0].total_rows) * Number(hallResult.rows[0].total_columns);
      const result = await pool.query(
        `INSERT INTO showtimes (movie_id, hall_id, start_time, price, available_seats)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [movieId, hallId, startTime, price, capacity]
      );

      return jsonResponse(res, 201, { message: 'Showtime created', showtimeId: Number(result.rows[0].id) });
    } catch (err) {
      return jsonResponse(res, 400, { error: err.message });
    }
  }

  return false;
}

async function main() {
  await initializeDatabase();

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);

      if (urlObj.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, urlObj);
        if (handled === false) {
          jsonResponse(res, 404, { error: 'API route not found' });
        }
        return;
      }

      const filePath = staticFilePath(urlObj.pathname);
      if (filePath && sendFile(res, filePath)) return;

      if (urlObj.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        textResponse(res, 500, 'Internal Server Error');
      } else {
        res.end();
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`Cinema Reservation System running on http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
