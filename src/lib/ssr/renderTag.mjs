/**
 * @description Render one custom element to a string with Lit SSR. The caller
 * supplies lit's `html` and @lit-labs/ssr's `render`, so this module has no
 * dependency on either and uses whichever copy of lit the elements loaded.
 */
import { ssrSkipReason } from "./skip.mjs";
import { withPrimitives } from "./primitives.mjs";

// Some elements render pages of documentation (d-d-docs is ~70 MB: every
// nested element repeats its shadow-root styles). Collect at most this much
// and stop rendering, so one element cannot exhaust memory.
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

/**
 * A lit template with property bindings, built the way the HAX editor builds a
 * demoSchema entry: <tag .prop=${value}>content</tag>. Property bindings keep
 * objects, arrays and booleans intact (attributes would stringify them).
 */
export function buildTemplate(html, tag, demo) {
  const strings = [];
  const values = [];
  let current = `<${tag}`;
  const properties = (demo && demo.properties) || {};
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      continue;
    }
    current += ` .${key}=`;
    strings.push(current);
    values.push(value);
    current = "";
  }
  const content = demo && typeof demo.content === "string" ? demo.content : "";
  current += `>${content}</${tag}>`;
  strings.push(current);
  // lit checks for an own "raw" property on the strings array
  strings.raw = strings;
  return html(strings, ...values);
}

/**
 * Collect a render result into a string, stopping at MAX_HTML_BYTES.
 * @returns {Promise<{html: string, truncated: boolean}>}
 */
export async function collectCapped(result, max = MAX_HTML_BYTES) {
  let html = "";
  // for await also resolves the promises a RenderResult can contain
  for await (const chunk of result) {
    html += chunk;
    if (html.length > max) {
      return { html, truncated: true };
    }
  }
  return { html, truncated: false };
}

/**
 * The element's own light-DOM fallback: the markup its haxHooks()
 * progressiveEnhancement hook produces for the given demo properties, or null
 * when it has none (only a few elements do, e.g. meme-maker).
 */
export async function progressiveFallback(tag, demo) {
  try {
    const Element = globalThis.customElements.get(tag);
    if (!Element) {
      return null;
    }
    const el = new Element();
    const hooks = typeof el.haxHooks === "function" ? el.haxHooks() : null;
    const name = hooks && hooks.progressiveEnhancement;
    if (!name || typeof el[name] !== "function") {
      return null;
    }
    Object.assign(el, (demo && demo.properties) || {});
    const markup = await el[name](el);
    return typeof markup === "string" && markup.trim() ? markup : null;
  } catch {
    return null;
  }
}

/**
 * True when server-rendered output has anything a reader could see: text,
 * media, or child elements. A shadow root holding only <style> does not.
 */
export function hasContent(markup, tag) {
  const inner = String(markup || "")
    .replace(/<!--[\s\S]*?--!?>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, "")
    .replace(/<template\b[^>]*>/gi, "")
    .replace(/<\/template\s*>/gi, "");
  const outer = new RegExp(`</?${tag}(?=[\\s>/])[^>]*>`, "gi");
  return inner.replace(outer, "").replace(/\s+/g, "") !== "";
}

/**
 * Swap an empty render for the element's own progressive-enhancement markup:
 * the host tag with the fallback as plain light DOM and no shadow root, so a
 * reader or crawler without JavaScript sees it. null when the host tag can't
 * be found.
 */
export function fallbackMarkup(markup, tag, progressive) {
  const open = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "i").exec(markup);
  return open ? `${open[0]}${progressive}</${tag}>` : null;
}

/**
 * @param {{render: Function, html: Function}} lit lit's html and @lit-labs/ssr's render
 * @param {string} tag custom element tag name
 * @param {object} [demo] { properties, content } like a haxProperties demoSchema entry
 * @param {{primitives?: boolean, max?: number}} [options] primitives: prepend the primitive stylesheet
 * @returns {Promise<{skipped?: string, html?: string, truncated?: boolean, progressive?: string|null, usedFallback?: boolean}>}
 */
export async function renderTag(lit, tag, demo, options = {}) {
  const skipped = ssrSkipReason(tag, globalThis.customElements.get(tag));
  if (skipped) {
    return { skipped };
  }
  const { html, truncated } = await collectCapped(
    lit.render(buildTemplate(lit.html, tag, demo)),
    options.max,
  );
  const progressive = await progressiveFallback(tag, demo);
  let out = html;
  let usedFallback = false;
  if (progressive && !truncated && !hasContent(html, tag)) {
    const swapped = fallbackMarkup(html, tag, progressive);
    if (swapped) {
      out = swapped;
      usedFallback = true;
    }
  }
  return {
    html: options.primitives ? withPrimitives(out) : out,
    truncated,
    progressive,
    usedFallback,
  };
}
