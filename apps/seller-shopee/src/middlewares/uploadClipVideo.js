const multer = require("multer");

function isValidMp4(file = {}) {
  const mime = String(file.mimetype || "").toLowerCase();
  const name = String(file.originalname || "").toLowerCase();
  return mime === "video/mp4" || mime === "application/mp4" || name.endsWith(".mp4");
}

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = isValidMp4(file);
    cb(ok ? null : new Error("Apenas video MP4 (max 30MB)"), ok);
  },
}).single("video");

