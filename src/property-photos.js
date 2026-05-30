"use strict";

const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadsRoot = path.join(__dirname, "public", "uploads", "properties");
const MAX_PROPERTY_PHOTOS = 50;
const MAX_UPLOAD_BATCH = 50;

function parsePhotosJson(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function propertyUploadDir(propertyId) {
  return path.join(uploadsRoot, String(propertyId));
}

function ensureUploadDir(propertyId) {
  fs.mkdirSync(propertyUploadDir(propertyId), { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      try {
        ensureUploadDir(req.params.id);
        cb(null, propertyUploadDir(req.params.id));
      } catch (err) {
        cb(err);
      }
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
      const base = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `${base}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: MAX_UPLOAD_BATCH },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, GIF, or WebP images are allowed."));
  }
});

function publicUrl(propertyId, filename) {
  return `/uploads/properties/${propertyId}/${filename}`;
}

function deletePhotoFile(photoUrl) {
  if (!photoUrl || !photoUrl.startsWith("/uploads/properties/")) return;
  const rel = photoUrl.replace(/^\/uploads\/properties\//, "");
  const abs = path.join(uploadsRoot, rel);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}

function deletePropertyUploads(propertyId) {
  const dir = propertyUploadDir(propertyId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  upload,
  parsePhotosJson,
  publicUrl,
  deletePhotoFile,
  deletePropertyUploads,
  uploadsRoot,
  MAX_PROPERTY_PHOTOS,
  MAX_UPLOAD_BATCH
};
