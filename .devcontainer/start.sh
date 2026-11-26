#!/usr/bin/env bash
# Start the backend (port 8001) and the Vite frontend (port 5173) in the
# background, at every start of the devcontainer (postStartCommand).
# Logs: /tmp/velxio-backend.log, /tmp/velxio-frontend.log. Restart: run again.
set -uo pipefail
cd "$(dirname "$0")/.."

# Stop the servers of a previous start, if any.
pkill -f "uvicorn app.main:app --host 127.0.0.1 --port 8001" 2>/dev/null || true
pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null || true
sleep 1

(cd backend && nohup python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 \
  > /tmp/velxio-backend.log 2>&1 &)
# The browser reaches only the forwarded port 5173: every API call and the
# simulation WebSockets go to /api on it, and Vite proxies them to the backend.
(cd frontend && VITE_API_BASE=/api nohup npx vite --host 0.0.0.0 --port 5173 --strictPort \
  > /tmp/velxio-frontend.log 2>&1 &)

echo "Velxio is starting: open the forwarded port 5173 (Ports tab)."
echo "Logs: /tmp/velxio-backend.log /tmp/velxio-frontend.log"
