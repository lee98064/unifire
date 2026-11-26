module.exports = {
  apps: [{
    name: 'unifire',
    cwd: __dirname,
    script: '.output/server/index.mjs',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    kill_timeout: 45000,
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || '3000',
      NITRO_HOST: process.env.NITRO_HOST || '127.0.0.1',
      TZ: process.env.TZ || 'Asia/Taipei',
      NUXT_DATA_DIR: process.env.NUXT_DATA_DIR || './.data',
      NUXT_TRUST_PROXY: process.env.NUXT_TRUST_PROXY || 'true',
    },
  }],
}
