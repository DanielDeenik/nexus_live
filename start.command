#!/bin/bash
# Nexus Live — double-click launcher for Mac
# Move to the folder containing this script
cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Nexus Live"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo ""
  echo "  ✗  Node.js not found."
  echo "     Install it from: https://nodejs.org  (LTS version)"
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

echo "  ✓  Node $(node -v)"

# Install dependencies if needed
if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
  echo "  ⏳  Installing dependencies..."
  npm install --silent
fi

echo "  ✓  Dependencies ready"
echo ""
echo "  ➜  http://localhost:3333"
echo ""
echo "  Starting server... (close this window to stop)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Open browser after short delay
(sleep 2 && open http://localhost:3333) &

# Start the server
node server.js
