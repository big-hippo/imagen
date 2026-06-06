module.exports = {
  apps: [
    {
      name: "imagen",
      script: "server.js",
      cwd: "/home/user/projects/imagen",
      interpreter: "node",
      env: {
        HOST: "0.0.0.0",
        PORT: "3100",
      },
      env_production: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: "3100",
      },
    },
  ],
};
