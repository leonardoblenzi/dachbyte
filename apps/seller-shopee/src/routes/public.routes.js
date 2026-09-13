const express = require("express");
const router = express.Router();

router.get("/auth/login", (req, res) => res.redirect("/shopee/login"));

module.exports = router;
