#!/bin/bash
set -e

echo "Starting Doorbell Intercom add-on v1.0.1..."
echo "ADDON_CONFIG: $ADDON_CONFIG"

exec node /app/server.js
