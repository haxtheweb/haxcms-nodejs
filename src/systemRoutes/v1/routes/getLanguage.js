const { getLanguage: lookupLanguage } = require('../../../lib/languageRegistry.js');

/**
 * One language from the registry. The code may be an alias or an underscore
 * form (zh_CN, iw); the entry returned carries the canonical `code`.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/languages/{code}",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="A supported language"
 *   )
 * )
 */
async function getLanguage(req, res) {
  const code = req && req.params ? req.params.code : '';
  try {
    const language = lookupLanguage(code);
    if (!language) {
      return res.status(404).json({
        status: 404,
        data: {
          message: 'Language not found',
        },
      });
    }
    return res.json({
      status: 200,
      data: language,
    });
  }
  catch {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to load language',
      },
    });
  }
}

module.exports = getLanguage;
