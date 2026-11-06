# Diffra 设计决策

这里记录已经定下的事和原因。要改其中任何一条，先在这里改并写明原因，不要在代码里悄悄推翻。

## 产品身份

- 名字：Diffra。定位是自用为主、小范围分发的桌面端编程 agent。
- appId：`dev.diffra.desktop`；`productName`：`Diffra`，它决定用户数据目录（`%APPDATA%\Diffra`）。
- 打包后的包名：`diffra`（`electron-builder.config.ts` 里的 `extraMetadata.name`）。它决定每用户安装目录（`%LOCALAPPDATA%\Programs\diffra`）和更新缓存目录（`%LOCALAPPDATA%\diffra-updater`）。不覆盖的话，会用 workspace 包名 `@diffra/desktop`，变成 `@diffradesktop`。
- 以上三项发布后都不能改：NSIS 安装包靠 appId 识别同一个应用，改了会断掉自动更新；改 productName 或包名，用户数据目录、安装目录会换位置。
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
- 打包和更新：electron-builder + electron-updater。electron-updater 打进主进程的 bundle，安装包里不带 node_modules。
- 按步骤再加：Tailwind + shadcn/ui（第 3 步出现第一个真实界面时）。

## 进程结构

- 主进程：窗口、IPC、自动更新；以后还负责密钥。
- core：独立子进程，在 stdio 上跑 ACP v1（`@agentclientprotocol/sdk`）。
  - 主进程用 Electron 自己的可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动它，不额外打包 Node。所以打包时不能关闭 Electron 的 RunAsNode fuse，否则 core 起不来。
  - electron-vite 把 core 打成 `out/main/core.js`，桌面端不依赖 core 的 `dist`。
  - 同一份 core 也能直接跑：`node packages/core/dist/index.js`。评测集走这条路。
- 渲染进程：开启沙箱和 contextIsolation，只能通过 preload 暴露的 `window.diffra` 和主进程通信，拿不到密钥。
  - 沙箱里的 preload 只能是 CJS。desktop 包是 `"type": "module"`，electron-vite 默认会打成 ESM，所以在 `electron.vite.config.ts` 里显式指定了 CJS。

## 发布与更新

- 打包：electron-builder 打 NSIS 一键安装包（每用户安装，x64），配置在 `packages/desktop/electron-builder.config.ts`。
  - electron-builder 只会自动找 `electron-builder.yml/json/ts` 这类文件名，所以 `package` 脚本里用 `--config` 显式指定配置文件。
- 更新源：electron-updater 走 generic，默认地址 `https://update.diffra.net/win/`，构建时写进客户端的 `resources/app-update.yml`。
  - 备案前先解析到海外存储（比如 Cloudflare R2），备案后改 DNS 指向国内 CDN，地址本身不变。
  - 环境变量 `DIFFRA_UPDATE_URL` 只用于本地验证更新流程，正式构建不要设置。
  - 域名没到位之前，不要把安装包发给别人：装上的客户端会一直显示「检查更新失败」，以后也收不到更新。
- 客户端行为：启动时检查一次，之后每 4 小时检查一次，有新版本就后台下载。下载完后界面出现「重启并更新」，点击后静默安装并自动重启；不点的话，下次正常退出时也会安装。未打包运行（开发模式、e2e）时不检查更新。
- 发布流程（现阶段手动）：
  1. 改 `packages/desktop/package.json` 的 version；
  2. 提交后打 `vX.Y.Z` tag 并推送；
  3. CI（`.github/workflows/release-windows.yml`）校验 tag 和版本号一致，跑类型检查、测试并打包，产物作为 artifact 上传；
  4. 把 `Diffra-Setup-X.Y.Z.exe`、`.blockmap` 和 `latest.yml` 传到更新源。
  - 旧版本的 `.blockmap` 要留在更新源上，客户端靠它做差分下载；找不到时会退回整包下载（约 116MB）。
- 代码签名：用支持云签名的 OV 证书。2024 年起 EV 证书也不再直接跳过 SmartScreen 的信誉积累，多花钱买 EV 意义不大。
  - 现在还没配签名。没有配置发布者名时，electron-updater 不校验更新包的签名。证书到位后，要同时配置签名和发布者名，客户端才会校验更新包。

## 执行隔离（第 4 步实施）

- 检查点用影子 git 仓库：GIT_DIR 放在应用数据目录，不碰用户自己的 `.git`。
- 命令按风险分级审批。Windows 上没有轻量沙箱，防线是「审批 + 检查点」：防误操作，不防提示注入。
- 用户可以配置禁写目录；`.env` 和密钥文件默认不读进模型上下文。

## 工具链注意事项

- pnpm 11 对刚发布的包有冷却期。被拦时换稍旧的版本（比如 Playwright 用 1.64.x），不要写 `minimumReleaseAgeExclude` 绕过。
- Electron 45 不在安装时下载二进制，改为首次运行时下载。新环境可以先执行 `pnpm --filter @diffra/desktop exec install-electron`。
- pnpm 11 用 `pnpm-workspace.yaml` 的 `allowBuilds` 管理依赖的安装脚本。electron-winstaller（Squirrel 安装器用的）设为 false，Diffra 只打 NSIS 包。
- core 和 desktop 的 Node 侧 tsconfig 把 `lib` 限定为 `es2023`（不含 DOM），否则 Node 的 web stream 类型会和 DOM 版冲突。
