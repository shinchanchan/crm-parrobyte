#!/bin/bash
# ParroByte CRM - Deployment helper
# Run this script on your production VPS after uploading the files

echo "=== ParroByte CRM Deployment ==="
echo ""

# Check if running as root for nginx reload
if [ "$EUID" -eq 0 ]; then
  echo "Running as root - can reload nginx"
  CAN_RELOAD_NGINX=1
else
  echo "Not running as root - nginx reload will need sudo"
  CAN_RELOAD_NGINX=0
fi

echo ""
echo "1. Checking Node.js app..."
if command -v pm2 &> /dev/null; then
  echo "   Restarting app with PM2..."
  pm2 restart parrobyte-web || pm2 restart all
elif pgrep -f "server.js" > /dev/null; then
  echo "   Killing existing node process..."
  pkill -f "server.js"
  sleep 2
  echo "   Starting server..."
  cd "$(dirname "$0")" && nohup node server.js > server.log 2>&1 &
else
  echo "   Starting server..."
  cd "$(dirname "$0")" && nohup node server.js > server.log 2>&1 &
fi

echo ""
echo "2. Updating nginx (if available)..."
if [ "$CAN_RELOAD_NGINX" -eq 1 ]; then
  # Check if client_max_body_size is already set
  if grep -q "client_max_body_size" /etc/nginx/sites-enabled/* 2>/dev/null; then
    echo "   client_max_body_size already set in nginx"
  else
    echo "   ⚠️  REMINDER: Add 'client_max_body_size 200M;' to your nginx server block"
    echo "      Location: /etc/nginx/sites-enabled/your-site-config"
  fi
  nginx -t && systemctl reload nginx
else
  echo "   ⚠️  REMINDER: Run 'sudo nginx -t && sudo systemctl reload nginx' to apply nginx changes"
fi

echo ""
echo "3. Verifying files..."
for f in public/icon-192.png public/icon-512.png public/manifest.json public/sw.js public/css/app.css; do
  if [ -f "$f" ]; then
    echo "   ✓ $f exists"
  else
    echo "   ✗ $f MISSING"
  fi
done

echo ""
echo "=== Deployment complete ==="
echo "Check https://crm.parrobyte.co.in in Chrome DevTools > Application to verify PWA"
