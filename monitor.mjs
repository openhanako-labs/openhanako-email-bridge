/**
 * hanako 邮件监听服务
 * 
 * 双平台监听：
 *   1. ClawEmail — WebSocket 实时推送（事件驱动）
 *   2. AgentQQ   — CLI 轮询（每 60 秒，可通过 AGENTQQ_POLL_INTERVAL_SEC 调整）
 * 
 * 统一处理管道：去重 → 访客意识路由 → 脱敏 → 存档 → 通知
 * 
 * 运行方式：pm2 start ecosystem.config.cjs --name "email-monitor"
 * 
 * 多账号配置方式（.env）：
 *   CLAWEMAIL_API_KEY=...                    # ClawEmail API Key
 *   CLAWEMAIL_ADDRESS=...                    # ClawEmail 主账号
 *   CLAWEMAIL_EXTRA_ADDRESSES=...            # ClawEmail 额外账号，逗号分隔
 *   AGENTQQ_EXTRA_ADDRESSES=...              # AgentQQ 额外邮箱，逗号分隔
 *   EMAIL_IDENTITY_MAP=...                   # 访客意识映射，addr=identity,addr=identity
 *   EMAIL_INTERNAL_CONTACTS=...              # 内部联系人，逗号分隔
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import { buildFromEnv } from "./identity.mjs";
import { pollLoop as agentqqPollLoop } from "./agentqq-adapter.mjs";

// ── 加载 .env（使用 dotenv，支持引号、注释、转义） ───────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(__dirname, ".env") });
} catch {
  // dotenv 未安装时 fallback 到简单解析
  const envFile = path.join(__dirname, ".env");
  try {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // 去除引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {}
}

// ── 配置 ────────────────────────────────────────────────
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`缺少环境变量 ${name}，请设置后重启`);
  return val;
}

const API_KEY = requireEnv("CLAWEMAIL_API_KEY");
const PRIMARY_EMAIL = requireEnv("CLAWEMAIL_ADDRESS");
const CLAW_EXTRA_EMAILS = (process.env.CLAWEMAIL_EXTRA_ADDRESSES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const AGENTQQ_EXTRA_ADDRESSES = (process.env.AGENTQQ_EXTRA_ADDRESSES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// 构建 ClawEmail 账号列表，每个账号有 id 和 email
const ACCOUNTS = [
  { id: "default", email: PRIMARY_EMAIL },
  ...CLAW_EXTRA_EMAILS.map(email => {
    const prefix = email.split("@")[0];
    const id = prefix.includes(".") ? prefix.split(".").pop() : prefix;
    return { id, email };
  }),
];

// AgentQQ 地址列表（由 adapter 自动检测主地址 + 额外地址）
const AGENTQQ_ADDRESSES = AGENTQQ_EXTRA_ADDRESSES;

// 合并所有地址用于 identity map 兜底
const ALL_ADDRESSES = [
  ...ACCOUNTS.map(a => a.email),
  ...AGENTQQ_ADDRESSES,
];

const CONFIG = {
  apiKey: API_KEY,
  homeEmail: process.env.CLAWEMAIL_HOME_EMAIL || "",
  dataDir: path.join(__dirname, "data"),
  // Token 刷新失败保护
  maxTokenRetries: 5,
  tokenRetryDelayMs: 5000,
  // 重连保护
  maxReconnectRetries: 10,
  reconnectBaseDelayMs: 2000,
  // 访客意识
  awareness: (() => {
    const awareness = buildFromEnv();
    // 兜底：把所有地址（ClawEmail + AgentQQ）都自动纳入映射
    for (const addr of ALL_ADDRESSES) {
      const lower = addr.toLowerCase();
      if (!awareness.map.has(lower)) {
        // 尝试从地址派生身份（取 @ 前最后一部分）
        const prefix = lower.split("@")[0];
        const id = prefix.includes(".") ? prefix.split(".").pop() : prefix;
        awareness.map.set(lower, id);
      }
    }
    return awareness;
  })(),
};

// ── 初始化 ─────────────────────────────────────────────
fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const PENDING_DIR = path.join(CONFIG.dataDir, "_pending");
fs.mkdirSync(PENDING_DIR, { recursive: true });

// ── 日志 ────────────────────────────────────────────────
function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const entry = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  console.log(entry);
}

// ── 已处理记录（按账号分片，避免并发冲突） ──────────────
function getProcessedFile(accountId) {
  return path.join(CONFIG.dataDir, `_processed_${accountId}.json`);
}

function getProcessedSet(accountId) {
  try { return new Set(JSON.parse(fs.readFileSync(getProcessedFile(accountId), "utf-8"))); } catch { return new Set(); }
}

function saveProcessedSet(accountId, set) {
  fs.writeFileSync(getProcessedFile(accountId), JSON.stringify([...set]));
}

// ── 验证码提取 ────────────────────────────────────────
function extractCode(text) {
  const nearMatch = text.match(/验证码[是为：:]\s*(\d{4,8})/);
  if (nearMatch) return nearMatch[1];
  const anyMatch = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return anyMatch ? anyMatch[1] : null;
}

// ── 桌面通知（使用 node-notifier，避免命令注入） ────────
function desktopNotify(title, body) {
  try {
    notifier.notify({
      title: `📬 ${title.slice(0, 60)}`,
      message: body.slice(0, 200),
      sound: false,
      wait: false,
    });
  } catch (e) {
    log("WARN", "桌面通知发送失败", { err: e.message });
  }
}

// ── 延迟函数 ───────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 指数退避 ───────────────────────────────────────────
function exponentialBackoff(attempt, baseDelay) {
  return Math.min(baseDelay * Math.pow(2, attempt), 60000); // 最大 60 秒
}

// ── ClawEmail 邮件处理（包装器，调用通用处理） ─────
async function processNewEmail(client, mailId, accountEmail, accountId) {
  log("INFO", "收到新邮件通知", { mailId, account: accountId });

  // 去重
  const processed = getProcessedSet(accountId);
  if (processed.has(mailId)) { log("INFO", "跳过已处理邮件"); return; }

  try {
    // 读取邮件内容
    const email = await client.mail.read({ id: mailId, markRead: true });
    log("INFO", "已读取邮件", {
      from: email.from,
      subject: email.subject?.slice(0, 40),
      hasAttachments: !!email.attachments?.length,
    });

    // 调用通用处理管道
    await handleEmailProcess(email, mailId, accountEmail, accountId);

    // ClawEmail 特有：下载附件
    if (email.attachments?.length) {
      for (const att of email.attachments) {
        try {
          const stream = await client.mail.getAttachment({ id: mailId, part: att.id });
          const safeId = mailId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const emailDir = path.join(CONFIG.dataDir, safeId);
          await stream.writeFile(path.join(emailDir, att.filename || `attachment_${att.id}`));
          log("INFO", "附件已保存", { filename: att.filename });
        } catch (e) {
          log("WARN", "附件下载失败", { id: att.id, err: e.message });
        }
      }
    }

  } catch (e) {
    log("ERROR", "处理邮件失败", { mailId, err: e.message, stack: e.stack?.slice(0, 200) });
  }
}

// ── AgentQQ 邮件处理入口（统一格式） ─────────────
async function processAgentQQEmail(email, accountEmail, accountId) {
  // 将 AgentQQ 邮件格式转换为内部处理所需的结构
  const mailId = email.id || `aq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  // 构建类似 ClawEmail 的邮件对象
  const normalizedEmail = {
    id: mailId,
    from: email.from || "",
    to: email.to || accountEmail,
    subject: email.subject || "",
    date: email.date || new Date().toISOString(),
    text: { content: email.text?.content || "" },
    html: email.html ? { content: email.html.content || "" } : null,
    attachments: email.attachments || [],
    headers: email.headers || {},
  };

  // 复用现有的 processNewEmail 逻辑，但需要独立的处理函数
  // 这里直接内联核心处理流程
  await handleEmailProcess(normalizedEmail, mailId, accountEmail, accountId);
}

// ── 通用邮件处理（ClawEmail 和 AgentQQ 共用） ─────
async function handleEmailProcess(email, mailId, accountEmail, accountId) {
  log("INFO", "收到新邮件", { mailId, account: accountId });

  // 去重
  const processed = getProcessedSet(accountId);
  if (processed.has(mailId)) { log("INFO", "跳过已处理邮件"); return; }

  try {
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    const fromStr = fromArr.join(" ");
    const subjectStr = email.subject || "";
    const textContent = email.text?.content || email.html?.content || "";

    // 跳过自己发出的邮件
    if (fromArr.some(f => f.includes(accountEmail))) {
      log("INFO", "跳过自己发出的邮件", { accountEmail });
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    // 访客意识路由
    const awareness = CONFIG.awareness;
    const { identity, rules, isExternal } = awareness.route(email, accountEmail);
    log("INFO", "访客意识路由", { identity, isExternal });

    // 对外意识：外部访客隐私过滤
    let scrubText = null;
    if (isExternal) {
      scrubText = awareness.scrub(textContent);
    }

    const effectiveText = scrubText || textContent;
    const isCodeWhitelist = /验证码|verification code|verify code/i.test(subjectStr);
    const isSystemNotification = /noreply@|no-reply@|notifications@/i.test(fromStr) ||
                                  /verify your email|please verify/i.test(subjectStr);

    // 跳过外部系统通知
    if (isExternal && isSystemNotification && !isCodeWhitelist) {
      log("INFO", "对外部系统通知，跳过");
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    // 跳过内部系统通知
    if (!isExternal && !isCodeWhitelist && (
        /noreply@|no-reply@|notifications@/i.test(fromStr) ||
        /verify your email|please verify/i.test(subjectStr))) {
      log("INFO", "跳过系统通知邮件");
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    // 保存邮件到本地存档
    const safeId = mailId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const emailDir = path.join(CONFIG.dataDir, safeId);
    fs.mkdirSync(emailDir, { recursive: true });
    fs.writeFileSync(path.join(emailDir, "email.json"), JSON.stringify({
      mailId, from: email.from, to: email.to,
      subject: email.subject, date: email.date,
      textContent, scrubbedText: scrubText,
      hasHtml: !!email.html?.content,
      identity, identityRules: rules, isExternal,
      replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none"),
      autoTags: rules.autoTag,
      attachments: email.attachments?.map(a => ({
        id: a.id, filename: a.filename, contentType: a.contentType, size: a.size
      })),
      platform: accountId === "agentqq" ? "agentqq" : "clawemail",
    }, null, 2));

    // 写入待处理队列
    const pendingFile = path.join(PENDING_DIR, `${safeId}.json`);
    fs.writeFileSync(pendingFile, JSON.stringify({
      mailId, safeId,
      from: fromStr, subject: email.subject, date: email.date,
      textContent, scrubbedText: scrubText,
      textPreview: effectiveText.slice(0, 200),
      identity, identityRules: rules, isExternal,
      replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none"),
      autoTags: rules.autoTag,
      emailDir,
      hasAttachments: !!(email.attachments?.length),
      receivedAt: new Date().toISOString(),
    }, null, 2));

    // 标记已处理
    processed.add(mailId);
    saveProcessedSet(accountId, processed);
    try { fs.unlinkSync(pendingFile); } catch {}

    // 桌面通知
    const senderName = fromStr.split("<")[0].trim() || "新邮件";
    let notifyBody;
    const previewSource = isExternal ? (scrubText || textContent) : textContent;
    if (isCodeWhitelist && textContent) {
      const code = extractCode(textContent);
      notifyBody = code ? `验证码：${code}` : `📧 ${email.subject || "(无主题)"}`;
    } else if (previewSource) {
      const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 80);
      notifyBody = `${email.subject || "(无主题)"}\n${preview}`;
    } else {
      notifyBody = `${email.subject || "(无主题)"}`;
    }

    const identityBadge = identity !== "unknown" ? `[${identity}]` : "[外部]";
    const externalBadge = isExternal ? "🔒" : "";
    desktopNotify(`${externalBadge}${identityBadge} ${senderName}`, notifyBody);

    log("INFO", "邮件处理完成", { mailId, identity });

  } catch (e) {
    log("ERROR", "处理邮件失败", { mailId, err: e.message });
  }

  try { saveProcessedSet(accountId, getProcessedSet(accountId)); } catch {}
}

// ── 启动时扫描已有未读邮件 ──────────────────────
async function scanExistingUnread(client) {
  try {
    log("INFO", "扫描已有未读邮件...");
    const unread = await client.transport.listMessages({ fid: 1, unread: true, limit: 50 });
    if (unread.length === 0) { log("INFO", "没有未读邮件"); return; }
    log("INFO", "发现未读邮件", { count: unread.length });
    for (const msg of unread) {
      await processNewEmail(client, msg.id, client.user, client.accountId);
    }
  } catch (e) {
    log("WARN", "扫描未读邮件失败", { err: e.message });
  }
}

// ── 启动单个账号的监听（含重连逻辑） ────────────────────
async function startAccount(account) {
  let tokenRetryCount = 0;
  let reconnectRetryCount = 0;

  async function connectWithRetry() {
    while (true) {
      try {
        log("INFO", `[${account.id}] 正在连接 ${account.email} ...`);

        const client = new MailClient({
          user: account.email,
          apiKey: CONFIG.apiKey,
          logger: {
            info: (msg, data) => log("WS", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
            warn: (msg, data) => log("WS_WARN", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
            error: (msg, data) => log("WS_ERROR", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
          },
        });

        // 挂载账号标识，方便后续使用
        client.accountId = account.id;

        // Token 获取（带重试保护）
        try {
          await client.getAccessToken();
          tokenRetryCount = 0; // 重置计数器
          log("INFO", `[${account.id}] MailClient 验证通过`);
        } catch (e) {
          tokenRetryCount++;
          if (tokenRetryCount > CONFIG.maxTokenRetries) {
            log("ERROR", `[${account.id}] Token 获取失败超过上限 (${CONFIG.maxTokenRetries} 次)，退出进程`, { err: e.message });
            process.exit(1);
          }
          const backoff = exponentialBackoff(tokenRetryCount, CONFIG.tokenRetryDelayMs);
          log("WARN", `[${account.id}] Token 获取失败 (第 ${tokenRetryCount} 次)，${backoff}ms 后重试...`);
          await delay(backoff);
          continue;
        }

        // 消息处理
        client.ws.onMessage(async (notification) => {
          if (notification?.mailId) {
            await processNewEmail(client, notification.mailId, account.email, account.id);
          }
        });

        // 断开重连（指数退避 + 上限）
        client.ws.onDisconnect(async (reason) => {
          log("WARN", `[${account.id}] WebSocket 断开: ${reason}`);
          reconnectRetryCount++;

          if (reconnectRetryCount > CONFIG.maxReconnectRetries) {
            log("ERROR", `[${account.id}] 重连次数超过上限 (${CONFIG.maxReconnectRetries} 次)，退出进程`);
            process.exit(1);
          }

          const backoff = exponentialBackoff(reconnectRetryCount, CONFIG.reconnectBaseDelayMs);
          log("INFO", `[${account.id}] 将在 ${backoff}ms 后尝试重连 (第 ${reconnectRetryCount}/${CONFIG.maxReconnectRetries} 次)...`);
          await delay(backoff);

          try {
            await client.ws.connect();
            reconnectRetryCount = 0; // 连接成功后重置
            log("INFO", `[${account.id}] 重连成功`);
          } catch (e) {
            log("ERROR", `[${account.id}] 重连失败`, { err: e.message });
            // 触发下一次 onDisconnect 循环
          }
        });

        await client.ws.connect();
        reconnectRetryCount = 0;
        log("INFO", `[${account.id}] ✅ WebSocket 推送已连接`);

        await scanExistingUnread(client);

        return client;

      } catch (e) {
        log("ERROR", `[${account.id}] 连接失败`, { err: e.message });
        const backoff = exponentialBackoff(reconnectRetryCount, CONFIG.reconnectBaseDelayMs);
        await delay(backoff);
      }
    }
  }

  return connectWithRetry();
}

// ── 主函数 ──────────────────────────────────────────────
async function main() {
  log("INFO", "=".repeat(50));
  log("INFO", `hanako 邮件监听服务启动`);
  log("INFO", `ClawEmail 账号: ${ACCOUNTS.length}`, { accounts: ACCOUNTS.map(a => a.id) });
  log("INFO", `AgentQQ 额外地址: ${AGENTQQ_ADDRESSES.length}`, AGENTQQ_ADDRESSES);
  log("INFO", "访客意识映射", { map: Object.fromEntries(CONFIG.awareness.map) });
  log("INFO", "内部联系人", { contacts: Array.from(CONFIG.awareness.internalContacts) });

  // ── 1. 启动 ClawEmail WebSocket 监听 ─────────
  const clawClients = [];
  const clawStartResults = await Promise.allSettled(
    ACCOUNTS.map(account => startAccount(account))
  );

  for (let i = 0; i < clawStartResults.length; i++) {
    const result = clawStartResults[i];
    if (result.status === "fulfilled") {
      clawClients.push(result.value);
      log("INFO", `[${ACCOUNTS[i].id}] ClawEmail 启动成功`);
    } else {
      log("ERROR", `[${ACCOUNTS[i].id}] ClawEmail 启动失败`, { err: result.reason });
    }
  }

  // ── 2. 启动 AgentQQ 轮询 ────────────────────
  if (AGENTQQ_ADDRESSES.length > 0) {
    log("INFO", "启动 AgentQQ 轮询适配器 (间隔: ${POLL_INTERVAL_SEC}s)...");
    
    // 启动轮询（后台运行，不阻塞）
    agentqqPollLoop(
      async (email, accountEmail, platform) => {
        // 为 AgentQQ 邮件生成唯一 ID 并处理
        const mailId = `aq_${accountEmail.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await handleEmailProcess(email, mailId, accountEmail, "agentqq");
      },
      CONFIG.awareness
    ).catch(e => {
      log("ERROR", "AgentQQ 轮询异常", { err: e.message });
    });
    
    log("INFO", "AgentQQ 轮询已启动");
  } else {
    log("INFO", "未配置 AgentQQ 地址，跳过轮询适配器");
  }

  // 至少有一个平台启动成功
  if (clawClients.length === 0 && AGENTQQ_ADDRESSES.length === 0) {
    log("ERROR", "所有平台启动失败，退出");
    process.exit(1);
  }

  // 信号处理
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  // 未捕获异常：打日志后退出，让 PM2 重启
  process.on("uncaughtException", (e) => {
    log("ERROR", "未捕获异常", { err: e.message, stack: e.stack?.slice(0, 500) });
    process.exit(1);
  });

  // 未处理的 Promise 拒绝
  process.on("unhandledRejection", (reason, promise) => {
    log("ERROR", "未处理的 Promise 拒绝", { reason: String(reason) });
  });

  async function gracefulShutdown() {
    log("INFO", "正在停止服务...");
    for (const c of clawClients) {
      try { c.ws.disconnect(); } catch {}
    }
    log("INFO", "服务已停止");
    process.exit(0);
  }
}

main();
