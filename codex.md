# AirSIM 全项目 Codex 部署辅助

本文为 AI 编码代理提供 AirSIM 全仓库的事实来源、构建顺序、部署边界和安全约束。开始任务前先阅读根目录 `README.md`，再阅读所修改组件的 README 和实际源码。源码与测试是协议事实来源；本文不能替代它们。

## 1. 项目目标

AirSIM 以 Air8000A 蜂窝模块作为电话与短信终端：

- Air8000A LuatOS 固件负责蜂窝通话、短信、GNSS、Wi-Fi 与媒体。
- `tools/air8000-vps` 网关连接 Air8000A，提供浏览器控制台与 iOS 云端 Relay API。
- iPhone 与 Apple Watch 通过 VoWLAN 或 Cloudflare Relay 使用通话和短信能力。
- Cloudflare Relay 负责公网事件、APNs、命令队列、Dashboard 与媒体中继。

不要把 AirSIM 描述为软 SIM、运营商替代品或紧急呼叫服务。不要恢复历史品牌、历史硬件模块方案或与当前 Air8000A 架构不一致的说明。

AirSIM 使用 `PolyForm-Noncommercial-1.0.0`，属于源码可见项目而不是 OSI 开源软件。只协助个人学习、研究、实验及许可证列明的其他非商业用途；商业使用、收费服务、商业产品集成和预期商业应用需要版权所有者单独书面授权。修改或分发时必须保留 `LICENSE`、`NOTICE` 和第三方声明。

## 2. 组件地图与事实来源

| 范围 | 先读 | 核心入口 | 验证命令 |
| --- | --- | --- | --- |
| Air8000A 固件 | `air8000/README.md` | `air8000/main.lua` | `lua air8000/tests/run.lua` |
| iOS App | `AirSIM-xtool/README.md` | `AirSIM-xtool/AirSIMXtool/Sources/AirSIM/` | Linux 上 `xtool dev` |
| VPS 网关 | `tools/air8000-vps/README.md` | `tools/air8000-vps/server.mjs`、`ios-api.mjs` | `(cd tools/air8000-vps && npm test)` |
| Cloudflare Relay | `push-relay-worker/README.md` | `push-relay-worker/src/index.mjs` | `(cd push-relay-worker && npm test && npm run check)` |
| 协议 | `docs/` | VoWLAN 与三星热点配对文档 | 对照双方实现与测试 |

修改跨组件协议时，必须同时搜索所有生产者、消费者、模型、持久化字段、测试和文档。不要只修改一端。

## 3. 不可破坏的架构契约

1. 紧急呼叫交回系统电话 App，AirSIM 不承担紧急通信。
2. 网关管理、SIP、RTP 与 PCM 服务只监听内部私网或 loopback，只有 HTTPS/WSS 主机名对外。
3. VoWLAN 控制面必须执行路由白名单、时间戳、nonce、HMAC 和消息大小校验。
4. 通话建立时确定 VoWLAN 或 Relay 传输；本次通话结束前不得静默切换路径。
5. PCM 只在内存与网络中处理，不保存到磁盘或诊断日志。
6. iOS 工程中的 `com.example.airsim`（xtool 为 `com.example.airsim.xtool`）是占位符。部署者必须使用自己的 Apple Team、唯一 Bundle ID、证书和 provisioning profile。
7. Relay 的 `ALLOWED_BUNDLE_ID` 必须等于重新签名后的主 iOS App Bundle ID。

## 4. 安全与 Secret 规则

以下内容绝不能提交、输出到日志或写入示例配置的明文值：

- Apple APNs `.p8` 私钥与 `APNS_P8`
- `DASHBOARD_TOKEN`
- Cloudflare API token
- Agent bearer token、设备 Secret、配对密钥与 HMAC
- Apple 签名身份和 provisioning profile
- 真实号码、完整短信、Push token 与 PCM 数据

Relay 的 `APNS_P8` 和 `DASHBOARD_TOKEN` 是必需的 Cloudflare Worker Secret。`wrangler.example.toml` 只能声明名称；生产值使用 `wrangler secret put`、versions secret 流程或 CI Secret Store 提供。不要把 Secret 放入 `[vars]`。

