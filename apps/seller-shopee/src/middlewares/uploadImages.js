const multer = require("multer");

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png"].includes(file.mimetype);
    cb(ok ? null : new Error("Apenas JPEG/PNG"), ok);
  },
}).array("images", 3);
