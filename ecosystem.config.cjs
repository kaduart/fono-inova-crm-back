/**
 * 🚀 PM2 Configuration - CRM Fono Inova v4.0
 * 
 * Arquitetura: API + Workers separados por domínio
 * Cada app roda isolada com limite de memória próprio.
 * 
 * Uso local ou VPS:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 */

const BASE_ENV = {
  NODE_ENV: 'production',
  MONGODB_URI: process.env.MONGODB_URI || '',
  REDIS_URL: process.env.REDIS_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  INTERNAL_BASE_URL: process.env.INTERNAL_BASE_URL || 'http://localhost:5000'
};

const WORKER_BASE = {
  type: 'module',
  max_memory_restart: '400M',
  node_args: '--max-old-space-size=512',
  restart_delay: 5000,
  max_restarts: 10,
  min_uptime: '10s',
  kill_timeout: 10000,
  listen_timeout: 15000,
  autorestart: true,
  env: {
    ...BASE_ENV,
    ENABLE_WORKERS: 'true'
  }
};

module.exports = {
  apps: [
    {
      name: 'crm-api',
      script: './server.js',
      type: 'module',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      node_args: '--max-old-space-size=512',
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      listen_timeout: 10000,
      log_file: './logs/api-combined.log',
      out_file: './logs/api-out.log',
      error_file: './logs/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        ...BASE_ENV,
        PORT: 5000,
        ENABLE_WORKERS: 'false',
        ENABLE_PROJECTIONS: 'true'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 5000,
        ENABLE_WORKERS: 'false',
        ENABLE_PROJECTIONS: 'true',
        watch: true,
        ignore_watch: ['node_modules', 'logs', '*.log']
      },
      autorestart: true,
      exp_backoff_restart_delay: 100
    },
    {
      name: 'crm-worker-scheduling',
      script: './workers/entrypoints/scheduling-worker.js',
      ...WORKER_BASE,
      env: { ...WORKER_BASE.env, WORKER_GROUP: 'scheduling' },
      log_file: './logs/worker-scheduling-combined.log',
      out_file: './logs/worker-scheduling-out.log',
      error_file: './logs/worker-scheduling-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'crm-worker-billing',
      script: './workers/entrypoints/billing-worker.js',
      ...WORKER_BASE,
      env: { ...WORKER_BASE.env, WORKER_GROUP: 'billing' },
      log_file: './logs/worker-billing-combined.log',
      out_file: './logs/worker-billing-out.log',
      error_file: './logs/worker-billing-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'crm-worker-clinical',
      script: './workers/entrypoints/clinical-worker.js',
      ...WORKER_BASE,
      env: { ...WORKER_BASE.env, WORKER_GROUP: 'clinical' },
      log_file: './logs/worker-clinical-combined.log',
      out_file: './logs/worker-clinical-out.log',
      error_file: './logs/worker-clinical-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'crm-worker-whatsapp',
      script: './workers/entrypoints/whatsapp-worker.js',
      ...WORKER_BASE,
      env: { ...WORKER_BASE.env, WORKER_GROUP: 'whatsapp' },
      log_file: './logs/worker-whatsapp-combined.log',
      out_file: './logs/worker-whatsapp-out.log',
      error_file: './logs/worker-whatsapp-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'crm-worker-reconciliation',
      script: './workers/entrypoints/reconciliation-worker.js',
      ...WORKER_BASE,
      env: { ...WORKER_BASE.env, WORKER_GROUP: 'reconciliation' },
      log_file: './logs/worker-reconciliation-combined.log',
      out_file: './logs/worker-reconciliation-out.log',
      error_file: './logs/worker-reconciliation-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'crm-watchdog',
      script: './infrastructure/workers/watchdog.js',
      type: 'module',
      max_memory_restart: '150M',
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '5s',
      log_file: './logs/watchdog-combined.log',
      out_file: './logs/watchdog-out.log',
      error_file: './logs/watchdog-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: BASE_ENV,
      autorestart: true
    }
  ],

  deploy: {
    production: {
      user: 'deploy',
      host: 'seu-servidor.com',
      ref: 'origin/main',
      repo: 'git@github.com:sua-org/crm.git',
      path: '/var/www/crm',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env production'
    }
  }
};
