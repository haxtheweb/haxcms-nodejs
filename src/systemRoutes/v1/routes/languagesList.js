const { listLanguages } = require('../../../lib/languageRegistry.js');

const REGION_MODES = ['all', 'featured', 'none'];

/**
 * List the languages HAXcms knows about (the canonical language registry).
 * Requires a valid user_token and JWT.
 *
 * Query: regions = all (default) | featured | none, which regional variants
 * (en-GB, pt-BR...) to include next to the languages themselves.
 *
 * @OA\Get(
 *    path="/languages",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="List supported languages"
 *   )
 * )
 */
async function languagesList(req, res) {
  const requested = req && req.query && req.query.regions;
  const regions = REGION_MODES.indexOf(requested) !== -1 ? requested : 'all';
  try {
    return res.json({
      status: 200,
      data: listLanguages(regions),
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to load languages',
      },
    });
  }
}

module.exports = languagesList;
