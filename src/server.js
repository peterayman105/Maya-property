const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const {
  pool,
  bootstrapDatabase,
  getUserByEmail,
  getPropertiesWithBookingCount,
  getPropertyById,
  getBookingsByPropertyId,
  updateProperty,
  createProperty,
  deleteProperty,
  findOverlappingBooking,
  createBooking,
  updateBooking
} = require("./config/db");
const { requireAuth } = require("./middleware/auth");
const {
  datetimeLocalToPgTimestamp,
  isValidPgBookingInput,
  bookingRangeOrderOk
} = require("./booking-time");

const app = express();
const PORT = process.env.PORT || 3000;

const PROPERTY_TYPES = new Set(["apartment", "duplex", "villa"]);
const BOOKING_STATUSES = new Set(["booked", "confirmed", "cancelled"]);

function parsePropertyIdParam(param) {
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseBookingBody(body) {
  return {
    client_name: String(body.client_name ?? "").trim(),
    staff_name: String(body.staff_name ?? "").trim(),
    start_date: String(body.start_date ?? "").trim(),
    end_date: String(body.end_date ?? "").trim(),
    status: String(body.status ?? "").trim().toLowerCase()
  };
}

function validateBookingFields(b, lang) {
  const isEn = lang === "en";
  if (!b.client_name || !b.staff_name) {
    return isEn ? "Client and staff names are required." : "اسم العميل وموظف الاستقبال مطلوبان.";
  }
  if (!BOOKING_STATUSES.has(b.status)) {
    return isEn ? "Pick a valid booking status." : "اختر حالة حجز صالحة.";
  }
  if (!isValidPgBookingInput(b.start_date) || !isValidPgBookingInput(b.end_date)) {
    return isEn ? "Start and end must be valid dates." : "أدخل تاريخي بدء وانتهاء صالحين.";
  }
  let startStr;
  let endStr;
  try {
    startStr = datetimeLocalToPgTimestamp(b.start_date);
    endStr = datetimeLocalToPgTimestamp(b.end_date);
  } catch {
    return isEn ? "Start and end must be valid dates." : "أدخل تاريخي بدء وانتهاء صالحين.";
  }
  if (!bookingRangeOrderOk(startStr, endStr)) {
    return isEn ? "End must be after start." : "يجب أن يكون الانتهاء بعد البدء.";
  }
  return null;
}

function bookingTimesForDb(b) {
  return {
    start: datetimeLocalToPgTimestamp(b.start_date),
    end: datetimeLocalToPgTimestamp(b.end_date)
  };
}

function parseRoomsField(raw, lang) {
  const v = String(raw ?? "").trim();
  const n = Number(v === "" ? "1" : v);
  const isEn = lang === "en";
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    return {
      error: isEn ? "Rooms must be a whole number from 1 to 500." : "عدد الغرف رقم صحيح من 1 إلى 500."
    };
  }
  return { rooms: n };
}

async function hasBookingOverlap({ propertyId, startDate, endDate, excludeBookingId = null }) {
  return findOverlappingBooking({ propertyId, startDate, endDate, excludeBookingId });
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/assets", express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "replace-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      httpOnly: true
    }
  })
);

app.get("/login", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  if (req.session.user) return res.redirect(`/?lang=${lang}`);
  return res.render("login", { title: "Maya's Property", error: null, lang });
});

app.post("/login", async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { email, password } = req.body;
  const user = await getUserByEmail(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render("login", {
      title: "Maya's Property",
      error: lang === "en" ? "Invalid login credentials." : "Invalid login credentials.",
      lang
    });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  return res.redirect(`/?lang=${lang}`);
});

app.post("/logout", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  req.session.destroy(() => res.redirect(`/login?lang=${lang}`));
});

app.get("/", async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const error = req.query.error || "";
  const success = req.query.success || "";
  const properties = await getPropertiesWithBookingCount();

  return res.render("index", {
    title: "Maya's Property",
    lang,
    user: req.session.user || null,
    properties,
    error,
    success
  });
});

