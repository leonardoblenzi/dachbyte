function createError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function notFound(message, code) {
  return createError(message, 404, code);
}

function badRequest(message, code) {
  return createError(message, 400, code);
}

module.exports = {
  badRequest,
  createError,
  notFound,
};
