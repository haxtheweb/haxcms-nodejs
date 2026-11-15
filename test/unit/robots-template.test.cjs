"use strict";

// Renders the boilerplate robots.txt managed template the same way
// HAXCMSSite.updateAlternateFormats does (twig) and checks the agent
// discovery rules: page markdown and API discovery docs are reachable,
// AI crawlers get their own group, and private sites block everything.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Twig = require("twig");

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "boilerplate", "site", "robots.txt"),
  "utf8",
);

function render(vars) {
  return Twig.twig({ data: TEMPLATE }).render(vars);
}

function groupFor(output, userAgent) {
  // a group is the run of rules after the last consecutive User-agent line
  const lines = output.split("\n").map((line) => line.trim());
  const rules = [];
  let inGroup = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("User-agent:") === 0) {
      if (inGroup && rules.length) {
        break;
      }
      if (line === `User-agent: ${userAgent}`) {
        inGroup = true;
      }
      continue;
    }
    if (
      inGroup &&
      (line.indexOf("Allow:") === 0 ||
        line.indexOf("Disallow:") === 0 ||
        line.indexOf("Crawl-delay:") === 0)
    ) {
      rules.push(line);
    }
  }
  return rules;
}

const PUBLIC_VARS = {
  privateSite: false,
  domain: "https://example.org/sites/demo/",
};

test("public sites expose page markdown and API discovery to every crawler", () => {
  const rules = groupFor(render(PUBLIC_VARS), "*");
  assert.ok(rules.indexOf("Allow: /pages/*/index.md$") !== -1);
  assert.ok(rules.indexOf("Allow: /x/api$") !== -1);
  assert.ok(rules.indexOf("Allow: /x/api/openapi") !== -1);
  assert.ok(rules.indexOf("Allow: /.well-known/") !== -1);
  // the per-item data endpoints stay off-limits to crawlers
  assert.ok(rules.indexOf("Disallow: /x/") !== -1);
});

test("public sites keep the files a page renders with fetchable", () => {
  const output = render(PUBLIC_VARS);
  for (const agent of ["*", "ClaudeBot"]) {
    const rules = groupFor(output, agent);
    // crawlers that render (Googlebot, Bingbot) need the scripts, styles and
    // page HTML; a Disallow on any of them leaves an empty page
    for (const blocked of [
      "/build/",
      "/pages/",
      "/theme/",
      "/assets/",
      "/custom/",
    ]) {
      assert.equal(
        rules.indexOf("Disallow: " + blocked),
        -1,
        agent + " " + blocked,
      );
    }
  }
});

test("no crawl delay for any crawler", () => {
  // Bing honors Crawl-delay; a per-request delay keeps big sites out of the
  // index AI answer engines draw on
  assert.equal(/^Crawl-delay:/im.test(render(PUBLIC_VARS)), false);
});

test("AI crawlers are named and share the public rules", () => {
  const output = render(PUBLIC_VARS);
  for (const agent of [
    "GPTBot",
    "ClaudeBot",
    "PerplexityBot",
    "Google-Extended",
  ]) {
    const rules = groupFor(output, agent);
    assert.ok(rules.length > 0, `${agent} has no group`);
    assert.ok(rules.indexOf("Allow: /pages/*/index.md$") !== -1, agent);
    assert.ok(rules.indexOf("Disallow: /x/") !== -1, agent);
    assert.equal(
      rules.filter((rule) => rule.indexOf("Crawl-delay") === 0).length,
      0,
      agent,
    );
  }
});

test("sitemap and llms.txt are advertised with the site domain", () => {
  const output = render(PUBLIC_VARS);
  assert.ok(
    output.indexOf("Sitemap: https://example.org/sites/demo/sitemap.xml") !==
      -1,
  );
  assert.ok(
    output.indexOf("# LLMS: https://example.org/sites/demo/llms.txt") !== -1,
  );
  // robots.txt parsers (and Lighthouse) reject unknown directives
  assert.equal(/^LLMS:/m.test(output), false);
});

test("private sites disallow everything and name no AI crawler", () => {
  const output = render({
    privateSite: true,
    domain: "https://example.org/sites/demo/",
  });
  assert.deepEqual(groupFor(output, "*"), ["Disallow: /"]);
  assert.equal(output.indexOf("GPTBot"), -1);
  assert.equal(output.indexOf("Sitemap:"), -1);
});

test("reserved sites ask AI crawlers to stay out and keep search crawlers", () => {
  const output = render({ ...PUBLIC_VARS, reservedSite: true });
  for (const agent of [
    "GPTBot",
    "ClaudeBot",
    "PerplexityBot",
    "Google-Extended",
  ]) {
    assert.deepEqual(groupFor(output, agent), ["Disallow: /"], agent);
  }
  assert.ok(groupFor(output, "*").indexOf("Allow: /") !== -1);
});
