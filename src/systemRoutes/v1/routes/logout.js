function logoutRoute(req, res)  {
    res.cookie('haxcms_refresh_token', '1', { maxAge: 1 });
    res.send({
        "status" : 200,
        "data" : 'loggedout',
    })
}

module.exports = logoutRoute;