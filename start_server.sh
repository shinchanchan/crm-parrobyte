#!/bin/bash
cd /home/vallarasu/Downloads/automation-whatsapp/kimi3/app
NODE_NO_WARNINGS=1 nohup node --no-deprecation server.js > server.log 2>&1 &
echo $!
