const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../config/db");

const router = express.Router();

router.get("/login", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  if (req.session.user) {
    return res.redirect(`/?lang=${lang}`);
  }
  return res.render("login", { title: "Maya's Property", error: null, lang });
});

router.post("/login", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const error = lang === "en" ? "Invalid login credentials." : "Invalid login credentials.";
    return res.status(401).render("login", {
      title: "Maya's Property",
      error,
      lang
    });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  return res.redirect(`/?lang=${lang}`);
});

router.post("/logout", (req, res) => {
  const lang = req.query.lang === "en" ? "en" : "ar";
  req.session.destroy(() => res.redirect(`/login?lang=${lang}`));
});

module.exports = router;
