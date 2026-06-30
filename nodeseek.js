/**
 * @name         NodeSeek 签到 (Arcadia)
 * @description  Arcadia 平台自动签到领鸡腿
 * @version      1.7.0
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const https = require("https");
const dns = require("dns");
const net = require("net");
const tls = require("tls");
const zlib = require("zlib");
const { readFileSync, existsSync } = require("fs");
const { resolve, dirname } = require("path");
const { fileURLToPath } = require("url");

const BARK_KEY = process.env.BARK;
const SCRIPT_NAME = "NodeSeek 签到";

const log = {
  info: (...args) => console.log(`[${SCRIPT_NAME}]`, ...args),
  warn: (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args),
  error: (...args) => console.error(`[${SCRIPT_NAME}]`, ...args),
};

async function barkPush(title, body, url = "") {
  if (!BARK_KEY) { log.warn("BARK 未设置"); return; }
  try {
    await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title, body, device_key: BARK_KEY, group: "nodeseek", ...(url ? { url } : {}) }),
    });
    log.info("Bark 推送成功");
  } catch (err) { log.error("Bark 推送失败:", err.message); }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const p = resolve(__dirname, "config.json");
  if (!existsSync(p)) { log.error("config.json 不存在"); process.exit(1); }
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { log.error("config.json 解析失败"); process.exit(1); }
}

function getProxy() {
  for (const v of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    if (process.env[v]) {
      try { const u = new URL(process.env[v]); return { host: u.hostname, port: parseInt(u.port) || 7890 }; } catch {}
    }
  }
  return null;
}

async function resolveIPs(hostname) {
  const results = [];
  const tried = new Set();
  for (const { name, servers } of [
    { name: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
    { name: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
  ]) {
    try {
      const orig = dns.getServers();
      dns.setServers(servers);
      const addrs = await dns.promises.resolve4(hostname);
      dns.setServers(orig);
      for (const ip of addrs) { if (!tried.has(ip)) { tried.add(ip); results.push(ip); } }
    } catch {}
  }
  return results;
}

// ────────── 通过代理 CONNECT 隧道发请求（响应体自动解压） ──────────
function proxyRequest(proxy, targetHost, options) {
  const parsedUrl = new URL(options.url);
  const postData = options.body || "";

  return new Promise((resolve, reject) => {
    log.info(`[CONNECT] ${targetHost}:443`);

    const proxySocket = net.connect({ host: proxy.host, port: proxy.port }, () => {
      proxySocket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);

      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString();
        if (!buf.includes("\r\n\r\n")) return;
        proxySocket.removeListener("data", onData);

        if (!buf.includes("200")) {
          reject(new Error(`代理拒绝: ${buf.slice(0, 80)}`));
          return;
        }

        const tlsSocket = tls.connect({ socket: proxySocket, servername: parsedUrl.hostname },
          () => {
            const req = https.request({
              socket: tlsSocket,
              host: parsedUrl.hostname,
              path: parsedUrl.pathname + parsedUrl.search,
              method: options.method || "GET",
              headers: options.headers,
              createConnection: () => tlsSocket,
            }, (res) => {
              const chunks = [];
              res.on("data", (d) => chunks.push(d));
              res.on("end", () => {
                const raw = Buffer.concat(chunks);
                // 自动解压
                const ce = (res.headers["content-encoding"] || "").toLowerCase();
                let decompressed = raw;
                if (ce === "gzip" || ce === "x-gzip") {
                  decompressed = zlib.gunzipSync(raw);
                } else if (ce === "deflate") {
                  decompressed = zlib.inflateSync(raw);
                } else if (ce === "br") {
                  try { decompressed = zlib.brotliDecompressSync(raw); } catch {}
                }
                resolve({
                  status: res.statusCode,
                  ok: res.statusCode >= 200 && res.statusCode < 300,
                  text: async () => decompressed.toString("utf-8"),
                });
              });
            });
            req.on("error", reject);
            if (postData) req.write(postData);
            req.end();
          }
        );
        tlsSocket.on("error", (err) => reject(new Error(`TLS 错误: ${err.message}`)));
      };
      proxySocket.on("data", onData);
    });

    proxySocket.on("error", (err) => reject(new Error(`代理连接失败: ${err.message}`)));
    proxySocket.setTimeout(20000, () => { proxySocket.destroy(); reject(new Error("代理超时")); });
  });
}

// ────────── 签到 ──────────
async function checkin(config) {
  const apiUrl = "https://www.nodeseek.com/api/attendance?random=true";

  const requestHeaders = {
    "Connection": "keep-alive",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://www.nodeseek.com",
    "refract-sign": config["refract-sign"] || "",
    "User-Agent": config["User-Agent"] || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "refract-key": config["refract-key"] || "",
    "Sec-Fetch-Mode": "cors",
    "Cookie": config.Cookie || "",
    "Referer": "https://www.nodeseek.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  const proxy = getProxy();
  if (proxy) log.info(`[代理] ${proxy.host}:${proxy.port}`);

  log.info("开始签到...");
  const startTime = Date.now();

  const tryRequest = async (targetHost) => {
    if (proxy) return await proxyRequest(proxy, targetHost, { url: apiUrl, method: "POST", headers: requestHeaders, body: "" });
    const parsedUrl = new URL(apiUrl);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: targetHost,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: { ...requestHeaders, "Content-Length": 0 },
        servername: parsedUrl.hostname,
        timeout: 15000,
      }, (res) => {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => body }));
      });
      req.on("error", reject);
      req.end();
    });
  };

  let lastErr;
  const targets = proxy ? ["www.nodeseek.com"] : await resolveIPs("www.nodeseek.com");

  for (const target of targets) {
    try {
      const resp = await tryRequest(target);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      let msg = await resp.text();
      try { const p = JSON.parse(msg); msg = p.message || msg; } catch {}

      log.info(`状态码: ${resp.status} | 耗时: ${elapsed}s`);

      if (resp.status >= 200 && resp.status < 300) {
        log.info(`响应: ${msg}`);
        await barkPush(`${SCRIPT_NAME} ✅ 签到成功`, msg);
        return { success: true, message: msg };
      }
      if (resp.status === 500 && (msg.includes("已完成签到") || msg.includes("重复操作"))) {
        log.info("今日已签到");
        await barkPush(`${SCRIPT_NAME} ℹ️ 今日已签到`, "今天已经领过鸡腿啦，明天再来吧~");
        return { success: true, message: "今日已签到" };
      }
      if (resp.status === 403) {
        const brief = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
        log.warn(`403 被拦截 (Cloudflare WAF/风控): ${brief}`);
        await barkPush(`${SCRIPT_NAME} ❌ 签到被拦截 (403)`, `可能是 Cloudflare WAF 拦截或 IP 被封，请稍后再试`);
        return { success: false, message: "403 被拦截" };
      }
      const brief = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
      log.warn(`${resp.status} 异常: ${brief}`);
      await barkPush(`${SCRIPT_NAME} ⚠️ ${resp.status}`, brief);
      return { success: false, message: `${resp.status}: ${brief}` };
    } catch (err) {
      lastErr = err;
      log.warn(`✗ ${target}: ${err.message}`);
    }
  }

  log.error(`全部失败: ${lastErr?.message}`);
  await barkPush(`${SCRIPT_NAME} ❌ 签到失败`, lastErr?.message || "未知错误");
  return { success: false, message: lastErr?.message };
}

async function main() {
  log.info("启动");
  const config = loadConfig();
  if (!config.Cookie) { log.error("Cookie 为空"); process.exit(1); }
  const r = await checkin(config);
  log.info("执行完成");
  process.exit(r.success ? 0 : 1);
}

main().catch((err) => { log.error("异常:", err.message); process.exit(1); });
