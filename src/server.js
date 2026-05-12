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

const app = express();
const PORT = process.env.PORT || 3000;

const PROPERTY_TYPES = new Set(["apartment", "duplex", "villa"]);

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

  try {
    await createProperty({ name, code: Number(code), type });
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
  try {
    await updateProperty({ id: Number(req.params.id), name, code: Number(code), type });
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
  const { client_name, staff_name, start_date, end_date, status } = req.body;
  if (!start_date || !end_date || start_date > end_date) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Invalid booking date range." : "نطاق التواريخ غير صالح."
      )}`
    );
  }

  const overlap = await hasBookingOverlap({
    propertyId: Number(req.params.id),
    startDate: start_date,
    endDate: end_date
  });
  if (overlap) {
    return res.redirect(
      `/properties/${req.params.id}?lang=${lang}&error=${encodeURIComponent(
        lang === "en"
          ? "Booking dates overlap with an existing booking."
          : "توجد مواعيد متداخلة مع حجز آخر."
      )}`
    );
  }

  await createBooking({
    propertyId: Number(req.params.id),
    clientName: client_name,
    staffName: staff_name,
    startDate: start_date,
    endDate: end_date,
    status
  });
  return res.redirect(
    `/properties/${req.params.id}?lang=${lang}&success=${encodeURIComponent(
      lang === "en" ? "Booking added successfully." : "تمت إضافة الحجز بنجاح."
    )}`
  );
});

app.post("/properties/:id/bookings/:bookingId", requireAuth, async (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { client_name, staff_name, start_date, end_date, status } = req.body;
  const bookingId = Number(req.params.bookingId);
  const propertyId = Number(req.params.id);

  if (!start_date || !end_date || start_date > end_date) {
    return res.redirect(
      `/properties/${propertyId}?lang=${lang}&error=${encodeURIComponent(
        lang === "en" ? "Invalid booking date range." : "نطاق التواريخ غير صالح."
      )}`
    );
  }

  const overlap = await hasBookingOverlap({
    propertyId,
    startDate: start_date,
    endDate: end_date,
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
    clientName: client_name,
    staffName: staff_name,
    startDate: start_date,
    endDate: end_date,
    status
  });

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