app.post("/properties", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { name, code, type } = req.body;

  if (!name || code === undefined || code === "" || !type || !PROPERTY_TYPES.has(type)) {
    return res.redirect(
      `/?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Fill name, apartment number, and unit type." : "أدخل الاسم ورقم الشقه ونوع الوحدة."
      )}`
    );
  }

  if (!Number.isFinite(Number(code))) {
    return res.redirect(
      `/?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Apartment number must be a valid number." : "رقم الشقه يجب أن يكون رقماً صحيحاً."
      )}`
    );
  }

  const roomsParsed = parseRoomsField(req.body.rooms, lang);
  if (roomsParsed.error) {
    return res.redirect(`/?lang=${lang}&error=${encodeURIComponent(roomsParsed.error)}`);
  }

  try {
    await createProperty({ name, code: Number(code), type, rooms: roomsParsed.rooms });
    return res.redirect(
      `/?lang=${lang}&success=${encodeURIComponent(
        lang === "en" ? "New unit added successfully." : "تمت إضافة الوحدة بنجاح."
      )}`
    );
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return res.redirect(
        `/?lang=${lang}&error=${encodeURIComponent(
          lang === "en" ? "That apartment number is already used." : "رقم الشقه مستخدم مسبقاً."
        )}`
      );
    }
    return res.redirect(
      `/?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Failed to add unit." : "فشل إضافة الوحدة."
      )}`
    );
  }
});

app.get("/properties/:id", async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const error = req.query.error || "";
  const success = req.query.success || "";
  const property = await getPropertyById(Number(req.params.id));
  if (!property) return res.status(404).send("Unit not found.");

  const bookings = await getBookingsByPropertyId(Number(req.params.id));

  return res.render("property-details", {
    title: "Maya's Property",
    lang,
    user: req.session.user || null,
    property,
    bookings,
    error,
    success
  });
});

app.post("/properties/:id", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { name, code, type } = req.body;
  if (!name || code === undefined || code === "" || !type || !PROPERTY_TYPES.has(type)) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Check name, apartment number, and type." : "تحقق من الاسم ورقم الشقه والنوع."
      )}`
    );
  }
  if (!Number.isFinite(Number(code))) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Apartment number must be a valid number." : "رقم الشقه يجب أن يكون رقماً صحيحاً."
      )}`
    );
  }

  const roomsParsed = parseRoomsField(req.body.rooms, lang);
  if (roomsParsed.error) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(roomsParsed.error)}`
    );
  }

  try {
    await updateProperty({
      id: Number(req.params.id),
      name,
      code: Number(code),
      type,
      rooms: roomsParsed.rooms
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return res.redirect(
        `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(
          lang === "en" ? "That apartment number is already used." : "رقم الشقه مستخدم مسبقاً."
        )}`
      );
    }
    throw error;
  }
  return res.redirect(`/properties/${req.params.id}?lang=${lang}`);
});

app.post("/properties/:id/delete", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  await deleteProperty(Number(req.params.id));
  return res.redirect(
    `/?lang=${lang}&success=${encodeURIComponent(
      lang === "en" ? "Unit deleted." : "تم حذف الوحدة."
    )}`
  );
});

app.post("/properties/:id/bookings", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const propertyId = parsePropertyIdParam(req.params.id);
  if (!propertyId) {
    return res.status(400).send("Bad request");
  }

  const b = parseBookingBody(req.body);
  const fieldError = validateBookingFields(b, lang);
  if (fieldError) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(fieldError)}`
    );
  }

  const { start: startStr, end: endStr } = bookingTimesForDb(b);

  try {
    const overlap = await hasBookingOverlap({
      propertyId,
      startDate: startStr,
      endDate: endStr
    });
    if (overlap) {
      return res.redirect(
        `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
          lang === "en"
            ? "Booking dates overlap with an existing booking."
            : "توجد مواعيد متداخلة مع حجز آخر."
        )}`
      );
    }

    await createBooking({
      propertyId,
      clientName: b.client_name,
      staffName: b.staff_name,
      startDate: startStr,
      endDate: endStr,
      status: b.status
    });
  } catch (err) {
    console.error("Create booking failed:", err && err.stack ? err.stack : err);
    const isEn = lang === "en";
    let msg = isEn
      ? "Could not save the booking. Check dates and try again."
      : "تعذر حفظ الحجز. تحقق من التواريخ وحاول مرة أخرى.";
    if (err && err.code === "22007") {
      msg = isEn ? "Invalid date or time." : "تاريخ أو وقت غير صالح.";
    }
    if (err && err.code === "23514") {
      msg = isEn ? "Booking data did not pass validation." : "بيانات الحجز لم تجتز التحقق.";
    }
    if (
      err &&
      (err.code === "42P05" ||
        err.code === "26000" ||
        err.code === "08P01" ||
        /prepared statement/i.test(String(err.message || "")))
    ) {
      msg = isEn
        ? "Database pool error: use Supabase Session mode or Direct connection (port 5432), not Transaction pooler (6543), in DATABASE_URL."
        : "خطأ في اتصال قاعدة البيانات: استخدم وضع Session أو الاتصال المباشر (5432) في رابط Supabase وليس Transaction pooler (6543).";
    }
    if (process.env.NODE_ENV !== "production" && err && err.message) {
      msg += ` [${err.code || "err"}]`;
    }
    return res.redirect(`/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(msg)}`);
  }

  return res.redirect(
    `/properties/${propertyId}?lang=${lang}&success=${encodeURIComponent(
      lang === "en" ? "Booking added successfully." : "تمت إضافة الحجز بنجاح."
    )}`
  );
});

