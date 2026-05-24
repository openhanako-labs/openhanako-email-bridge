# openhanako-email-bridge

Hanako 邮件监听服务。通过 ClawEmail WebSocket Push 实时接收新邮件通知，存档到本地并弹出桌面通知。事件驱动，无需轮询。

## 架构

```
发件人 → ClawEmail → WebSocket Push → monitor.mjs
                                          ↓
                                   存档到 data/
                                          ↓
                                   桌面通知
                                          ↓
                                   hanako 定时处理
```

- **monitor.mjs**：持久化守护进程（PM2），WebSocket 实时接收邮件推送
- 启动时自动扫描未读邮件，避免遗漏
- 所有配置通过 `.env` 注入，不硬编码凭据
- 不自动回复，新邮件进入待处理队列由 hanako 定时巡检

## 快速开始

```bash
# 克隆
git clone https://github.com/Yuexiye/openhanako-email-bridge.git
cd openhanako-email-bridge

# 安装依赖
npm install

# 配置环境变量（必填）
export CLAWEMAIL_API_KEY=your_api_key_here
export CLAWEMAIL_ADDRESS=your_email@example.com
export CLAWEMAIL_HOME_EMAIL=admin@example.com   # 可选

# 启动
pm2 start ecosystem.config.cjs

# 安装日志轮转（防止日志文件无限增长）
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5

# 持久化（开机自启）
pm2 save

# 查看状态
pm2 status
pm2 logs email-monitor
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `CLAWEMAIL_API_KEY` | 是 | ClawEmail API Key |
| `CLAWEMAIL_ADDRESS` | 是 | 监听邮箱地址 |
| `CLAWEMAIL_HOME_EMAIL` | 否 | 主账号邮箱（跳过自动回复） |

## 目录结构

```
email-monitor/
├── monitor.mjs          # 主程序
├── .env.example         # 环境变量模板
├── package.json
└── data/                # 邮件存档（gitignored）
    ├── _pending/        # 临时队列
    ├── _processed.json  # 已处理邮件 ID
    └── <mailId>/        # 单封邮件存档
```

## License

MIT
