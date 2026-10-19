// Security (L1, 2026-10-19 audit / EXPRESS-ERROR-001): helpers for turning
// caught exceptions into text that is safe to send to API clients.
//
// Raw library errors (fs, sharp, puppeteer, parsers) routinely embed absolute
// server paths, temp directories and multi-line internals. Route handlers
// used to interpolate e.message straight into JSON responses. These helpers
// keep the useful part of the message (the apiMessageCodes middleware and the
// UI surface "Error processing X: <detail>") while never disclosing paths or
// stack text.

const DETAIL_MAX_LENGTH = 200;
const DEFAULT_DETAIL = "Unexpected error";

// absolute POSIX paths (preceded by start, whitespace, a quote, paren, = or ,)
// and Windows drive paths, plus file:// URLs
const POSIX_PATH_PATTERN = /(^|[\s'"(=,])\/(?!\/)[^\s'"(),]+/g;
const WINDOWS_PATH_PATTERN = /(^|[\s'"(=,])[A-Za-z]:\\[^\s'"(),]*/g;
const FILE_URL_PATTERN = /file:\/\/[^\s'"(),]+/gi;

/**
 * Only surface messages from intentional status errors (createStatusError
 * style: an Error carrying a .status). Anything else gets the fallback.
 * Used where a fixed, translated-by-the-UI message is preferred.
 */
function resolveClientFacingErrorMessage(err, fallback) {
  if (err && err.status && err.message) {
    return err.message;
  }
  return fallback;
}

/**
 * Client-safe version of err.message for "<prefix>: <detail>" responses.
 * Intentional status errors pass through unchanged; other messages are cut to
 * their first line, have absolute filesystem paths replaced with "[path]",
 * and are truncated. Returns `fallback` when there is no usable message.
 */
function clientSafeErrorDetail(err, fallback = DEFAULT_DETAIL) {
  if (
    err &&
    err.status &&
    typeof err.message === "string" &&
    err.message !== ""
  ) {
    return err.message;
  }
  let message = "";
  if (err && typeof err.message === "string") {
    message = err.message;
  } else if (typeof err === "string") {
    message = err;
  }
  message = message.split(/\r?\n/)[0].trim();
  if (message === "") {
    return fallback;
  }
  message = message
    .replace(FILE_URL_PATTERN, "[path]")
    .replace(POSIX_PATH_PATTERN, "$1[path]")
    .replace(WINDOWS_PATH_PATTERN, "$1[path]");
  if (message.length > DETAIL_MAX_LENGTH) {
    message = message.substring(0, DETAIL_MAX_LENGTH) + "…";
  }
  return message;
}

module.exports = {
  resolveClientFacingErrorMessage,
  clientSafeErrorDetail,
};
