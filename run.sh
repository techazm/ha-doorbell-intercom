#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "Starting Doorbell Intercom add-on..."
bashio::log.info "Reading configuration..."

# Export the full add-on config as JSON for the Node server
export ADDON_CONFIG
ADDON_CONFIG="$(bashio::config '.')"

bashio::log.info "Configured doorbells: $(bashio::config 'doorbells | length')"

exec node /app/server.js
