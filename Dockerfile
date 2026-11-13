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

CMD ["node", "server.js"]
