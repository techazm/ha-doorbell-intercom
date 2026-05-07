#!/bin/bash

echo "Starting Doorbell Intercom add-on..."
echo "Current PID: $$"
echo "Parent PID: $PPID"
echo "ADDON_CONFIG: $ADDON_CONFIG"

node /app/server.js
