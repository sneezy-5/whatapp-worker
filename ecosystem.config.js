module.exports = {
  apps: [{
    name: 'whatsapp-worker',
    script: 'src/worker.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'false' // Important: Allow download
    }
  }]
};