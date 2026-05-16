/**
 * hanako 邮件监听服务
 * 
 * 通过 ClawEmail WebSocket Push 实时接收新邮件通知，
 * 保存邮件内容到本地存档，立即处理并发送自动回复。
 * 事件驱动，无需 cron 轮询。
 * 
 * 运行方式：pm2 start monitor.mjs --name "email-monitor"
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// ── 加载 .env（gitignored，不上传） ───────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, ".env");
try {
  const lines = fs.readFileSync(envFile, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
} catch {}

// ── 配置 ────────────────────────────────────────────────
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`缺少环境变量 ${name}，请设置后重启`);
  return val;
}

const CONFIG = {
  apiKey: requireEnv("CLAWEMAIL_API_KEY"),
  email: requireEnv("CLAWEMAIL_ADDRESS"),
  user: requireEnv("CLAWEMAIL_ADDRESS"),
  homeEmail: process.env.CLAWEMAIL_HOME_EMAIL || "",
  logDir: path.join(__dirname, "logs"),
  dataDir: path.join(__dirname, "data"),
};

// ── 初始化 ─────────────────────────────────────────────
fs.mkdirSync(CONFIG.logDir, { recursive: true });
fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const PENDING_DIR = path.join(CONFIG.dataDir, "_pending");
const PROCESSED_FILE = path.join(CONFIG.dataDir, "_processed.json");
fs.mkdirSync(PENDING_DIR, { recursive: true });

// ── 日志 ────────────────────────────────────────────────
const logFile = path.join(CONFIG.logDir, `email-${new Date().toISOString().slice(0, 10)}.log`);
function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const entry = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  console.log(entry);
  try { fs.appendFileSync(logFile, entry + "\n"); } catch {}
}

// ── 已处理记录 ─────────────────────────────────────────
function getProcessedSet() {
  try { return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8"))); } catch { return new Set(); }
}
function saveProcessedSet(set) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set]));
}

// ── 验证码提取 ────────────────────────────────────────
function extractCode(text) {
  // 优先匹配「验证码(是|为|：|:)」后面的数字串
  const nearMatch = text.match(/验证码[是为：:]\s*(\d{4,8})/);
  if (nearMatch) return nearMatch[1];
  // 其次匹配任何独立的 4-8 位数字（前后非数字）
  const anyMatch = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return anyMatch ? anyMatch[1] : null;
}

// ── 桌面通知 ───────────────────────────────────────────
function desktopNotify(title, body) {
  try {
    const safeTitle = title.replace(/['"]/g, "").slice(0, 60);
    const safeBody = body.replace(/['"]/g, "").slice(0, 120);
    const psCmd = `powershell -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${safeBody}','📬 ${safeTitle}','OK','Information')}"`;
    execSync(psCmd, { timeout: 3000, windowsHide: true });
  } catch (e) {
    log("WARN", "桌面通知发送失败", { err: e.message });
  }
}

// ── 邮件处理 ────────────────────────────────────────────
async function processNewEmail(client, mailId) {
  log("INFO", "收到新邮件通知", { mailId });

  // 去重
  const processed = getProcessedSet();
  if (processed.has(mailId)) { log("INFO", "跳过已处理邮件"); return; }

  try {
    // 1. 读取邮件内容
    const email = await client.mail.read({ id: mailId, markRead: true });
    log("INFO", "已读取邮件", {
      from: email.from,
      subject: email.subject?.slice(0, 40),
      hasAttachments: !!email.attachments?.length,
    });

    // 2. 跳过自己发出的邮件
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    if (fromArr.some(f => f.includes(CONFIG.email))) {
      log("INFO", "跳过自己发出的邮件");
      processed.add(mailId); saveProcessedSet(processed);
      return;
    }

    // 3. 跳过系统通知（noreply、verify 等）
    //    白名单：标题含"验证码"/"verification code"的邮件放行，不跳过
    const fromStr = fromArr.join(" ");
    const subjectStr = email.subject || "";
    const textContent = email.text?.content || email.html?.content || "";
    const isCodeWhitelist = /验证码|verification code|verify code/i.test(subjectStr);
    if (!isCodeWhitelist && (
        /noreply@|no-reply@|notifications@/i.test(fromStr) ||
        /verify your email|please verify/i.test(subjectStr))) {
      log("INFO", "跳过系统通知邮件");
      processed.add(mailId); saveProcessedSet(processed);
      return;
    }

    // 4. 保存邮件到本地存档
    const safeId = mailId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const emailDir = path.join(CONFIG.dataDir, safeId);
    fs.mkdirSync(emailDir, { recursive: true });
    fs.writeFileSync(path.join(emailDir, "email.json"), JSON.stringify({
      mailId, from: email.from, to: email.to,
      subject: email.subject, date: email.date,
      textContent,
      hasHtml: !!email.html?.content,
      attachments: email.attachments?.map(a => ({
        id: a.id, filename: a.filename, contentType: a.contentType, size: a.size
      })),
    }, null, 2));

    // 5. 下载附件
    if (email.attachments?.length) {
      for (const att of email.attachments) {
        try {
          const stream = await client.mail.getAttachment({ id: mailId, part: att.id });
          await stream.writeFile(path.join(emailDir, att.filename || `attachment_${att.id}`));
          log("INFO", "附件已保存", { filename: att.filename });
        } catch (e) {
          log("WARN", "附件下载失败", { id: att.id, err: e.message });
        }
      }
    }

    // 6. 写入待处理队列（等 hanako 来取）
    const pendingFile = path.join(PENDING_DIR, `${safeId}.json`);
    fs.writeFileSync(pendingFile, JSON.stringify({
      mailId, safeId,
      from: fromStr,
      subject: email.subject,
      date: email.date,
      textContent,
      textPreview: textContent.slice(0, 200),
      emailDir,
      hasAttachments: !!(email.attachments?.length),
      receivedAt: new Date().toISOString(),
    }, null, 2));
    log("INFO", "已加入待处理队列", { pendingFile });

    // 7. 立即处理——发送自动确认回复
    const isHomeEmail = fromArr.some(f => f.includes(CONFIG.homeEmail));
    if (isHomeEmail) {
      log("INFO", "来自主账号的邮件，跳过自动回复", { from: fromStr });
    } else {
      try {
        const safeSubject = (email.subject || "").replace(/['"]/g, "").slice(0, 80);
        const replyBody = `您好，\n\n已收到您的邮件，我会尽快查阅并回复。\n\n感谢来信。\n\n祝好，\n${CONFIG.email}`;
        execSync(
          `mail-cli --profile kimilophelia compose send ` +
          `--to "${fromStr}" ` +
          `--subject "Re: ${safeSubject}" ` +
          `--body "${replyBody}"`,
          { timeout: 15000, windowsHide: true }
        );
        log("INFO", "自动回复已发送", { to: fromStr, subject: safeSubject });
      } catch (e) {
        log("WARN", "自动回复发送失败", { err: e.message });
      }
    }

    // 8. 标记已处理，清理待处理队列
    processed.add(mailId);
    saveProcessedSet(processed);
    try { fs.unlinkSync(pendingFile); } catch {}
    log("INFO", "邮件处理完成", { mailId });

    // 9. 桌面通知（按邮件类型显示不同内容）
    const senderName = fromStr.split("<")[0].trim() || "新邮件";
    let notifyBody;
    if (isCodeWhitelist && textContent) {
      const code = extractCode(textContent);
      notifyBody = code
        ? `验证码：${code}`
        : `📧 ${email.subject || "(无主题)"}`;
    } else if (textContent) {
      const preview = textContent.replace(/\s+/g, " ").trim().slice(0, 80);
      notifyBody = `${email.subject || "(无主题)"}\n${preview}`;
    } else {
      notifyBody = `${email.subject || "(无主题)"}`;
    }
    desktopNotify(senderName, notifyBody);

  } catch (e) {
    log("ERROR", "处理邮件失败", { mailId, err: e.message, stack: e.stack?.slice(0, 200) });
  }

  // 确保已处理记录持久化
  try { saveProcessedSet(getProcessedSet()); } catch {}
}

// ── 启动时扫描已有未读邮件 ──────────────────────
async function scanExistingUnread(client) {
  try {
    log("INFO", "扫描已有未读邮件...");
    const unread = await client.transport.listMessages({ fid: 1, unread: true, limit: 50 });
    if (unread.length === 0) { log("INFO", "没有未读邮件"); return; }
    log("INFO", "发现未读邮件", { count: unread.length });
    for (const msg of unread) {
      await processNewEmail(client, msg.id);
    }
  } catch (e) {
    log("WARN", "扫描未读邮件失败", { err: e.message });
  }
}

// ── 主函数 ──────────────────────────────────────────────
async function main() {
  log("INFO", "=".repeat(50));
  log("INFO", "hanako 邮件监听服务启动", { email: CONFIG.email });

  let client;
  try {
    client = new MailClient({
      user: CONFIG.user, apiKey: CONFIG.apiKey,
      logger: {
        info: (msg, data) => log("WS", msg, data && typeof data === "object" ? data : { msg: data }),
        warn: (msg, data) => log("WS_WARN", msg, data && typeof data === "object" ? data : { msg: data }),
        error: (msg, data) => log("WS_ERROR", msg, data && typeof data === "object" ? data : { msg: data }),
      },
    });

    await client.getAccessToken();
    log("INFO", "MailClient 验证通过");

    client.ws.onMessage(async (notification) => {
      if (notification?.mailId) await processNewEmail(client, notification.mailId);
    });
    client.ws.onDisconnect((reason) => log("WARN", "WebSocket 断开", { reason }));

    await client.ws.connect();
    log("INFO", "✅ WebSocket 推送已连接");

    await scanExistingUnread(client);

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
    process.on("uncaughtException", (e) => log("ERROR", "未捕获异常", { err: e.message }));

    async function gracefulShutdown() {
      log("INFO", "正在停止服务...");
      try { client.ws.disconnect(); } catch {}
      log("INFO", "服务已停止");
      process.exit(0);
    }
  } catch (e) {
    log("ERROR", "服务启动失败", { err: e.message, stack: e.stack?.slice(0, 500) });
    process.exit(1);
  }
}

main();
