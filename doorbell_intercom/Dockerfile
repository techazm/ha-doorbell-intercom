ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js 20 LTS
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install Node dependencies first (layer cached unless package.json changes)
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev

# Copy application code
COPY server/server.js ./
COPY ui/ ./ui/

# Startup script
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
