/**
 * @description Elements known not to server-render. Server pipelines (and
 * `hax audit ssr`) skip these instead of importing and rendering them: they
 * need a real browser (WebGL, audio, layout) so they only ever fail or come
 * back empty on the server. Most are third-party elements, so the marker lives
 * here; an element of our own can opt out with a static `ssr = false`.
 */
export const SSR_SKIP = {
  "model-viewer":
    "3D model viewer (third-party): needs WebGL and a browser DOM to render",
  "midi-player":
    "MIDI player (third-party): needs browser audio APIs and the Node global",
};

/**
 * @param {string} tag custom element tag name
 * @param {Function} [ctor] the registered element class, when it is loaded
 * @returns {string|null} why the element is skipped, or null to render it
 */
export function ssrSkipReason(tag, ctor) {
  if (ctor && ctor.ssr === false) {
    return typeof ctor.ssrSkipReason === "string"
      ? ctor.ssrSkipReason
      : "marked ssr = false";
  }
  return Object.prototype.hasOwnProperty.call(SSR_SKIP, tag)
    ? SSR_SKIP[tag]
    : null;
}
