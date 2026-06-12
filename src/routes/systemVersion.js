const { HAXCMS } = require('../lib/HAXCMS.js');

async function systemVersion(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(
      req.query.user_token,
      HAXCMS.getActiveUserName(),
    )
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }
  return res.json({
    status: 200,
    data: {
      version: await HAXCMS.getHAXCMSVersion(),
    },
  });
}

module.exports = systemVersion;
