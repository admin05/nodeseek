/**
 * @name         NodeSeek 签到 (Arcadia)
 * @description  Arcadia 平台自动签到领鸡腿
 * @version      1.4.0
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const https = require("https");
const dns = require("dns");
const { readFileSync, existsSync } = require("fs");
const { resolve, dirname } = require("path");
const { fileURLToPath } = require("url");

const BARK_KEY = process.env.BARK;
const SCRIPT_NAME = "NodeSeek 签到";

// ────────── 日志工具 ──────────
const log = {
  info: (...args) => console.log(`[${SCRIPT_NAME}]`, ...args),
  warn: (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args),
  error: (...args) => console.error(`[${SCRIPT_NAME}]`, ...args),
};

// ────────── Bark 推送 ──────────
async function barkPush(title, body, url = "") {
  if (!BARK_KEY) {
    log.warn("BARK 环境变量未设置，跳过推送");
    return;
  }
  try {
    const res = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title, body, device_key: BARK_KEY, group: "nodeseek", ...(url ? { url } : {}) }),
    });
    const result = await res.json();
    if (result.code === 200) {
      log.info("Bark 推送成功");
    } else {
      log.warn("Bark 推送返回异常:", JSON.stringify(result));
    }
  } catch (err) {
    log.error("Bark 推送失败:", err.message);
  }
}

// ────────── 读取配置 ──────────
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = resolve(__dirname, "config.json");
  if (!existsSync(configPath)) {
    log.error("config.json 不存在，请复制 config.example.json 并填写 Headers");
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    log.error("config.json 解析失败:", err.message);
    process.exit(1);
  }
}

// ────────── 使用公共 DNS 解析真实 IP ──────────
async function resolveRealIp(hostname) {
  const resolvers = [
    { server: "1.1.1.1", name: "Cloudflare" },
    { server: "8.8.8.8", name: "Google" },
  ];
  // Try each public DNS server
  for (const { server, name } of resolvers) {
    try {
      const addresses = await dns.promises.resolve4(hostname, { server });
      log.info(`[DNS] ${name}(${server}) 解析 ${hostname}: ${addresses.join(", ")}`);
      return addresses[0];
    } catch {
      log.warn(`[DNS] ${name} 解析失败，尝试下一个...`);
    }
  }
  // Fallback: system DNS
  try {
    const addresses = await dns.promises.resolve4(hostname);
    log.info(`[DNS] 系统DNS 解析 ${hostname}: ${addresses.join(", ")}`);
    return addresses[0];
  } catch (err) {
    log.error(`[DNS] 所有 DNS 解析失败: ${err.message}`);
    return null;
  }
}

// ────────── 诊断代理环境 ──────────
function diagnoseProxy() {
  const info = [];
  for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    if (process.env[v]) info.push(`${v}=${process.env[v]}`);
  }
  for (const v of ["NO_PROXY", "no_proxy"]) {
    if (process.env[v]) info.push(`${v}=${process.env[v]}`);
  }
  return info;
}

// ────────── 直连请求 ──────────
function directRequest(url, options, resolvedIp) {
  const parsedUrl = new URL(url);
  const postData = options.body || "";
  const connectHost = resolvedIp || parsedUrl.hostname;

  log.info(`直连 ${connectHost}:443`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: connectHost,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        ...options.headers,
        "Content-Length": Buffer.byteLength(postData),
      },
      servername: parsedUrl.hostname,
      timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        text: async () => data,
      }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", (err) => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

// ────────── 签到主逻辑 ──────────
async function checkin(config) {
  const url = "https://www.nodeseek.com/api/attendance?random=true";

  const requestHeaders = {
    "Connection": config.Connection || "keep-alive",
    "Accept-Encoding": config["Accept-Encoding"] || "gzip, deflate, br",
    "Content-Type": config["Content-Type"] || "application/json;charset=UTF-8",
    "Origin": config.Origin || "https://www.nodeseek.com",
    "refract-sign": config["refract-sign"] || "",
    "User-Agent": config["User-Agent"] || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "refract-key": config["refract-key"] || "",
    "Sec-Fetch-Mode": config["Sec-Fetch-Mode"] || "cors",
    "Cookie": config.Cookie || "",
    "Host": config.Host || "www.nodeseek.com",
    "Referer": config.Referer || "https://www.nodeseek.com/",
    "Accept": config["Accept"] || "application/json, text/plain, */*",
    "Accept-Language": config["Accept-Language"] || "zh-CN,zh;q=0.9",
  };

  // 诊断代理
  const proxyInfo = diagnoseProxy();
  if (proxyInfo.length > 0) {
    log.info("[诊断] 检测到代理:");
    proxyInfo.forEach((p) => log.info(`  ${p}`));
    log.info("[诊断] 将通过公共 DNS 获取真实 IP 直连");
  }

  // 用公共 DNS 解析真实 IP，避开代理 DNS 污染
  const realIp = await resolveRealIp("www.nodeseek.com");
  if (!realIp) {
    log.error("无法解析 www.nodeseek.com 的 IP，退出");
    process.exit(1);
  }

  log.info("开始签到...");
  const startTime = Date.now();

  try {
    const response = await directRequest(url, { method: "POST", headers: requestHeaders }, realIp);

    const status = response.status;
    const bodyText = await response.text();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    let message = bodyText;
    try { const parsed = JSON.parse(bodyText); message = parsed.message || message; } catch {}

    log.info(`状态码: ${status} | 耗时: ${elapsed}s | 响应: ${message}`);

    if (status >= 200 && status < 300) {
      await barkPush(`${SCRIPT_NAME} ✅ 签到成功`, message, "https://www.nodeseek.com");
      return { success: true, message };
    }
    if (status === 500 && (message.includes("已完成签到") || message.includes("重复操作"))) {
      log.info("今日已签到");
      await barkPush(`${SCRIPT_NAME} ℹ️ 今日已签到`, "今天已经领过鸡腿啦，明天再来吧~");
      return { success: true, message: "今日已签到" };
    }
    if (status === 403) {
      log.warn("403 风控:", message);
      await barkPush(`${SCRIPT_NAME} ❌ 风控`, `暂时被风控，稍后再试\n内容：${message}`);
      return { success: false, message: `403 风控: ${message}` };
    }
    log.warn(`${status} 异常:`, message);
    await barkPush(`${SCRIPT_NAME} ⚠️ ${status} 异常`, message);
    return { success: false, message: `${status}: ${message}` };
  } catch (err) {
    log.error("请求失败:", `${err.code || err.message}${err.message ? " (" + err.message + ")" : ""}`);
    log.error("错误类型:", err.constructor?.name || "unknown");
    await barkPush(`${SCRIPT_NAME} ❌ 请求失败`, err.message || err.code || "未知错误");
    return { success: false, message: err.message };
  }
}

async function main() {
  log.info("启动");
  const config = loadConfig();

  if (!config.Cookie) {
    log.error("Cookie 为空，请填写 config.json 中的 Cookie");
    await barkPush(`${SCRIPT_NAME} ❌ 配置错误`, "Cookie 为空，请检查 config.json");
    process.exit(1);
  }

  const result = await checkin(config);
  log.info("执行完成");
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  log.error("未捕获异常:", err.constructor?.name, err.message);
  barkPush(`${SCRIPT_NAME} ❌ 脚本异常`, err.message);
  process.exit(1);
});
