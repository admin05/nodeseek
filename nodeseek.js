/**
 * @name         NodeSeek 签到 (Arcadia)
 * @description  Arcadia 平台自动签到领鸡腿
 * @version      1.5.0
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const https = require("https");
const http = require("http");
const dns = require("dns");
const net = require("net");
const tls = require("tls");
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
  if (!BARK_KEY) { log.warn("BARK 环境变量未设置，跳过推送"); return; }
  try {
    const res = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title, body, device_key: BARK_KEY, group: "nodeseek", ...(url ? { url } : {}) }),
    });
    await res.json();
    log.info("Bark 推送成功");
  } catch (err) {
    log.error("Bark 推送失败:", err.message);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const p = resolve(__dirname, "config.json");
  if (!existsSync(p)) { log.error("config.json 不存在"); process.exit(1); }
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch (err) { log.error("config.json 解析失败:", err.message); process.exit(1); }
}

// ────────── 多 DNS 源解析 ──────────
async function resolveIPs(hostname) {
  const results = [];
  const tried = new Set();

  const tryResolve = async (resolver) => {
    try {
      // set custom DNS servers temporarily
      const origServers = dns.getServers();
      dns.setServers(resolver.servers);
      const addrs = await dns.promises.resolve4(hostname);
      dns.setServers(origServers);
      for (const ip of addrs) {
        if (!tried.has(ip)) { tried.add(ip); results.push({ ip, source: resolver.name }); }
      }
      log.info(`[DNS] ${resolver.name}: ${addrs.join(", ")}`);
    } catch {
      log.warn(`[DNS] ${resolver.name} 解析失败`);
    }
  };

  const resolvers = [
    { name: "Cloudflare(1.1.1.1)", servers: ["1.1.1.1", "1.0.0.1"] },
    { name: "Google(8.8.8.8)", servers: ["8.8.8.8", "8.8.4.4"] },
    { name: "OpenDNS(208.67.222.222)", servers: ["208.67.222.222", "208.67.220.220"] },
    { name: "系统DNS", servers: dns.getServers() },
  ];

  for (const r of resolvers) await tryResolve(r);
  log.info(`[DNS] 总计获得 ${results.length} 个唯一 IP: ${results.map(r => r.ip).join(", ")}`);
  return results;
}

// ────────── 获取代理配置 ──────────
function getProxy() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return { host: u.hostname, port: parseInt(u.port) || 7890 };
  } catch { return null; }
}

// ────────── 通过代理 CONNECT 隧道发起 HTTPS 请求 ──────────
function requestThroughProxy(proxy, destHost, destPort, options) {
  const parsedUrl = new URL(options.url);
  const postData = options.body || "";

  return new Promise((resolve, reject) => {
    log.info(`[代理] CONNECT ${destHost}:${destPort} → ${parsedUrl.hostname}`);

    const proxySocket = net.connect({ host: proxy.host, port: proxy.port }, () => {
      // 发送 HTTP CONNECT 请求
      proxySocket.write(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n\r\n`);

      let proxyResp = "";
      proxySocket.once("data", (data) => {
        proxyResp += data.toString();
        if (proxyResp.includes("200")) {
          log.info(`[代理] CONNECT 成功`);
          // 建立 TLS 隧道
          const tlsSocket = tls.connect({
            socket: proxySocket,
            servername: parsedUrl.hostname,
            rejectUnauthorized: true,
          }, () => {
            log.info(`[TLS] 握手成功 (SNI: ${parsedUrl.hostname})`);

            const reqHeaders = {
              ...options.headers,
              "Host": parsedUrl.hostname,
              "Content-Length": Buffer.byteLength(postData),
            };

            let reqPath = parsedUrl.pathname + parsedUrl.search;
            if (!reqPath) reqPath = "/";

            const httpReq = `POST ${reqPath} HTTP/1.1\r\n${Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${postData}`;

            let responseData = "";
            let headersDone = false;
            let respHeaders = {};
            let statusCode = 0;

            tlsSocket.on("data", (chunk) => {
              const str = chunk.toString();
              if (!headersDone) {
                responseData += str;
                const headerEnd = responseData.indexOf("\r\n\r\n");
                if (headerEnd !== -1) {
                  headersDone = true;
                  const headerLines = responseData.slice(0, headerEnd).split("\r\n");
                  const statusLine = headerLines[0];
                  statusCode = parseInt(statusLine.split(" ")[1]);
                  for (let i = 1; i < headerLines.length; i++) {
                    const [k, ...v] = headerLines[i].split(": ");
                    respHeaders[k.toLowerCase()] = v.join(": ");
                  }
                  responseData = responseData.slice(headerEnd + 4);
                }
              }
            });

            tlsSocket.on("end", () => {
              // 检查是否有 Transfer-Encoding: chunked
              if (respHeaders["transfer-encoding"] === "chunked") {
                // 简单处理：去掉 chunked 编码
                const body = responseData.replace(/^[0-9a-fA-F]+\r\n|\r\n[0-9a-fA-F]+\r\n|\r\n0\r\n\r\n$/gm, "");
                resolve({
                  status: statusCode,
                  ok: statusCode >= 200 && statusCode < 300,
                  text: async () => body.replace(/\r\n$/, ""),
                });
              } else {
                resolve({
                  status: statusCode,
                  ok: statusCode >= 200 && statusCode < 300,
                  text: async () => responseData,
                });
              }
            });

            tlsSocket.write(httpReq);
          });

          tlsSocket.on("error", (err) => reject(new Error(`TLS 错误: ${err.message}`)));
        } else {
          reject(new Error(`代理 CONNECT 失败: ${proxyResp.slice(0, 100)}`));
        }
      });
    });

    proxySocket.on("error", (err) => reject(new Error(`代理连接失败: ${err.message}`)));
    proxySocket.setTimeout(20000, () => { proxySocket.destroy(); reject(new Error("代理超时")); });
  });
}

// ────────── 签到主逻辑 ──────────
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
    "Host": "www.nodeseek.com",
    "Referer": "https://www.nodeseek.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  // 检测代理
  const proxy = getProxy();
  if (proxy) log.info(`[代理] 检测到 HTTP 代理 ${proxy.host}:${proxy.port}`);

  // 获取 DNS IP（多个源）
  const ipResults = await resolveIPs("www.nodeseek.com");

  if (ipResults.length === 0) {
    log.error("无法解析任何 IP");
    process.exit(1);
  }

  log.info("开始签到...");
  const startTime = Date.now();

  // 尝试策略：1) 优先用代理+解析的IP  2) 代理+直接hostname  3) 直连
  const strategies = [];

  if (proxy) {
    for (const { ip } of ipResults) {
      strategies.push({ type: "proxy_ip", label: `代理+${ip}`, destHost: ip, destPort: 443 });
    }
    strategies.push({ type: "proxy_host", label: "代理+hostname", destHost: "www.nodeseek.com", destPort: 443 });
  } else {
    for (const { ip } of ipResults) {
      strategies.push({ type: "direct", label: `直连${ip}`, destHost: ip, destPort: 443 });
    }
  }

  let lastError;

  for (const s of strategies) {
    log.info(`[策略] 尝试: ${s.label}`);
    try {
      const response = await requestThroughProxy(
        s.type === "direct" ? { host: s.destHost, port: s.destPort } : proxy,
        s.destHost,
        s.destPort,
        { url: apiUrl, method: "POST", headers: requestHeaders, body: "" }
      );

      const status = response.status;
      const bodyText = await response.text();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      let message = bodyText;
      try { const p = JSON.parse(bodyText); message = p.message || message; } catch {}

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
        await barkPush(`${SCRIPT_NAME} ❌ 风控`, `暂时被风控\n内容：${message}`);
        return { success: false, message: `403 风控: ${message}` };
      }
      log.warn(`${status} 异常:`, message);
      await barkPush(`${SCRIPT_NAME} ⚠️ ${status} 异常`, message);
      return { success: false, message: `${status}: ${message}` };
    } catch (err) {
      lastError = err;
      log.warn(`[策略] ✗ ${s.label} 失败: ${err.message}`);
    }
  }

  log.error(`所有策略均失败。最后错误: ${lastError?.message}`);
  await barkPush(`${SCRIPT_NAME} ❌ 签到失败`, `所有连接策略均失败: ${lastError?.message}`);
  return { success: false, message: lastError?.message };
}

async function main() {
  log.info("启动");
  const config = loadConfig();
  if (!config.Cookie) {
    log.error("Cookie 为空");
    await barkPush(`${SCRIPT_NAME} ❌ 配置错误`, "Cookie 为空");
    process.exit(1);
  }
  const result = await checkin(config);
  log.info("执行完成");
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => { log.error("异常:", err.message); barkPush(`${SCRIPT_NAME} ❌ 异常`, err.message); process.exit(1); });
