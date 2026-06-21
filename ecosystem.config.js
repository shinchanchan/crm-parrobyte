module.exports = {
  apps: [{
    name: 'parrobyte-crm',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '1G',
    restart_delay: 3000,
    max_restarts: 5,
    min_uptime: '10s',
    watch: false,
    ignore_watch: ['node_modules', 'logs', '.wwebjs_auth', 'uploads'],
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,
    node_args: '--max-old-space-size=1024'
  }]
};
