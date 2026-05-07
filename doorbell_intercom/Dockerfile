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

# Register as an s6-overlay service (required by HA base images)
RUN mkdir -p /etc/services.d/doorbell_intercom
COPY run.sh /etc/services.d/doorbell_intercom/run
RUN chmod a+x /etc/services.d/doorbell_intercom/run

CMD ["/init"]
