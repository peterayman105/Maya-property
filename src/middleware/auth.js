function requireAuth(req, res, next) {
  if (!req.session.user) {
    const lang = req.query.lang === "en" ? "en" : "ar";
    return res.redirect(`/login?lang=${lang}`);
  }
  return next();
}

module.exports = { requireAuth };
