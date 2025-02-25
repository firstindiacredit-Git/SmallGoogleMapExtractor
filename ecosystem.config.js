module.exports = {
  apps: [{
    name: 'google-maps-scraper',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '8G',
    node_args: [
      '--expose-gc',
      '--max-old-space-size=16384',
      '--optimize-for-size',
      '--max-semi-space-size=512',
      '--nouse-idle-notification',
      '--gc-interval=100',
      '--no-incremental-marking'
    ],
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: 128,
      NODE_OPTIONS: '--max-old-space-size=16384'
    },
    exp_backoff_restart_delay: 100,
    kill_timeout: 3000,
    merge_logs: true
  }]
}; 