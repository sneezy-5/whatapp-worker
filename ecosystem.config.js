module.exports = {
  apps: [
    {
      name: 'whatsapp-worker-1',
      script: './src/config/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        WORKER_ID: 'worker-1',
        WORKER_NAME: 'WhatsApp Worker 1',
        LOG_LEVEL: 'info',
      },
    },
    {
      name: 'whatsapp-worker-2',
      script: './src/config/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        WORKER_ID: 'worker-2',
        WORKER_NAME: 'WhatsApp Worker 2',
        LOG_LEVEL: 'info',
      },
    },
    {
      name: 'whatsapp-worker-3',
      script: './src/config/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        WORKER_ID: 'worker-3',
        WORKER_NAME: 'WhatsApp Worker 3',
        LOG_LEVEL: 'info',
      },
    },
  ],
};