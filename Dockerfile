FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js orderService.js timeDistribution.js ./
COPY public ./public
COPY scripts ./scripts

# Ensure runtime directories exist and belong to non-root node user
RUN mkdir -p orders campaigns && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3005

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http = require('http'); const port = process.env.PORT || '3005'; const url = String(port) === '3005' ? 'http://127.0.0.1:3005/api/health' : 'http://127.0.0.1:' + port + '/api/health'; const req = http.get(url, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); }); req.setTimeout(4000, () => { req.destroy(); process.exit(1); }); req.on('error', () => process.exit(1));"

CMD ["node", "server.js"]
