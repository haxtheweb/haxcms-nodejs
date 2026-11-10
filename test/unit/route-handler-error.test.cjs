"use strict";

// An error thrown inside an API route handler answers the ApiError envelope
// (src/lib/routeHandlerError.js, used by src/app.js for every system and
// site route). The HTTP-level checks are fault-injection-critical-writes-
// http.test.cjs (FI-HTTP-01 and the site.json write scenarios).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sendRouteHandlerError,
  guardApiRouteHandler,
  ROUTE_HANDLER_ERROR_MESSAGE,
} = require("../../src/lib/routeHandlerError.js");

function stubRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    writableEnded: false,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
  };
}

function captureConsole(t) {
  const lines = [];
  t.mock.method(console, "error", function () {
    lines.push(
      Array.prototype.map
        .call(arguments, (a) =>
          a && typeof a === "object" && !(a instanceof Error)
            ? JSON.stringify(a)
            : String(a),
        )
        .join(" "),
    );
  });
  return lines;
}

test("a thrown error answers the 500 ApiError envelope without the error text", (t) => {
  const lines = captureConsole(t);
  const res = stubRes();
  const err = new Error(
    "ENOSPC: no space left on device, open '/srv/secret/site.json'",
  );
  err.code = "ENOSPC";
  sendRouteHandlerError({}, res, err, "site PATCH site/outline");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    status: 500,
    data: { message: ROUTE_HANDLER_ERROR_MESSAGE },
  });
  assert.equal(ROUTE_HANDLER_ERROR_MESSAGE, "Server error");
  assert.ok(lines.join("\n").indexOf("site PATCH site/outline") !== -1);
});

test("a response the handler already started is only ended", (t) => {
  captureConsole(t);
  const res = stubRes();
  res.headersSent = true;
  sendRouteHandlerError({}, res, new Error("late"), "site GET x");
  assert.equal(res.statusCode, null);
  assert.equal(res.body, null);
  assert.equal(res.ended, true);
});

test("an error carrying the request body is logged without it", (t) => {
  const lines = captureConsole(t);
  const err = new Error("weird");
  err.body = "SECRET-BODY-CONTENT";
  sendRouteHandlerError({}, stubRes(), err, "site PATCH x");
  assert.equal(lines.join("\n").indexOf("SECRET-BODY-CONTENT"), -1);
});

test("guardApiRouteHandler answers a rejected async handler and resolves", async (t) => {
  captureConsole(t);
  const res = stubRes();
  const guarded = guardApiRouteHandler("system POST x", async () => {
    throw new TypeError("Cannot read properties of null (reading 'id')");
  });
  await guarded({}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.data.message, "Server error");
});

test("guardApiRouteHandler passes a handler's own response through", async () => {
  const res = stubRes();
  const guarded = guardApiRouteHandler("system GET x", async (req, r) => {
    return r.status(200).json({ status: 200, data: { ok: true } });
  });
  await guarded({}, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 200, data: { ok: true } });
});
