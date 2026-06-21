#!/bin/bash
# ParroByte CRM Production Startup Script
# Single-process architecture (no BullMQ workers)

cd "$(dirname "$0")"

# Create logs directory if not exists
mkdir -p logs

echo "[Start] Starting ParroByte CRM with PM2..."

# Start web server via PM2
npx pm2 start ecosystem.config.cjs

echo "[Start] Server started. Monitoring:"
npx pm2 status

echo ""
echo "Useful commands:"
echo "  npx pm2 logs          - View all logs"
echo "  npx pm2 monit         - Real-time monitor"
echo "  npx pm2 reload all    - Zero-downtime reload"
echo "  npx pm2 stop all      - Stop all processes"
echo "  npx pm2 startup       - Configure auto-start on boot"
echo "  npx pm2 save          - Save current process list"
