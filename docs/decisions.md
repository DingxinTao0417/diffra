# Diffra 设计决策

这里记录已经定下的事和原因。要改其中任何一条，先在这里改并写明原因，不要在代码里悄悄推翻。

## 产品身份

- 名字：Diffra。定位是自用为主、小范围分发的桌面端编程 agent。
- appId：`dev.diffra.desktop`；`productName`：`Diffra`，它决定用户数据目录（`%APPDATA%\Diffra`）。
  - 发布后这两个都不能改：NSIS 安装包靠 appId 识别同一个应用，改了会断掉自动更新；改 productName 会让用户数据目录换位置。
- 域名：`diffra.dev` 做官网（.dev 不能备案，部署在海外）；`diffra.net` 做更新和下载（需要备案）。两个都还没买。

## v1 / v2 范围

v1：
- 只发 Windows。
- 模型只通过 API Key 接入：预置各大厂商的 base URL、Coding Plan 模板（智谱、百炼、Kimi），以及自定义协议配置。
- 不做订阅账号登录（用 OAuth 消耗 Claude / ChatGPT / Gemini 订阅额度）。Anthropic 和 Google 都禁止第三方应用这样用，分发出去后被封号的是用户；OpenAI 的第三方登录计划还没核实到官方原文。

v2：
- 外接 agent：通过 ACP 驱动 Claude Code / Codex / Gemini CLI / Copilot CLI，官方账号登录在这条路上由它们自己完成。
- 多候选方案（每个候选一个 git worktree）、Java 适配器、macOS。

## 技术栈

- pnpm 11 workspace：`packages/core`（agent 核心）、`packages/desktop`（Electron 应用）。
- Electron 45 + electron-vite 6 + Vite 8 + React 19 + TypeScript 7。
- 运行时代码面向 Electron 内置的 Node（Electron 45 对应 Node 24），所以 `@types/node` 用 24，不跟本机的 Node 版本走。
- 测试：core 用 vitest；界面用 Playwright 直接驱动 Electron 窗口。
- 按步骤再加：Tailwind + shadcn/ui（第 3 步出现第一个真实界面时）；electron-builder + electron-updater（第 2 步）。

## 进程结构

- 主进程：窗口和 IPC；以后还负责自动更新和密钥。
- core：独立子进程，在 stdio 上跑 ACP v1（`@agentclientprotocol/sdk`）。
  - 主进程用 Electron 自己的可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动它，不额外打包 Node。所以打包时不能关闭 Electron 的 RunAsNode fuse，否则 core 起不来。
  - electron-vite 把 core 打成 `out/main/core.js`，桌面端不依赖 core 的 `dist`。
  - 同一份 core 也能直接跑：`node packages/core/dist/index.js`。评测集走这条路。
- 渲染进程：开启沙箱和 contextIsolation，只能通过 preload 暴露的 `window.diffra` 和主进程通信，拿不到密钥。
  - 沙箱里的 preload 只能是 CJS。desktop 包是 `"type": "module"`，electron-vite 默认会打成 ESM，所以在 `electron.vite.config.ts` 里显式指定了 CJS。

## 发布与更新（第 2 步实施）

- electron-builder 打 NSIS 安装包，electron-updater 走 generic 更新源。
- 更新地址定为 `update.diffra.net`，会写死在已安装的客户端里。备案前先解析到海外存储（比如 Cloudflare R2），备案后改 DNS 指向国内 CDN，地址本身不变。
- 代码签名用支持云签名的 OV 证书。2024 年起 EV 证书也不再直接跳过 SmartScreen 的信誉积累，多花钱买 EV 意义不大。

## 执行隔离（第 4 步实施）

- 检查点用影子 git 仓库：GIT_DIR 放在应用数据目录，不碰用户自己的 `.git`。
- 命令按风险分级审批。Windows 上没有轻量沙箱，防线是「审批 + 检查点」：防误操作，不防提示注入。
- 用户可以配置禁写目录；`.env` 和密钥文件默认不读进模型上下文。

## 工具链注意事项

- pnpm 11 对刚发布的包有冷却期。被拦时换稍旧的版本（比如 Playwright 用 1.64.x），不要写 `minimumReleaseAgeExclude` 绕过。
- Electron 45 不在安装时下载二进制，改为首次运行时下载。新环境可以先执行 `pnpm --filter @diffra/desktop exec install-electron`。
- core 和 desktop 的 Node 侧 tsconfig 把 `lib` 限定为 `es2023`（不含 DOM），否则 Node 的 web stream 类型会和 DOM 版冲突。
