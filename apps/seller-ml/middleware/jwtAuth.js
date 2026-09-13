'use strict';

const jwt = require('jsonwebtoken');

function ensureAuthApi(req, res, next) {
  try {
    const token = req.cookies?.auth_token;
    if (!token) return res.status(401).json({ ok: false, error: 'Não autenticado.' });

    const payload = jwt.verify(token, (process.env.ML_JWT_SECRET || process.env.JWT_SECRET));
    req.user = payload; // { uid, email, nivel, nome }
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Sessão inválida. Faça login novamente.' });
  }
}

function ensureAdmin(req, res, next) {
  const u = req.user;
  if (u && String(u.nivel) === 'administrador') return next();
  return res.status(403).json({ ok: false, error: 'Acesso não autorizado.' });
}

module.exports = { ensureAuthApi, ensureAdmin };
