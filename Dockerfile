FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY patch.mjs preview.js browser-storage.js review.js review-ui.js review-cli.js ./
COPY LICENSE UPSTREAM-LICENSE ./
RUN node patch.mjs
COPY test ./test
RUN npm test
USER 1000:1000
EXPOSE 3000
CMD ["node", "node_modules/postplan/src/server.js"]
