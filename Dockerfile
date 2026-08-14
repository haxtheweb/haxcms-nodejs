# HAXcms Node.js server — production container.
#
# Babel-transpiles src/ -> dist/ at build time, then runs the Express server
# as the non-root `node` user (uid 1000, shipped with node:22-slim). Runtime
# HAX sites are persisted under /app/_sites — HAXCMS.js sets sitesDirectory to
# '_sites' relative to cwd / HAXCMS_ROOT.
FROM node:22-slim

WORKDIR /app

# Hand ownership of the working directory and the runtime site-storage
# directory to the non-root `node` user so the app never runs as root and can
# still write new sites at runtime.
RUN chown node:node /app \
    && mkdir -p /app/_sites \
    && chown node:node /app/_sites

# --- Dependencies layer (cached independently of source changes) ---
# No --production flag: devDependencies (@babel/cli, @babel/core,
# @babel/preset-env, etc.) are required by the `yarn run build` step below.
# The final image only executes dist/, so devDeps are build-time only.
COPY --chown=node:node package.json yarn.lock ./
USER node
RUN yarn install --frozen-lockfile

# --- Source + build layer ---
# .dockerignore keeps node_modules / dist / _sites / .git out of this COPY so
# the freshly-installed node_modules layer is preserved. `yarn run build` runs
# `babel src --out-dir dist --copy-files --include-dotfiles` and chmods the CLI
# entrypoints (dist/local.js, dist/app.js, dist/cli.js).
COPY --chown=node:node . .
RUN yarn run build

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

# Runtime site storage. Declaring it a VOLUME keeps site data out of the image
# layer and lets operators mount a named/anonymous volume or a host bind. The
# directory is pre-owned by `node` so a fresh anonymous volume starts writable
# by the non-root process.
VOLUME /app/_sites

# node:22-slim ships no curl or wget, so the health probe uses Node's built-in
# `http` core module — zero extra packages added to the image. Any 2xx/3xx
# response is treated as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/', (r) => process.exit(r.statusCode >= 200 && r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/app.js"]
