# Apify image with Node.js 22, Playwright, its browsers (in /pw-browsers) and the system libraries they need
FROM apify/actor-node-playwright-chrome:22

# Copy package files first for Docker layer caching
COPY --chown=myuser:myuser package*.json ./

# Use the exact Playwright version that ships with this image, so the browsers already installed in it match.
# (Browsers cannot be downloaded at build time: /pw-browsers is read-only for this user.)
RUN PW_VERSION=$(node -p "require('playwright/package.json').version" 2>/dev/null || true) \
    && if [ -n "$PW_VERSION" ]; then npm pkg set dependencies.playwright="$PW_VERSION"; fi \
    && echo "Playwright version: ${PW_VERSION:-as in package.json}" \
    && npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && rm -r ~/.npm

# Copy the source code
COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
