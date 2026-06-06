module.exports = {
  apps: [
    {
      name: "Atlas",
      script: "index.js",
      cwd: __dirname,
      env: {
        PIDUSAGE_WMIC_DISABLED: "1",
        DOTENV_QUIET: "true",
        DOTENVX_QUIET: "true",
      },
      // interpreter: "bun",
      node_args: "--max-old-space-size=8000 --expose-gc --import tsx", // ignored when using Bun
      restart_delay: 3000,
      autorestart: true,
      watch: false,
    },
  ],
};
