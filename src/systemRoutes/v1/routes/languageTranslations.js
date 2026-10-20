const { getLanguage } = require('../../../lib/languageRegistry.js');
const {
  collectTranslations,
  isSafeName,
} = require('../../../lib/languageTranslations.js');

const TYPES = ['all', 'ui', 'schema'];

/**
 * Every translated string for one language, grouped by element namespace.
 * Meant for translators and tools (including LLMs) that need to check or work
 * on a whole language at once. A full language is a few hundred KB; use
 * `namespace` to get one element.
 * Requires a valid user_token and JWT.
 *
 * Query:
 *  - namespace: only this element (e.g. video-player), its UI and schema files
 *  - type: all (default) | ui | schema (editor / HAX schema strings)
 *
 * @OA\Get(
 *    path="/languages/{code}/translations",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Translated strings for a language"
 *   )
 * )
 */
async function languageTranslations(req, res) {
  const code = req && req.params ? req.params.code : '';
  const query = (req && req.query) || {};
  try {
    const language = getLanguage(code);
    if (!language) {
      return res.status(404).json({
        status: 404,
        data: {
          message: 'Language not found',
        },
      });
    }
    const namespace = typeof query.namespace === 'string' ? query.namespace : '';
    if (namespace && !isSafeName(namespace)) {
      return res.status(400).json({
        status: 400,
        data: {
          message: 'Invalid namespace',
        },
      });
    }
    const type = typeof query.type === 'string' ? query.type : 'all';
    if (TYPES.indexOf(type) === -1) {
      return res.status(400).json({
        status: 400,
        data: {
          message: 'Invalid type',
        },
      });
    }
    const collected = await collectTranslations({
      locale: language.locale,
      namespace,
      type,
    });
    return res.json({
      status: 200,
      data: {
        language: language,
        locale: language.locale,
        count: collected.count,
        namespaces: collected.namespaces,
      },
    });
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Unable to load translations',
      },
    });
  }
}

module.exports = languageTranslations;
