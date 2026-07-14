// Config do PM2 pra manter o server.js sempre no ar na VPS (reinicia
// sozinho se cair, e volta a subir se a VPS reiniciar — ver "pm2 startup").
module.exports = {
  apps: [
    {
      name: 'prospeccao-ativa',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
