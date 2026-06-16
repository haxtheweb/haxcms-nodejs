const { HAXCMS } = require('../../../lib/HAXCMS.js');

async function systemVersion(req, res) {
  return res.json({
    status: 200,
    data: {
      version: await HAXCMS.getHAXCMSVersion(),
    },
  });
}

module.exports = systemVersion;
