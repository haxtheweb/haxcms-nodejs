#!/bin/bash
set -e

# Install dependencies and build dist/ (babel src -> dist) so the Express
# server and CLI entrypoints (local.js / app.js / cli.js) are ready to run.
yarn install
yarn run build

printf "\033[34mhaxtheweb/haxcms-nodejs Next Steps:\033[0m\n"
printf "Run \033[34myarn dev\033[0m for live rebuilds of the server (nodemon on src/app.js)\n"
printf "Run \033[34mnode dist/app.js\033[0m to serve the built app on port 3000\n"
