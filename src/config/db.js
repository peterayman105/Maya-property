const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { parsePhotosJson } = require("../property-photos");

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

async function getPropertiesList() {
  const result = await query(
    `SELECT
      p.id, p.code, p.name, p.type, p.rooms,
      p.price_daily, p.price_monthly, p.price_yearly,
      p.monthly_expenses, p.photos,
      p.sale_probability
    FROM properties p
    ORDER BY p.id ASC`
  );
  return result.rows;
}

async function getAllBookingsForStats() {
  const result = await query(
    `SELECT
      property_id,
      status,
      start_date,
      end_date,
      amount_paid,
      TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS start_date_display,
      TO_CHAR(end_date, 'YYYY-MM-DD HH24:MI') AS end_date_display
    FROM bookings
    ORDER BY start_date ASC`
  );
  return result.rows;
}

async function getActiveBookingsForAvailability() {
  const result = await query(
    `SELECT
      b.property_id,
      b.status,
      b.start_date,
      b.end_date,
      TO_CHAR(b.start_date, 'YYYY-MM-DD HH24:MI') AS start_date_display,
      TO_CHAR(b.end_date, 'YYYY-MM-DD HH24:MI') AS end_date_display
    FROM bookings b
    WHERE b.status IN ('booked', 'confirmed')
    ORDER BY b.start_date ASC`
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

async function updateProperty({
  id,
  name,
  code,
  type,
  rooms,
  priceDaily,
  priceMonthly,
  priceYearly,
  monthlyExpenses
}) {
  await query(
    `UPDATE properties
     SET name = $1, code = $2, type = $3, rooms = $4,
         price_daily = $5, price_monthly = $6, price_yearly = $7,
         monthly_expenses = $8
     WHERE id = $9`,
    [name, code, type, rooms, priceDaily, priceMonthly, priceYearly, monthlyExpenses, id]
  );
}

async function createProperty({
  code,
  name,
  type,
  rooms,
  priceDaily,
  priceMonthly,
  priceYearly,
  monthlyExpenses
}) {
  await query(
    `INSERT INTO properties (code, name, type, rooms, price_daily, price_monthly, price_yearly, monthly_expenses, photos, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, NOW())`,
    [code, name, type, rooms, priceDaily, priceMonthly, priceYearly, monthlyExpenses]
  );
}

async function setPropertyPhotos(id, photos) {
  await query(`UPDATE properties SET photos = $1::jsonb WHERE id = $2`, [JSON.stringify(photos), id]);
}

async function appendPropertyPhotos(id, photoUrls) {
  const row = await getPropertyById(id);
  if (!row) return;
  const next = [...parsePhotosJson(row.photos), ...photoUrls];
  await setPropertyPhotos(id, next);
}

async function removePropertyPhoto(id, photoUrl) {
  const row = await getPropertyById(id);
  if (!row) return;
  const next = parsePhotosJson(row.photos).filter((p) => p !== photoUrl);
  await setPropertyPhotos(id, next);
}

async function deleteProperty(id) {
  await query("DELETE FROM properties WHERE id = $1", [id]);
}

async function updateSaleProbability(id, saleProbability) {
  await query("UPDATE properties SET sale_probability = $1 WHERE id = $2", [saleProbability, id]);
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

async function createBooking({
  propertyId,
  clientName,
  staffName,
  startDate,
  endDate,
  status,
  amountPaid
}) {
  await query(
    `INSERT INTO bookings (property_id, client_name, staff_name, start_date, end_date, status, amount_paid, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [propertyId, clientName, staffName, startDate, endDate, status, amountPaid]
  );
}

async function updateBooking({
  bookingId,
  propertyId,
  clientName,
  staffName,
  startDate,
  endDate,
  status,
  amountPaid
}) {
  await query(
    `UPDATE bookings
     SET client_name = $1, staff_name = $2, start_date = $3, end_date = $4, status = $5, amount_paid = $6
     WHERE id = $7 AND property_id = $8`,
    [clientName, staffName, startDate, endDate, status, amountPaid, bookingId, propertyId]
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
      type TEXT NOT NULL CHECK (type IN ('apartment', 'duplex', 'villa')),
      rooms INTEGER NOT NULL DEFAULT 1,
      price_daily NUMERIC(12, 2) NOT NULL DEFAULT 0,
      price_monthly NUMERIC(12, 2) NOT NULL DEFAULT 0,
      price_yearly NUMERIC(12, 2) NOT NULL DEFAULT 0,
      monthly_expenses NUMERIC(12, 2) NOT NULL DEFAULT 0,
      photos JSONB NOT NULL DEFAULT '[]'::jsonb,
      sale_probability INTEGER NOT NULL DEFAULT 50 CHECK (sale_probability >= 0 AND sale_probability <= 100),
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
      amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Older DBs may have been created without created_at; add before ALTER.
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'created_at'
      ) THEN
        ALTER TABLE properties ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT NOW();
      END IF;
    END
    $$;
  `);
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'created_at'
      ) THEN
        ALTER TABLE bookings ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT NOW();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'amount_paid'
      ) THEN
        ALTER TABLE bookings ADD COLUMN amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0;
      END IF;
    END
    $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'rooms'
      ) THEN
        ALTER TABLE properties ADD COLUMN rooms INTEGER NOT NULL DEFAULT 1;
      END IF;
    END
    $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'price_daily'
      ) THEN
        ALTER TABLE properties ADD COLUMN price_daily NUMERIC(12, 2) NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'price_monthly'
      ) THEN
        ALTER TABLE properties ADD COLUMN price_monthly NUMERIC(12, 2) NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'price_yearly'
      ) THEN
        ALTER TABLE properties ADD COLUMN price_yearly NUMERIC(12, 2) NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'monthly_expenses'
      ) THEN
        ALTER TABLE properties ADD COLUMN monthly_expenses NUMERIC(12, 2) NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'photos'
      ) THEN
        ALTER TABLE properties ADD COLUMN photos JSONB NOT NULL DEFAULT '[]'::jsonb;
      END IF;
    END
    $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'sale_probability'
      ) THEN
        ALTER TABLE properties ADD COLUMN sale_probability INTEGER NOT NULL DEFAULT 50;
      END IF;
    END
    $$;
  `);
  await query(`
    UPDATE properties
    SET sale_probability = LEAST(100, GREATEST(0, COALESCE(sale_probability, 50)))
    WHERE sale_probability IS NULL OR sale_probability < 0 OR sale_probability > 100
  `);
  await query(`ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_sale_probability_check`);
  await query(
    `ALTER TABLE properties ADD CONSTRAINT properties_sale_probability_check
     CHECK (sale_probability >= 0 AND sale_probability <= 100)`
  );

  await query("ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_type_check");
  await query("UPDATE properties SET type = 'apartment' WHERE type = 'house'");
  await query(
    "ALTER TABLE properties ADD CONSTRAINT properties_type_check CHECK (type IN ('apartment', 'duplex', 'villa'))"
  );

  await query(
    "ALTER TABLE properties ALTER COLUMN created_at TYPE TIMESTAMP USING created_at::timestamp"
  );
  await query("ALTER TABLE properties ALTER COLUMN created_at SET DEFAULT NOW()");
  await query("ALTER TABLE bookings ALTER COLUMN start_date TYPE TIMESTAMP USING start_date::timestamp");
  await query("ALTER TABLE bookings ALTER COLUMN end_date TYPE TIMESTAMP USING end_date::timestamp");
  await query("ALTER TABLE bookings ALTER COLUMN created_at SET DEFAULT NOW()");

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
      `INSERT INTO properties (code, name, type, rooms, price_daily, price_monthly, price_yearly, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [127, "دوبلكس الزملاك جنينة الأسماك", "duplex", 5, 2500, 45000, 480000, now]
    );
    const p2 = await query(
      `INSERT INTO properties (code, name, type, rooms, price_daily, price_monthly, price_yearly, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [124, "دوبلكس ايستاون H1-34-23 التجمع الخامس", "duplex", 4, 2200, 40000, 420000, now]
    );
    await query(
      `INSERT INTO properties (code, name, type, rooms, price_daily, price_monthly, price_yearly, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [130, "فيلا مستقلة - الشيخ زايد", "villa", 6, 5000, 90000, 950000, now]
    );

    await createBooking({
      propertyId: p1.rows[0].id,
      clientName: "مهران",
      staffName: "مهران",
      startDate: "2026-04-23",
      endDate: "2026-04-27",
      status: "confirmed",
      amountPaid: 10000
    });
    await createBooking({
      propertyId: p2.rows[0].id,
      clientName: "محمد سمير",
      staffName: "محمد سمير",
      startDate: "2026-04-09",
      endDate: "2026-04-23",
      status: "confirmed",
      amountPaid: 30800
    });
  }
}

module.exports = {
  pool,
  query,
  bootstrapDatabase,
  getUserByEmail,
  getPropertiesList,
  getActiveBookingsForAvailability,
  getAllBookingsForStats,
  getPropertyById,
  getBookingsByPropertyId,
  updateProperty,
  createProperty,
  deleteProperty,
  setPropertyPhotos,
  appendPropertyPhotos,
  removePropertyPhoto,
  updateSaleProbability,
  findOverlappingBooking,
  createBooking,
  updateBooking
};
