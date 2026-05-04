#!/usr/bin/env sh
set -eu

proxy_port="${PROXY_PORT:-80}"
target_port="${TARGET_PORT:-}"

case "$proxy_port" in
  ''|*[!0-9]*)
    echo "Invalid PROXY_PORT: $proxy_port" >&2
    exit 1
    ;;
esac

case "$target_port" in
  ''|*[!0-9]*)
    echo "Invalid TARGET_PORT: ${target_port:-<empty>}" >&2
    exit 1
    ;;
esac

if [ "$proxy_port" -lt 1024 ]; then
  sysctl -w net.ipv4.ip_unprivileged_port_start=0 >/dev/null
fi

exec node reverse-proxy.js
