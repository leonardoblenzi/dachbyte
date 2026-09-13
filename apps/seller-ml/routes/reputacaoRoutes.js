"use strict";

const express = require("express");
const ReputacaoController = require("../controllers/ReputacaoController");

const router = express.Router();

router.get("/overview", ReputacaoController.overview);

module.exports = router;
