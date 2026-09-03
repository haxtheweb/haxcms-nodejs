'use strict';
// Shared HAX CLI terminal theme.
//
// Single source of truth for the "Merlin" voice used by haxcms-nodejs,
// desktop, and (by convention) the `create` CLI. Zero runtime dependencies:
// bespoke ANSI escapes so this stays appropriate as a headless-server
// dependency (no picocolors / @clack pulled into haxcms-nodejs).
//
// Respects NO_COLOR, non-TTY stdout, and HAXCMS_CLI_QUIET so CI / Docker /
// log-scrapers keep getting the plain `open: <url>` line they expect instead
// of ANSI art.
//
// merlinSays() is kept byte-for-byte identical to create/src/lib/statements.js
// merlinSays() so the voice is unified across the ecosystem. If you change one,
// change the other.

// --- ANSI escape sequences ---
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const UNDERLINE = '\x1b[4m';
// foreground
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';
const BLACK = '\x1b[30m';
// background
const BG_BLACK = '\x1b[40m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';
const BG_BLUE = '\x1b[44m';
const BG_WHITE = '\x1b[47m';
const BG_YELLOW = '\x1b[43m';

// Evaluated once at module load. FORCE_COLOR overrides non-TTY (matches
// picocolors / standard CLI behavior); NO_COLOR always wins.
function colorEnabled() {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return !!process.stdout.isTTY;
}

const ENABLED = colorEnabled();

function wrap(open, close) {
  return function (str) {
    if (!ENABLED) {
      return String(str);
    }
    return open + String(str) + close;
  };
}

// picocolors-compatible subset (the methods used by create + haxcms-nodejs).
const color = {
  red: wrap(RED, RESET),
  green: wrap(GREEN, RESET),
  yellow: wrap(YELLOW, RESET),
  blue: wrap(BLUE, RESET),
  magenta: wrap(MAGENTA, RESET),
  cyan: wrap(CYAN, RESET),
  white: wrap(WHITE, RESET),
  gray: wrap(GRAY, RESET),
  black: wrap(BLACK, RESET),
  bold: wrap(BOLD, RESET),
  underline: wrap(UNDERLINE, RESET),
  bgBlack: wrap(BG_BLACK, RESET),
  bgGreen: wrap(BG_GREEN, RESET),
  bgRed: wrap(BG_RED, RESET),
  bgBlue: wrap(BG_BLUE, RESET),
  bgWhite: wrap(BG_WHITE, RESET),
  bgYellow: wrap(BG_YELLOW, RESET),
  isColorSupported: ENABLED,
};

// Canonical "Merlin" status line. Matches create/src/lib/statements.js
// merlinSays() exactly so the voice is unified across the ecosystem.
function merlinSays(text) {
  return `${color.yellow(color.bgBlack(` 🧙 Merlin: `))} ${color.bgBlack(color.green(` ${text} `))}`;
}

// Merlin-flavored error line (red) for CLI error surfaces.
function merlinError(text) {
  return `${color.yellow(color.bgBlack(` 🧙 Merlin: `))} ${color.bgBlack(color.red(` ${text} `))}`;
}

// Community outro block (links + tagline). Mirrors create's communityStatement
// content; rendered via console.log so this module does not depend on
// @clack/prompts.
function communityStatement() {
  const lines = [
    '',
    `  🧙  HAX @ Penn State: ${color.underline(color.cyan('https://hax.psu.edu'))}`,
    '',
    `  🔮  Ideas to HAX Harder, Better, Faster, Stronger: ${color.underline(color.white('https://github.com/haxtheweb/issues/issues'))}`,
    '',
    `  👔  Share on LinkedIn: ${color.underline(color.cyan('https://bit.ly/hax-the-linkedin'))}`,
    '',
    `  🧵  Tweet on X: ${color.underline(color.white('https://bit.ly/hax-the-x'))}`,
    '',
    `  💬  Join Community: ${color.underline(color.cyan('https://discord.gg/EKYJAjqGhf'))}`,
    '',
    `  💡  ${color.bold(color.white('Never. Stop. Innovating.'))}`,
    '',
  ];
  for (let i = 0; i < lines.length; i++) {
    console.log(lines[i]);
  }
}

// Strip ANSI escapes so padRight can compute visible width.
function visibleLen(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(str, width) {
  const pad = Math.max(0, width - visibleLen(str));
  return str + ' '.repeat(pad);
}

const INNER_WIDTH = 60;

// Boxed, colorized "server is up" banner. Falls back to the exact pre-existing
// `open: <url>` single line when color is disabled (non-TTY / NO_COLOR) so
// scripts and log-scrapers do not break. HAXCMS_CLI_QUIET suppresses entirely.
//
// opts: { url, mode, siteName, theme, version }
function printServerBanner(opts) {
  opts = opts || {};
  if (process.env.HAXCMS_CLI_QUIET) {
    return;
  }
  const url = String(opts.url || '');
  if (!ENABLED) {
    // Identical to the pre-existing output so CI / log-scrapers keep working.
    console.log(`open: ${url}`);
    return;
  }
  const mode = String(opts.mode || '');
  const contentLines = [];
  contentLines.push(`  ${merlinSays('The Web : CLI is summoning itself')}`);
  contentLines.push('');
  contentLines.push(`  🚀  Server running at: ${color.underline(color.cyan(url))}`);
  if (mode) {
    contentLines.push(`  🏠  Mode: ${color.bold(mode)}`);
  }
  if (opts.siteName) {
    contentLines.push(`  📁  Site: ${color.bold(color.green(String(opts.siteName)))}`);
  }
  if (opts.theme) {
    contentLines.push(`  🎨  Theme: ${color.bold(String(opts.theme))}`);
  }
  if (opts.version) {
    contentLines.push(`  🏷️  Version: ${color.gray(String(opts.version))}`);
  }
  contentLines.push('');
  contentLines.push(`  ⌨️  To stop server, press: ${color.bold(color.black(color.bgRed(' CTRL + C ')))}`);
  const W = INNER_WIDTH;
  const top = color.green('╔' + '═'.repeat(W) + '╗');
  const bottom = color.green('╚' + '═'.repeat(W) + '╝');
  console.log(top);
  console.log(color.green('║') + ' '.repeat(W) + color.green('║'));
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (line === '') {
      console.log(color.green('║') + ' '.repeat(W) + color.green('║'));
    } else {
      console.log(color.green('║') + padRight(line, W) + color.green('║'));
    }
  }
  console.log(color.green('║') + ' '.repeat(W) + color.green('║'));
  console.log(bottom);
}

module.exports = {
  color,
  merlinSays,
  merlinError,
  communityStatement,
  printServerBanner,
  colorEnabled,
};
