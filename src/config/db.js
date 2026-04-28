const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Please check your .env file in project root.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}

async function getUserByEmail(email) {
  const result = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
  return result.rows[0] || null;
}

async function getPropertiesWithBookingCount() {
  const result = await query(
    `SELECT
      p.id, p.code, p.name, p.type, p.created_at,
      TO_CHAR(p.created_at, 'YYYY-MM-DD HH24:MI') AS created_at_display,
      COUNT(CASE WHEN b.status IN ('booked', 'confirmed') THEN 1 END)::int AS booked_count
    FROM properties p
    LEFT JOIN bookings b ON b.property_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC`
  );
  return result.rows;
}

async function getPropertyById(id) {
  const result = await query("SELECT * FROM properties WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] || null;
}

async function getBookingsByPropertyId(propertyId) {
  const result = await query(
    `SELECT
      b.*,
      TO_CHAR(b.start_date, 'YYYY-MM-DD HH24:MI') AS start_date_display,
      TO_CHAR(b.end_date, 'YYYY-MM-DD HH24:MI') AS end_date_display,
      TO_CHAR(b.start_date, 'YYYY-MM-DD"T"HH24:MI') AS start_date_input,
      TO_CHAR(b.end_date, 'YYYY-MM-DD"T"HH24:MI') AS end_date_input
    FROM bookings b
    WHERE b.property_id = $1
    ORDER BY b.start_date DESC, b.id DESC`,
    [propertyId]
  );
  return result.rows;
}

async function updateProperty({ id, name, code, type }) {
  await query("UPDATE properties SET name = $1, code = $2, type = $3 WHERE id = $4", [
    name,
    code,
    type,
    id
  ]);
}

async function createProperty({ code, name, type }) {
  await query(
    "INSERT INTO properties (code, name, type, created_at) VALUES ($1, $2, $3, NOW())",
    [code, name, type]
  );
}

async function findOverlappingBooking({ propertyId, startDate, endDate, excludeBookingId = null }) {
  const params = [propertyId, startDate, endDate];
  let sql = `
    SELECT id
    FROM bookings
    WHERE property_id = $1
      AND status IN ('booked', 'confirmed')
      AND NOT (end_date < $2 OR start_date > $3)
  `;

  if (excludeBookingId) {
    params.push(excludeBookingId);
    sql += ` AND id != $4`;
  }

  sql += " LIMIT 1";
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function createBooking({ propertyId, clientName, staffName, startDate, endDate, status }) {
  await query(
    `INSERT INTO bookings (property_id, client_name, staff_name, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [propertyId, clientName, staffName, startDate, endDate, status]
  );
}

async function updateBooking({
  bookingId,
  propertyId,
  clientName,
  staffName,
  startDate,
  endDate,
  status
}) {
  await query(
    `UPDATE bookings
     SET client_name = $1, staff_name = $2, start_date = $3, end_date = $4, status = $5
     WHERE id = $6 AND property_id = $7`,
    [clientName, staffName, startDate, endDate, status, bookingId, propertyId]
  );
}

async function bootstrapDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      code INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('house', 'duplex')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      client_name TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      start_date TIMESTAMP NOT NULL,
      end_date TIMESTAMP NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('booked', 'confirmed', 'cancelled')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(
    "ALTER TABLE properties ALTER COLUMN created_at TYPE TIMESTAMP USING created_at::timestamp"
  );
  await query("ALTER TABLE properties ALTER COLUMN created_at SET DEFAULT NOW()");
  await query("ALTER TABLE bookings ALTER COLUMN start_date TYPE TIMESTAMP USING start_date::timestamp");
  await query("ALTER TABLE bookings ALTER COLUMN end_date TYPE TIMESTAMP USING end_date::timestamp");

  const adminName = process.env.ADMIN_NAME || "مايا";
  const adminEmail = process.env.ADMIN_EMAIL || "admin@maya-property.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin@12345";
  const passwordHash = bcrypt.hashSync(adminPassword, 10);

  await query(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
    [adminName, adminEmail, passwordHash]
  );

  const propertiesCount = await query("SELECT COUNT(*)::int AS count FROM properties");
  if (propertiesCount.rows[0].count === 0) {
    const now = new Date().toISOString().slice(0, 10);
    const p1 = await query(
      "INSERT INTO properties (code, name, type, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [127, "دوبلكس الزملاك جنينة الأسماك", "duplex", now]
    );
    const p2 = await query(
      "INSERT INTO properties (code, name, type, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [124, "دوبلكس ايستاون H1-34-23 التجمع الخامس", "duplex", now]
    );
    await query("INSERT INTO properties (code, name, type, created_at) VALUES ($1, $2, $3, $4)", [
      130,
      "فيلا مستقلة - الشيخ زايد",
      "house",
      now
    ]);

    await createBooking({
      propertyId: p1.rows[0].id,
      clientName: "مهران",
      staffName: "مهران",
      startDate: "2026-04-23",
      endDate: "2026-04-27",
      status: "confirmed"
    });
    await createBooking({
      propertyId: p2.rows[0].id,
      clientName: "محمد سمير",
      staffName: "محمد سمير",
      startDate: "2026-04-09",
      endDate: "2026-04-23",
      status: "confirmed"
    });
  }
}

module.exports = {
  pool,
  query,
  bootstrapDatabase,
  getUserByEmail,
  getPropertiesWithBookingCount,
  getPropertyById,
  getBookingsByPropertyId,
  updateProperty,
  createProperty,
  findOverlappingBooking,
  createBooking,
  updateBooking
};
