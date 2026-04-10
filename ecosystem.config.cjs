/**
 * 🚀 PM2 Configuration - Produção Resiliente
 * 
 * Features:
 * - Auto-restart on memory limit (300MB)
 * - Graceful shutdown
 * - Log rotation
 * - Cluster mode (opcional)
 * 
 * Uso:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    {
      name: 'crm-api',
      script: './server.js',
      type: 'module',
      
      // ⚡ Performance
      instances: 1,              // Ou 'max' para cluster mode
      exec_mode: 'fork',         // 'cluster' para múltiplas instâncias
      
      // 🔥 Memory Management (CRÍTICO)
      max_memory_restart: '300M', // Restarta se passar de 300MB
      node_args: '--max-old-space-size=512', // Heap máximo 512MB
      
      // 🔄 Auto-restart
      restart_delay: 3000,       // Espera 3s antes de restartar
      max_restarts: 10,          // Máximo 10 restarts em 10 min
      min_uptime: '10s',         // Só conta restart se rodou +10s
      
      // 🛑 Graceful shutdown
      kill_timeout: 5000,        // 5s para fechar conexões
      listen_timeout: 10000,     // 10s para iniciar
      
      // 📁 Logs
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // 🌿 Environment
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 5000,
        watch: true,
        ignore_watch: ['node_modules', 'logs', '*.log']
      },
      
      // ❌ Não restarta se falhar muito
      autorestart: true,
      exp_backoff_restart_delay: 100, // Backoff exponencial
      
      // 📊 Monitoring
      monitoring: true,
      pmx: true,
      
      // 🔔 Para testar memory restart:
      // pm2 trigger crm-api memory:heap:150
    },
    {
      name: 'crm-worker',
      script: './workers/startWorkers.js',
      type: 'module',
      
      // Workers precisam de menos memória
      max_memory_restart: '400M',
      node_args: '--max-old-space-size=512',
      
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      
      kill_timeout: 10000,       // Workers precisam de mais tempo
      listen_timeout: 15000,
      
      log_file: './logs/worker-combined.log',
      out_file: './logs/worker-out.log',
      error_file: './logs/worker-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      env: {
        NODE_ENV: 'production'
      },
      
      // Workers são críticos - sempre restarta
      autorestart: true
    },
    {
      name: 'crm-watchdog',
      script: './infrastructure/workers/watchdog.js',
      type: 'module',
      
      // Watchdog usa pouca memória
      max_memory_restart: '150M',
      
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '5s',
      
      log_file: './logs/watchdog-combined.log',
      out_file: './logs/watchdog-out.log',
      error_file: './logs/watchdog-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      env: {
        NODE_ENV: 'production'
      },
      
      // Watchdog é essencial - sempre restarta
      autorestart: true
    }
  ],
  
  // 🚀 Deployment (opcional)
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
