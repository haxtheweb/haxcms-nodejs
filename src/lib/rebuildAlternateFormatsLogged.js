/**
 * Await site.updateAlternateFormats() (rss, atom, sitemap, search index,
 * llms.txt) for the callers that used to start it without awaiting it.
 *
 * Awaiting means the git commit that follows includes the regenerated
 * files, and rebuilds of the same site no longer overlap. A failure is
 * logged, not thrown: those callers never saw it (it became an unhandled
 * rejection, which stops the Node process), so the save they belong to
 * still answers the way it did.
 */
async function rebuildAlternateFormatsLogged(site, context = "") {
  try {
    await site.updateAlternateFormats();
  } catch (e) {
    console.warn(
      "[haxcms] generated files rebuild failed" +
        (context ? " (" + context + ")" : "") +
        ": " +
        (e && e.message ? e.message : String(e)),
    );
  }
}

module.exports = { rebuildAlternateFormatsLogged };
