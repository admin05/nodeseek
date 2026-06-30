import dns from "node:dns";

/**
 * @name         NodeSeek 签到 (Arcadia)
 * @description  Arcadia 平台自动签到领鸡腿
 * @version      1.3.0
 */

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
    const pushUrl = "https://api.day.app/push";
    const payload = { title, body, device_key: BARK_KEY, group: "nodeseek" };
    if (url) payload.url = url;
    const res = await fetch(pushUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
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

// ────────── 诊断工具 ──────────
async function diagnose() {
  const proxyVars = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  for (const v of proxyVars) {
    if (process.env[v]) log.info(`[诊断] ${v}=${process.env[v]}`);
  }
  log.info("[诊断] DNS 系统解析 www.nodeseek.com...");
  try {
    const addresses = await dns.promises.resolve4("www.nodeseek.com");
    log.info(`[诊断] DNS 解析结果: ${addresses.join(", ")}`);
    return { hostname: "www.nodeseek.com", resolvedIp: addresses[0] };
  } catch (err) {
    log.error(`[诊断] DNS 解析失败: ${err.message}`);
    return { hostname: "www.nodeseek.com", resolvedIp: null };
  }
}

// ────────── 直连请求（绕过代理，用解析到的真实 IP） ──────────
function directRequest(url, options, resolvedIp) {
  const parsedUrl = new URL(url);
  const postData = options.body || "";

  return new Promise((resolve, reject) => {
    // headers 里已经有了 Content-Type 等
    const reqHeaders = {
      ...options.headers,
      "Content-Length": Buffer.byteLength(postData),
    };

    // 重点：如果解析到了真实 IP，直接用 IP 连 + Host header 保证 SNI 正确
    const connectHost = resolvedIp || parsedUrl.hostname;
    log.info(`直连目标: ${connectHost}:443 (Host: ${parsedUrl.hostname})`);

    const req = https.request(
      {
        hostname: connectHost,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: reqHeaders,
        servername: parsedUrl.hostname, // SNI
        timeout: 15000,
        rejectUnauthorized: true,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => data,
          })
        );
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("直连请求超时")); });
    req.on("error", (err) => {
      log.error(`直连错误: ${err.code || err.message}`);
      reject(err);
    });
    if (postData) req.write(postData);
    req.end();
  });
}

// ────────── 读取配置 ──────────
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = resolve(__dirname, "config.json");
  if (!existsSync(configPath)) {
    log.error("config.json 不存在，请复制 config.example.json 并填写 Headers");
    process.exit(1);
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    log.error("config.json 解析失败:", err.message);
    process.exit(1);
  }
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

  log.info("开始签到...");

  // 诊断网络环境
  const diag = await diagnose();

  const startTime = Date.now();

  try {
    // 直接使用直连，绕过 fetch（Arcadia 环境下 fetch 会走代理到错误出口）
    const response = await directRequest(url, { method: "POST", headers: requestHeaders }, diag.resolvedIp);

    const status = response.status;
    const bodyText = await response.text();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    let message = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      message = parsed.message || message;
    } catch {}

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
    log.error("请求错误:", err.message);
    await barkPush(`${SCRIPT_NAME} ❌ 请求错误`, err.message);
    return { success: false, message: err.message };
  }
}

// ────────── 入口 ──────────
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
  log.error("未捕获异常:", err.message);
  barkPush(`${SCRIPT_NAME} ❌ 脚本异常`, err.message);
  process.exit(1);
});