app.post("/properties/:id/bookings/:bookingId", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const bookingId = Number(req.params.bookingId);
  const propertyId = parsePropertyIdParam(req.params.id);
  if (!propertyId || !Number.isInteger(bookingId) || bookingId < 1) {
    return res.status(400).send("Bad request");
  }

  const b = parseBookingBody(req.body);
  const fieldError = validateBookingFields(b, lang);
  if (fieldError) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(fieldError)}`
    );
  }

  const { start: startStr, end: endStr } = bookingTimesForDb(b);

  try {
    const overlap = await hasBookingOverlap({
      propertyId,
      startDate: startStr,
      endDate: endStr,
      excludeBookingId: bookingId
    });
    if (overlap) {
      return res.redirect(
        `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
          lang === "en"
            ? "Booking dates overlap with an existing booking."
            : "توجد مواعيد متداخلة مع حجز آخر."
        )}`
      );
    }

    await updateBooking({
      bookingId,
      propertyId,
      clientName: b.client_name,
      staffName: b.staff_name,
      startDate: startStr,
      endDate: endStr,
      status: b.status
    });
  } catch (err) {
    console.error("Update booking failed:", err && err.stack ? err.stack : err);
    const isEn = lang === "en";
    let msg = isEn
      ? "Could not update the booking. Check dates and try again."
      : "تعذر تحديث الحجز. تحقق من التواريخ وحاول مرة أخرى.";
    if (err && err.code === "22007") {
      msg = isEn ? "Invalid date or time." : "تاريخ أو وقت غير صالح.";
    }
    if (err && err.code === "23514") {
      msg = isEn ? "Booking data did not pass validation." : "بيانات الحجز لم تجتز التحقق.";
    }
    if (
      err &&
      (err.code === "42P05" ||
        err.code === "26000" ||
        err.code === "08P01" ||
        /prepared statement/i.test(String(err.message || "")))
    ) {
      msg = isEn
        ? "Database pool error: use Supabase Session mode or Direct connection (port 5432), not Transaction pooler (6543), in DATABASE_URL."
        : "خطأ في اتصال قاعدة البيانات: استخدم وضع Session أو الاتصال المباشر (5432) في رابط Supabase وليس Transaction pooler (6543).";
    }
    if (process.env.NODE_ENV !== "production" && err && err.message) {
      msg += ` [${err.code || "err"}]`;
    }
    return res.redirect(`/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(msg)}`);
  }

  return res.redirect(
    `/properties/${propertyId}?lang=${lang}&success=${encodeURIComponent(
      lang === "en" ? "Booking updated successfully." : "تم تحديث الحجز بنجاح."
    )}`
  );
});

async function startServer() {
  await bootstrapDatabase();
  app.listen(PORT, () => {
    console.log(`Maya's Property running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
