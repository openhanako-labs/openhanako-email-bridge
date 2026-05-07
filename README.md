# openhanako-email-bridge

Hanako 邮件监听与自动回复服务。通过 ClawEmail WebSocket Push 实时接收新邮件，存档并发送自动确认回复。事件驱动，无需轮询。
码放这儿了，自取：

CLAW2860DD50A3D6

CLAW3CD4B6A418A5

CLAWB852ED898A5D

CLAW53BFB78087F2

CLAW2DA5FC020035（已用）

已用的请说一声

## 架构

```
发件人 → ClawEmail → WebSocket Push → monitor.mjs
                                          ↓
                                   存档到 data/
                                          ↓
                                   发送自动回复
                                          ↓
                                   桌面通知
```

- **monitor.mjs**：持久化守护进程（PM2），WebSocket 实时接收邮件推送
- 启动时自动扫描未读邮件，避免遗漏
- 来自主账号的邮件不触发自动回复

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
pm2 start monitor.mjs --name "email-monitor"

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
