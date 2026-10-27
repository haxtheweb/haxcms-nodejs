/**
 * Server-side rendering kit for HAX web components (Lit SSR). Plain ESM,
 * excluded from babel (babel rewrites import() into require(), which cannot
 * load the ESM-only @lit-labs/ssr or element modules).
 *
 *   installInertDom()   the browser surface elements assume but Lit SSR's DOM
 *                       shim lacks (window, listeners, observers, query APIs)
 *   renderTag()         render one element: skip list, capped output,
 *                       progressive-enhancement fallback, primitive styles
 *   SSR_SKIP            elements known not to server-render
 *   SSR_PRIMITIVE_CSS   stylesheet for plain HTML primitives in fallback markup
 */
export { installInertDom } from "./inertDom.mjs";
export { SSR_PRIMITIVE_CSS, withPrimitives } from "./primitives.mjs";
export { SSR_SKIP, ssrSkipReason } from "./skip.mjs";
export {
  MAX_HTML_BYTES,
  buildTemplate,
  collectCapped,
  progressiveFallback,
  hasContent,
  fallbackMarkup,
  renderTag,
} from "./renderTag.mjs";
