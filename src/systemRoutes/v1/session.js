const loginRoute = require('./routes/login.js');
const logoutRoute = require('./routes/logout.js');
const refreshAccessTokenRoute = require('./routes/refreshAccessToken.js');
const sessionRoute = require('./routes/session.js');
const connectionSettingsRoute = require('./routes/connectionSettings.js');
const connectionTestRoute = require('./routes/connectionTest.js');
const getUserDataRoute = require('./routes/getUserData.js');

async function login(req, res, next) {
  return loginRoute(req, res, next);
}

async function logout(req, res, next) {
  return logoutRoute(req, res, next);
}

async function refreshAccessToken(req, res, next) {
  return refreshAccessTokenRoute(req, res, next);
}
async function session(req, res, next) {
  return sessionRoute(req, res, next);
}

async function connectionSettings(req, res, next) {
  return connectionSettingsRoute(req, res, next);
}

async function connectionTest(req, res, next) {
  return connectionTestRoute(req, res, next);
}

async function getUserData(req, res, next) {
  return getUserDataRoute(req, res, next);
}

module.exports = {
  login,
  logout,
  refreshAccessToken,
  session,
  connectionSettings,
  connectionTest,
  getUserData,
};
