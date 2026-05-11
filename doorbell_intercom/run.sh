#!/bin/sh
set -eu

if [ ! -f /app/server.key ] || [ ! -f /app/server.crt ]; then
	echo "[doorbell_intercom] generating ephemeral TLS certificate"
	openssl req -x509 -nodes -days 30 -newkey rsa:2048 \
		-keyout /app/server.key \
		-out /app/server.crt \
		-subj "/CN=doorbell-intercom" >/dev/null 2>&1
fi

echo "[doorbell_intercom] service runner started"
exec node /app/server.js
