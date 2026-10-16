// Security (PR8-4): final express error handler.
//
// body-parser errors carry the full raw request body on err.body (and, for
// JSON parse failures, an excerpt of it in err.message). The previous handler
// console.error'd the whole error object, writing arbitrary client-supplied
// bodies (credentials, page content, tokens) to the server log, and answered
// with a generic 500. Body-parser failures are client errors: answer with the
// existing {status, message} JSON envelope and log only the error type plus a
// truncated message.

const BODY_ERROR_LOG_MESSAGE_MAX = 120;

// body-parser / raw-body error types and the status each maps to
const BODY_PARSER_ERROR_STATUS = {
  'entity.parse.failed': 400,
  'entity.verify.failed': 400,
  'request.aborted': 400,
  'request.size.invalid': 400,
  'entity.too.large': 413,
  'parameters.too.many': 413,
  'encoding.unsupported': 415,
  'charset.unsupported': 415,
};

const BODY_PARSER_ERROR_MESSAGE = {
  400: 'Malformed request body',
  413: 'Request body too large',
  415: 'Unsupported request body encoding',
};

function truncateForLog(value, max) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\x00-\x1f\x7f]+/g, ' ');
  if (text.length <= max) {
    return text;
  }
  return text.substring(0, max) + '…';
}

/**
 * Returns the HTTP status for a body-parser error, or 0 when err is not one.
 */
function bodyParserErrorStatus(err) {
  if (!err || typeof err !== 'object') {
    return 0;
  }
  if (typeof err.type === 'string' && Object.prototype.hasOwnProperty.call(BODY_PARSER_ERROR_STATUS, err.type)) {
    return BODY_PARSER_ERROR_STATUS[err.type];
  }
  // any other client error raised by the body parsers (http-errors with
  // expose=true and a body attached) with a 400/413 status
  const status = Number(err.status || err.statusCode);
  if (err.expose === true && Object.prototype.hasOwnProperty.call(err, 'body') && (status === 400 || status === 413)) {
    return status;
  }
  return 0;
}

function haxcmsErrorHandler(err, req, res, next) {
  if (err && err.code === 'ENOENT') {
    res.status(404).end();
    return;
  }
  // Security (HAX-SEC-004): return 413 for multer file-size/count limit errors
  // so the client gets a meaningful status instead of a generic 500.
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT')) {
    res.status(413).json({ status: 413, message: 'File too large or too many files' });
    return;
  }
  // Security (PR8-4): never log err.body (the raw request body).
  const bodyStatus = bodyParserErrorStatus(err);
  if (bodyStatus) {
    console.warn(
      'HAXcms: rejected request body (' +
      truncateForLog(err.type || 'unknown', 40) + '): ' +
      truncateForLog(err.message, BODY_ERROR_LOG_MESSAGE_MAX)
    );
    if (res.headersSent) {
      return;
    }
    res.status(bodyStatus).json({ status: bodyStatus, message: BODY_PARSER_ERROR_MESSAGE[bodyStatus] });
    return;
  }
  if (err && typeof err === 'object' && Object.prototype.hasOwnProperty.call(err, 'body')) {
    // unknown error that still carries a request body: log without it
    const safe = {};
    for (const key of ['name', 'message', 'type', 'status', 'statusCode', 'code', 'stack']) {
      if (err[key] !== undefined) {
        safe[key] = key === 'message' ? truncateForLog(err[key], BODY_ERROR_LOG_MESSAGE_MAX) : err[key];
      }
    }
    console.error(safe);
  }
  else {
    console.error(err);
  }
  res.status(500).send('Server error');
}

module.exports = {
  haxcmsErrorHandler,
  bodyParserErrorStatus,
  BODY_PARSER_ERROR_STATUS,
  BODY_ERROR_LOG_MESSAGE_MAX,
};