任何部署操作前都要检查：

```sh
git status --short
git diff --check
git grep -nE 'BEGIN (EC |)PRIVATE KEY|APNS_P8[[:space:]]*=|DASHBOARD_TOKEN[[:space:]]*=' -- ':!push-relay-worker/README.md' ':!push-relay-worker/wrangler.example.toml'
```

示例命令中的占位文本不等于真实 Secret；如果扫描命中，必须逐项判断且不得在回复中回显敏感值。

## 5. 推荐工作顺序

1. 阅读根 README、目标组件 README、源码和现有测试。
2. 检查 `git status --short`，保留用户已有改动；不得重置、覆盖或清理无关文件。
3. 用 `rg` 定位协议字段、环境变量、Bundle ID、端口和所有消费者。
4. 先修改最小必要范围，再同步测试与文档。
5. 先运行目标组件验证，再按跨组件影响扩大验证范围。
6. 部署前做 Secret、占位符、Bundle ID、Cloudflare 资源和目标环境检查。
7. 最终报告列出已改文件、验证结果、未执行的真机/生产步骤和剩余风险。

未经用户明确要求，不执行 Cloudflare 生产部署、Apple 发布、GitHub Release、真实设备安装、远程推送或 Git push。即使用户要求部署，也必须使用其明确指定的账户、设备、域名和签名身份，不得猜测。

## 6. 构建与验证

### Air8000A 固件与网关

```sh
lua air8000/tests/run.lua
(cd tools/air8000-vps && npm test)
```

### iOS

在装有 xtool 的 Linux 上构建并安装到已连接的 iPhone：

```sh
cd AirSIM-xtool/AirSIMXtool
xtool dev
```

模拟器构建不能验证 PushKit、CallKit 真机生命周期、APNs、Watch 配套安装、蜂窝通话或通话音频。真机安装前必须完成 Bundle ID、Team、capabilities、entitlements 和 provisioning profile 的整套替换。

### Cloudflare Relay

```sh
cd push-relay-worker
npm ci
npm test
npm run check
npx wrangler deploy --dry-run --config wrangler.toml
```

`wrangler.toml` 是本地/生产配置并被忽略；从 `wrangler.example.toml` 创建。生产部署前必须确认 KV ID、Durable Object migrations、`ALLOWED_BUNDLE_ID`、APNs Team/Key ID、自定义域名以及两个必需 Secret。

## 7. 部署清单

### Air8000A 与网关

- Air8000A 固件已刷写，Wi-Fi 与网关地址配置正确。
- 网关 `.env` 中的管理 token、设备 Secret、iOS 访问 token 与 APNs 凭据仅保存在本地。
- 外部网络无法访问网关管理、SIP 与 RTP 内部端口。
- 拨号、接听、拒接、挂断、DTMF、短信、双向音频和重启恢复已验证。

### iPhone 与 Apple Watch

- 主 App、Watch App、Live Activity、测试 Target 的 Bundle ID 关系正确。
- Team、证书、provisioning profile、capabilities 和最终签名 entitlement 正确。
- Relay `ALLOWED_BUNDLE_ID` 与主 App 完全一致。
- sandbox 和 production token 未混用。
- VoWLAN 配对、CallKit、PushKit、Watch、Live Activity 和媒体已在真机验证。

### Relay

- 使用部署者自己的 Cloudflare 账户、KV、Durable Objects 和域名。
- `APNS_P8` 与 `DASHBOARD_TOKEN` 仅存在于 Secret Store。
- 测试、语法检查和 dry-run 通过。
- `/healthz`、Dashboard 鉴权、设备注册、Agent 心跳、APNs 和 WebSocket 已验证。
- 发布后使用 `wrangler tail` 观察错误，但日志不显示敏感内容。

## 8. 完成标准

“构建通过”只说明本地编译或测试成功；“部署完成”必须有目标环境的部署结果；“真机可用”必须有实际 Air8000A、iPhone/Apple Watch 和网络链路证据。不能把未执行的步骤写成已完成。
