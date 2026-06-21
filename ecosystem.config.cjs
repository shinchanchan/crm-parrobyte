/**
 * PM2 Ecosystem Config for ParroByte CRM
 * Multi-process architecture for high concurrency on 8-14GB RAM
 *
 * Processes:
 *  - web (2 instances): Express API + Web UI + Webhooks
 *  - worker-message (1): Bulk sends, scheduled messages, incoming auto-replies
 *  - worker-scraper (1): Google Maps scraping (concurrency=1, RAM heavy)
 *  - worker-ai (1): AI reply generation via Ollama
 *  - worker-heartbeat (1): Keeps WhatsApp sessions alive
 *
 * WhatsApp Session Limits:
 *  - Each Chromium uses ~100-200MB optimized
 *  - Max 15-20 concurrent WhatsApp sessions on 8GB
 *  - Max 25-30 on 14GB
 */
module.exports = {
  apps: [
    {
      name: "parrobyte-web",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "3000M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/web-error.log",
      out_file: "./logs/web-out.log",
      merge_logs: true,
      restart_delay: 3000,
      max_restarts: 5,
      min_uptime: "10s",
      watch: false,
    },
  ],
};

