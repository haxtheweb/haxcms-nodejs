"use strict";

// session/user (getUserData) names the signed-in user. userData.json is
// shared by the install and its boilerplate carries no userName, so the
// route fills it from the request's authenticated user. The dashboard and
// the site label the user menu with it and key the saved character to it.
// Mirrors haxcms-php tests/Unit/OperationsTokenGateTest.php
// (testGetUserDataFillsAnEmptyUserNameWithTheSignedInUser).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const getUserData = require("../../src/systemRoutes/v1/routes/getUserData.js");

function fakeRes() {
  return {
    body: null,
    send(b) {
      this.body = b;
      return this;
    },
  };
}

function withUserData(t, value) {
  const saved = HAXCMS.userData;
  HAXCMS.userData = value;
  t.after(() => {
    HAXCMS.userData = saved;
  });
}

test("an empty userName is filled with the signed-in user", (t) => {
  withUserData(t, { userName: "", userPicture: "" });
  const user = HAXCMS.getActiveUserName();
  const res = fakeRes();
  getUserData(
    { headers: { authorization: "Bearer " + HAXCMS.getJWT(user) } },
    res,
  );
  assert.equal(res.body.status, 200);
  assert.equal(res.body.data.userName, user);
  // the shared userData is not rewritten
  assert.equal(HAXCMS.userData.userName, "");
});

test("a stored userName is kept", (t) => {
  withUserData(t, { userName: "stored", userPicture: "" });
  const res = fakeRes();
  getUserData(
    {
      headers: {
        authorization: "Bearer " + HAXCMS.getJWT(HAXCMS.getActiveUserName()),
      },
    },
    res,
  );
  assert.equal(res.body.data.userName, "stored");
});
