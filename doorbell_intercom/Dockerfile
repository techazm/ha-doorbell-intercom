FROM node:22-alpine

WORKDIR /app

# Install openssl (needed to generate the self-signed cert for the HTTPS mic port)
RUN apk add --no-cache openssl

# Install Node dependencies first (layer cached unless package.json changes)
COPY server/package.json server/package-lock.json ./
# npm version from package.json "packageManager"; keep the two in step.
ARG NPM_VERSION=11.17.0
RUN npm install -g --no-audit --no-fund npm@${NPM_VERSION}
RUN npm install --omit=dev

# Copy application code
COPY server/server.js ./
COPY ui/ ./ui/
COPY run.sh ./

RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
