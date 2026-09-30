module.exports = {
  apps: [{
    name: 'starlink-monitor',
    script: 'server.js',
    cwd: __dirname,
    env: { PORT: 7000, DISH: '192.168.100.1:9200' },
    max_memory_restart: '200M',
  }],
};
