// PM2 生态系统配置 — email-monitor
// 启动：pm2 start ecosystem.config.cjs
// 保存：pm2 save
// 日志轮转由 pm2-logrotate 模块管理，此处不配置 max_size 避免冲突

module.exports = {
  apps: [{
    name: "email-monitor",
    script: "./monitor.mjs",
    cwd: __dirname,
    // 日志由 PM2 接管，存 C 盘避免外接盘 IO
    out_file: "C:/Users/Administrator/.pm2/logs/email-monitor-out.log",
    error_file: "C:/Users/Administrator/.pm2/logs/email-monitor-error.log",
    // 轮转由 pm2-logrotate 全局管理，不在此配置 max_size
    max_restarts: 10,
    // 异常退出后等 5 秒再重启
    restart_delay: 5000,
    min_uptime: "10s",
    max_memory_restart: "200M",
    env: {
      NODE_ENV: "production",
      PATH: "C:\\Users\\Administrator\\AppData\\Roaming\\npm;" + process.env.PATH,
    },
  }],
};