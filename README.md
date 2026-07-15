# openhanako-email-bridge


![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)


Hanako 邮件监听与管理服务。事件驱动的被动监听 + 助手自治的主动管理。

## 架构

```
发件人 → ClawEmail WebSocket / AgentQQ CLI 轮询 → monitor.mjs
                                                     ↓
                                              访客意识路由 → 脱敏 → 存档
                                                     ↓
                                              桌面通知
                                                     ↓
                  inbox.mjs（助手主动管理：列表/阅读/回复/转发/归档）
                          ↓
            clawemail-backend.mjs（SDK 列表/搜索 + mail-cli 移动/标记）
            agentqq-backend.mjs（agently-cli）
```

### 模块说明

| 文件 | 职责 |
|------|------|
| `monitor.mjs` | 守护进程（PM2），被动接收新邮件 |
| `identity.mjs` | 访客意识引擎，身份路由 + 隐私脱敏 |
| `agentqq-adapter.mjs` | AgentQQ CLI 轮询适配器 |
| `inbox.mjs` | **统一入口**——按 account 自动选 backend |
| `clawemail-backend.mjs` | ClawEmail 封装（SDK 列表/搜索/读写 + mail-cli 移动/标记） |
| `agentqq-backend.mjs` | AgentQQ 封装（agently-cli 全部能力） |
| `scripts/daily-summary.mjs` | 每日摘要 → 桌面通知 |
| `scripts/smart-reply.mjs` | 智能回复辅助（基于 data/ 存档） |

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 ClawEmail API Key 与邮箱地址

# 启动守护进程
pm2 start ecosystem.config.cjs

# 安装日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
pm2 save
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `CLAWEMAIL_API_KEY` | 是 | ClawEmail API Key |
| `CLAWEMAIL_ADDRESS` | 是 | 监听主邮箱 |
| `CLAWEMAIL_EXTRA_ADDRESSES` | 否 | 额外 ClawEmail 邮箱，逗号分隔 |
| `CLAWEMAIL_HOME_EMAIL` | 否 | 主账号（跳过自动回复） |
| `AGENTQQ_EXTRA_ADDRESSES` | 否 | AgentQQ 邮箱，逗号分隔 |
| `AGENTQQ_POLL_INTERVAL_SEC` | 否 | AgentQQ 轮询间隔，默认 60 |
| `EMAIL_IDENTITY_MAP` | 否 | 访客意识映射 |
| `EMAIL_INTERNAL_CONTACTS` | 否 | 内部联系人（白名单） |

## 访客意识

### 身份路由

| 身份 | 规则 |
|------|------|
| `ophelia` / `luoqixi` / `aimis` / `alice` | 高优先级、通知、自动标签 |
| `yuexiye` | 中优先级、通知、自动标签 `[yuexiye, owner]` |
| `unknown` | 低优先级、通知、自动标签 `[unclassified]` |

配置示例：

```env
EMAIL_IDENTITY_MAP=ophelia@claw.163.com=ophelia,luoqixi@claw.163.com=luoqixi,owner@qq.com=yuexiye
```

### 对外意识

外部访客邮件自动脱敏（路径、凭证、邮箱、手机号），默认不自动回复。

## 主动管理（inbox.mjs）

`inbox.mjs` 提供助手自治的邮件操作能力。按目标账号自动选 backend：

- `xxx@claw.163.com` → `clawemail-backend.mjs`（SDK 列表 + mail-cli 移动）
- `xxx@agent.qq.com` → `agentqq-backend.mjs`（agently-cli）

### 能力矩阵

| 操作 | ClawEmail | AgentQQ |
|---|---|---|
| list / search | ✅ SDK（含 fid 过滤 + 缓存） | ✅ agently-cli |
| read（含 body） | ✅ SDK | ✅ agently-cli |
| send | ✅ SDK | ✅ agently-cli |
| reply | ✅ SDK | ✅ agently-cli |
| forward | ❌ SDK 不支持 | ✅ agently-cli |
| download attachment | ✅ SDK | ✅ agently-cli |
| move / mark | ✅ mail-cli | ⚠️ markRead 仅支持已读 |

### 白名单逻辑

- **内部联系人**（`EMAIL_INTERNAL_CONTACTS`）→ 直接发送
- **外部访客** → 写入 `data/_pending_send/` 队列，等待桌面通知确认

### CLI 用法

```bash
# 列出收件箱邮件
node inbox.mjs list kimilophelia@claw.163.com --limit=20

# 列出垃圾邮件（fid=5）
node inbox.mjs list kimilophelia@claw.163.com --fid=5 --limit=20

# 搜索邮件
node inbox.mjs search kimilophelia@claw.163.com "verify" --limit=20

# 阅读邮件
node inbox.mjs read kimilophelia@claw.163.com <messageId>

# 发送邮件
node inbox.mjs send kimilophelia@claw.163.com --to=x@y.com --subject="..." --body="..."

# 回复邮件
node inbox.mjs reply kimilophelia@claw.163.com <messageId> --body="..."

# 标记已读
node inbox.mjs mark-read kimilophelia@claw.163.com <messageId>

# 列出文件夹
node inbox.mjs folders kimilophelia@claw.163.com
```

### 模块导入

```javascript
import {
  listMessages, searchMessages, readMessage,
  sendMail, reply, forward,
  downloadAttachment, moveMessage, markRead,
  listFolders,
} from "./inbox.mjs";

// 列出爱弥斯邮箱的未读邮件
const unread = await listMessages("aimilghost@agent.qq.com", { isUnread: true });

// 读取正文
const mail = await readMessage("aimilghost@agent.qq.com", "msg_001");
console.log(mail.subject, mail.body);
```

## 脚本

### 每日摘要

```bash
# 桌面通知（早上弹一次）
node scripts/daily-summary.mjs

# JSON 输出（调试）
node scripts/daily-summary.mjs --json

# 按身份过滤
node scripts/daily-summary.mjs --identity=ophelia
```

### 智能回复

```bash
# 查看上下文 + 生成回复草稿
node scripts/smart-reply.mjs <mailId> --days 3

# 只看上下文
node scripts/smart-reply.mjs <mailId> --context
```

## 目录结构

```
email-monitor/
├── monitor.mjs                  # 守护进程（PM2）
├── identity.mjs                 # 访客意识引擎
├── agentqq-adapter.mjs          # AgentQQ 适配
├── inbox.mjs                    # 统一入口
├── clawemail-backend.mjs        # ClawEmail 封装
├── agentqq-backend.mjs          # AgentQQ 封装
├── scripts/
│   ├── daily-summary.mjs        # 每日摘要 → 桌面通知
│   └── smart-reply.mjs          # 智能回复辅助
├── data/                        # 邮件存档
│   ├── _pending/                # 待处理邮件
│   ├── _pending_send/           # 待确认发送（白名单外部）
│   └── _processed.json          # 已处理记录
├── .env                         # 环境变量
├── .env.example
├── ecosystem.config.cjs         # PM2 配置
└── package.json
```

## License

[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html)