const express = require("express");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const {
  pool,
  bootstrapDatabase,
  getUserByEmail,
  getPropertiesList,
  getActiveBookingsForAvailability,
  getPropertyById,
  getBookingsByPropertyId,
  updateProperty,
  createProperty,
  deleteProperty,
  appendPropertyPhotos,
  removePropertyPhoto,
  getAllBookingsForStats,
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
const { attachAvailabilityToProperties, computeUnitAvailability } = require("./availability");
const { buildSalesDashboard } = require("./sales-statistics");
const { typeLabel, formatPrice } = require("./view-helpers");
const {
  upload: photoUpload,
  parsePhotosJson,
  publicUrl,
  deletePhotoFile,
  deletePropertyUploads,
  MAX_PROPERTY_PHOTOS,
  MAX_UPLOAD_BATCH
} = require("./property-photos");

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
    status: String(body.status ?? "").trim().toLowerCase(),
    amount_paid: String(body.amount_paid ?? "").trim()
  };
}

function parseAmountPaid(raw, lang) {
  const isEn = lang === "en";
  const n = Number(String(raw ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) {
    return { error: isEn ? "Enter a valid amount paid (0 or more)." : "أدخل مبلغاً مدفوعاً صحيحاً (0 أو أكثر)." };
  }
  return { amountPaid: Math.round(n * 100) / 100 };
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

function validateBookingAmount(b, lang) {
  const isEn = lang === "en";
  const parsed = parseAmountPaid(b.amount_paid, lang);
  if (parsed.error) return parsed.error;
  if (b.status !== "cancelled" && parsed.amountPaid <= 0) {
    return isEn ? "Amount paid is required for active bookings." : "المبلغ المدفوع مطلوب للحجوزات النشطة.";
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

function parsePricesField(body, lang) {
  const isEn = lang === "en";
  const daily = Number(body.price_daily);
  const monthly = Number(body.price_monthly);
  const yearly = Number(body.price_yearly);
  if (![daily, monthly, yearly].every((n) => Number.isFinite(n) && n >= 0)) {
    return { error: isEn ? "Enter valid prices (0 or more)." : "أدخل أسعاراً صحيحة (0 أو أكثر)." };
  }
  return { priceDaily: daily, priceMonthly: monthly, priceYearly: yearly };
}

function parseExpensesField(body, lang) {
  const isEn = lang === "en";
  const n = Number(body.monthly_expenses);
  if (!Number.isFinite(n) || n < 0) {
    return { error: isEn ? "Enter valid monthly expenses (0 or more)." : "أدخل مصروفات شهرية صحيحة (0 أو أكثر)." };
  }
  return { monthlyExpenses: n };
}

function enrichProperty(property) {
  if (!property) return null;
  return {
    ...property,
    photos: parsePhotosJson(property.photos),
    monthly_expenses: Number(property.monthly_expenses) || 0
  };
}

function viewHelpers(lang) {
  return {
    typeLabel: (t) => typeLabel(t, lang),
    formatPrice: (n) => formatPrice(n, lang)
  };
}

async function hasBookingOverlap({ propertyId, startDate, endDate, excludeBookingId = null }) {
  return findOverlappingBooking({ propertyId, startDate, endDate, excludeBookingId });
}

function readViewSource(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buf.length >= 4 && buf[0] === 0x3c && buf[1] === 0x00) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

ejs.fileLoader = readViewSource;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/assets", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
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

app.get("/accounts", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const properties = await getPropertiesList();
  const allBookings = await getAllBookingsForStats();
  const { rows, summary } = buildSalesDashboard(properties, allBookings, lang);
  const selectedUnitId = parsePropertyIdParam(req.query.unit);
  const selectedRow = selectedUnitId ? rows.find((r) => r.id === selectedUnitId) || null : null;

  return res.render("accounts", {
    title: "Maya's Property — Accounts",
    lang,
    user: req.session.user,
    rows,
    summary,
    selectedUnitId,
    selectedRow,
    h: viewHelpers(lang)
  });
});

app.get("/", async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const error = req.query.error || "";
  const success = req.query.success || "";
  const rows = await getPropertiesList();
  const bookingRows = await getActiveBookingsForAvailability();
  const properties = attachAvailabilityToProperties(rows, bookingRows, lang).map((p) => enrichProperty(p));

  return res.render("index", {
    title: "Maya's Property",
    lang,
    user: req.session.user || null,
    properties,
    error,
    success,
    h: viewHelpers(lang)
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

  const pricesParsed = parsePricesField(req.body, lang);
  if (pricesParsed.error) {
    return res.redirect(`/?lang=${lang}&error=${encodeURIComponent(pricesParsed.error)}`);
  }

  const expensesParsed = parseExpensesField(req.body, lang);
  if (expensesParsed.error) {
    return res.redirect(`/?lang=${lang}&error=${encodeURIComponent(expensesParsed.error)}`);
  }

  try {
    await createProperty({
      name,
      code: Number(code),
      type,
      rooms: roomsParsed.rooms,
      priceDaily: pricesParsed.priceDaily,
      priceMonthly: pricesParsed.priceMonthly,
      priceYearly: pricesParsed.priceYearly,
      monthlyExpenses: expensesParsed.monthlyExpenses
    });
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
  const property = enrichProperty(await getPropertyById(Number(req.params.id)));
  if (!property) return res.status(404).send("Unit not found.");

  const bookings = await getBookingsByPropertyId(Number(req.params.id));
  const availability = computeUnitAvailability(bookings, lang);

  return res.render("property-details", {
    title: "Maya's Property",
    lang,
    user: req.session.user || null,
    property,
    bookings,
    availability,
    error,
    success,
    maxPhotos: MAX_PROPERTY_PHOTOS,
    h: viewHelpers(lang)
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

  const pricesParsed = parsePricesField(req.body, lang);
  if (pricesParsed.error) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(pricesParsed.error)}`
    );
  }

  const expensesParsed = parseExpensesField(req.body, lang);
  if (expensesParsed.error) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(expensesParsed.error)}`
    );
  }

  try {
    await updateProperty({
      id: Number(req.params.id),
      name,
      code: Number(code),
      type,
      rooms: roomsParsed.rooms,
      priceDaily: pricesParsed.priceDaily,
      priceMonthly: pricesParsed.priceMonthly,
      priceYearly: pricesParsed.priceYearly,
      monthlyExpenses: expensesParsed.monthlyExpenses
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
  const propertyId = Number(req.params.id);
  deletePropertyUploads(propertyId);
  await deleteProperty(propertyId);
  return res.redirect(
    `/?lang=${lang}&success=${encodeURIComponent(
      lang === "en" ? "Unit deleted." : "تم حذف الوحدة."
    )}`
  );
});

app.post("/properties/:id/photos", requireAuth, (req, res, next) => {
  photoUpload.array("photos", MAX_UPLOAD_BATCH)(req, res, (err) => {
    if (err) {
      const lang = req.query.lang === "en" ? "en" : "ar";
      const propertyId = parsePropertyIdParam(req.params.id) || req.params.id;
      const msg =
        lang === "en"
          ? err.message || "Could not upload photos."
          : "تعذر رفع الصور.";
      return res.redirect(`/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(msg)}`);
    }
    next();
  });
}, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const propertyId = parsePropertyIdParam(req.params.id);
  if (!propertyId) return res.status(400).send("Bad request");

  const property = await getPropertyById(propertyId);
  if (!property) return res.status(404).send("Unit not found.");

  const files = req.files || [];
  if (!files.length) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Choose at least one image to upload." : "اختر صورة واحدة على الأقل للرفع."
      )}`
    );
  }

  const existing = parsePhotosJson(property.photos);
  const slotsLeft = MAX_PROPERTY_PHOTOS - existing.length;
  if (slotsLeft <= 0) {
    files.forEach((f) => deletePhotoFile(publicUrl(propertyId, f.filename)));
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
        lang === "en"
          ? `This unit already has ${MAX_PROPERTY_PHOTOS} photos. Remove some first.`
          : `هذه الوحدة لديها ${MAX_PROPERTY_PHOTOS} صورة بالفعل. احذف بعضاً أولاً.`
      )}`
    );
  }

  const accepted = files.slice(0, slotsLeft);
  const overflow = files.slice(slotsLeft);
  overflow.forEach((f) => deletePhotoFile(publicUrl(propertyId, f.filename)));

  try {
    const urls = accepted.map((f) => publicUrl(propertyId, f.filename));
    await appendPropertyPhotos(propertyId, urls);
    let successMsg = lang === "en" ? `${urls.length} photo(s) uploaded.` : `تم رفع ${urls.length} صورة.`;
    if (overflow.length) {
      successMsg +=
        lang === "en"
          ? ` (${overflow.length} skipped — max ${MAX_PROPERTY_PHOTOS} per unit.)`
          : ` (تم تخطي ${overflow.length} — الحد ${MAX_PROPERTY_PHOTOS} لكل وحدة.)`;
    }
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&success=${encodeURIComponent(successMsg)}`
    );
  } catch (err) {
    console.error("Photo upload failed:", err);
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Could not upload photos." : "تعذر رفع الصور."
      )}`
    );
  }
});

app.post("/properties/:id/photos/delete", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const propertyId = parsePropertyIdParam(req.params.id);
  const photoUrl = String(req.body.photo_url ?? "").trim();
  if (!propertyId || !photoUrl.startsWith(`/uploads/properties/${propertyId}/`)) {
    return res.status(400).send("Bad request");
  }

  try {
    deletePhotoFile(photoUrl);
    await removePropertyPhoto(propertyId, photoUrl);
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&success=${encodeURIComponent(
        lang === "en" ? "Photo removed." : "تم حذف الصورة."
      )}`
    );
  } catch (err) {
    console.error("Photo delete failed:", err);
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Could not remove photo." : "تعذر حذف الصورة."
      )}`
    );
  }
});

app.post("/properties/:id/bookings", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const propertyId = parsePropertyIdParam(req.params.id);
  if (!propertyId) {
    return res.status(400).send("Bad request");
  }

  const b = parseBookingBody(req.body);
  const fieldError = validateBookingFields(b, lang) || validateBookingAmount(b, lang);
  if (fieldError) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(fieldError)}`
    );
  }
  const { amountPaid } = parseAmountPaid(b.amount_paid, lang);

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
      status: b.status,
      amountPaid
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
  const fieldError = validateBookingFields(b, lang) || validateBookingAmount(b, lang);
  if (fieldError) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(fieldError)}`
    );
  }
  const { amountPaid } = parseAmountPaid(b.amount_paid, lang);

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
      status: b.status,
      amountPaid
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
