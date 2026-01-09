const { HAXCMS } = require('../lib/HAXCMS.js');
function loginRoute(req, res)  {
  // primary branch: username / password login
  if (req.body && req.body.username && req.body.password) {
    const u = req.body.username;
    const p = req.body.password;
    // test if this is a valid user login
    if (!HAXCMS.testLogin(u, p, true)) {
      return res.sendStatus(403);
    }
    // set a refresh_token COOKIE that will ship w/ all calls automatically
    res.cookie('haxcms_refresh_token', HAXCMS.getRefreshToken(u), { 
      expires: 0 ,
      path: '/',
      domain: '',
      secure: false,
      httpOnly: true,
    });
    return res.json({
      status: 200,
      jwt: HAXCMS.getJWT(u),
    });
  }
  // login end point requested yet a jwt already exists
  // this is something of a revalidate case
  else if (
    (req.body && Object.keys(req.body).length && req.body['jwt']) ||
    (req.query && Object.keys(req.query).length && req.query['jwt'])
  ) {
    const valid = HAXCMS.validateJWT(req, res);
    if (valid) {
      return res.json({
        status: 200,
        jwt: valid,
      });
    }
    return res.sendStatus(403);
  }
  else {
    res.sendStatus(403);
  }
}

module.exports = loginRoute;
