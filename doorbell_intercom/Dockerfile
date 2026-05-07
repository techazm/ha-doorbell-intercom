FROM node:20-alpine

WORKDIR /app

# Install Node dependencies first (layer cached unless package.json changes)
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev

# Copy application code
COPY server/server.js ./
COPY ui/ ./ui/

CMD ["node", "/app/server.js"]
