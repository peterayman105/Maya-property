const express = require("express");
const { db } = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const properties = db
    .prepare(
      `SELECT
        p.id, p.code, p.name, p.type, p.created_at,
        COUNT(CASE WHEN b.status IN ('booked', 'confirmed') THEN 1 END) AS booked_count
      FROM properties p
      LEFT JOIN bookings b ON b.property_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC`
    )
    .all();

  return res.render("index", {
    title: "Maya's Property",
    lang,
    user: req.session.user || { name: "زائر" },
    properties
  });
});

router.get("/properties/:id", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(req.params.id);
  if (!property) return res.status(404).send("الوحدة غير موجودة.");

  const bookings = db
    .prepare("SELECT * FROM bookings WHERE property_id = ? ORDER BY start_date DESC")
    .all(req.params.id);

  return res.render("property-details", {
    title: "Maya's Property",
    lang,
    user: req.session.user || null,
    property,
    bookings
  });
});

router.post("/properties/:id", requireAuth, (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { name, code, type } = req.body;
  db.prepare("UPDATE properties SET name = ?, code = ?, type = ? WHERE id = ?").run(
    name,
    Number(code),
    type,
    Number(req.params.id)
  );
  return res.redirect(`/properties/${req.params.id}?lang=${lang}`);
});

router.post("/properties/:id/bookings", requireAuth, (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { client_name, staff_name, start_date, end_date, status } = req.body;
  db.prepare(
    "INSERT INTO bookings (property_id, client_name, staff_name, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(req.params.id, client_name, staff_name, start_date, end_date, status);

  return res.redirect(`/properties/${req.params.id}?lang=${lang}`);
});

module.exports = router;
