#!/bin/bash
# ─────────────────────────────────────────────
#  Nexus Live + Nexus Budget — One-click launcher
#  Double-click this file in Finder to start both apps
# ─────────────────────────────────────────────

NEXUS_LIVE_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NEXUS_BUDGET_DIR="$HOME/Documents/GitHub/Nexus_Budget"

# ── Colours ──────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  ⬡  Nexus Launcher${NC}"
echo "  ─────────────────────────────────────"

# ── Kill anything already on these ports ─────
for PORT in 3333 8501; do
  PID=$(lsof -ti tcp:$PORT 2>/dev/null)
  if [ -n "$PID" ]; then
    echo -e "  ${YELLOW}⚠  Port $PORT in use (PID $PID) — stopping...${NC}"
    kill -9 $PID 2>/dev/null
    sleep 1
  fi
done

# ── Start Nexus Budget App (:8501) ────────────
if [ -d "$NEXUS_BUDGET_DIR" ]; then
  echo -e "  ${CYAN}▶  Starting Nexus Budget App on :8501...${NC}"
  cd "$NEXUS_BUDGET_DIR"
  nohup python3 run.py --mode pipeline --port 8501 > /tmp/nexus_budget.log 2>&1 &
  BUDGET_PID=$!
  echo "     PID: $BUDGET_PID  |  Log: /tmp/nexus_budget.log"
else
  echo -e "  ${RED}✗  Nexus Budget not found at: $NEXUS_BUDGET_DIR${NC}"
fi

# ── Start Nexus Live (:3333) ──────────────────
echo -e "  ${CYAN}▶  Starting Nexus Live on :3333...${NC}"
cd "$NEXUS_LIVE_DIR"
nohup node server.js > /tmp/nexus_live.log 2>&1 &
LIVE_PID=$!
echo "     PID: $LIVE_PID  |  Log: /tmp/nexus_live.log"

# ── Wait for apps to be ready ─────────────────
echo ""
echo -n "  Waiting for apps to be ready"
for i in {1..20}; do
  sleep 1
  echo -n "."
  LIVE_UP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3333 2>/dev/null)
  BUDGET_UP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8501/health 2>/dev/null)
  if [ "$LIVE_UP" = "200" ] && [ "$BUDGET_UP" = "200" ]; then
    break
  fi
done
echo ""

# ── Status report ─────────────────────────────
echo ""
if curl -s -o /dev/null -w "" http://localhost:3333 2>/dev/null; then
  echo -e "  ${GREEN}✓  Nexus Live       → http://localhost:3333${NC}"
else
  echo -e "  ${RED}✗  Nexus Live failed to start (check /tmp/nexus_live.log)${NC}"
fi

if curl -s http://localhost:8501/health 2>/dev/null | grep -q "healthy"; then
  TXNS=$(curl -s http://localhost:8501/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transactions_loaded','?'))" 2>/dev/null)
  echo -e "  ${GREEN}✓  Nexus Budget App → http://localhost:8501  ($TXNS transactions)${NC}"
else
  echo -e "  ${RED}✗  Budget App failed to start (check /tmp/nexus_budget.log)${NC}"
fi

echo ""
echo "  ─────────────────────────────────────"
echo -e "  ${CYAN}Opening in browser...${NC}"
sleep 1
open "http://localhost:3333"
sleep 1
open "http://localhost:8501"

echo ""
echo -e "  ${GREEN}Both apps running. Close this window to stop them.${NC}"
echo ""

# Keep terminal open so apps stay alive
wait
