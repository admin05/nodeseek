# NodeSeek 签到 (Arcadia)

NodeSeek 自动签到脚本，适配 [Arcadia](https://github.com/LxCloud/Arcadia) 平台运行。

## 功能

- 自动签到 NodeSeek 领取鸡腿
- Bark 推送签到结果
- 支持风控检测、重复签到识别
- 签到完成自动退出（适合 Arcadia 定时任务）

## 配置

1. 复制 `config.example.json` 为 `config.json`
2. 登录 [NodeSeek](https://www.nodeseek.com)，打开浏览器开发者工具
3. 从任意 API 请求的 Request Headers 中复制以下字段到 `config.json`：

| 字段 | 说明 |
|------|------|
| Cookie | 登录后的 Cookie（必填） |
| User-Agent | 浏览器 UA |
| refract-sign | anti-bot 签名 |
| refract-key | anti-bot key |

## 运行

```bash
node nodeseek.js
```

### 环境变量

| 变量 | 说明 |
|------|------|
| BARK | Bark 推送 Key，用于发送签到结果通知 |

## Cloudflare 403 处理

如果日志出现 `cf-mitigated: challenge`、`Just a moment...` 或脚本提示 `Cloudflare 验证`，说明请求被 Cloudflare 拦在站点入口，尚未进入 NodeSeek 签到接口。

处理步骤：

1. 在浏览器中使用与 Arcadia 相同的出口 IP 或代理打开 `https://www.nodeseek.com/`。
2. 完成 Cloudflare 验证并确认浏览器可正常访问 NodeSeek。
3. 从浏览器开发者工具重新复制 Cookie 到 `config.json`，确认 Cookie 中包含 `cf_clearance`。
4. 保持 Arcadia 运行脚本时使用同一个出口 IP 或代理，再重新运行。

如果浏览器和 Arcadia 使用不同出口 IP，`cf_clearance` 通常不会生效，脚本仍可能继续返回 403。
