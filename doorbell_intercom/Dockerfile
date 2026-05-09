FROM node:20-alpine

WORKDIR /app

# Install openssl (needed to generate the self-signed cert for the HTTPS mic port)
RUN apk add --no-cache openssl

# Generate a 10-year self-signed cert at build time.
# Users accept it once in the browser then have permanent HTTPS mic access.
RUN openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /app/server.key \
    -out  /app/server.crt \
    -subj "/CN=doorbell-intercom"

# Install Node dependencies first (layer cached unless package.json changes)
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev

# Copy application code
COPY server/server.js ./
COPY ui/ ./ui/

CMD ["node", "/app/server.js"]
