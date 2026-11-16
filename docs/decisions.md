# Diffra 设计决策

这里记录已经定下的事和原因。要改其中任何一条，先在这里改并写明原因，不要在代码里悄悄推翻。

## 产品身份

- 名字：Diffra。定位是个人开发者（艾特）开发的桌面端编程 agent，2026-11 起对外公开、公测期间免费（第 298 步，之前是自用为主、小范围分发）。
- appId：`dev.diffra.desktop`；`productName`：`Diffra`，它决定用户数据目录（`%APPDATA%\Diffra`）。
- 打包后的包名：`diffra`（`electron-builder.config.ts` 里的 `extraMetadata.name`）。它决定每用户安装目录（`%LOCALAPPDATA%\Programs\diffra`）和更新缓存目录（`%LOCALAPPDATA%\diffra-updater`）。不覆盖的话，会用 workspace 包名 `@diffra/desktop`，变成 `@diffradesktop`。
- 以上三项发布后都不能改：NSIS 安装包靠 appId 识别同一个应用，改了会断掉自动更新；改 productName 或包名，用户数据目录、安装目录会换位置。
- 域名：`diffra.dev`（2026-11 买下，DNS 在 Cloudflare），兼做更新源 `update.diffra.dev`。不做备案（服务器在美国），原定做更新下载的 `diffra.net` 不买了。国内下载慢的问题暂不处理。

## v1 / v2 范围

v1：
- 先发 Windows。macOS 版 2026-11-11 开始做（原来排在 v2），进度和做法见「macOS」。
- 模型只通过 API Key 接入：预置各大厂商的 base URL、Coding Plan 模板（智谱、百炼、Kimi），以及自定义协议配置。
- 不做订阅账号登录（用 OAuth 消耗 Claude / ChatGPT / Gemini 订阅额度）。Anthropic 和 Google 都禁止第三方应用这样用，分发出去后被封号的是用户；OpenAI 的第三方登录计划还没核实到官方原文。

v2（2026-11-15 起按里程碑做，进度见各节；设备连接只做局域网，互联网远程、P2P 打洞、离线暂存、自建中转、远程撤销不做）：
- 外接 agent：通过 ACP 驱动 Claude Code / Codex / Gemini CLI / Copilot CLI，官方账号登录在这条路上由它们自己完成。已做，见「外接智能体」。
- 多候选方案（每个候选一个 git worktree）、Java 适配器。已做，见「计划逐步打勾和多候选方案（v2 · M2）」「Java 适配器（v2 · M3）」。
- 扩展（见「扩展页」）：MCP 的浏览器登录（OAuth，Vercel 和 Railway 远程版要靠它）、扩展目录联网更新、插件更新、LSP。已做，见「扩展的 v2 部分」。
- 浏览器与电脑操控：智能体直接启动系统 Chrome、浏览器面板的开发者工具、电脑操控（默认关）。已做，见「系统 Chrome 直连、开发者工具（v2 · M5）」「电脑操控（v2 · M5）」。
- 设备连接只在局域网里直连。已做，见「局域网设备连接（v2 · M6）」。托盘和开机自启已做，见「托盘和开机自启（v2 · M7）」。
- 待办：重复、嵌套标签、日历拖动、局域网同步。已做，见「重复、嵌套标签、日历拖动、局域网同步（v2 · M8）」。
- 架构：函数调用图、运行时追踪、更多语言、监听文件变化、导出到仓库、任务里的智能体查架构。已做，见「架构的 v2 部分（v2 · M9）」。
- 安全：污点分析、Semgrep 和 CodeQL（装了、有许可才用）、动态测试、依赖许可证、按项目单独设开关。已做，见「安全的 v2 部分（v2 · M10）」。
- 杂项（M11）：用量的费用、每月预算、导出和清理；评测结果的统计（区间、按题配对比较、费用、难度）和在桌面端看；设计任务用用户自己的 Pexels、Unsplash Key 找图；无项目任务转成正式项目、用量里合成一行、提示词里说明、有了文件后重选规则包；任务之间直接回复。已做，见「用量统计」「评测集」「设计模式」「无项目任务」「任务之间互通」里的 v2 部分。

里程碑签收（2026-11-15，按 v2 目标里每个里程碑的验收逐条核对，证据见各节的「验证」；只有验收全部满足的才写「完成」）：
- M1 完成。验收要求用假 ACP 服务端测，已测；另外在本机用真的 Claude Code 跑通。Codex 检测通过，但它自己连不上用户配的模型网关，没跑完一轮；Gemini CLI、Copilot CLI 本机没装，没实跑。
- M2 完成。
- M3 完成。
- M4 完成。验收要求用假的 OAuth、目录、LSP 服务测，已测；另外用真的 gopls 和两种 TypeScript 语言服务器跑通。Vercel、Railway 的真账号登录没试。
- M5 未完成：Windows 上验收全过（含真的 Chrome 157 和真鼠标键盘）；macOS 没有机器，没验证（「Windows 和 macOS 必须可用」）。Linux 的电脑操控按验收标注为不支持。
- M6 完成。验收要求两个本地实例，已测；两台真电脑没试。
- M7 未完成：Windows 上验收全过；macOS、Linux 的托盘没验证（「三平台托盘」）。
- M8 完成。
- M9 完成。
- M10 完成。Semgrep、CodeQL 另外用真的跑通。
- M11 完成。图库的真 Key 没试（用本机假图库测）。

## 技术栈

- pnpm 11 workspace：`packages/core`（agent 核心）、`packages/desktop`（Electron 应用）。
- Electron 45 + electron-vite 6 + Vite 8 + React 19 + TypeScript 7。
- 运行时代码面向 Electron 内置的 Node（Electron 45 对应 Node 24），所以 `@types/node` 用 24，不跟本机的 Node 版本走。
- 测试：core 用 vitest；界面用 Playwright 直接驱动 Electron 窗口。
- 打包和更新：electron-builder + electron-updater。electron-updater 打进主进程的 bundle。安装包里的 node_modules 只有 node-pty：原生模块打不进 bundle，所以它是桌面端唯一放在 `dependencies` 里的包。
- 界面：Tailwind 4 + shadcn/ui（radix-nova 样式，底层是 Radix）。
  - shadcn CLI 识别不了 electron-vite 项目，`components.json` 和主题变量是手写的；之后加组件用 `pnpm exec shadcn add <名字>`。
  - 合并 class 用 shadcn 作者发布的 `cn` 包，代替 clsx + tailwind-merge。
  - CLI 加依赖时会写进 `dependencies`，要挪到 `devDependencies`：界面代码打进 bundle，安装包里不需要它们。
- 模型调用：AI SDK 7（`ai` 和 `@ai-sdk/*`），只在 core 里用。
- 其他运行时依赖：
  - core：`@vscode/ripgrep`（搜索）、`shell-quote`（拆分命令做权限分级）、`@modelcontextprotocol/sdk`（MCP 客户端，只用到 client 部分，服务端依赖不进 bundle）。
  - 桌面端：`diff`（渲染 diff）、`react-markdown` + `remark-gfm`（回复按 Markdown 显示，不渲染原始 HTML）、`@xterm/xterm` + `@xterm/addon-fit`（终端界面）、`node-pty`（终端进程）。
  - 回答里的富内容（第 640 步起，见「对话里的富内容」）：`remark-math` + `katex`（公式）、`mermaid`（流程图等）、`echarts`（图表）。都按需加载，不进首屏的包；代码高亮复用文件面板的 CodeMirror 语法，不另加高亮库。
- 运行前提：Windows 上需要 Git for Windows，检查点要用 git，命令执行要用它自带的 bash。Mac 上用系统的 `/bin/bash` 和 git（Xcode 命令行工具）。

## 进程结构

- 主进程：窗口、IPC、自动更新、设置和密钥。
- core：独立子进程，在 stdio 上跑 ACP v1（`@agentclientprotocol/sdk`）。
  - 主进程用 Electron 自己的可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动它，不额外打包 Node。所以打包时不能关闭 Electron 的 RunAsNode fuse，否则 core 起不来。
  - electron-vite 把 core 打成 `out/main/core.js`，桌面端不依赖 core 的 `dist`。
  - 同一份 core 也能直接跑：`node packages/core/dist/index.js`。评测集走这条路。
- 渲染进程：开启沙箱和 contextIsolation，只能通过 preload 暴露的 `window.diffra` 和主进程通信，拿不到密钥。
  - 沙箱里的 preload 只能是 CJS。desktop 包是 `"type": "module"`，electron-vite 默认会打成 ESM，所以在 `electron.vite.config.ts` 里显式指定了 CJS。

## 模型接入

- 调用模型的事都放在 core 里：拉取模型列表、测试连接，以后的 agent 主循环也在 core。
  - 主进程解密密钥后，通过 ACP 扩展方法 `_diffra/models/list`、`_diffra/models/test` 把 `{协议, 地址, 密钥, 模型}` 传给 core。
  - 模型调用失败（密钥错、限流、超时等）作为正常结果返回 `{ ok: false, error }`；只有参数不合法才是 JSON-RPC 错误。
  - 超时：拉列表 15 秒，测试连接 30 秒，ACP 请求再兜底 60 秒。
- 协议有 5 种：`anthropic`、`anthropic-compatible`、`openai-responses`、`openai-compatible`、`gemini`。自定义供应商只能选两种兼容协议。
  - Anthropic 系的地址按 Claude Code 的写法填，不带 `/v1`（各家文档给的也是这种），core 拼 `/v1/messages`；OpenAI 系地址带 `/v1`。
  - `anthropic-compatible` 同时带 `x-api-key` 和 `Authorization: Bearer`，因为兼容服务认哪个的都有；官方 Anthropic 只带 `x-api-key`。
  - User-Agent 如实写 `diffra-core/版本号`，不冒充其他工具。要放在每次调用的 headers 里，provider 层设置的会被 AI SDK 覆盖。
- 预置清单在 `packages/desktop/src/shared/presets.ts`，地址允许用户修改。2026-11-06 核对过的来源：
  - 官方文档：DeepSeek、百炼按量、智谱开放平台、Kimi 开放平台、OpenRouter、智谱 GLM Coding Plan、百炼 Token Plan、百炼 Coding Plan、Kimi Code。
  - AI SDK 默认值：Anthropic、OpenAI、Gemini。
  - DeepSeek 的 Anthropic 兼容接口只接受 `claude-` 开头的模型名，所以预置走 OpenAI 兼容接口。
  - 百炼 Coding Plan 在官方文档里已标为「旧版」（Lite 停售，Pro 在售），所以同时预置了 Token Plan。
- 套餐条款：智谱 Coding Plan 只允许在官方列出的工具里用，Diffra 不在列表里；百炼套餐只允许交互式编程工具使用；Kimi Code 支持第三方 agent，但禁止伪造客户端身份。这些写在预置的说明里，添加时会显示。
- 存储：都在用户数据目录下。
  - `settings.json`：供应商、模型、角色。
  - `secrets.json`：只存 Electron safeStorage（Windows 上是 DPAPI）加密后的密文。系统加密不可用时拒绝保存，不会退回明文。
  - 写文件时先写临时文件再改名；同一个文件的写入排队执行。
  - 读取时文件解析失败，就暂停保存并在界面提示，不覆盖原文件。
  - 界面拿不到密钥，只能看到末 4 位；服务返回的报错里如果带着密钥原文，会先抹掉。
- 数据目录：正式安装版用 `%APPDATA%\Diffra`；未打包运行（开发模式）用 `%APPDATA%\Diffra-dev`；e2e 用 `DIFFRA_USER_DATA_DIR` 指定的临时目录（只在未打包时生效）。
- 角色：编码必选；规划、评审不选就用编码模型；兜底（界面上叫「备用」，字段仍是 `fallback`）不选就不升级。供应商或模型被删除后，指向它的角色会自动清空。

## 发布与更新

- 打包：electron-builder 打 NSIS 向导安装包（默认每用户安装，x64），配置在 `packages/desktop/electron-builder.config.ts`。关闭 oneClick 并启用 allowToChangeInstallationDirectory，手动安装时可选择其他盘的目录；不改变 appId、包名和用户数据位置。已有安装的升级通常沿用原目录，选择程序安装目录不代表移动 AppData 中的会话和缓存。
  - electron-builder 只会自动找 `electron-builder.yml/json/ts` 这类文件名，所以 `package` 脚本里用 `--config` 显式指定配置文件。
  - `npmRebuild: false`：唯一的原生依赖 node-pty 自带 N-API 预编译文件，Electron 能直接用。打包时默认会用 node-gyp 重新编译，本机没装 VS 编译工具就会失败。
  - node-pty 的原生文件由 electron-builder 自动解到 `app.asar.unpacked`（约 8.5MB）。
  - 静态检查用的 `@ast-grep/napi`、`@ast-grep/lang-python` 也是原生依赖，和 node-pty 一样列在桌面端的 `dependencies` 里，electron-builder 会自动把原生文件解到 asar 外面。
  - Python 语法的解析器（`parser.so`）由 ast-grep 的原生代码加载，不认 asar 路径，路径不对时会直接让进程崩溃（Rust panic，try/catch 接不住）。core 加载前先把路径换成 `app.asar.unpacked`，并确认文件存在。打包后用 Diffra.exe 启动包里的 core 实测过。
- 更新源：electron-updater 走 generic，地址 `https://update.diffra.dev/win/`，构建时写进客户端的 `resources/app-update.yml`，发布后不能再改。
  - 服务器：黑果云美国洛杉矶轻量云（Ubuntu 24.04，30Mbps），nginx 只提供 `/var/www/diffra-update/win/` 下的文件，其他路径 404、不列目录；`.yml` 不缓存，安装包和 `.blockmap` 长期缓存（文件名带版本号）；传到一半的 `.partial` 不对外。
  - HTTPS 证书来自 Let's Encrypt（没留邮箱），certbot 的定时任务自动续期；HTTP 跳转到 HTTPS。`.dev` 域名浏览器只允许 HTTPS。
  - Cloudflare 上是「仅 DNS」，不走它的代理：要保证多段 Range 能直接到 nginx，差分下载才不退回整包。
  - 上传用 root 和专用密钥（`~/.ssh/diffra_server_ed25519`）；服务器原本只允许密码登录，密钥是用户自己加的。没有建单独的部署账号。
- 官网 `https://diffra.dev`（第 298–308 步改版）：同一台服务器上的静态网站，纯 HTML 和 CSS，不用网站框架、不用 Cookie、不加载第三方脚本。http 和 `www` 都跳到 `https://diffra.dev`，页面不缓存。
  - 页面：首页、下载、快速开始、更新日志、隐私政策、用户协议、第三方许可、浏览器扩展隐私政策、404。署名是个人开发者「艾特」，联系邮箱 2034994530@qq.com；口径是「公测、免费，模型用你自己的 API Key」。
  - 源文件：`website/layout.html` 是公共页头页脚，`website/pages/*.html` 是各页正文，`website/public/` 原样拷到网站根目录。`scripts/build-website.ts` 拼成 `out/website/`，同时生成更新日志页（按 tag）、第三方许可页（从 `NOTICE.md`）、`sitemap.xml`、`robots.txt`，并检查站内链接和锚点，有错就失败。
  - 产品截图：`pnpm --filter @diffra/desktop website:shots`（`scripts/shots/website.shots.ts`）用演示项目和脚本模型在开发版里摆场景，浅色、深色各截一套 2 倍 WebP，连同分享卡片 `og.png` 和图标一起生成到 `website/public/`。界面改了就重跑，不用真实数据。页面里写 `width="{{shot:名字}}"`，构建时换成图片的真实宽高。
  - 颜色和圆角沿用应用的令牌，深色跟系统走；产品截图用 `<picture>` 按系统配色换浅色、深色那一套。
  - 下载按钮指向固定地址 `https://update.diffra.dev/win/Diffra-Setup-latest.exe`，它是指向最新安装包的软链接，由发布脚本维护，nginx 对它不缓存；每次发版不用改网页。
  - 页面读更新源上的 `latest.yml` 显示版本号、大小、发布日期和 SHA-512（`website/public/site.js`；更新源只允许 `https://diffra.dev` 跨域读 `.yml`，本地预览读不到，显示默认文字）；还没有发布版本时下载按钮变灰。
  - 更新网页：`pnpm --filter @diffra/desktop publish:website`（`scripts/publish-website.ts`）先生成再上传 `out/website/` 里的全部文件，传完从公网取回每个页面核对。
  - 访问统计：只用服务器的 nginx 访问日志，不在页面里加统计脚本。日志保留 180 天（隐私政策里写了），`pnpm --filter @diffra/desktop stats`（`scripts/website-stats.ts`）经 SSH 用 GoAccess 生成报表下载到 `out/stats/`，并打出安装包下载次数、每天检查更新的不同 IP 数（大致等于在用的安装数）。报表只在本机看，不公开。
  - 服务器上配合的三处（2026-11-10 改好，原文件备份在 `/root/backup/`）：`/etc/logrotate.d/nginx` 改成保留 180 天（原来 14 天）、装了 GoAccess 1.8.1、`/etc/nginx/sites-available/diffra.dev` 加了 `error_page 404 /404.html`。官网和更新源共用 `/var/log/nginx/access.log`，按路径区分（`/win/` 是更新源）。日志路径变了就在 `publish.config.json` 的 `accessLogs` 里写。
  - 不做：国内下载源、定价页、英文版、完整文档、演示视频。
  - 环境变量 `DIFFRA_UPDATE_URL` 只用于本地验证更新流程，正式构建不要设置；发布脚本发现它设了就拒绝发布。
- 客户端行为：启动时检查一次，之后每 4 小时检查一次，有新版本就后台下载。下载完后界面出现「重启并更新」，点击后静默安装并自动重启；不点的话，下次正常退出时也会安装。未打包运行（开发模式、e2e）时不检查更新。
  - 免安装版也不检查更新（「更新与关于」显示「免安装版不检查更新，请用安装版」）：程序目录里没有 `Uninstall Diffra.exe` 的就是免安装版，比如本地打包出来的 `release/win-unpacked`。原因：更新包只会装到注册表里那份安装版，免安装版下载、安装后重开还是旧版，一直提示有新版本（2026-11-10 开始菜单和任务栏的快捷方式指向了 `win-unpacked`，点了更新看起来没生效）。打包版 e2e 跑的就是 `win-unpacked`，所以它测的是「不检查」这一边。
- 发布流程（现阶段手动）：
  1. 改 `packages/desktop/package.json` 的 version；
  2. 提交后打 `vX.Y.Z` tag 并推送；
  3. CI（`.github/workflows/release-windows.yml`）校验 tag 和版本号一致、这一版有中文更新日志，跑类型检查、测试并打包，产物传到 `v<版本号>` 的草稿 Release（已有就覆盖里面的文件，说明是这一版的更新日志）；
     - 不用 Actions 的产物存储：账号的存储配额按月累计，满了以后上传直接失败（2026-11 的一次构建就卡在这一步）。仓库私有，草稿 Release 只有有权限的人能下载。
  4. 本机运行 `pnpm --filter @diffra/desktop publish:release`（`scripts/publish-release.ts`，服务器连接方式写在不提交的 `publish.config.json`，样例 `publish.config.example.json`）：从 Release 下载三个文件，核对 `latest.yml` 的版本、文件名、sha512 和大小，先传安装包和 `.blockmap`、最后传 `latest.yml`，每个先传成 `.partial` 再改名；再把官网用的 `Diffra-Setup-latest.exe` 指向这个版本；传完从公网取回核对。
  - 旧版本的 `.blockmap` 要留在更新源上，客户端靠它做差分下载；找不到时会退回整包下载（约 116MB）。
- 更新时「Failed to uninstall old application files: 2」（第 380–381 步，2026-11-11 升 0.3.0 时装了 4 次才成功）：
  - 原因：浏览器扩展的本机宿主由 Chrome、Edge 经 `%APPDATA%\Diffra\browser-bridge\diffra-browser-host.cmd` 拉起，跑的是安装目录里的 `Diffra.exe`。它不是 Diffra 的子进程，Diffra 退出时不跟着退（Diffra 没开时每 2 秒重连一次）。安装程序会先结束安装目录里的进程，再最多 5 次、每次隔 1 秒运行旧版卸载程序；可宿主被结束后，扩展 3 秒就重新拉起它，新拉起的宿主又占着 `Diffra.exe`，5 次全撞上。updater.log 里旧版每次 10 毫秒内就退出了，说明卡住的不是主进程。
  - 修法（`build/installer.nsh`）：安装程序的 `customInit` 和卸载程序的 `customUnInit` 里，先把启动脚本改名成 `.cmd.updating`，再结束命令行里有 `native-host.js` 的 `Diffra.exe`。浏览器再拉起时找不到脚本，起不来；新版启动时会重写脚本，宿主随即恢复。只在脚本还在时才改名：升级时安装程序和旧版的卸载程序各跑一次，第二次不能把第一次改名的那份删掉。逻辑在新版安装程序里，所以从 0.3.0 升上来的这一次就生效。
  - 验证：Chrome 扩展连着，按自动更新的参数（`--updated /S --force-run`）在原安装目录覆盖安装 3 轮。每轮退出码 0、约 20 秒；安装过程中每 0.2 秒看一次，宿主一次也没被重新拉起；装完后新版启动，宿主重新连上。没有在旧安装程序上做对照，失败的证据是用户这次的 updater.log 和当时还在跑的宿主进程。
  - 在开发机上测安装程序时要注意：安装程序按注册表 `HKCU\Software\<APP_GUID>` 的 `InstallLocation` 决定装到哪里，读不到就装到默认的 `%LOCALAPPDATA%\Programs\Diffra`。这台机器装在 `D:\Users\...\Programs\Diffra`，第一次测试没指定目录，装出了 C 盘的第二份，还把卸载项、开始菜单都改了过去。后来用 `/D=<原目录>` 装回去（顺带卸掉了 C 盘那份），再用普通安装重建开始菜单快捷方式（`--updated` 模式不重建快捷方式）。以后测之前先确认 `InstallLocation`，必要时带 `/D=`。从这个环境里运行安装程序，`--force-run` 不一定能把新版拉起来，要手动启动。
- 更新日志（第 290–297 步）：从提交信息自动生成，客户端、官网、更新包、GitHub Release 用同一份。
  - 生成：`scripts/changelog.ts` 按 `v<版本号>` 的 tag 分版本，收每个版本和上一个 tag 之间的 `feat:`、`fix:` 提交；主题按「；」分条，去掉末尾的「（第 x–y 步）」；`fix:` 的和以「修」开头的条目算修复，其余算新增；`chore`、`docs`、`test`、`ci` 和合并提交不收。`package.json` 的版本比最新 tag 新时，最新 tag 之后的提交算这个版本，日期是生成那天。
  - 所以 feat、fix 提交的主题就是用户看到的日志：用中文、写给用户看，一件事一条，用「；」分开，不写内部实现。早期几条英文提交按提交哈希在 `scripts/changelog-overrides.ts` 里配了中文说明（提交已推送，不改历史）。这条约定也写在仓库根目录的 `AGENTS.md` 里，Diffra 自己的智能体会读到（第 317 步；起因是它写了英文提交、把发版提交写成 feat，CI 拦下了 v0.1.10）。
  - 只留重点（第 551–555 步）：日志原来一件事一条，界面挪位置、滚动条这类小优化也写进去，一版十几二十条，重点被淹没（0.1.0 到 0.4.2 共 192 条）。现在只写新能力、智能体会不会问你和动你东西的变化、功能不工作或结果出错的修复，一条一句话。发过的 21 个版本按这个标准在 `changelog-overrides.ts` 的 `RELEASE_OVERRIDES` 里整版改写（改完 81 条），有整版改写的版本不再从提交生成，按提交哈希换的说法对这些版本也就用不到了。整版改写而不是逐个提交覆盖：一版往往有好几个提交（0.1.5 有 23 个），逐个改既难读也难看出整版剩下什么。以后的版本照旧从提交生成，小优化写在提交正文里或用 `chore:`（见 `AGENTS.md`）。
  - 整版改写只影响之后生成的地方：官网下次 `publish:website` 时更新，客户端要到下一个版本的安装包才带上新的 `changelog.json`；已经发布的 GitHub Release 说明和已上传的 `latest.yml` 不变。
  - `build`、`package`、`dev`、`test` 都会先生成 `out/changelog.json`（不进仓库），客户端主进程从应用目录读它。
  - 打包时把这一版的说明写进 `latest.yml` 的 `releaseNotes`（`electron-builder.config.ts` 的 `releaseInfo`）：旧客户端包里没有新版本的日志，下载新版时靠它在「更新与关于」里显示新版改了什么。
  - 客户端：「更新与关于」按版本列出全部日志，当前版本标「当前」。设置里记 `lastSeenVersion`，升级后第一次启动弹窗列出这次升级带来的版本；全新安装不弹；以前的版本不记版本号，配过模型的当成老用户，只列当前版本。
  - CI：checkout 要完整历史和 tag（`fetch-depth: 0`）；打 tag 发版时 `changelog.ts --check` 要求这一版至少一条日志、而且每条都是中文，不满足就失败；草稿 Release 的说明换成这一版的日志。
  - 官网的 `changelog.html` 由 `scripts/build-website.ts` 生成，不进仓库；顶栏有链接。要在 `publish:release` 之后再发官网。
- 打包版验收：`pnpm --filter @diffra/desktop test:packaged` 先打包，再把全部 e2e 跑在打包出来的 `release/win-unpacked/Diffra.exe` 上（Playwright 的 `packaged` 项目；`pnpm test` 只跑开发版）。
  - 打包版只认正式数据目录，不看 `DIFFRA_USER_DATA_DIR`；测试用 Chromium 的 `--user-data-dir` 启动参数换成临时目录，实测生效，正式目录不受影响。
  - 打包版启动就检查更新；更新源不通时「关于」里显示「检查更新失败：」加原始错误（比如 `net::ERR_NAME_NOT_RESOLVED`）。
- 自动更新实测（2026-11-06，本机临时更新源，0.0.1 → 0.0.2，未签名）：
  - 安装程序会把自己存一份到 `%LOCALAPPDATA%\diffra-updater\installer.exe`，所以装完后的第一次更新就能差分下载：实际只下了 7 段、约 1.0MB（整包 128MB）。
  - 差分下载一次请求多段 Range，更新源要支持 `multipart/byteranges`（nginx 默认支持）。更新源上要保留旧版本的 `.blockmap`。
  - 点「重启并更新」后静默安装、自动重新启动，新版本启动后照常检查更新。
  - 卸载不删 `%APPDATA%\Diffra`（用户数据），也不删 `%LOCALAPPDATA%\diffra-updater`（更新缓存，约 250MB，里面是两份安装包）。
- 代码签名：用支持云签名的 OV 证书。2024 年起 EV 证书也不再直接跳过 SmartScreen 的信誉积累，多花钱买 EV 意义不大。
  - 现在还没配签名。没有配置发布者名时，electron-updater 不校验更新包的签名。证书到位后，要同时配置签名和发布者名，客户端才会校验更新包。

## macOS

- 原则：Windows 的行为一点不改。主进程按 `process.platform` 分支，界面从 `renderer/src/lib/platform.ts` 的 `IS_MAC` 分（preload 把 `process.platform` 放在 `window.diffra.platform`）。只在 Windows 上有意义的代码保持原样；两边都要的改动先确认 Windows 上结果不变。
- 现状（2026-11-11）：开发版和临时签名的打包版在 Mac（Apple 芯片）上能跑，core 的单元测试、桌面端 e2e（开发版和打包版各 98 个）全部通过。签名公证、自动更新、CI 还没做（见下面「还没做」）。
- 窗口：
  - 去掉系统标题栏（`titleBarStyle: 'hidden'`），红绿灯放在 (14, 12)。
  - 顶栏不单独占一行（2026-11-11 定的「侧栏通顶」，像访达、备忘录）：红绿灯、侧栏开关、后退前进浮在窗口左上角，落在侧栏顶部留出的 40px 里；内容面板顶到窗口上沿（留 8px）。侧栏收起时内容区顶上留一条 40px 放这几个按钮。全屏时红绿灯藏起来，按钮挪到最左（主进程发 `window:full-screen`）。侧栏最窄 216px，放得下这一组。
  - 「某台设备能操作本机」的提示在 Mac 上是按钮组后面的琥珀色小图标（文字给读屏），点开看详情；侧栏左下角的设备那行照常变琥珀色。
  - 拖动窗口：窗口最上面 40px 整条（`mac-drag-strip`，垫在所有内容下面）和任务页的标题行（`app-drag`）能拖，里面的按钮、输入框、分隔条不拖；弹窗、下拉菜单打开时整条先不拖。拖动条不能用 `pointer-events: none`，那样的元素可能不算进拖动区；放在负 z-index 下面，点击照常落在上面的内容上。用 `ELECTRON_DEBUG_DRAGGABLE_REGIONS=1 pnpm dev` 能看到实际的拖动区。
  - 不放 ≡：菜单在系统菜单栏里。菜单是单独一份（`window-chrome.ts` 的 `macMenuTemplate`）：应用菜单（关于、检查更新、设置、服务、隐藏、退出）、文件、编辑、视图、窗口、帮助。Windows 那份不动。
  - 点红绿灯关窗只是藏起来，任务和终端照常跑，点 Dock 图标再拿出来；⌘Q、菜单退出时才真正退出。Mac 装更新时先关窗口、后发 `before-quit`，所以 `before-quit-for-update` 时也放行。
- 快捷键：
  - ⌘N、⌘O、⌘K、⌘B、⌘,、⌘J；后退前进是 ⌘[、⌘]；终端开关和 VS Code 一样是 ⌃`（⌘` 是系统切换同一应用的窗口）。
  - Mac 上 Ctrl+K、Ctrl+B、Ctrl+N 在输入框里是移动光标的按键，⌥← 是按词移动，这些都不拦（Windows 上照旧 Ctrl 和 ⌘ 都认、Alt+← 后退）。
  - 界面上的按键提示代码里按 Windows 写（`Ctrl+K`），经 `shortcutLabel`、`shortcutKeys` 在 Mac 上显示成 ⌘K、⌃`、⌘[。
  - e2e 按应用快捷键用 Playwright 的 `ControlOrMeta`（Windows 上就是 Ctrl）；后退用 `flows.ts` 的 `BACK_KEY`。
- 终端：默认 shell 是 `$SHELL -l`（登录 shell，读用户的 zshrc）。node-pty 在 Mac 上靠 `spawn-helper` 拉起 shell，但 npm 包里这个文件没有执行权限，直接用报「posix_spawnp failed」；桌面端的 `postinstall`（`scripts/node-pty-permissions.ts`）在 Mac 上补执行权限，Windows 上什么都不做。打包时 electron-builder 照原样拷贝，所以先装依赖再打包。
- 用户自己的浏览器（扩展的本机宿主）：
  - 没有注册表：清单 JSON 直接写进各浏览器的 `~/Library/Application Support/<浏览器>/NativeMessagingHosts/`（Chrome 是 `Google/Chrome`，Edge 是 `Microsoft Edge`，Chromium 是 `Chromium`）。只登记已经装了的浏览器，不替没装的建目录。卸载没有清理（Mac 没有卸载程序），留下的清单指向不存在的脚本，浏览器连不上就算了。
  - 启动脚本是 `browser-bridge/diffra-browser-host.sh`（755），和 Windows 的 `.cmd` 一样写好管道、令牌文件、Electron 和脚本的路径。
  - 管道是数据目录里的 Unix socket（`browser-bridge/bridge.sock`），路径超过 100 字节（上限 104）时退到临时目录；上次没正常退出留下的 socket 文件启动时先删掉。
  - 实测：Mac 上 Chrome 读的是「用户数据目录/NativeMessagingHosts」，用 `--user-data-dir` 启动的浏览器（e2e 的 Chrome for Testing）不读 `Google/Chrome` 下的清单。所以 e2e 在 Mac 上不登记到真实浏览器的目录，用 `DIFFRA_BROWSER_HOST_DIRS` 把清单写进这次的临时配置目录。
- 内置浏览器的网页弹窗：Electron 自动按取消关掉，关闭事件在 Windows 上 150 毫秒内到，Mac 上更晚。点击、按键后看到弹窗时，等它关掉再回（最多 1 秒），不然工具结果会让模型去处理已经没有的弹窗。
- 测试里的平台差异：Mac 的临时目录 `/var` 是 `/private/var` 的软链接，子进程看到的是真实路径；路径大小写只在 Windows 上合并；Retina 屏截图是 2 倍像素，按截图坐标点击的用例按窗口的 `devicePixelRatio` 换算；PowerShell 命令换成 sh 的（`flows.ts` 的 `TERMINAL_ECHO`、`TERMINAL_PWD`）。
- 打包（`pnpm --filter @diffra/desktop package:mac`，配置在 `electron-builder.config.ts` 的 `mac`）：
  - 出 `release/Diffra-<版本>-arm64.dmg`（给人下载安装）、同名 `.zip`（自动更新只认 zip）和 `latest-mac.yml`；应用在 `release/mac-arm64/Diffra.app`（约 340MB，dmg 约 135MB）。
  - 先只出 Apple 芯片（arm64）：ripgrep、ast-grep 的原生文件按本机架构装，Intel 版要在 Intel 机器或 CI 上另打，universal 包要两套原生文件，以后再说。
  - ripgrep 按平台放进 `extraResources`（Windows 还是 `rg.exe`，Mac 是 `rg`），Windows 打出来的东西不变。
  - 图标 `build/icon.icns`：Windows 的 `icon.ico` 是透明底的标志，Mac 程序坞里习惯带底板，所以按 Apple 模板单独做（1024 画布、824 的白色圆角方块、中间放 `build/brand/icon.svg`）。`pnpm --filter @diffra/desktop icon:mac`（`scripts/mac-icon.ts`）生成，只能在 Mac 上跑；品牌图形改了就重跑。
  - 签名：开 hardened runtime（公证要求），权限在 `build/entitlements.mac.plist`（JIT，和关掉库校验让 node-pty、ast-grep 这些原生模块能加载）。有 Developer ID 证书时（`CSC_LINK` 或 `CSC_NAME`）用证书签名并公证，没有就临时签名（ad-hoc）。临时签名的包只能自己用：发给别人会被 Gatekeeper 拦。
  - 更新源 `https://update.diffra.dev/mac/`（`mac.publish`，写进包里，发布后不能改）。
- 自动更新：Mac 的自动更新要求新旧版本用同一个 Developer ID 签名，临时签名的包一更新就失败，所以现在 Mac 打包版不检查更新，「更新与关于」显示「Mac 预览版暂不自动更新，新版本请到官网下载」（`updater.ts` 的 `mac-preview`）。正式发 Mac 版时去掉。
- 钥匙串：Mac 上 safeStorage 用钥匙串里的「Diffra Safe Storage」加密 API Key，开发版和打包版共用这个名字。签名不同的程序第一次读它会弹系统授权框；临时签名每次打包都不一样，所以每装一个新包都会问一次，有了 Developer ID 就不会。e2e 在 Mac 上加 `--use-mock-keychain`，不碰用户真实的钥匙串。
- 发布（2026-11-15 起，从 0.5.2 开始，Mac 版叫「预览版」）：
  - 还没有 Developer ID 证书，先发临时签名、没公证的包。用户第一次打开会被 Gatekeeper 拦，要到「系统设置 → 隐私与安全性」点「仍要打开」；下载页、首页常见问题、快速开始里写了步骤，和 Windows 没签名时教用户点「仍要运行」一样。有了证书以后改成签名公证的包，再去掉这些说明。
  - 流程：在 Mac 上 `package:mac`（先 `pnpm install`），把 `release/` 里的 dmg、zip、两个 `.blockmap`、`latest-mac.yml` 用 `gh release upload v<版本> … --clobber` 传到这一版的 GitHub Release；然后在有 `publish.config.json` 的电脑上 `pnpm --filter @diffra/desktop publish:mac`（`scripts/publish-mac.ts`），再 `publish:website`。Windows 的 `publish:release` 不变，两边各发各的。
  - 服务器目录：`publish.config.json` 的 `macRemoteDir`，不写就是 `remoteDir` 旁边的 `mac`（`/var/www/diffra-update/mac`），脚本自己建。官网的下载按钮用 `Diffra-latest-arm64.dmg`（软链接，和 Windows 的 `Diffra-Setup-latest.exe` 一样）。
  - 官网：下载页两块卡片，Windows 读 `win/latest.yml`、Mac 读 `mac/latest-mac.yml` 里 dmg 那一项（顶层的 sha512 是 zip 的）。首页的下载按钮和版本说明标了 `data-follow-platform`，用 Mac 打开时换成 Mac 版（iPad 也自称 Mac，按触点数排除）。Intel 芯片的 Mac 浏览器认不出来，下载页写明暂不支持。跨域读 `.yml` 要 nginx 给 `/mac/` 也加 `Access-Control-Allow-Origin: https://diffra.dev`，`publish:mac` 发完会检查，没有就提醒（不影响下载）。
  - 用户的数据在 `~/Library/Application Support/Diffra`，隐私政策、用户协议、快速开始里和 Windows 的写在一起。
- 打包版验收：`pnpm --filter @diffra/desktop test:packaged:mac` 先打包，再把全部 e2e 跑在 `release/mac-arm64/Diffra.app` 上（Playwright 的 `packaged` 项目按系统选程序路径）。
- 还没做：
  - 签名和公证：要 Apple Developer 账号（每年 99 美元，国内 688 元）和 Developer ID Application 证书；公证要 App Store Connect 的 API 密钥或 App 专用密码。个人账号的话，系统弹窗里显示的开发者是本人姓名。
  - 下载统计（`website-stats.ts`）还只算 Windows 的安装包。
  - CI 加 `macos-latest` 的任务（打包、跑打包版 e2e、传草稿 Release），证书和公证凭据放进 secrets。
  - Intel 版或 universal 包。

## Agent 核心（v0）

- 结构：core 实现 ACP 的 `session/new`、`session/prompt`、`session/cancel`，过程通过 `session/update` 推给界面，需要确认的命令通过 `session/request_permission` 询问。
  - 桌面端在 `session/new` 的 `_meta.diffra` 里传入编码模型、评审模型、规划模型、兜底模型、检查命令、禁写目录、规则包、权限模式、单次任务上限、检查点目录，以及是不是设计任务（`design`）、设计任务的风格预设（`designStyle`）、无项目任务（`noProject`）（类型见 `packages/core/src/protocol.ts`）。
- 会话持久化（推翻了原来「会话只存在内存里」的做法）：
  - core 把会话存到应用数据目录的 `sessions/<id>.json`（第 437 步起每轮的更新另存在 `sessions/<id>/` 下，见「内核改进：参照 qwen-code」），另有 `index.json` 做列表；目录由桌面端通过 `DIFFRA_SESSIONS_DIR` 告诉 core。
  - 每轮开始和结束时保存；还没开始过任务的会话不保存，免得每次打开项目都留下空记录。
  - 存的是：标题、项目、每轮的提问和界面要重放的会话更新、发给模型的对话消息、每轮的检查点和对话起点（撤销、重新生成要用）。不存模型地址和 API Key。
  - 用 ACP 标准的 `session/load`、`session/list`、`session/delete`；改名、归档、搜索、重新生成、取 diff 走 `_diffra/session/*` 扩展方法。历史放在 `session/load` 响应的 `_meta.diffra` 里一次给界面，不逐条回放 `session/update`。
  - 打开旧任务时，模型、检查命令、禁写目录、规范都按当前设置重新组装，只有对话历史来自记录。
  - 写文件先写临时文件再改名、按会话排队；`index.json` 丢失或损坏时从各个会话文件重建。
  - 会话记录和 `index.json` 的每一项都带 `design`（设计任务）和 `noProject`（无项目任务），`session/list` 的 `_meta.diffra` 和 `session/load` 的 `LoadedSession` 一起带回；设计首页和侧栏的「无项目」分组靠列表里的这两项，不逐个读会话文件。会话记录里两项缺省都是 false。索引里 `design` 是必填项：没有它的旧索引第一次读取时按上一条的「格式不对就重建」从会话文件重建一次，日志里多一条「索引格式不对，重建」；`noProject` 缺省为 false（旧任务都在项目里），不用为它重建。
  - 应用退出时没跑完的一轮，重新打开后显示为「已停止」；还有没拿到证据的完成条件时显示「受阻（未完成）」（见「本轮结论」）。
- 任务标题取第一次提问的第一行，最长 40 字，可以重命名。
- 主循环自己写，不用 AI SDK 的 agent 循环：每一步调一次 `streamText`，工具由我们执行，这样权限、检查点、检查和门禁都在我们手里。
  - 上限：步数上限和上下文压缩的触发点在「设置 → 任务执行」里调，见下面「长任务」；模型请求失败重试 3 次，回复中途断开会续写或重发，还不行就换兜底模型（第 438 步，见「内核改进：参照 qwen-code」）。
  - 模型一直没有输出（第 186 步）：主循环、子智能体和只读轮（出计划、深度扫描）每一步调模型时记下最后一次收到数据的时间，超过 3 分钟一点数据都没有，就发一条 session_info_update，`_meta.diffra.modelSilentSince` 是最后一次收到数据的时刻；又收到数据、重发或这一步正常结束时发 null（被停止时不发，见下）。界面在「进行中…」下面提示「模型已 N 没有输出，可能卡住了」，旁边是「重试这一步」。子智能体的这条更新带 `agent`，界面按智能体分开记，几个同时没输出时提示最久的那个，一轮结束时清空。
    - 只提示，不自动中断、不自动重试：不显示思考过程的模型想得久时同样一点数据都没有，分不清是卡住还是在想；自动中断会误杀，自动重试要把整段输入重新发一遍。以前连接卡住时界面一直是「进行中」，只能干等。
    - 提示旁边有「重试这一步」（第 202 步）：用户点了才中断那一次模型请求、原样再发一次，这一轮不停（`_diffra/session/retry-step`，按智能体找，子智能体只重发它自己的）。已经显示出来的半截文字留着，被中断的那次请求的回复不进对话。
    - 被停止时 core 不发 null：记录里留着「停下时模型已经多久没输出」，停下说明靠它写「模型已 N 没有输出，你停止了这一轮」。界面把它记在这一轮上（`Turn.silence`），实时的提示和停下说明用同一份，打开旧任务时从记录里重放出来。
    - 这条更新和别的更新一样记进这一轮、触发一次保存。时限可以用环境变量 `DIFFRA_MODEL_SILENCE_MS` 改，只给测试缩短用。
  - 参数不合法的工具调用，AI SDK 会自己在返回消息里补错误结果，主循环不再重复补，否则同一调用会有两个结果。
  - 系统提示词用英文，回复语言跟随用户；会读入项目根目录的 `AGENTS.md`、`CLAUDE.md`（合计最多 8000 字）。
- 基础工具：read_file、list_files、search、outline、edit_file、run_command、verify_changes、task_progress、pause_task、finish。
- 验证与结束分离：`verify_changes` 执行完整检查、安全扫描及规范审查但不结束任务；`finish` 是终结操作。原因：曾将中间检查成功当成发布完成，提前停止。
  - 收紧到「检查之后还有下一步」才用（第 499 步）：提交、推送、等 CI、发布这类要接着做的，先 `verify_changes` 再继续；改完就结束的任务直接 `finish`，`finish` 本身跑同一套检查，工作区没变时还会复用紧接着的 `verify_changes` 结果（verification 为 reused）。系统提示词和工具说明都按这个写。起因：评测里几乎每题都在 `finish` 前单独调一次 `verify_changes`，可它和 `finish` 走同一个完成门禁，紧接着调只拿到「已复用」，白多一轮模型调用。
- 多阶段任务通过 `task_progress` 定义完成条件，引用 core 从成功命令生成的 receipt，匹配命令和实际输出。发布请求另强制 commit/push/ci/publish 四项，交叉核对提交 SHA、远端 SHA、CI completed/success 与正式发布脚本的线上验证结果；不是操作系统沙箱或对恶意模型的证明系统。
  - 只在发版、要跨好几轮、或用户一次提了好几件事时才定（第 499 步）：普通的改代码加跑测试不用定，定了只多一次调用，还容易因为写错预期输出过不了 `finish`。系统提示词和工具说明写明这一点。
  - 非发版任务的完成条件可以重新定义（第 500 步）：再调一次 `define`，新清单替换旧清单，已有的证据（receipts 和各条的 receiptId）一起作废，新条件要用重新跑过的命令来满足；第一次定义时照旧保留定义前跑过的命令。发版任务（`contractRequired`）保持原规则：已有条件不能覆盖、不能删、不能减，commit、push、ci、publish 四项和真实命令校验一条都不放松。起因：以前条件一定就改不了，评测 t08 里把预期输出写错一个字，代码改对了也永远过不了 `finish`，只能 `pause_task` 收场。
- 状态 running/waiting/blocked/cancelled/completed 与 ACP stopReason 分离；`pause_task` 仅暂停，不冒充完成。状态、清单、证据在关键步骤落盘，重启可恢复，运行中断恢复为受阻；界面用 session_info_update 元数据展示状态，不把 end_turn 当成功。
  - `needsVerification`：有改动还没过完成门禁。只在文件真的改了之后置位（edit_file 写入成功，或 finish 时、只回文字时发现命令、MCP 工具改了文件），被拒或失败的编辑不算；非目标模式下 finish 被接受、目标模式下目标达成、进入下一目标轮或轮数用完时清掉（这几种情况 finish 都已经过了完成门禁）；撤销、重新生成时回到那一轮开始时的值。以前在 edit_file 执行前就置位，写入被拒的一轮也会显示「未完成」，下一轮还会被拉回来调 finish。
    - 只算项目里的文件（第 484 步）：用户授权写到项目外的文件（比如临时目录里的统计脚本）不算改动，不置位、不跑完成检查、只回文字也不拉回来要 finish。起因：一轮只查不改的调研，模型在临时目录写了几个脚本，收尾时跑了整个项目的 typecheck 和全量 e2e，还因为一个不相干的 e2e 失败停在受阻。
    - 它随任务状态落盘，下一轮开始时带进来，算作这一轮已经改过文件。上一轮改了文件后没过门禁就停下（用户停止、暂停、连续打回、卡死、出错、到步数上限、上下文超限、没调 finish 等）时它还为真，下一轮哪怕只用文字回答也会被拉回来要求调 finish，拉回时说明是之前轮次的改动还没验证，不说本轮改了文件；本轮又用命令或 MCP 工具改了文件时（拉回前和本轮开始时的工作区指纹比一次），两者都说，只跑了只读命令时仍用原来的说法。门禁里检查命令写的文件（如 `lint --fix`）也会让指纹变，同样算进「本轮改的」。模型一直不调，拉回 3 次后记 no-finish，显示「未完成 · 未验证」。这样用户说「继续」、模型只回一句「做完了」时也要走完门禁。
    - 撤销时不一律置为真：撤销第 X 轮及之后的改动时，工作区回到第 X 轮开始时的快照，待验证也取那时的值：主循环、出计划、深度扫描开始时都把任务状态记进这一轮，取这一轮的第一份；以前的记录里计划和深度扫描轮没有这一份，就取更早轮次最后记下的，都没有算 false（更早的记录没有这个字段，也算 false）。撤销掉的是用户自己退回的改动，不是智能体没验证的改动；以前一律置为真，撤销后下一轮只是提问也会被拉回 3 次。第 X 轮开始时本来就有没验证的改动，撤销后照样要验证。
    - 重新生成第 X 轮也取这一份；没有检查点、文件没回滚时工作区没变，保留重新生成前的值。以前重新生成一律置为 false，第 X 轮开始时带着的没验证的改动，在重新生成的那一轮里不再被拉回。
    - 重新生成保留这一轮开始前就定下的完成条件、只作废证据：receipts 清空，各条完成条件的 receiptId 置 null，完成契约要求和发布版本号照旧；这一轮里才定下的完成条件随对话一起撤掉（定下后改不了，留着的话写错的条件再也摆脱不了），按这一轮开始时记下的任务状态判断；状态回到 running、没有原因（马上要重发这一轮，不像撤销那样记 blocked）。以前重新生成把任务状态整个换成新的，完成条件一起清掉，重新生成的那一轮不用再满足它们。
  - 每轮结束时（主循环的 finally）发一条 session_info_update，`_meta.diffra` 里同时带任务状态和 `turnOutcome: { finish, stop }`，随这一轮的更新落盘，记录格式不用迁移。plan、deep-scan、compact、diagnose 轮不走主循环，没有它。
    - stop 是 model-error 时另带 `errorKind`（第 201 步）：模型接口出错的类型（auth、rate-limit、server、timeout、network 等，和模型设置里测连接用的同一套），停下说明按它写原因、给下一步。旧记录没有，按「模型调用失败」显示。
    - finish：本轮所有被接受的 finish 合并后的值，优先级 unverified > verified > no-edits（reused 算 verified），没有被接受的 finish 时为 null。目标模式一轮里有几次 finish，后面「没有改动」的 finish 不能盖掉前面未经验证的改动。
    - stop：本轮非正常停下的原因：paused、cancelled、no-finish、gate-exhausted、check-exhausted、stuck、model-error、step-limit、context-limit、goal-exhausted、deep-scan；正常结束为 null。deep-scan 是智能体提交前用户选了先做深度扫描（第 425 步，见「安全检查」），界面接着发起深度扫描，这一轮不显示停下的原因。check-exhausted 是快速检查卡住停下，第 418 步起不再产生（第 431 步起快速检查不再每步跑），只有旧记录里有；gate-exhausted 是完成检查卡住停下或完成门禁因其他原因连续 3 次打回；卡住指完成检查连续 3 次没有进展，或这一轮完成检查失败满 12 次；见下文检查命令一节。以前是连续 3 次失败。stop 和 finish 不互斥：goal-exhausted 发生在最后一次 finish 被接受之后，这时 finish 也有值；目标模式里前几轮的 finish 被接受后才停下，两者也都有值。以前这几条停止路径只发一条提示，不留结构化的痕迹。
    - no-finish 只在应该调 finish 却没调时记：改了文件（包括之前轮次留下、还没过门禁的改动，见上面的 needsVerification）、目标模式、要求完成契约、还有没完成的完成条件；不是这几种情况的纯文字回答记 null。
  - 打开旧任务时 `session/load` 的响应带 core 当前的任务状态（`LoadedSession.taskState`），比最后一轮里的快照新；撤销、重新生成之后 core 也马上发一条带任务状态的 session_info_update。界面优先用 core 给的，没有时（旧版 core、还没跑过任务）才从最后一轮的更新里取。
- 验证缓存仅在进程内保存，按独立检查点仓库的工作树指纹复用；编辑和命令执行使缓存失效，恢复会话不复用，撤销、重新生成使完成证据作废。
  - outline 列出一个文件或一个目录下所有源文件里的函数、类和方法、接口和类型、模块级变量，带行号，不带函数体。支持 TS/JS、Vue 的 `<script>`、Python；用 core 已经依赖的 ast-grep 解析，和静态安全检查共用解析器的加载（`packages/core/src/syntax.ts`）。目录模式和 list_files 一样用 ripgrep 列文件（git 仓库里按 `.gitignore` 跳过），最多 200 个文件、3 万字。
  - 不做自动附带的项目大纲（每次请求都带会拖慢提示词缓存、多花 token），由模型按需调用；系统提示词里提示先用它看概览。
  - list_files 和 search 用 ripgrep（`@vscode/ripgrep`）。打进桌面端后它找不到自己的平台包，所以打包时把 rg.exe 放进 resources，由主进程通过 `DIFFRA_RG_PATH` 传给 core。
  - edit_file：先精确匹配；匹配不到时忽略缩进和行尾空白，并按文件里的缩进重排新内容；还匹配不到就返回最相近的片段。精确命中的位置如果落在某行缩进中间，也走按行对齐的逻辑。必须先读过文件，而且读完后文件没变过；保留文件原来的 CRLF/LF。
  - 路径只能在项目目录里，符号链接解析后也要在项目里。Git Bash 风格的 `/d/...` 路径会转成 Windows 路径。
  - run_command 用 Git for Windows 自带的 bash（不能用 PATH 里的 bash，那是 WSL 入口），默认超时 120 秒，最长 600 秒，超时结束整个进程树；输出保留首尾各 200 行、最多 30KB。
- 命令权限（`packages/core/src/permissions.ts`）：
  - 自动放行：只读命令（ls、cat、rg、git status/diff/log 等），以及项目配置的检查命令。
  - 询问：其他命令，以及带重定向、命令替换、后台执行的命令。选「本会话内允许同类命令」后，按「程序名 + 子命令」（如 `pnpm test`）记住。
  - 直接拒绝：递归删除根目录、用户目录、上级目录或整个项目，强制推送，`curl | sh`，系统级危险命令。
  - Windows 上没有轻量沙箱，防线是「审批 + 检查点」：防误操作，不防提示注入。
- 权限模式（输入框左下角切换，任务中途可改；改了同时记成新任务的默认值）：
  - 每次询问（默认）：就是上面的规则。
  - 自动审批：普通命令直接执行；git 推送、重置、清理、变基、恢复、切换，安装和卸载依赖，npx 这类临时下载执行，联网下载和远程连接，递归删除，命令替换，仍然问。
    - 第 634 步：单引号里、引号定界的 heredoc（`<<'EOF'`）正文里的反引号和 `$(` 不算命令替换，shell 不会展开。评测里自动审批下的确认大半是 `node -e '...'`、`node - <<'EOF'` 里 JS 模板字符串的反引号。`for f in $(rg ...)` 这种真替换照旧问：`git $(echo push)` 能借它绕过推送检查。改后之前确认最多的 6 道题各跑 3 遍：确认从 26 次降到 7 次，通过率不变（18/18）。
    - 第 635 步：剩下的确认里再放开两种：`npx --no-install` / `--no`（明说不下载，本地全局都没有就报错）；`rm -rf` 只删项目里的 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`（只认相对路径、不带 `..` 和通配符）。删 `/tmp` 下的目录照旧问。
    - 第 637 步：路径里只要有 `~` 就当成「看不出在哪」按项目外算，可 bash 只展开开头和 `=`、`:` 后面的 `~`。Windows 用户名长时临时目录是 8.3 短路径（`C:/Users/RUNNER~1/...`），命令输出、Skill 目录在这下面就读一次问一次。GitHub 的 Windows 构建机正是这样，v0.5.0 发版时 CI 的 core 测试挂在这两条上（本机路径没有 `~`，测不出来；v0.4.1、v0.4.2 的 CI 被取消、在本机打包，没在 CI 上跑过）。改成只认开头和 `=`、`:` 后面的 `~`。
  - 完全访问：不再询问。
  - 三种模式下，直接拒绝的命令清单都照旧，改动禁写目录时总要问。
  - 受保护文件（第 495 步）：完全访问不再因为命令提到或可能读到 `.env` 这类文件而问，和 Claude Code 的 bypassPermissions、Codex 的完全访问一样，只剩直接拒绝和禁写目录。每次询问、自动审批里，命令字面写了受保护文件的名字（含 `*.pem` 这种扩展名）照旧要问；递归搜索（`grep -r`、`rg -u`/`--hidden`）和能匹配受保护名字的通配符，先看要搜的地方真有没有受保护文件，没有就放行。
    - 第 625 步：不问不等于让密钥进对话。评测里完全访问档下 `cat .env` 串在一长串查看命令里，密钥原样发给了模型服务商。现在 exec_command、write_stdin 的输出交给模型和界面之前，把项目里受保护文件（同一份名单）里的值换成「hidden by Diffra: value of X in .env」，三种模式都一样。按值换而不是猜格式：怎么打印出来的都挡得住，不误伤别的内容；只取名字像密钥的变量和像随机串的长值，localhost、端口照常显示。扫项目有文件数和条目上限，结果缓存 15 秒。
    - 第 631 步：工作区里没有、命令里也没写名字的历史内容也换。评测里智能体用 `git show <提交>` 查是哪次改坏的，那次提交顺手带了后来删掉的 `.env`，diff 原样进了对话。现在输出里受保护文件的 diff 段（`git show`、`git log -p`、`git diff` 的格式）和 `git grep` 的「提交:路径:内容」行，按同样的规则取值再换掉。
    - 怎么看：用 `tools/protected.ts` 的 `isProtectedFile`，递归时跳过 `node_modules` 和 `.git`，最多看 1 万个目录项（本机在仓库根目录约 3 毫秒），看不完按会读到处理；`cd` 换后面几段的目录，路径里有 `~`、`$` 这类定不下来的也按会读到处理。
    - 推翻了第 431 步「通配符、递归搜索一律要问」：那样连 `grep -rn xxx src/` 这种普通搜索也弹窗，完全访问下也躲不掉。代价：完全访问下在有 `.env` 的目录里递归搜索，密钥内容可能会发给模型；`read_file` 读不了受保护文件这条不变。
- 检查点：每轮开始前打快照，存在应用数据目录 `checkpoints/<项目路径哈希>` 下的裸仓库里，用 `--work-tree` 指向项目，不碰项目自己的 `.git`。
  - 第 632 步：禁写目录本来就被忽略时（`node_modules` 在快照仓库的默认排除里，`data/` 这类常写在 `.gitignore` 里），不再写进 `git add` 的排除：git 碰到点名的被忽略路径会退出 1，整个检查点建不起来，撤销和安全检查跟着没了。每次快照前用 `git check-ignore` 筛一遍。
  - 仓库配置关掉 autocrlf，按原样保存字节；遵守项目的 `.gitignore`，并总是排除 `node_modules/`。
  - 撤销这一轮及之后的改动时，只动这一轮开始之后有变化的文件：改过和删掉的恢复，新建的删掉；执行前先列出文件让用户确认。列表是工作区和这一轮开始时的快照比出来的，不分是谁改的：这段时间里用户手动改过的、同一项目其他任务改过的文件也在里面，确认框的提示里写明。智能体的 git 命令带进来的文件除外，见本节最后一条。界面上的入口和叫法见「对话流」。
  - 撤销就是回到这一轮开始时的快照，更早撤销掉的轮次的改动会跟着回来。所以 core 给这一轮及之后的轮次记 `restoredAt`（`StoredTurn`，多次撤销记最后一次），只表示「之后撤销过」这个历史事实，不表示这一轮的改动现在不在；重新生成、再次撤销都不清已有的标记。
  - 撤销后任务状态改为 blocked、`needsVerification` 回到被撤那一轮开始时的值，完成条件的证据全部作废。原因按状态写：有完成条件（或发布类任务还没定义完成条件）时写「文件已撤销，需要重新验证完成条件。」，否则待验证为真时写「文件已撤销，之前轮次的改动还没验证。」，都没有时写「文件已撤销，原来的结论不再算数。」以前一律写第一句，撤销后没有完成条件、也不用验证时说错了。
  - 「已撤销 N 个文件的改动」提示（最多列 50 个路径）记进被撤销的那一轮，重新打开任务照样显示；界面撤销时本地追加同样的一条，文本都由 `protocol.ts` 的 `restoreNotice` 生成。以前这条只在界面本地插入、不存盘，可撤销后结论会变成「未完成」，重新打开时得看得到原因。
  - 需要系统装有 git；没有时会话照常运行，界面提示改动无法撤销。
  - 同一个仓库上的 git 操作（快照、列变化、取 diff、还原）在 core 里按仓库目录排队执行。它们都要写仓库的索引文件，同时跑会撞上 `index.lock`；同一项目的多个任务共用一个仓库，界面上任务监控、审阅面板、撤销确认框也会同时来读。
  - 无项目任务各用一个文件夹（见「无项目任务」），检查点仓库按路径哈希也各是一个：撤销、工作区指纹、本节说的「同一项目其他任务改过的文件」这类互相影响只发生在真实项目里，无项目任务之间互相隔离。
  - 一轮刚开始、快照还没打好时来要这一轮起的 diff，返回空：快照在任何工具运行之前打，这时还没有改动。
  - Git 带进来的文件不算智能体的改动（第 413、435 步）：主智能体执行带 `git` 的命令前后各读一次项目的 HEAD。挪了的话，两次提交之间变了、命令跑完后又和新 HEAD 一模一样的文件（没有未提交的改动、没有同名的未跟踪文件），是 Git 带进来的：把它们换进这一轮的基线，存成检查点仓库里的一个提交，记在会话记录这一轮的 `gitBase`（`Session.changeBase`）。
    - 用这个基线的地方：完成门禁判断「改没改文件」（本轮开始指纹跟着换）、交给安全检查和规范审查的 diff、任务监控和审阅面板的改动、撤销和它的确认列表、重新生成、深度扫描「本任务改动」的范围和提交前问不问。从第 X 轮撤销时，把第 X 轮及之后每一轮带进来的文件依次叠上去。
    - 以前只比工作区内容，不分谁改的：一次「拉一下最新代码」把拉下来的 49 个文件当成这一轮的改动，跑了 4 次全量测试、3 次审查别人的代码，智能体还去改那些代码，前后 30 分钟；撤销那一轮时文件退回拉取前、HEAD 没退，工作区里多出 50 个把上游改动反着撤掉的改动。
    - 改了的行为：智能体自己切分支、`reset --hard`、`revert`、`cherry-pick` 带来的文件也不审查、撤销时也不退回（提交本来就不会退回）。拉取之前它已经改过的文件（跑完后和新 HEAD 不一样），照旧整份算它的改动，会连带上游的改动一起审。
    - 不管：子智能体执行的 git 命令、用户自己在终端里拉的代码（照旧算进那一轮的工作区变化，和以前一样）、没挪 HEAD 的命令（`stash pop`、`checkout -- 文件` 这类）。
    - 代价：每条带 git 的命令多两次 `rev-parse`；HEAD 挪了时再多一次 diff、status 和检查点指纹。读不到（不是 Git 仓库、出错）时记日志，这一轮照旧按整个工作区算。项目在仓库的子目录里时只算这个子目录下的文件。
- 检查命令按项目路径存在应用设置里（`settings.json` 的 `projects`），不往用户仓库写文件。新建或重新打开任务时传给 core，改了对已经打开的任务不生效。
  - core 在会话信息里带上这个会话实际生效的检查命令（`SessionInfo.checks`），任务监控的检查行读它，和项目设置不一致时行尾标「新任务生效」；旧版 core 没有这一项时退回读设置。
  - 改的过程中不跑任何检查（第 431 步）：只有一栏「完成检查」，智能体调 finish（或 verify_changes）时跑一次；静态检查、轻量扫描、规范审查也都在那时一起跑。系统提示词写明检查只在 finish 时跑、改的过程中不要自己跑。
    - 以前每一步改了文件就跑「快速检查」（比如 `pnpm typecheck`）：第 418 步先改成失败只当提示、不计入上限，第 424 步又加了编码中的静态检查；用户不要每步检查，第 431 步两样都撤掉。大仓库里一次类型检查几十秒，一轮改十几步就是好几分钟；跨文件改动的中间状态本来就编不过，每步查出来的多半是还没改完的地方。
    - 代价：模型真的一路写坏时，要到 finish 才发现，那时一次修的东西多；完成检查失败按进展计数、有上限，步数上限也照样兜底。
    - 旧设置里存的「快速检查」（`checks.afterEdit`）不迁移：完成检查没填时，finish 照旧用它，和以前「完成检查不填就用快速检查」一样；两栏都填了的，快速检查那条不再跑。项目设置弹窗按实际会跑的那条显示，保存时只存完成检查、快速检查清空。
  - 完成检查：finish 时跑；不过就打回。按错误有没有进展计数，不按失败次数：连续 3 次没有进展、或这一轮完成检查失败满 12 次才算卡住。完成条件没满足、发布证据不合格、安全检查和规范审查的打回没有可比的错误列表，维持连续 3 次打回就停下。和安全检查、规范审查同时跑、一起打回，见「安全检查」的完成门禁一条。
  - 改了文件却没调 finish、只回文字的，会被拉回来要求调用，最多拉回 3 次，和上面「其他原因的打回」共用一个计数。检查命令不过的打回不占这个名额：以前占，完成检查有进展地打回 3 次后模型回一句文字，就直接记 no-finish 停下，按进展计数形同虚设。
  - 进展的判定（`packages/core/src/session/check-progress.ts`）：
    - 检查输出整理成一组错误，每条去掉行号列号、颜色码、耗时和项目根路径，只留「文件 + 错误内容」。tsc、eslint、pytest、cargo、go test、vitest 的格式按行认，其他「文件:行号: 内容」的行也认。
    - 警告不算错误：tsc、eslint、cargo 的 warning 和「文件:行号: warning…」的行认出来，但不进错误集合，也不算进下面的其余输出。停下的提示、进展摘要里的剩余错误都不含警告。
    - pnpm -r 给每行加的「包目录 脚本名: 」前缀先剥掉再认。第一段要求不带冒号、带字母数字，免得剥掉 go 的「文件:行:列:」和「--- FAIL:」；runShell 加的「Exit code:」不剥。
    - pytest 只用用例 id 比较，不带后面的消息：同一个用例只是断言的值变了不算修好。参数化 id 的方括号里可以有空格。
    - 和上一次失败比：上次的错误至少修好一条，或者认出的行以外的其余输出（规范化后）变了，就算有进展；新冒出来的错误不影响判断：跨文件改动常常修一处、牵出一处。认出的错误一条都没修好、其余输出也没变，算没进展；第一次失败没有可比的，也算一次。
    - 认不出格式时，整段输出就是其余输出，规范化后整体比较。规范化去掉耗时、百分比、时刻（vitest 的汇总行每次都不一样）、行号列号，包括 eslint 风格的行首「行:列」。
    - 消息变化算进展，靠总上限兜底：其余输出里的汇总行（「Found N errors」、pytest 的「N failed」、cargo 的「due to N previous errors」）、代码片段、认不出的测试框架的失败消息和断言里的实际值，变了都算有进展，只是新冒出一个错误导致的计数变化也算。宁可多给几次机会也不误停，来回打转由每轮 12 次的总上限兜住。
    - 已知认不出、只能整体比较的形态：jest 的失败（「● 套件 › 用例」加消息）、mocha、只有汇总行没有逐条错误的工具；tsc --pretty 和 cargo 的代码片段行也只进其余输出。
    - 比较用截短前的输出：runShell 额外返回一份只按 2 万行、2MB 截的输出（超出时同样保留首尾、中间注明省略了多少行），给模型看的照旧截成首尾各 200 行、3 万字，交给模型时再截成 120 行、8000 字。以前比较用的是截过的输出：错误超过 400 行时，只多一条新错误、什么都没修，挤出截断窗口的旧错误也被算成修好，判为有进展。runProcess 收集输出超过 1MB 时只留首尾各 64KB 并注明，这一层没动。
    - 检查通过时「没进展」的计数清零，这一轮的失败总数不清：总上限防止在不同错误之间来回打转。目标模式里每一轮目标重新计数。
    - 以前是连续 3 次失败就停，不看进展：改一个函数签名要动 4 个文件、每步改 1 个时，前 3 步必然失败，正修到一半就被判为卡住；完成检查从 10 个失败修到 2 个也会被停。代价是有进展时一轮里可能多跑几次检查，耗时和 token 多一些，上限是失败 12 次。
  - 交给模型的失败信息在检查输出前加一行进展摘要：第一次写共几个错误，之后写上次几个错误修好了几个、新增几个、还剩几个，认不出格式时只说输出变没变。输出后面加一句引导：剩下的错误在同一处改动的文件里时，下一步一起改完，一步里可以调多次 edit_file。
  - 卡住时配了兜底模型先换它接手，计数清零（见「规划和兜底」）；没配就停下，stop 记 gate-exhausted。停下的提示写明是完成检查连续 3 次没有进展，还是「完成检查失败次数到上限」（这一轮完成检查一共失败了 12 次），列出最多 5 条剩余错误和一共还剩几个，并说明发「继续」可以接着修，或者先手动处理这几处。
    - 认不出格式时列没认出的输出最后几行：失败信息一般在末尾。跳过「Exit code:」、pnpm 的「Scope:」和「包目录 脚本名$ 命令」、npm 的「> 包@版本 脚本」这类头部。以前取开头几行，常常只看到退出码和脚本头。
  - 停下时剩余错误（最多 20 条）记在会话上，下一个执行轮开始时交给模型一次，用户要继续时从这些错误接着修。出计划、深度扫描轮不消费它，中间可能隔着这些轮次，所以说明里写「最近一次因检查卡住停下时」，不写「上一轮」。改了文件还没验证的照样由待验证拉回，这里只补上剩余错误。
    - 只在内存里，重新打开任务后没有；撤销后作废。会话上按轮记着每个执行轮开始时收到的剩余错误：重新生成收到它的那一轮时放回去，重发的那一轮照样收到；重新生成停下的那一轮时，它留下的剩余错误随之作废（放回的是那一轮自己开始时收到的，没有就是空）。
  - 完成卡和 verify_changes 卡的 `_meta.diffra.verification` 写这次是怎么验证的，界面按它出词：
    - verified：配了检查命令，整个完成门禁都过了；reused：复用这份工作区已经通过的验证；no-edits：本轮没改文件；failed：打回。
    - unverified：没配检查命令，或者没有检查点、本轮又跑过命令或 MCP 工具，判断不了改没改文件。完成卡显示「已完成 · 未经自动验证」，不用成功色；verify_changes 行的画法见「对话流」。
    - 取代原来只在没配检查时写 `_meta.diffra.unverified` 的做法：那样无编辑短路、复用验证和 verify_changes 都不带标记，界面只能猜。没配检查时 `unverified: true` 照旧写；旧记录只有这个标记，带它的按未经自动验证显示，其余只写「已完成」。
  - 只用命令或 MCP 工具改了文件也要过完整门禁：本轮开始时记下工作区指纹，finish 时没有 edit_file 的改动就比较指纹，变了按有改动处理。没有检查点又跑过这两类工具时记 unverified，不记 no-edits。
    - 不调 finish、只回文字时，本轮跑过这两类工具也比一次指纹：变了就置 `needsVerification`，按「改了文件没调 finish」拉回，拉回 3 次还不调记 no-finish，界面不再显示「已完成」；判断不了（没有检查点）或没变时不拉回。以前只在 finish 时比，智能体只用命令改了文件、又不调 finish 时，界面显示「已完成」，待验证也是 false，下一轮不会被拉回。代价是这种轮次多算一次 git 指纹。指纹是整个工作区的，不分谁写的：同一项目其他任务、用户手改、没被忽略的缓存（如 `__pycache__`）、开发服务器写的日志，在这一轮里变了也算，纯问答轮也可能被拉回。和 finish 时的判定是同一个局限，接受。
  - 系统提示词会写明哪些检查命令会自动跑、要求模型不要自己再跑。真实模型试跑时发现，不写这条的话模型会自己再跑一遍测试，还会多弹一次权限确认。
  - 系统提示词的编码规则里约定：改函数签名、类型、重命名导出这类牵动多个文件的改动，在同一步里把相关文件一起改。原先是为了减少中间状态被每步检查查到的次数；第 431 步起每步不查了，这条照样留着，少几个步骤。
  - 「完成」卡片在完成检查跑完后才显示，界面上的先后顺序和实际执行一致。
  - 完成条件没满足、发布证据不合格的打回也发一张「还没完成」的完成卡（verification 为 failed），写明还差什么或证据哪里不对。以前这两种打回在对话里看不到。
- 自动识别检查命令（`packages/core/src/project/detect.ts`，原第 5 步的一部分）：
  - 只读项目文件，不执行命令；识别结果只是建议，用户在项目设置里看过、点「填入」再保存才生效。检查命令运行时不再逐次确认，来路不明的仓库里 `package.json` 的脚本可能有害，所以建议里把脚本的实际内容一起列出来。
  - 项目设置弹窗里完成检查一栏下面一条建议行：第一行「建议：」加命令和「填入」按钮（填完换成「已填入」），下面逐条写其中每条命令的种类、来源和实际运行的脚本（core 用 ` && ` 连接命令，拆开才对得回来源）。第 431 步以前是快速检查、完成检查两栏各一条建议。
  - 和已保存的值不同、并且不为空时，下面出现信任提示「保存后这条命令会在任务里自动运行，不再逐次确认。只保存你信任的命令。」；命令没改时用户不需要做什么，不显示。
  - TS/JS：包管理器按 `packageManager` 字段、再按锁文件判断。优先用 typecheck、lint、test 脚本；没有脚本时，项目依赖里有对应工具才用 `tsc --noEmit`、`vue-tsc --noEmit`、`eslint .`、`vitest run`、`jest`，npx 加 `--no-install`，不会去下载。
  - 会改文件（`--fix`、`--write`）或进入监听模式的脚本不选，npm 生成的占位 test 不选；test 脚本是 vitest 时加 `--run`。
  - Python：用项目的 `.venv` 或 `venv` 里的解释器跑 `-m ruff`、`-m mypy`（或 pyright）、`-m pytest`；配置里提到了、但虚拟环境里没装的工具不选。pytest 还要求有 tests 或 test 目录。
  - 建议的完成检查是类型检查、lint 加测试连成一条；没有测试时就是类型检查和 lint。core 的识别结果里仍分两项（`afterEdit` 是类型检查和 lint，`beforeFinish` 再加测试、没有测试时为空），界面取 `beforeFinish ?? afterEdit`。
  - 项目里没有的工具不替用户装，也不改项目的配置。
  - 首页在项目还没配检查时提示识别到几条；项目设置里完成检查一栏可以「试运行」（Git Bash，和任务里的检查一样最长 5 分钟）。
  - 标签和任务监控、对话检查卡一样叫「完成检查」，什么时候跑写在标签下的提示行里。以前弹窗里叫「改动后检查」「完成前检查」，从任务监控点「编辑检查命令」进去，同一个东西换了名字。旧记录里的「快速检查」卡照旧按检查卡显示。
- 测试连接会额外探测工具调用（要求模型必须调用一个工具），不支持的模型在界面上会标出来，agent 用不了。
- 受保护文件（`packages/core/src/tools/protected.ts`）：`.env`、`.env.*`（`.env.example`/`.sample`/`.template`/`.dist` 除外）、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa`/`id_ed25519`/`id_ecdsa` 私钥（`.pub` 除外）、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`。
  - read_file 和 edit_file 直接拒绝；search 用 ripgrep 的排除规则把它们排除在外，指定搜它们也会被拒；list_files 照常显示文件名。
  - 命令里提到这些名字时，即使是 cat 这类只读命令也要用户确认；只有和配置的检查命令完全一致时才自动放行。
  - 这是防止 Diffra 自己的工具把密钥读进模型上下文，不是安全边界：用户批准的命令仍然可以读到它们。
- 禁写目录：按项目在应用设置里配置（`settings.json` 的 `projects[路径].readOnlyPaths`，相对项目根目录），用来保护项目里的数据目录。
  - edit_file 不能改、也不能在里面新建文件。
  - 非只读命令的参数提到禁写目录里的路径时，即使之前选过「同类命令始终允许」也要再问；读取不受限制。
  - 和检查命令一样，新建或重新打开任务时生效。
- 检查点不包含受保护文件和禁写目录：密钥不会被复制进快照仓库；撤销时也不会把用户在这些地方的改动还原掉。代价是 `.env.example` 这类示例文件、`.pub` 公钥同样不进快照，agent 改了它们没法撤销。
- 系统提示词会写明受保护文件和禁写目录，减少模型反复尝试。

## 长任务（第 7 步）

- 设置（「设置 → 任务执行」，所有项目共用，新建或重新打开的任务生效）：
  - 上下文压缩的触发点：模型窗口的 50% / 60% / 70% / 80% / 90%，默认 70%。没配窗口大小的模型按 12.8 万算。
  - 单次任务步数上限：30 / 50 / 80 / 100 步或无上限，默认 100。模型每回复一次算一步。到了上限停下，提示可以发消息让它继续。
- 上下文压缩（`packages/core/src/session/compact.ts`）：每次调编码模型前，用上一次调用实际的输入 token 数按字数比例估算这次的大小，超过触发点就压缩。
  - 先把最近 4 步之前、500 字以上的工具输出换成一句占位（告诉模型需要时重新执行）。不调模型。模型凭旧印象改文件也不会改错：编辑要求和当前文件逐字一致。
  - 还不够时用编码模型把最近 4 步之前的对话写成摘要：发过去的是原来的前缀加一条写摘要的要求，不让调工具，能用上提示词缓存。从模型回复处切开，工具调用和它的结果不会被拆开。摘要消息里原样附上当前这一轮的提问，不靠模型转述。
  - `session.messages` 保留原文，另记压缩点和摘要（会话记录的 `compaction` 字段，旧记录为 null）；发给模型的是摘要加压缩点之后的原文。重新生成、撤销到压缩点之前的轮次时摘要作废，下次超限再压。
  - 压缩后 3 步内不再压缩；这期间超过窗口 95% 就停下（最近几步本身太大，比如一次读了很大的文件）。写摘要失败也停下。停下时说明原因。
  - 对话里显示「上下文压缩」卡片，展开看摘要；写摘要的调用记进用量（角色算编码）。界面上的历史不受影响，界面读的是每轮存下的更新。
- 卡死检测：同一个调用（工具、参数和返回结果都一样）在两次成功的编辑之间出现 3 次，先提醒模型换思路；提醒后再出现就停下，说明是哪个操作。
  - 判断带着返回结果，改完文件再读、再跑测试不会被误判。
  - 另有两道限制：完成检查连续 3 次没有进展，或这一轮完成检查失败满 12 次就停下（见「Agent 核心」的检查命令一节）。改的过程中不跑检查。
- 手动压缩：会话输入 `/compact` 从斜杠菜单触发独立操作轮（TurnKind compact），经 IPC/ACP 扩展复用编码模型摘要。空闲时可用，不受百分比阈值限制；优先保留最近 4 步，短会话至少保留最新用户轮，调用和工具结果不拆开。对话过短或摘要未缩短时不替换，失败/取消保留原上下文；最长 5 分钟。历史、任务完成条件、工作区均不变，摘要持久化、用量照常记账，刷新估算的上下文用量。不提供该操作轮的文件撤销或重新生成。
  - 压缩后按「压缩前字数 → 压缩后字数」的比例折算上下文用量，压缩卡片完成前就把新的 `usage_update` 推给界面，输入框下方的百分比马上变小；重启后 `lastContext` 为空时，用会话里存下的最近一次 `usage_update` 折算，不会因为拿不到上次调用而停在压缩前的百分比。
  - `usage_update` 的 `_meta.cache` 带上最近一次模型调用的缓存命中、写入和那次调用的输入 token 数；缓存命中率按那次输入算，压缩后 `used` 变小时不会把命中率算高。
- 不做（以后再说）：LSP、深度扫描里的压缩（它有自己的处理：上下文快满时要求直接交报告）。

## 规划和兜底（第 15 步）

- 「规划」「兜底」两个角色从第 15 步起才真正生效：桌面端按角色把两个模型放进会话配置（`planModel`、`fallbackModel`），任务监控里显示编码、规划、备用各用哪个模型。
- 兜底：编码模型在这三种情况下本来会停下——卡死检测提醒过后还在重复、完成检查卡住（连续 3 次没有进展，或这一轮失败满 12 次）、完成门禁因其他原因连续 3 次打回。第 418 步以前快速检查卡住也会换。配了兜底模型时改为换它做这一轮剩下的部分。
  - 每轮最多换一次；换了以后计数清零，再卡住就照常停下。下一轮回到编码模型。
    - 不管因为哪一项换的人（包括卡死检测），完成检查的「没进展」计数、这一轮的检查失败总数、完成门禁打回和拉回的次数一起清零。上次失败的输出留着，备用模型的失败照样和它比。
    - 以前只清触发换人的那一项：快速检查和完成检查是同一条命令、每步都改了又 finish 时，两项同时到头，换完人马上因另一项停下，备用模型一步没做。
  - 换的时候给模型留一句说明（前面卡在哪、换了人、要换个思路），对话里提示「已换用备用模型」和原因。
  - 上下文窗口、上下文压缩、用量记录都按当时在用的模型算；用量角色仍是编码。
  - 模型接口报错（限流、宕机）时不换：那是「备用线路」，和「卡住了换个更强的模型」不是一回事，以后单独做。
- 先出计划：通过输入框的 `/计划` 启用（默认关，每个任务各自记住，首页的状态带到新任务），用可移除的「计划」标签显示，不再常驻工具栏按钮。启用时由规划模型（没选就用编码模型）出一份计划，不改代码。
  - 作为一轮记进会话（`TurnKind = 'plan'`，`_diffra/session/plan`），和深度扫描一样：进度实时显示、能停止、存进历史，没有「重新生成」。
  - 只读：读文件、列文件、搜索、大纲，最后调一次「提交计划」（对需求的理解、分步骤要做什么和改哪些文件、风险和要用户确认的问题）。最多 30 步，最后一步或上下文快满时要求直接交计划。这个只读循环和深度扫描共用（`packages/core/src/session/read-only.ts`）。
  - 系统提示词用编码的那份（带着项目规则和编码规范），后面接一段规划模式的说明；规划模型看得到之前的对话，接着已有任务出计划不会脱节。规划模型的窗口比当前对话小时可能放不下，这时调用会失败并提示。
  - 规划过程不进编码模型的对话。计划卡片里的文字可以直接改，点「按计划执行」把这一轮的需求和改过的计划作为新的一轮发给编码模型；不满意就接着输入意见，开关开着会重新出计划。
  - 用量记成新角色「规划」（planner）。
- 不做（以后再说）：接口报错时自动换模型。计划逐步打勾跟踪、多个计划方案对比 v2 做了，见下一节。

## 计划逐步打勾和多候选方案（v2 · M2）

- 计划逐步打勾：计划卡片上点「按计划执行」或「从第 N 步开始执行」时，界面把计划里编号的步骤（`PlanSteps` 的 `splitPlan`，最多 20 步）连同出计划那一轮的 id 放进提问的 `_meta.diffra.fromPlan`。core 在这一轮开头先把这些步骤列成步骤清单（都还没开始），发给模型的提问后面接一段「照这几步、这个顺序用 update_plan 打勾」（存下来的提问还是原话）；这一轮记下 `fromPlan`（出计划那一轮的 id，可选字段，旧版读到会丢掉）。
  - 计划卡片找 `fromPlan` 指向它的最后一轮，按那一轮的步骤卡片给每一步换成状态图标（做完打勾、进行中转圈、没开始空圈），上面一行「正在按计划执行 / 按计划执行过：做完 N / M 步」；有了进度就不再给手动勾选框。步骤按文字对，对不上按位置对。这一轮正常结束时进行中的那一步算做完（沿用第 466 步）。
  - 不靠模型：模型不调 update_plan 时卡片上只是都没打勾，不会自己猜。
- 多候选方案：计划卡片上「生成候选方案…」，弹框里选 2 或 3 个、改每个的名字和思路（默认「按计划直接实现」「尽量少的改动」「先保证可读性和可测试」），每个候选在项目的一份独立副本里按自己的思路做，项目本身不动；做完比较，选一个应用回项目。
  - 为什么用 git worktree：每个候选要能完整地改、跑检查，又不能互相影响、不能动用户的工作区。`git worktree add --detach`（不建分支），放在应用数据目录的 `worktrees/<会话>-<轮次>/<a|b|c>`，不往项目里写。起点是 HEAD 加上工作区里还没提交的改动（`git diff --binary HEAD` 打上去）和没跟踪的新文件（复制，超过 5000 个就不做），和用户眼前的项目一样；起点和终点都按 git 树算（`git add -A` + `write-tree`），比较、应用都用树，不提交。只能在 git 仓库里用，仓库还没有提交时说明原因。
  - 依赖目录（三层以内的 `node_modules`、`.venv`、`venv`）不复制：用目录联接（Windows）或符号链接链到项目里的那一份，候选里设成禁写，不算候选的改动。删 worktree 前先断开这些链接，断不开就不删（递归删除可能顺着链接删掉项目里真正的依赖），单测专门覆盖。
  - 每个候选是一个只跑这一轮的会话（`session/candidates.ts`）：和主会话同样的模型、规则包、插件、系统提示词和权限模式，自己的检查点（放在 worktree 旁边），不带浏览器、设计、MCP、记忆。几个候选并行跑，过程挂在各自的「候选方案 X」卡片下面（和子智能体同一种卡片，组织图写「同时生成 N 个候选方案」）；要确认的事排队，一个一个问。各自过完成门禁，结论记在候选上（检查通过 / 没配检查 / 检查没通过）。
  - 「候选方案」卡片（标题和 `_meta.diffra.candidates`，结构见 `CandidateRunView`）：每个候选的思路、它最后说的话、改了几个文件和增删行数；「看改动」就地展开 diff，「并排比较」左右各选一个候选看 diff（窄的时候上下排），「应用这个」，「全部放弃」。
  - 应用：记成一轮 `apply`，开头打检查点（能撤销）；先 `git apply --check` 检查项目在生成之后有没有又改过同一处，合不上就什么都不改、在卡片上列出冲突的文件，候选留着；合得上就 `git apply --binary` 合回项目，每个改了的文本文件出一张改动卡片，告诉模型文件变了，任务状态记「还没在项目里跑检查」。应用、放弃之后这组候选的 worktree 全部清掉（`git worktree remove` + `prune`），卡片的更新补在生成它的那一轮里（界面按卡片 id 找到那一轮）。
  - 清理：生成到一半停止、全部失败、应用、放弃、删除任务时都清掉；应用退出时还在生成的，下次打开任务时清掉并记成停止；等着选的留着，重开应用后照样能比较、应用。
  - 记录：会话记录多一个可选的 `candidateRuns`（每组候选的仓库、起点、各 worktree 的位置和状态），旧记录没有；生成那一轮的 `kind` 是 `plan`、应用那一轮是 `apply`，没加新的轮次种类：旧版 Diffra 认不出新种类会把整条记录当成损坏。旧版读到新记录会丢掉 `candidateRuns`，卡片按普通工具卡显示文字，没清掉的 worktree 留在数据目录里。
  - 外接智能体的任务没有这个按钮（候选要用 Diffra 自己的智能体）。
- 不做 / 已知限制：候选的数量上限 3；不让模型自己想几种思路（多一次模型调用，弹框里用户改得更准）；很大的仓库建 worktree 要检出整个仓库，会慢；子模块不处理；候选之间不能互相参考；比较只看 diff，不跑候选的程序。
- 验证：core `test/worktrees.test.ts`（6 个：不是 git 仓库、没提交、起点带未提交和未跟踪的文件、二进制合回、冲突时不改文件、依赖目录只断开链接、目录已经没了也能清理、子目录）、`test/candidates.test.ts`（6 个：并行生成两个候选并应用、冲突后放弃、生成中途停止、不是 git 仓库、删除任务时清掉、上次没跑完的打开时清掉）、`test/sessions.test.ts` 的按计划执行；e2e `candidates.spec.ts`：计划卡片跟着打勾；从计划生成两个候选、看改动、并排比较、应用一个、worktree 清掉、撤销应用。

## 斜杠命令、目标模式和 Skill（第 17 步）

- 输入框里输入「/」打开菜单：在开头或空白后面输入「/」才弹出，后面接着输入就按名字、说明和英文关键词过滤，没有匹配时不显示。
  - ↑↓ 选择，Enter 或 Tab 确认，Esc 关掉（输入的「/」留着）。选中后去掉输入的「/xxx」。
  - 命令组：目标、计划，任务页另有 compact（手动压缩上下文，见「长任务」一节）和「深度扫描 · 本任务改动 / 整个项目」。compact 运行中不列出；深度扫描在设置里打开才有，运行中不列出，选了和任务监控里的按钮一样先弹确认。
  - Skill 组：项目和用户目录里的 Skill，标出来源。菜单每次打开都重新读一遍，改了 Skill 文件不用重启。
- 选中的目标和 Skill 显示成输入框上方的标签，点 × 或光标在最前面时按退格去掉；发出去后清空，每条消息各选各的。提问气泡上方留着这一轮的标签，重新打开任务也在。
- 「计划」就是启用计划模式并显示计划标签。计划和目标二选一：选了目标移除计划标签，启用计划去掉目标标签。
- 目标模式：这一轮的提问前面加一段目标模式说明，模型每轮做完调 finish，用 `goal_met` 说明目标达成没有（普通任务忽略这个字段）。
  - 每轮都要过完成检查。没达成就提示「目标模式第 N 轮」和上一轮还剩什么，接着做下一轮；只回了文字没调 finish 时拉回来，和改了文件不调 finish 共用拉回的次数上限。
  - 达成提示「目标已完成（用了 N 轮）」；到了轮数上限还没达成，提示没完成和最后一轮的总结。
  - 轮数上限在「设置 → 任务执行」：3 / 5 / 10 / 20 轮，默认 5（旧设置文件没有这项时用默认值）。每轮各有一份步数上限，卡死检测和兜底照常起作用。
  - 作为一轮记进会话（`TurnKind = 'goal'`），能重新生成，重新生成时带着原来的 Skill。
- Skill：一个文件夹放一个 `SKILL.md`，开头 frontmatter 写 `name` 和 `description`（没写 name 用文件夹名），正文是给模型的说明，可以引用同目录的其他文件。
  - 读取顺序：项目 `.diffra/skills`、用户 `~/.diffra/skills`，兼容 `~/.claude/skills`、`~/.codex/skills`，最后是随 Diffra 带的内置 Skill。同名的只认排在前面的，所以用户自己装了同名的就用用户的。最多读 300 个，单个 `SKILL.md` 超过 200KB 跳过。
  - 内置 Skill 放在 `packages/core/skills/`，出处和许可见同目录的 `NOTICE.md`。打包时作为 extraResources 放到 `resources/skills`（模型要按路径读，得是真实文件），主进程通过 `DIFFRA_SKILLS_DIR` 告诉 core；直接跑 core 时就用包里的目录。
  - 模型自己选：系统提示词里列出已装 Skill 的索引（名称、截到 150 字的描述、`SKILL.md` 的绝对路径），任务对得上时模型用 read_file 读全文。
    - 索引合计最多 2000 字，按项目、用户、插件、内置、Claude Code、Codex 的顺序放，放不下的只写条数，提示用户可以从斜杠菜单选。
    - 索引在任务打开时生成，之后装的 Skill 要新建或重新打开任务才进索引（系统提示词不变才能用上提示词缓存）。
  - 也可以手动选：选了的 Skill 正文连同所在目录放在这一轮提问前面（存下来的提问还是原话）；找不到选中的 Skill 时这一轮不开始，直接报错，不悄悄少了说明。
  - Skill 目录对模型只读：读文件、列文件、搜索、大纲可以用绝对路径访问这些目录，改文件和命令仍然只限项目里。
  - 出计划也能带 Skill；深度扫描不带。
- 不做（以后再说）：Skill 里的脚本自动执行、在设置里管理和编辑 Skill。

## MCP（第 18 步）

- 用 MCP 官方 SDK（`@modelcontextprotocol/sdk`，core 的依赖，打包时随 core.js 一起打进去）。支持本地命令（stdio）和远程 HTTP（Streamable HTTP），不支持旧的 SSE 方式。
- 配置在侧栏「扩展 → 已安装」（第 601 步从「设置 → MCP 服务器」搬过来），所有项目共用：名称（只用字母、数字、- 和 _）、启动命令和参数或地址、环境变量或请求头、开关。扩展目录里的服务一键装，见「扩展页」一节。
  - 环境变量和请求头的值可能是密钥，和 API Key 一样用系统加密存在 `secrets.json`（键是 `mcp:服务器 id:env|header:名字`），设置文件里只记名字；编辑时不回显，留空表示不改。
  - 新建或重新打开任务时，桌面端把开着的服务器连同解密后的值放进 ACP 的 `mcpServers` 交给 core（core 声明 `mcpCapabilities.http`）。改了配置，已经打开的任务不变。
- 连接（`packages/core/src/mcp.ts`）：同一个项目、同样配置的服务器在各个任务间共用一个连接；stdio 服务器在项目目录里启动，只继承 SDK 默认的安全环境变量加上配置的变量。
  - 任务打开时在后台先连；每轮开始时取一次工具，这一轮里不变。连不上的服务器在这一轮开头提示原因（本地命令带上 stderr 末尾；远程服务器带上 HTTP 状态码，401/403 提示检查请求头里的密钥），照常开始；30 秒后的下一轮再试，设置页和任务监控可以马上重连。
  - 等待上限：连接 60 秒（首次用 npx 可能要下载），列工具和 prompt 30 秒，调工具没有进度时 5 分钟、总共 30 分钟，用户点停止时取消。
  - 只留还开着的任务用到的连接，配置改了以后旧的在新建、打开、删除任务时关掉。core 退出时 stdio 服务器读到输入结束自行退出。
- 工具：名字是 `mcp__服务器__工具`，只留模型接口允许的字符，超过 64 个字符截断加哈希；描述前面标上服务器名。最多给模型 100 个 MCP 工具（OpenAI 一次最多 128 个），多出来的提示。
  - 权限：完全放行模式、服务器声明只读（`readOnlyHint`）的工具、本会话里选过「始终允许」的直接调，其余每次先问。只读声明由服务器作者给出，服务器本来就是用户自己装、在本机运行的程序，所以照它的说法放行。
  - 结果转成文字给模型：图片、音频、二进制资源只留一句说明；工具报错（`isError`）原样告诉模型。不算编辑：不重置卡死检测。
  - 工具定义计入上下文估算和「工具定义」分项；上下文压缩写摘要时带同样的工具，能用上提示词缓存。规划和深度扫描不给 MCP 工具（可能有副作用）。
- Prompt：斜杠菜单里列出各服务器的 prompt（「服务器:prompt」）。有参数的先弹框填参数，然后展开成文字放进输入框，看过、改过再发送。
- 状态：「扩展 → 已安装」里每个服务器显示连上没有、几个工具和 prompt、失败原因；任务监控里显示这个任务用到的服务器。
- OAuth 登录的远程服务器（扩展目录里的 Vercel 和 Railway 远程版靠它）v2 已做，见「扩展的 v2 部分（v2 · M4）」。
- 不做（以后再说）：MCP 的资源（resources）和采样（sampling）、从 JSON 配置粘贴导入、按项目单独开关服务器、项目目录里的 MCP 配置文件、规划时用只读的 MCP 工具。

## 外接智能体（v2 · M1）

- 做什么：让 Claude Code、Codex、Gemini CLI、Copilot CLI 跑 Diffra 的任务。它们用自己的模型和账号，登录在终端里由各 CLI 自己完成，Diffra 不实现订阅 OAuth、不保存它们的账号密码（和 v1「不做订阅登录」不冲突：消耗订阅额度的是它们自己的客户端）。
- 结构：core 当外部 CLI 的 ACP 客户端，桌面端照旧只和 core 说 ACP（`packages/core/src/external/`）。不在主进程里直接连外部 CLI，因为放在 core 里能复用会话记录（侧栏、搜索、重开）、检查点（看改动、撤销改动）和同一套会话更新；界面不用另做一套。
  - `spawn.ts`：按 PATH 和常见安装位置找命令（npm 全局目录、`~/.local/bin`、Homebrew、pnpm、bun、volta 等），Windows 上只认 PATHEXT 里的扩展名（npm 目录里同名的无扩展名文件是给 sh 用的）；`.cmd`、`.bat` 经 `cmd.exe /d /s /c` 起，参数按 cross-spawn 的规则转义（单测覆盖空格、`&|`、`%PATH%`、引号、`^`）；结束时 Windows 用 `taskkill /T`，其他系统结束整个进程组。
  - `connection.ts`：一个进程一条 ACP 连接。不声明文件和终端能力：它用自己的工具读写文件、跑命令，要确认的事经 `session/request_permission` 问过来。握手失败分成没装（找不到命令）、版本不对（不按 ACP 应答、报不认识参数、协议版本对不上）、启动失败（带退出码和它最后 4000 字输出）、超时（握手 2 分钟，第一次用 npx 要下载）、还没登录（ACP 的 -32000 或报错里像「要登录」）。
  - `session.ts`：外接智能体的任务（`ExternalSession`）。每个任务一个进程，第一条消息时才起；一轮结束后空闲 15 分钟结束，下次发消息重新起，智能体支持 `session/load` 时接上原来的会话（重放的历史不转发），不支持时提示「开了新对话，之前的上下文它看不到」。设置里改了命令、参数、环境变量，下一轮换成新进程。
- 预设（`packages/desktop/src/shared/external-agents.ts`，2026-11-15 按官方文档核对）：Claude Code 和 Codex 用 agentclientprotocol 组织维护的适配器，本机装了 `claude-agent-acp` / `codex-acp` 就用它，否则 `npx -y @agentclientprotocol/claude-agent-acp`、`npx -y @agentclientprotocol/codex-acp`（`@zed-industries/codex-acp` 已标废弃）；Gemini CLI 是 `gemini --acp`（旧版只认 `--experimental-acp`）；Copilot CLI 是 `copilot --acp`。每个预设写了安装命令、怎么登录和说明链接。也可以自定义任何支持 ACP 的命令。
- 设置（「设置 → 智能体 → 外接智能体」）：已添加的列表（检测、编辑、删除）；四个预设和「自定义」，打开页面时在本机找各自的命令，找到标「已装」和路径，没找到给安装命令；添加、编辑在原地展开表单（名称、启动命令、参数一行一个、环境变量），表单里能先检测再保存。检测结果按类型给下一步（去装、升级、在终端登录、检查网络）。
  - 存法：`settings.json` 的 `externalAgents`（id、预设、名称、命令、参数、环境变量名）；环境变量的值和 MCP 一样加密进 `secrets.json`（`external:<id>:env:<名字>`），编辑时不回显，留空沿用。启动时和改了之后整份交给 core（`_diffra/external/agents`），值只在内存里。
- 任务：首页模型菜单里多一组「外接智能体」，选了就用它建任务（不需要配 Diffra 的模型）；设计首页不给（设计工具只有 Diffra 自己的智能体能用）。任务里输入框的模型菜单显示它的名字、锁住不能换。对话、工具调用卡片、改动卡片、确认卡、停止按钮、出错提示都是原来那套：它发来的标准 ACP 更新原样转给界面，它的步骤清单（ACP 的 `plan`）画成和 Diffra 一样的「步骤」卡片；它发来的 `_meta.diffra` 一律去掉，免得冒充 Diffra 的结论和任务状态。
  - 权限：每次询问、自动审批都把它的确认请求原样转给用户（Diffra 看不懂它的工具，不替它分风险）；完全放行时替用户选它给的「允许」（优先只允许这一次）。
  - 停止：先发 `session/cancel` 等它回 cancelled，10 秒还不回就结束进程；等确认时停止，确认作废。
  - 崩溃、超时：进程中途退出、握手超时、没登录、智能体从设置里删了，这一轮都停下：结论「出错」，提示卡片写原因和它最后的输出，停下说明给「继续」（没装、版本不对时还有「打开外接智能体设置」）；任务不会卡在运行中。3 分钟没有输出时和 Diffra 自己的模型一样提示可能卡住了，但没有「重试这一步」（请求在它那边，重发不了）。
  - 结论：Diffra 不管它怎么收尾，这一轮改了文件（按检查点算）就是「已完成」（`finish: unverified`），没改是「没有改动」；不过 Diffra 的完成门禁（检查命令、安全检查、规范审查、架构检查）。撤销改动照常；撤销后的下一条消息前面告诉它文件变了。
  - 选了的 Skill 照样放在提问前面发给它；没有目标模式、出计划、压缩、深度扫描、重新生成、定位问题、换模型（输入框和停下说明里都不出这些按钮，core 收到也会说不支持）。
- 兼容：会话记录、索引新加的 `agent`（id 和建任务时的名字）、`externalSessionId` 都是可选的；轮次的 `kind` 还是 `prompt`，旧版能读。旧版读到这种任务会当成没有对话历史的普通任务打开（它不认识 `agent`），不报错、不删记录。旧版 Diffra 读设置会丢掉 `externalAgents`，下次保存时就没了，任务记录不受影响。新加的结论 `agent-error` 旧版界面不认，当没有结论显示。
- 没做 / 已知限制：
  - 真的 CLI（2026-11-15，经用户同意用 npx 下载官方适配器、用掉一点订阅额度；e2e `external-real.spec.ts`，`DIFFRA_E2E_REAL_AGENTS=1` 才跑）：
    - Claude Code 2.1.283 + `@agentclientprotocol/claude-agent-acp` 0.107.0：检测连上、能接着原来的对话；第一次跑时它的登录过期了，任务停在「Claude Code 还没登录」的提示卡，用户在任务的终端里 `/login` 后点「继续」，回了「好的」、结论「没有改动」、项目里没多文件。
    - Codex 0.143.0 + `@agentclientprotocol/codex-acp` 2.6.0：检测连上；任务发出去后一直在跑——用户的 Codex 配的是自定义的模型网关，连不上（`codex exec` 直接跑也一样一直「Reconnecting... waiting for network」），不是 Diffra 的问题，网关通了再试。
    - 顺着这个修了：智能体在 `session_info_update` 的 `_meta.<它自己的键>.error` 里报的错（Codex 就是这样报断网重连的），以前 Diffra 不显示，而且这些状态被当成「有输出」，「可能卡住了」的提示一直出不来，用户只看到「运行中」。现在这类报错按原文提醒一次（「Codex 报错：Reconnecting... waiting for network」），状态不算输出，3 分钟照常提示可能卡住了。core `external.test.ts` 用假智能体的「断网」模式测，也接真的 codex-acp 看到了这条提醒。
    - Copilot：本机的 `copilot` 只是 VS Code 带的占位程序（运行时说没装 Copilot CLI），用户说不试；Gemini CLI 没装。
  - Diffra 配置的 MCP 服务器不传给外接智能体（会把解密后的密钥交给第三方进程），它用自己配置的 MCP。
  - 它的 token 用量不进用量统计（ACP 没有标准的用量数字）；任务互通（`task_create`）建的仍是 Diffra 自己的任务；远程设备连接的远程任务页不区分外接智能体。
- 验证：core `test/external.test.ts` 20 个用例（假 ACP 服务端 `test/fixtures/fake-acp-agent.mjs`，不依赖 SDK）：检测的五种结果、`.cmd` 启动和参数转义、常见安装位置、一问一答、改文件和撤销、确认（含完全放行）、停止（含不理停止的）、等确认时停止、很久没输出、中途崩溃后重起并接上会话、重启 core 后打开旧任务、不支持接上时的提示、没登录、智能体被删、步骤卡片和去掉 `_meta.diffra`、不支持的操作。e2e `external-agents.spec.ts`：设置里检测出没装、版本不对、可用，添加（环境变量值不落明文）、编辑、删除；不配 Diffra 模型用它建任务，对话、确认、改文件、停止、很久没输出、崩溃、任务监控、重启应用后打开旧任务接上会话、智能体删了再发消息。手动确认：在登录过的机器上添加 Claude Code、Codex 预设，检测、跑一个改文件的任务、停止一次。

## Java 适配器（v2 · M3）

- 检查命令（`project/detect.ts` 的 `detectJava`，只读项目文件、不运行命令，和别的语言一样要用户在项目设置里确认）：
  - 有 `pom.xml` 按 Maven，否则有 `build.gradle(.kts)`、`settings.gradle(.kts)` 按 Gradle；两样都有时按 Maven 并说明。项目里有 `mvnw`、`gradlew` 就用（检查命令在 Git Bash 里跑，wrapper 是 sh 脚本，Windows 上也能跑），没有就用 `mvn`、`gradle`。
  - 快速检查是编译主代码和测试代码（`mvn -q -B -DskipTests test-compile`、`gradle -q testClasses`）；配了 checkstyle、PMD 插件的加上 `checkstyle:check`、`pmd:check`（Gradle 是 `checkstyleMain`、`pmdMain`）；有测试（`src/test` 或依赖里有 JUnit、TestNG）时完成检查加 `test`。
  - p3c-pmd（阿里巴巴 Java 开发手册的规则）是可选的：项目的 PMD 配置里用了它就跟着 `pmd:check` / `pmdMain` 跑，来源里写明；没配的不拿它当检查命令（没装就会一直失败），说明里写怎么在 Maven、Gradle 里加，不加也不影响编译和测试。不去找本机的 PMD 命令行：p3c 规则要它的 jar 在 PMD 的类路径上，命令行版拼不对就只会报错。
  - 本机没装 JDK（PATH 里没有 java，也没有 JAVA_HOME）、没装 mvn 又没有 mvnw 时在说明里写清楚，不报错；多模块写出模块名（Maven 的 `<modules>`、Gradle 的 `include`）。
- 规范审查：本来就按扩展名认出 `.java`、选内置的 Java 规则包（《Java 开发手册（黄山版）》改写），v2 补了测试确认。
- 静态检查（`security/rules.ts` 的 `JAVA_RULES`，ast-grep 的 Java 语法，`syntax.ts` 的 `languageOf` 认 `.java`）：SQL 拼接（Statement、JdbcTemplate、JPA 的 createQuery 这类，字符串相加或 `String.format`）、命令拼接（`Runtime.exec`、`ProcessBuilder("sh", "-c", …)`）、脚本引擎执行动态代码、`ObjectInputStream` / `XMLDecoder` 反序列化、SnakeYAML 的 `load`、XML 解析没关外部实体（同一个方法里没有 `setFeature` 这类）、关闭 TLS 校验（空的 `checkServerTrusted`、主机名校验总返回 true、`NoopHostnameVerifier`）、MD5/SHA-1 处理密码、`Random` / `Math.random` 生成令牌、把拼接的内容写进响应。规则号对应安全规则包，安全写法（预编译语句、参数数组、ProcessBuilder 逐个传参、字面量脚本、校验和用的 MD5、骰子用的 Random、关了外部实体的解析）单测确认不报，import 行不报，放行注释照样认。
- 架构分析：
  - 解析时记下 Java 顶层类型上的注解（`FileFacts.annotations`，可选字段）；缓存里以前的 Java 结果没有这一项，下次分析时重新解析一次。
  - 入口：除了 `public static void main`，标着 `@SpringBootApplication`、`@QuarkusMain`、`@MicronautApplication` 的类也算（启动类不一定自己写 main）。
  - 分层（`architecture/model.ts` 的 `javaLayout`，纯函数，界面和 core 共用）：Java 文件占解析过的代码一半以上才做。按 package 分包（`src/test` 下的单独算），去掉公共前缀；先按包名里的词判断层（controller/web/api → 接口层，service/application/biz → 业务层，repository/dao/mapper → 数据访问层，entity/model/dto/vo → 领域模型，config → 配置，util/common/exception → 通用），包名看不出来按类上的注解投票（`@RestController`、`@Service`、`@Repository`、`@Entity`、`@Configuration`…）。包之间的依赖按文件依赖汇总带次数；下层反过来依赖上层（数据访问层依赖业务层这类）列成问题，带最多 5 处文件和行。
  - 应用架构图：能分出层的包有两个以上时按层画（分不出层的在最上面，接口层、业务层、数据访问层、领域模型往下，配置、通用、测试放竖栏，层之间写引用了几处），包是方块、认领包自己的目录（不含子包），多模块时按模块分组；按功能分包、没有注解的项目退回原来按目录排的画法。
  - 概览页多一块「Java 分层」：各层有哪些包、每个包几个文件，下层反过来依赖上层的地方，点文件和行跳到依赖图。
- 没做 / 已知限制：Java 依赖的漏洞审计（OWASP dependency-check 要下载很大的漏洞库，SNYK 要账号）；Kotlin、Scala 的解析；按功能分包（`order/OrderController`）时每个功能里的分层只在包名带层名时认得出；Lombok、注解处理器生成的代码看不到。
- 验证：core `security.test.ts` 的 Java 静态检查（13 处该报的、9 种安全写法不报、只看新增行、放行注释）；`detect.test.ts` 的 Maven（wrapper、带 p3c 的 PMD、多模块）、没配 p3c 和没装工具时的说明、Gradle Kotlin DSL 和 Groovy 写法；`rules.test.ts` 的 Java 规范审查；`architecture-java.test.ts` 用 `test/fixtures/java-shop`（Spring 风格的 Maven 项目，repository 故意反过来依赖 service）测入口、注解、分层、包依赖、违规、分层的应用架构图、旧缓存重新解析、整个项目过静态检查不误报。e2e `architecture-languages.spec.ts` 加了 Java 项目：概览的分层和违规、应用架构图按层画、点违规跳到依赖图。没有用真的 JDK、Maven、PMD 跑过检查命令（测试不依赖本机环境）。

## 外观与模型配置界面

- 外观采用主题缩略图卡片、亮暗下拉框和紧凑设置行；保留现有四种配色，支持对话无衬线/衬线字体，终端保持等宽。旧配置没有 fontStyle 时按无衬线显示。
- 模型与角色页（第 579–588 步改版）：服务平时收成一行（图标、名称，灰字写协议、密钥尾号、模型数和被哪些角色使用，右边「编辑」），列表最后一行是「添加模型服务」；添加和编辑都在页面里原地展开一块面板，不再用弹窗。同一时间只展开一个面板（添加，或者编辑某个服务）；面板里改过东西还没保存时，切到别的面板或点「收起」先问「放弃没保存的改动？」；点「取消」、保存成功直接收起。页头不放添加按钮，没有服务时空状态里是主按钮。
  - 以前是两步向导弹窗（连接信息 → 模型能力，离顶部 10vh，加最小高度防跳动）和单独的「配置模型能力」弹窗，这些都作废：两步合成一张表单，能力在模型那一行上点开；表单在页面里，没有弹窗的跳动问题。
  - 添加面板：右上角分段切「预设服务 / 自定义 API」（替代原来供应商下拉里的「自定义」）。预设页是供应商（按量计费、编程套餐两组）、预设说明、API Key；名称、图标、API 类型和地址已经预填，收在「名称和地址」里，点开能改。自定义页是名称和图标、API 类型、API Key、地址。下面是模型：一个模型 ID 一行，右边写能力摘要（「128k · 视觉 · 思考」），点开就地显示能力（显示名称、上下文长度、最大输出、视觉和思考模式；勾了思考模式再勾支持的思考强度档位）。底部「取消」「校验并添加模型」。添加面板里不能拉取模型列表：拉取接口只认已经保存的服务，新建时要拉取得加新的 IPC，没做。
  - 编辑面板分两区。上半是连接信息，和添加面板同一个表单，能在预设和自定义之间换；「校验并保存」用新的连接把启用的模型都校验一遍，Key 留空沿用已加密的密钥。下半是模型，改动即时生效：启用开关、「…」里的配置能力（就地展开，「保存模型能力」，不重新校验）、测试连接、移除；「拉取模型列表」挑一个或「添加模型」都是就地展开一份添加表单，「校验并添加模型」通过才保存。最底下「删除服务」。模型改动不并进连接的保存，免得改个显示名也把所有模型重新调一遍。
  - 改版前从拉取列表里挑模型，打开的是「配置模型能力」并按已有模型处理，保存后模型并没有加进服务（第 581 步前在开发版复现过）；现在挑选后走添加流程，e2e 覆盖。
  - 最终保存前通过草稿校验接口真实检查连接及工具调用，校验失败不落盘，错误写在面板里，填过的内容（包括能力草稿）都在。
  - 能力用勾选框加一句说明，不用切换按钮：按钮关着时和普通按钮一样，看不出是开关，开着时还借了只做当前项的 soft。协议发不了思考强度参数时（现在只有 Gemini）思考模式禁用，说明换成不支持的提示。
  - 离开这一页也先问（第 589–593 步）：所有页面切换都经过 `state/actions.ts` 的 `navigate()`，模型与角色页打开时用 `setLeaveGuard` 挂一个离开前确认；面板里有没保存的改动时，点「返回」、换设置分区、顶栏后退、快捷键、菜单、搜索结果、通知都会先弹同一个「放弃没保存的改动？」，选「放弃」才照原来要去的地方走，离开设置页时重读设置也挪到确认之后。关窗口、退出应用、重新加载不拦：Electron 里用 beforeunload 拦关闭不会弹系统确认框，只会让窗口关不掉。从搜索点开任务时任务先在后台载入，选「继续编辑」就只是没打开它。
- 保留供应商与角色的数据结构，旧模型默认启用。停用模型从选择器移除并清空对应角色，服务端拒绝新任务使用停用模型；已经运行的任务不强行中断。显示名称只用于界面，请求继续使用原始 Model ID。
- 模型行通过省略号菜单配置能力、测试连接或移除，启用开关在展开服务后可见（第 579–588 步以前一直显示在服务卡片上）。能力表只列当前协议能实际发送的思考参数。
- 思考强度（第 636 步）：档位不分协议，都是 low、medium、high、xhigh、max，按用户要求统一；以前 OpenAI 系还有 none、minimal，没有 max。模型能力和输入框里档位直接显示这几个英文值（不勾时的档位显示 default），不译成中文。
  - Anthropic 系（官方和兼容）以前发不了思考强度，思考模式禁用，提示「此协议暂不支持」。其实 Claude 新模型（Sonnet 5.5、Opus 5.5 等）不带参数时照样思考，用服务端默认强度（Sonnet 5.5 是 high，Opus 5.5 是 medium），界面上没勾像是不思考。现在按 `output_config.effort` 发（AI SDK 的 `providerOptions.anthropic.effort`），不勾时什么都不发，说明里写明按服务商默认强度思考。
  - Anthropic 系不按型号猜档位，用户在模型能力里勾了才有；兼容服务（Kimi 等）不一定认这个参数，没勾就不发。也没有「恢复自动识别」。
  - OpenAI 已知型号自动识别的档位去掉关闭、最小（gpt-5 系、o 系是低中高，gpt-5.2、5.4 再加极高）。OpenAI 官方不认 max，勾了「最高」会被服务拒绝，和别的档位一样按「只勾服务商文档里列出的」处理。
  - `REASONING_EFFORTS` 还留着 none、minimal：旧设置文件里存过这两档，删了枚举设置就读不出来。读出来后不在列表里，记住的档位按「默认」。
  - 没做：Gemini 的思考参数；Sonnet 5.5 用 `between_tools` 关掉思考；`display: "summarized"` 让 Claude 的思考内容显示出来（现在默认 omitted，思考块是空的）。
- 角色分配在服务列表下面，下拉框和选项前有模型的品牌图标（和模型行同一套匹配），文字仍写「服务 / 模型」，同名模型靠服务名分清。

## 模型图标（第 130–137 步）

- 来源：`@lobehub/icons@6.15.0`（MIT，出处登记在 `packages/desktop/NOTICE.md`），锁定版本。主界面 CSP 是 `img-src 'self' data:`，图标只能打包进应用，不从 CDN 取。
- 只在构建期使用：放在 `devDependencies`，渲染进程构建时打进 `out/`，包本身不进 asar（打包只带 `out/**/*` 和生产依赖）。
- 只用它的品牌图标组件（Mono、Color 两个变体）、`toc`（图标清单）和 `features/modelConfig` 的模型匹配表；`ModelIcon`、`ProviderIcon`、`Avatar` 这些组件都不用。
  - `lib/lobe-icon-table.ts` 由 `scripts/gen-lobe-icons.ts` 生成：`toc` 里服务类、模型类的图标，加上模型匹配表用到的图标，共 230 个。升级包以后重跑。
- `@lobehub/ui` 用本地占位模块，不安装：
  - 包把它列为必需的 peer，但它是一整套 UI 库（emotion 等几十个依赖），和本项目的 shadcn + Tailwind 是两套体系。
  - 品牌入口会导入 Avatar 和 Combine，它们依赖 `@lobehub/ui` 的 `Flexbox`、`Center`、`useThemeMode`；模型匹配表又导入了全部品牌入口，所以绕不开这条导入链。
  - `pnpm-workspace.yaml` 用 `packageExtensions` 把它标成可选 peer；渲染进程构建用 alias 把 `@lobehub/ui` 指到 `lib/lobe-ui-shim.tsx`，只导出这条链上用到的名字（`Flexbox`、`Center`、`useThemeMode`），只为让构建能解析，Avatar、Combine 实际不会渲染。升级后构建报缺少导出，再按报错补。
  - 包里每个组件文件都带 `"use client"`，构建会逐个告警，渲染进程关掉了 `moduleLevelDirective` 检查。
- 服务图标的匹配顺序（`lib/model-icons.ts`）：
  1. 用户自选的；
  2. 预设对应的图标（服务类优先：百炼三个预设都是 Bailian，Kimi 两个预设是 Moonshot，智谱两个是 Zhipu）；
  3. 名称：先查中文和常见叫法的别名表（硅基流动、百炼、通义、智谱、月之暗面、火山、混元、文心、讯飞……，更具体的写在前面）；再和 `toc` 的 id、标题、全称做整词匹配，全称括号里的别名（如「SiliconCloud (SiliconFlow)」）排在后面，同等时服务类优先于模型类；
     - id 或标题本身是常用词的（Inference、Nova、Together、Spark、Yi 等，见 `COMMON_WORDS`）只在整个名称等于它时命中，作为名称里的一个词不算：「Local Inference」「Nova 网关」不会认成 Inference、Nova；
  4. 地址：主机名去掉 `api.`、`www.` 后各段都试，顺序是二级域名、往左逐段的子域名、最后整个注册域名（`api.siliconflow.cn` → siliconflow；x.ai、z.ai 这类二级域名只有一个字母的，靠注册域名认出）。别名表先在所有段里按表的顺序找（`dashscope.aliyuncs.com` 是百炼，不是阿里云），再逐段按清单匹配；子域名是常用词的跳过，IP 和 localhost 不参与；
  5. 都不中，显示通用回退：32px 的卡片头像是首字母方块，20px 及以下（模型行、菜单、选择器）写不下字，换成 lucide 的 `Box` 图标。
- 模型图标：按模型 ID 用 Lobe 的模型匹配表，按表的顺序取第一条命中（`qwen3-coder` → Qwen）；不中就用所属服务的图标。这样聚合服务下面的模型也能分清。
- 自选与自动匹配：服务配置多一个 `icon` 字段，存 Lobe 的图标 id，null 表示自动匹配；旧设置文件没有这个字段，按 null 读。
  - 添加和编辑服务弹窗里，「名称」左边是图标按钮，显示当前图标；点开是选择器：搜索框、「自动匹配」一项、服务类和模型类图标的网格。预设服务也能改。
  - 选择器的显示名称去重：标题重名的（Azure 和 Microsoft 都叫 Azure，Grok 和 xAI 都叫 Grok）换成完整标题，还重名就用 id。
  - 搜索查 id、标题、完整标题和别名表里的叫法，搜「深度求索」能搜到 DeepSeek；在搜索框按 Enter 选中第一条（输入法组字时的 Enter 不算）。
  - 键盘和读屏：「自动匹配」和网格是同一个 `radiogroup`，每项是 `radio`，`aria-checked` 标当前自选，可访问名称是「选择图标：名字」；只有一项在 Tab 序列里，方向键在网格里按行列移动焦点、不选中，Home、End 到首尾，Enter、空格选中。
  - 名称不为空又认不出来时，标签旁显示「没认出来，点这里选」，点了直接打开选择器。
  - 切换预设会把自选清回自动匹配；选「自动匹配」保存后存回 null。
- 彩色和单色：有彩色版本的用彩色，没有的用单色（跟随 `currentColor`，深浅主题都看得清）。彩色版主体是近黑色的几个（`DARK_MONO`：AionLabs、CogVideo、CogView、LlmApi、Meshy、Targon、Unsloth）深色主题下改用单色。图标都是 `aria-hidden`，不改变按钮、菜单项的可访问名称。
- 品牌图标 SVG 自带的原色是第三方数据，列在「组件里不写 px 字号……和十六进制颜色」那条的例外里。
- 按需加载：图标组件、清单和匹配表放在 `lib/lobe-icons.tsx`，只通过 `useLobeIcons()` 动态导入；第一次用到时加载，加载完之前显示上面的通用回退。
- 体积（2026-11-08，渲染进程构建，和接入前对比；审查后的修复没有重新构建，下面的数字未重测）：
  - 启动时加载的部分多了约 12.5 kB（主入口 2,151.24 kB → 2,140.99 kB，另拆出静态加载的 `model-icons` 22.76 kB）。
  - 按需加载的 `lobe-icons` 1,857.74 kB（gzip 约 406 kB），外加 1.64 kB 的依赖小块。
- 范围：设置里的服务行和模型行、添加和编辑服务面板、角色分配下拉（第 584 步加上）、输入框的模型菜单（分组标题、模型行、触发按钮）。任务监控里的模型行、网站不在这次。

## 紧凑会话展示

- 改动和思考、工具调用一起收在过程组里（第 454 步，见「界面」的对话流），组的标题行写改了几个文件、净增删多少行；展开后每次编辑一行，完整 diff 再点开，逐次操作记录都在。每轮提供展开/收起代码详情，用户手动展开不会被流式更新自动收回。
- 文件累计统计以首次旧内容和最终新内容计算净差异，不把中间多次编辑的行数相加；失败编辑不计入交付统计。
- 长任务的记录体积和界面性能（第 314–316 步）。起因：一个 41 轮的任务记录涨到 43 MB，打开时报 `MessageTooLargeError`，运行时界面卡住几十秒。
  - 改动卡片不再带整份文件：oldText、newText 只是变化的那段（前后各留 3 行），`_meta.diffra.edit` 记起始行号、两段各几行；一轮里第一次改某个文件、或它在两次改动之间被别处改过时，才带一份整份的 `base`（core 的 `session/edit-diff.ts`，协议见 `EditDiffMeta`）。界面按顺序重放一轮的改动还原每次前后的全文（`edit-replay.ts`），净改动统计和以前一样；改动卡片的行号按起始行号换成文件里的行号。那个任务的轮次记录从 35 MB 降到 12 MB（剩下的主要是已截断的命令输出）。
  - 旧记录不改：载入时发给界面前按同样规则压缩，记录文件和 core 内存里的照旧。压缩后重放出的全文和原记录逐次核对过（666 次改动全一致）。
  - ACP 单条消息上限从 SDK 默认的 32 MiB 调到 256 MiB（两端都设，`ACP_MAX_MESSAGE_BYTES`），留足余量。
  - 界面：每一轮只拿它用到的任务字段（`TurnTask`），回调换成不变的包装，已经结束的轮次用 `memo` 跳过重画；改动卡片的增删行数按卡片内容缓存。原来每来一条流式更新就重画全部轮次、每张改动卡片重算 diff。同一个任务、同样的流式输出：一轮从 52.8 s 降到 17.9 s，界面被长任务占住的时间从 44 s 降到 0.1 s，界面响应从最多 25–30 s 降到 4 ms。
- 完成卡的标题按这张卡的 verification 出词，和顶栏用同一套词（见「本轮结论」）：「已完成 · 已验证」（success 勾）、「已完成 · 未经自动验证」（warning，提示条写明为什么没验证：没配检查命令，或者没有检查点、判断不了命令改没改文件）、「已完成 · 没有改动」、「还没完成」（打回，destructive）。没有 verification 的旧卡：打回的写「还没完成」，带 unverified 标记的写「已完成 · 未经自动验证」，其余写「已完成」，都不画绿色。原来统一写「本轮交付」，和顶栏的结论对不上，同一屏上会出现两种说法。
  - 标题行右侧是这张卡的改动计数（「N 个文件 +x −y」），下面列文件和「审阅改动」「撤销改动」两个按钮。「审阅改动」只在最后一轮最后一张通过、有改动的卡上用 primary，其余卡用 outline。
  - 任务监控开着并且有检查点时，文件列表收起，标题行的计数变成展开按钮（带 `aria-expanded`），收起的列表用 `hidden` 留在 DOM 里。监控里已经列了整个任务的改动，单轮任务时两份列表一模一样。没有检查点时监控不列文件，完成卡照常列出。代价是往上翻着看对话时开关监控，完成卡的高度会变。
  - 一轮里有几张完成卡时（目标模式、打回后再完成），每张只列上一张通过的卡之后的改动；打回的卡不切分范围，否则「打回 → 修 → 通过」时，通过的那张会漏掉打回前的改动。
  - 已验证时，过程中失败的命令不再放进 warning 提示条，改成一行 muted 说明「过程中有 N 条命令失败（最终检查已通过）」。
  - 之后撤销过的轮次（`restoredAt`）里，通过且不是「没有改动」的完成卡（不看有没有文件列表：只靠命令改的文件没有 diff，检查照样跑过）保留原来的词，但图标和标题去色（不用 success、warning、destructive），标题后加「· 之后撤销过改动」；不显示提示条、审阅和撤销按钮，文件行不可点，卡片带 `data-restored="true"`。同一轮的 verify_changes 行也不再提醒。
- 完成条件仅使用 core 执行证据，不从自然语言推断已推送或已发布。授权请求、失败检查及计划继续显式展示。

## 用户终端与模型共享

- 手动终端不是自动模型上下文。终端面板的「附加终端内容」优先取选中文本，否则最近 80 行，最多 16000 字符；可编辑预览、检查敏感信息后放入当前输入框，不自动发送。
- 桌面编码工具提供 terminal_list（元数据）和 terminal_read（只读，最多 200 行）。读取必须单次或会话内按终端 id 授权，即使完全访问模式也不跳过首次审批；无输入命令能力。
- 主进程仅在内存保留有上限的终端输出；窗口归属校验，输出按不可信数据处理并尽力脱敏常见凭据，不保证识别所有秘密。退出并关闭的终端不提供模型历史读取，用户仍可从 xterm 附加可见内容。

## 自定义命令和插件（第 19 步）

- 自定义命令：一个 markdown 文件，frontmatter 里写 `description`、`argument-hint`，正文是要发给模型的话。和 Claude Code 的 commands、Codex 的 prompts 格式一样。
  - 读取顺序：项目 `.diffra/commands`、用户 `~/.diffra/commands`、开着的插件的 `commands/`，兼容 `~/.claude/commands`、`~/.codex/prompts`。同名的只认排在前面的。子目录是命名空间（`git/sync.md` 叫 `git:sync`，最多两层），插件的命令前面加插件名（`kit:greet`）。最多 300 个，单个文件超过 100KB 跳过。
  - 在斜杠菜单的「自定义命令」组里，选了以后把正文放进输入框，看过、改过再发；正文里有 `$ARGUMENTS` 或 `$1`～`$9` 时先弹框填参数。
  - 不执行正文里的 `` !`命令` ``（Claude Code 会先跑这些命令把输出拼进去）：选命令不应该就在本机执行命令，模型需要时会自己调 run_command，照常过权限。
- 插件：一个文件夹，兼容 Claude Code 插件的一部分。清单是 `.diffra-plugin/plugin.json` 或 `.claude-plugin/plugin.json`（name、version、description，没有清单时用文件夹名），内容是 `commands/`、`skills/`、`agents/`、`hooks/hooks.json`、`.mcp.json`（子智能体和钩子是第 599–600 步加的，见「扩展页」一节）。
  - `.mcp.json` 认 `{ "mcpServers": {…} }` 和直接写服务器两种写法；`${CLAUDE_PLUGIN_ROOT}`、`${DIFFRA_PLUGIN_ROOT}` 换成插件目录，其他 `${名字}` 取环境变量（没有就是空）。服务器名前面加插件名，免得和用户自己配的重名。只认插件根目录的 `.mcp.json`，清单里另写的 `mcpServers` 路径不读。
  - output-styles、monitors、清单里另写的 hooks、不支持的钩子时机和类型，在「已安装」里列出「已忽略」。
- 安装和管理在侧栏「扩展」（第 601 步从「设置 → 插件」搬过来），插件列表存在设置文件里：
  - 从文件夹装：就地使用那个文件夹，不复制，改了插件文件下次读到的就是新的；删除插件只是不再使用，文件夹不动。
  - 从 Git 装：用本机的 git `clone --depth 1` 到数据目录的 `plugins/<id>`（地址只接受 https://、ssh://、git@、file://，等 2 分钟），克隆下来不是插件或重名时删掉克隆；删除插件时连克隆一起删（只删 `plugins/` 下面的目录）。可以填仓库里的子目录（第 598 步），这时先 `--filter=blob:none --sparse` 再稀疏检出那个目录，插件目录是克隆下的子目录。
  - 安装分两步（第 600 步）：先取回、读出内容（从 Git 来的先克隆到 `plugins/.staging/<id>`），带钩子的给用户看过命令、选了要不要允许再装，没有钩子的直接装；确认后挪到 `plugins/<id>`，取消时删掉暂存的克隆。
  - 安装时读清单拿名字，插件名不能重复。装好默认开着，可以单独关。
  - 插件里的 MCP 服务器和钩子会在本机运行命令，安装说明里提醒只装信任的来源。不做签名校验；目录是随版本带的内置目录，不从网上拉。
- 开着的插件由桌面端放进会话配置（`plugins: [{ name, dir, hooks? }]`，`hooks` 是允许时记下的钩子指纹）：core 据此读插件的 Skill（排在用户自己的 Skill 后面、兼容目录前面，也加进只读目录）、命令、子智能体、钩子和 MCP 服务器（和用户配置的服务器一起连）。首页、扩展页查 MCP 状态时也带上插件的服务器。新建或重新打开的任务生效。
  - 已打开的任务里，斜杠菜单的 Skill 和命令也按这个任务建立时开着的插件列（`_diffra/skills/list`、`_diffra/commands/list` 只传 `sessionId`，core 取会话配置里的 `plugins`），和 core 选 Skill、连 MCP 用同一份；首页还没有任务，仍按设置里开着的插件列。以前菜单按设置里当前开着的插件列，任务里新开的插件能列出、选了却报「找不到 Skill」，停用的插件菜单里没了、core 照样能用。
- 插件更新、LSP 插件 v2 已做，见「扩展的 v2 部分（v2 · M4）」。
- 不做（以后再说）：从 Claude Code 已装的插件导入、命令里的 `!` 命令执行、按项目开关插件。

## 扩展页：内置目录、插件的子智能体和钩子（第 594–604 步）

- 侧栏「待办」下面加「扩展」，页面分「推荐 / MCP / 插件 / 已安装」，带搜索（按名称、说明、来源）。换分栏不新增后退记录。设置里的「MCP 服务器」「插件」两页删掉，管理都在「已安装」。不叫「插件」：MCP 连接和插件都在里面，插件只是其中一类。
- 目录（`shared/extensions.ts`）随版本更新，离线也能用、装的都是审过的；v2 起还会联网取官网上更新的目录（见「扩展的 v2 部分」）。每项写清连接方式（远程地址、本地命令和要先装的命令，或只支持浏览器登录）、要填什么 Key、拼成什么请求头、去哪拿、要注意什么。地址和请求头写法按各家官方文档核对过（2026-11-13）。
  - MCP：GitHub、Linear、Supabase、Neon、Railway、Sentry、Vercel、Context7、Tavily、Exa、Firecrawl、Chrome DevTools、Playwright。Sentry 的请求头是 `Sentry-Bearer`（`Bearer` 留给 OAuth）；Railway 是本机的 `railway mcp`，用 CLI 的登录状态；Context7、Exa、Firecrawl 不填 Key 也能用；Vercel 只支持浏览器登录，v1 标「下一版支持」不能装，v2 起用浏览器登录装（见「扩展的 v2 部分」），还加了 Railway 的远程版。
  - 插件：Superpowers、Anthropic 官方市场的 Feature Dev、PR Review Toolkit、Frontend Design、Commit Commands、Skill Creator（仓库子目录），Supabase、Tavily 的官方 Skill 插件。Railway、Vercel 的官方插件带着只支持浏览器登录的 MCP 服务器，装上每轮都会提示连不上，标「下一版支持」。
  - 装没装：MCP 按目录给的服务器名、同样的地址或同样的命令认（自己手动加的也算），插件按清单里的名字认。没改 `McpServerConfig` 的结构，所以不记「从目录装的」这件事。
- MCP 一键装（第 596 步）：点「安装」在原地展开，只填一个 Key（有的可选），「安装并测试」。主进程只收目录 id 和 Key，地址、命令按目录来，界面不能借这个口子塞任意命令；先用 core 连一次，连上了才走和手动添加同一个保存（Key 加密进 `secrets.json`），连不上不保存，401/403 说成 Key 不对或权限不够。服务器名用目录 id，被手动加的占了就加数字。
- 前置命令（第 597 步）：只在 PATH 里找 npx、uvx、docker、railway（Windows 按 PATHEXT），不运行、不替用户装。缺了在目录里和「已安装」里说缺什么、给安装说明链接，有「重新检测」；目录里缺命令的项不能装。
- 插件的子智能体（第 599 步，`subagents.ts`）：开着的插件的 `agents/*.md` 也是工人类型，名字是「插件名:类型名」。frontmatter 的 `tools` 写了、又没有 Bash、Write、Edit、MultiEdit、NotebookEdit 的是只读工人；没写 `tools` 的什么都能用；`model` 不管，用任务的模型。正文前面加一句「这是给 Claude Code 写的，提到的工具用你自己的」。和项目、用户的类型各自最多 20 个。
- 插件的钩子（第 600 步，`session/plugin-hooks.ts`）：兼容 Claude Code `hooks/hooks.json` 的五个时机，`type: command` 的钩子。
  - 怎么跑：和 Claude Code 一样用 bash -c（Windows 上是 Git Bash，没有 Git Bash 就不跑），环境变量 `CLAUDE_PLUGIN_ROOT`、`DIFFRA_PLUGIN_ROOT`（插件目录，/ 分隔）、`CLAUDE_PROJECT_DIR`，标准输入是一段 JSON（`session_id`、`cwd`、`hook_event_name` 和各时机的字段）。每个最多 60 秒（钩子自己写的 `timeout` 更短就按它的）。同一时机的钩子按顺序跑。
  - 结果：退出码 2 表示拦下，理由在标准错误；也认 JSON 输出（`decision: "block"` 和 `reason`，`hookSpecificOutput.additionalContext`，PreToolUse 的 `permissionDecision: "deny"`）。别的退出码、超时、没跑起来只记日志，不拦事情。
  - SessionStart：建会话（新建或重新打开任务）时跑，输出放进主智能体的系统提示词；系统提示词每次打开都重新拼，所以每次都按 `startup` 匹配。子智能体不带。
  - UserPromptSubmit：拦下就不发给模型，告诉用户理由，这一轮停下；标准输出接在这条消息后面给模型。
  - PreToolUse、PostToolUse：只对 Diffra 自己的工具。执行命令叫 `Bash`（`tool_input.command`），补丁按文件拆成 `Write`（新建）和 `Edit`（`tool_input.file_path` 是绝对路径），其他工具用自己的名字；`matcher` 是正则。PreToolUse 拦下就不执行，理由给模型；PostToolUse 只在工具跑完后跑，拦下的理由和 additionalContext 接在工具结果后面（和 Claude Code 一样，普通标准输出不给模型）。MCP 工具不触发。
  - Stop：智能体过了结束门禁要停下时跑，拦下就把理由交回去接着做，下次 `stop_hook_active` 是 true；一轮最多接着做 3 次，免得钩子写得不好停不下来。
  - 同意：装的时候列出每个钩子在什么时候跑什么命令，勾了「允许」才跑；不勾也能装。允许时记下钩子的指纹（hooks.json 里支持的那些钩子的哈希），core 建会话时再算一遍，对不上就不跑，「已安装」里显示「钩子变了」要重新允许。指纹只管 hooks.json 里的命令，不管命令调用的脚本内容。「已安装」里能随时撤销。
  - 项目钩子（第 447 步）不变，两套各跑各的。
- 验证（第 604 步）：core 单测覆盖插件子智能体和钩子的读取、指纹、五个时机；e2e `extensions.spec.ts` 用本机的假 MCP 服务、假的 railway 命令和本地 Git 仓库，走一键装（Key 不对不保存）、前置命令检测、子目录安装、钩子确认和取消、钩子在任务里运行和撤销、插件子智能体出现在 delegate 里；`mcp.spec.ts`、`plugins.spec.ts` 改成在扩展页操作。没有连真的服务、没有装真的插件：真的 Superpowers 钩子是 cmd/bash 双解释脚本，Git Bash 会把它交给 cmd.exe 去找 bash，没在真插件上跑过。
- v2 再做：MCP 的浏览器登录（OAuth，Vercel、Railway 远程版）、目录联网更新、插件更新、LSP。见下一节。
- 不做（以后再说）：钩子的 `prompt` 类型和其他时机（Notification、SubagentStop、PreCompact、SessionEnd）、PreToolUse 的 `allow` 跳过确认（Diffra 照常按权限模式问）。

## 扩展的 v2 部分（v2 · M4）

- MCP 的浏览器登录（OAuth 2.1 + PKCE，`core/src/mcp-oauth.ts` 的 `McpOAuth`，用 MCP SDK 的 `auth()`、`discoverOAuthServerInfo`、`refreshAuthorization`，不另加依赖）：
  - 发现：先按 RFC 9728 找受保护资源的元数据，再按 RFC 8414 / OIDC 找授权服务器；找不到授权服务器的元数据就说「找不到这个服务器的登录方式」，不去猜地址。客户端用动态注册（RFC 7591）拿 client_id，`token_endpoint_auth_method: none`（公开客户端），授权码换令牌必须带 PKCE（S256）。
  - 回调：每次登录在 `127.0.0.1` 上临时开一个随机端口，回调地址是 `http://127.0.0.1:<端口>/callback`（RFC 8252 的回环地址，注册时登记，所以每次登录都重新注册一次）；只认 state 对得上的那一次，浏览器里显示「登录完成，可以关掉这个页面回到 Diffra 了」。授权页用系统浏览器打开（`shell.openExternal`，只开 http(s)）。最多等 5 分钟，可以取消；超时、取消、授权服务器拒绝都说原因，回调端口关掉。每个请求 15 秒超时。
  - 存放：注册信息和令牌在密钥库里（PKCE 校验码只在这次登录的内存里）（`secrets.json`，safeStorage 加密），键是 `mcp-oauth:<服务器地址规范化后 sha256 的前 16 位>`，同一地址的几个服务器配置共用一份登录；不进设置文件、日志和会话。设置里的 MCP 服务器只多一个可选的 `auth: 'oauth'`，旧版读到会忽略这一项（当成没请求头的远程服务器，连不上而已，不会崩、不清数据）。
  - 用的时候：建会话、查连接状态时取访问令牌，离过期不到 1 分钟先用刷新令牌续（不打开浏览器）；续不了就标成「登录过期了」，这个服务器不带进任务（别的照常），扩展页提示重新登录。
  - 退出登录：授权服务器给了撤销地址（RFC 7009）就把刷新令牌和访问令牌都撤销（失败不挡退出），然后删掉本机的。删除服务器时，没有别的服务器用同一地址就顺带退出登录。
- 界面：
  - 目录里只支持浏览器登录的服务写「用浏览器登录」，展开后按钮是「在浏览器里登录并安装」，等待时是「等你在浏览器里登录…」和「取消登录」。登录后带着令牌连一次，连上才保存；连不上就退出登录、不保存，说明「登录了，但连不上」。
  - 「已安装」里这种服务器多一行登录状态：已登录（令牌几点到期、会自动续）、过期、没登录，按钮是登录 / 重新登录、退出登录。手动添加远程服务器时可以勾「用浏览器登录（OAuth）」，勾了不填请求头。
  - 目录：Vercel 能装了，新加 Railway 远程版（`https://mcp.railway.com`，Railway 标的是公开测试；本机 CLI 版的 Railway 照旧）。Railway、Vercel 的官方插件里带的 MCP 服务器要浏览器登录，插件里的 MCP 还不支持这条路，这两个插件仍标「下一版支持」。
- 验证：core `mcp-oauth.test.ts` 用 `test/fixtures/oauth-mcp-server.ts`（同一个端口上的假授权服务器加要令牌的 MCP 服务器，授权页直接跳回回调，校验 PKCE）测登录后能调工具、令牌快过期自动续、续不了标成过期、退出登录撤销、拒绝 / 超时 / 取消、没有元数据、地址规范化。e2e `mcp-oauth.spec.ts` 把目录里 Vercel 的地址换成假服务器、把系统浏览器换成直接请求授权页：取消登录不装，登录后装上并连上，设置文件里只有 `auth: oauth`、令牌明文不在设置和密钥文件里，退出登录后授权服务器收到撤销、状态变成没登录，重新登录又连上。没有连真的 Vercel、Railway（要真实账号）。
- 目录联网更新（`main/catalog.ts`，校验在 `main/catalog-schema.ts`）：
  - 官网多一个 `extensions/catalog.json`，是构建官网时从内置目录生成的（`{ version: 1, updatedAt, mcp, plugins }`，和内置目录同一个格式），构建时用应用的同一份校验检查一遍，有一项过不了就不让构建。这样新加的扩展不用等用户升级应用；不另起目录服务。
  - 扩展页打开时先显示缓存的（没有就是内置的），再联网查：一小时内查过不再查，页面底下有「检查更新」随时查。请求带上次的 ETag，没变是 304；15 秒超时，最大 2MB。取到的存到 `userData/extensions-catalog.json`（ETag、取到的时间、目录），写入先写临时文件再改名。
  - 逐项校验，一项不对只丢这一项、写日志，其余照用（以后的版本加了这一版认不出的连接方式也不会整份作废）；整份不是第 1 版或没日期就当没取到。联网的目录不能让人随便跑程序：地址、帮助链接、插件仓库都必须是 https，本地命令只能是目录认得的前置命令（npx、uvx、docker、railway）且和「要先装的命令」对得上，参数不能带换行，插件子目录不能有 `.`、`..`，id 只能小写字母数字和连字符。
  - 比内置目录新（日期不早于内置的）才用：装了新版本、官网还没更新时，不拿旧目录盖掉新的。内置目录的日期是 `CATALOG_UPDATED_AT`，改目录时一起改。
  - 取不到（断网、超时、格式不对）时用上次缓存的，页面底下说「没连上目录服务器（原因），用的是几点取到的目录」；没缓存或缓存坏了用内置的。目录只决定能装什么，已经装上的服务器和插件在设置里，目录怎么变都不动它们，页面上也写了。
  - 不走系统代理（主进程用 Node 的 fetch，和模型调用一样）。e2e 默认把目录地址指到本机不通的端口，不去请求真的官网。
- 验证（目录）：`scripts/catalog.test.ts`（`node --test`）测内置目录整份过校验、不安全或认不出的项丢掉（http 地址、任意命令、带换行的参数、以后的连接方式、`javascript:` 链接、大写 id、重复 id、ssh / file 仓库、往上跳的子目录）、整份格式不对报错。e2e `extensions-catalog.spec.ts` 用假的官网（带 ETag、能换内容、能断网）：官网比内置旧时用内置的；更新后新加的服务出现、混进来的任意命令被丢掉；装上新加的服务；再查带 ETag 得到 304；断网用缓存并说明，已装的照常连接；重启后离线用缓存；缓存坏了退回内置。
- 插件更新（`main/plugins-ipc.ts`，换目录在 `main/plugin-swap.ts`）：
  - 只管从 Git 装的插件（目录里的和手动填 Git 地址的）；本地文件夹的由用户自己改，Diffra 每次建会话都重新读。
  - 检查：「已安装」的插件区有「检查更新」（手动，不自动联网），对每个 Git 插件比本机克隆的提交（`rev-parse HEAD`）和远端默认分支的提交（`git ls-remote <地址> HEAD`），30 秒超时，不弹凭据输入（`GIT_TERMINAL_PROMPT=0`）。有新版本的插件名字旁边标「有新版本」，查不成的写原因。
  - 取回：和安装一样浅克隆（有子目录就只检出那个目录）到 `plugins/.staging`，读一遍清单；名字变了不算更新（要用就删掉再装），清单坏了直接报错，都不动装着的。给用户看版本和提交（`v1.0.0 → v1.1.0`、短提交号）、插件目录里新加 / 删掉 / 改了的文件（按内容哈希比，不看 `.git`，每类最多列 30 个）。钩子：新版本的钩子指纹和允许时一样就照旧允许；新加或变了的列出命令，勾了才允许，不勾也能更新、钩子不跑（和安装时同一个规矩）。取消就删掉暂存的克隆。
  - 换上：旧的克隆目录挪到 `plugins/.backup/<id>`，新的挪到原位置（插件路径不变，设置里只改钩子允许），再读一遍、写设置；任何一步失败都把旧的挪回来，说「更新失败，还是原来的版本：原因」。Windows 上插件文件被占用（比如任务里正跑着它的 MCP 服务器）挪不动时说清楚。换到一半应用崩了：下次启动时原位置没了就把备份挪回去，在就删掉备份。
  - 不做：自动定时检查、选分支或标签、版本回退到更早的提交。
- 验证（插件更新）：`scripts/plugin-swap.test.ts` 测换成功、验证失败和新目录挪不过去时旧的原样恢复（连 `.git`）、启动时恢复备份、比文件（加删改、不看 `.git`、截断）。e2e `plugin-update.spec.ts` 用本地 Git 仓库里的插件：没新版本时说都是最新的；有新版本时看改了哪些文件、取消不留暂存克隆、更新后版本和文件换了、钩子没变照旧允许、不留备份；钩子变了列出新命令、不勾就变成没允许；新版本清单坏了、改了名都不换，原来的照常；仓库没了说没查成。
- 插件的语言服务器（LSP，`core/src/lsp/`）：
  - 配置兼容 Claude Code：插件根目录的 `.lsp.json`（服务器名 → 配置），加上 `plugin.json` 的 `lspServers`（`./` 开头的文件路径、内联配置或数组，后写的同名覆盖）。字段严格：`command`、`extensionToLanguage` 必填，`args`、`transport`（都按 stdio 跑）、`env`、`initializationOptions`、`settings`、`workspaceFolder`、`startupTimeout`、`shutdownTimeout`、`requestTimeout`、`restartOnCrash`、`maxRestarts`、`diagnostics` 可选，有不认识的字段这个服务器就不用，原因列进插件的「不支持」。`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PROJECT_DIR}` 在 command、args、env、workspaceFolder 里展开，也放进进程的环境变量。服务器名是「插件名-服务器名」。只有 `.lsp.json` 的文件夹也算插件；插件内容里写「N 个语言服务器」，装的时候提示它们会在本机运行命令（和插件的 MCP 服务器一样，不另外确认）。
  - 进程（`lsp/pool.ts`）：同一项目、同样配置的服务器在各任务间共用一个进程。智能体改了它管的扩展名的文件才启动（Windows 上 .cmd 经 cmd.exe 起，和外接智能体同一套）；10 分钟没用就停掉，下次用到再起；删任务时只留还开着的任务所在项目的；core 和桌面端断开时全部停掉。停的时候先 `shutdown` / `exit`，`shutdownTimeout`（默认 3 秒）内不退就结束整个进程树。启动等 `initialize` 的回答最多 `startupTimeout`（默认 20 秒），找不到命令、一启动就退出、超时都停在「没在运行」，带上标准错误的最后几行。
  - 崩溃：`restartOnCrash`（默认开）时按 1、2、4 秒退避重启，最多 `maxRestarts`（默认 3）次，重启后把打开过的文件按原来的内容和版本重新交给它；次数用完停在「没在运行」，不再自动启动。用户在任务监控里重启时次数清零。
  - 诊断进任务：改完文件（`apply_patch` 的每个新建或修改的文件，项目 afterEdit 钩子跑完之后读现在的内容）交给管它的服务器（第一次 `didOpen`，之后整份 `didChange`，版本号往上数），等这个版本的 `publishDiagnostics` 最多 5 秒，收到后再等 150 毫秒合并后续的。错误和警告（最多 20 条，按严重程度和行号排）接在编辑结果后面给模型：`[Language server kit-go reports 1 error(s) and 0 warning(s) in src/a.go after this edit: …]`；没问题的不加。服务器配了 `diagnostics: false` 的不给模型。服务器起不来或崩了，在这个任务里提示用户一次（同样的不重复），不打扰模型。子智能体改的文件也一样；多候选方案在各自的 worktree 里跑，不带语言服务器。服务器反过来问的 `workspace/configuration` 按 section 从 `settings` 里取，注册能力、进度这类答空。
  - 界面：任务监控多一块「语言服务器」（这个任务用到的才显示）：每个服务器的状态（用到时启动、启动中、运行中、重启过几次、崩溃了重启中、没在运行、已停止）、错误和警告数、出问题的文件和第一条诊断，能停止、启动、重启（没在运行时）。任务开着时每 3 秒查一次。停止后改文件也不再自动启动，直到点启动。
  - 不做：跳转定义、查引用这类 LSP 查询工具（v3）；读文件时就打开文档（现在只在改后检查）；按文件保存（didSave）；socket 方式真的走 socket。
- 验证（LSP）：core `lsp.test.ts` 用 `test/fixtures/fake-lsp.mjs`（stdio 上的假语言服务器，按行报 ERROR / WARN，能崩一次、一直崩、不回 initialize、一启动就退出，记下收到的方法）测配置合并和严格字段、只有 `.lsp.json` 的插件、按扩展名启动、版本对应的诊断和状态计数、回答配置请求、崩溃后退避重启并重新打开文件、重启次数用完停在失败和手动重启清零、停止后不自动启动、闲置停止、只留开着的项目、dispose 结束进程、找不到命令 / 启动就退出 / 握手超时 / 不发诊断的时限、任务里改文件后诊断接在结果后面且崩溃只提示一次。e2e `lsp.spec.ts` 从文件夹装只带语言服务器的插件，脚本模型改文件：模型收到错误诊断，崩了提示并自动重启，任务监控显示运行中（重启过 1 次）、警告数和文件，停止和启动。
- 真的语言服务器（2026-11-15，core `real-tools.test.ts`，`DIFFRA_REAL_TOOLS=1` 才跑）：gopls v0.24.0、TypeScript 7.0.2 自带的 `tsc --lsp --stdio`、typescript-language-server 6.1.0 配 TypeScript 5.9 的 tsserver（`DIFFRA_TSSERVER_PATH`），都是改出类型错误报诊断、改对后清空；typescript-language-server 在项目里没有 TypeScript 时起不来，原因原样给用户。跑的时候查出两个只在真服务器上才有的问题，修了：
  - Windows 上地址对不上：服务器发回来的诊断地址和我们发的写法不一样（typescript-language-server 是 `file:///d%3A/...`，盘符小写、冒号转义；TypeScript 7 连整条路径都转成小写），以前按原样比，永远等不到诊断。现在先解码，Windows 盘符路径按小写比（`uriKey`）；状态里显示的路径用我们自己的地址，大小写不变。
  - 拉取式诊断（LSP 3.17 `textDocument/diagnostic`）：TypeScript 7 自带的语言服务器不推送打开的文件的诊断，要客户端去拉。initialize 时声明支持；服务器声明了 `diagnosticProvider` 就改完直接拉，「没变」沿用上次的。
  - 假语言服务器加了 `FAKE_LSP_URI=lower`、`FAKE_LSP_PULL=1` 两种模式，`lsp.test.ts` 各一个用例，以后不用真服务器也测得到。
  - TypeScript 7 没有 `tsserver.js` 了，typescript-language-server 只能配 TypeScript 6 及以前的；项目用 TypeScript 7 的，插件里写 `tsc --lsp --stdio`。

## 图片输入

- 输入框占位统一为「请输入指令」，工具栏移除图片图标。粘贴或拖入图片，一条消息最多 6 张。发出前在界面里缩小到长边 1600、转成 WebP（三家模型都收），模型那边长边超过这个也会缩小，大图只是白占上下文和会话记录。
- 文件/文件夹拖入时显示「松开以添加文件或文件夹」，最多 20 个路径引用；拖入不读取内容、不递归文件夹，主进程规范化路径和验证元数据，拒绝凭据文件。消息只包含带边界的 JSON 路径引用；项目外文件读取仍经原有权限卡片，不因拖入直接授权。附件可移除、去重，仅图片或仅路径也可发送，成功发送后清空，未发送成功保留。
- 模型能不能看图由用户在「设置 → 模型与角色」里，在每个模型的「配置能力」中打开「视觉」（默认关，浏览器截图也受它控制）：接口不会告诉我们，没打开的模型收到图片会直接报错。
  - 输入框发送前先查当前模型打开了没有，没打开就提示去哪里开，内容留着；core 也会拒绝（`supportsImages`），兜住设置过期的情况。core 的报错另外说明：设置里改过的，要新建任务或在输入框里重新选一次这个模型才生效。
  - 出计划暂时不带图片。
- 图片作为 ACP 提问里的 image 块交给 core，放进这一轮提问消息里；这一轮的记录（`StoredTurn.images`）也存一份给界面显示，提问气泡里能点开看大图。重新生成时带着原来的图片。
- 上下文估算：base64 按字数算会大上百倍，每张图按 6000 字（约一千多个 token）算。
- 渲染进程的内容安全策略加了 `img-src 'self' data:`，只放开本地的 data 图片，回复里的外部图片照样加载不了。

## 输入框草稿、@附件和用量界面

- 输入框草稿按「首页项目 / 设计首页项目 / 任务会话」分开存在渲染进程内存里，切到设置、首页或另一个任务再回来接着写；图片、文件引用、目标和 Skill 也一起保留，成功发出后清空，应用退出后不保留。草稿表不放进全局 store，按键时不会让整页重渲染。
- 输入框最高 10 行：内容少时保持原来的 2 行（首页 4 行），多了按滚动高度长高，超过 10 行在框内滚动；字体样式、字号和宽度的设置照旧生效。
  - 输入框里粘贴或拖入的图片、文件同时插入 `@图片N`、`@文件名` 提示词，提示词带强调色；文件重名时加 `(2)` 区分。着色画在 textarea 下面的文字层上，两层的内边距、字体和右侧滚动条宽度保持一致；输入法组字时先藏起着色层，用 textarea 自己的文字显示。
  - 点图片缩略图、文件标签或输入框里的 `@` 提示词都能打开预览：图片看大图，文件看完整路径和「只传路径引用、读取仍需授权」的说明。
- 输入框右下角的模型菜单改成接近 Codex 的卡片：上面按服务列出可用模型，显示上下文长度、视觉和原始 ID；下面是整块的思考强度，当前档位用大字显示、滑条调整，档位沿用模型能力里配置的范围。触发器同时显示模型名和当前档位。
- 任务页输入框下方在上下文百分比旁增加缓存命中率：最近一次模型调用的命中 token / 输入 token；供应商没返回时显示「—」。点上下文弹层还能看到命中、写入和说明，压缩后按压缩前的输入 token 计算，不会虚高。
- 「设置 → 用量」改成仪表板：
  - 6 个指标：总用量、输入、输出、缓存命中率、模型调用、活跃天数。
  - 每天的堆叠柱状图：缓存命中、新增输入、输出、推理，悬停看当天明细；统计范围选「今天」时不画柱子。
  - 用量构成环形图、缓存效率卡片（命中率、命中、写入）。
  - 最近 8 周每天的活动热力图，颜色深浅按当天 token。
  - 按模型、按项目、按任务三张表保留调用、输入、缓存命中、输出、合计，名称下加一条占比条；任务表仍可点进任务。
  - 表头和 JSON 里的 `UsageTotals` 多了 `cacheWrite`；旧记录没有时按 0 计。热力图单独查询最近 8 周，不随上面的统计范围变。

## 内置浏览器和开发服务器

- 任务页右侧的「浏览器」面板（和任务监控、审阅三选一；设计任务里还有设计面板，四选一）。每个任务一组标签页（主进程的 `WebContentsView`，当前那个叠在面板的位置上，最多 10 个），所有任务共用一个浏览器配置（`persist:diffra-browser`），和应用、和用户自己的浏览器分开，登录状态会保留。智能体也可以改用用户自己的 Chrome、Edge，见「用户自己的浏览器」。
  - 网页要的权限（摄像头、定位、通知等）一律拒绝，不下载文件。网页开新窗口时在这个任务里开一个新标签页并切过去（满 10 个就在当前标签页打开）；多于一个标签页时面板顶栏下面有标签条，能切换、关闭。
  - 网页弹窗（alert、confirm、prompt）：内置浏览器的视图不显示，Electron 直接按取消关掉（confirm 得到 false）。调试协议照样报 `Page.javascriptDialogOpening`，工具结果里告诉模型弹过什么、已经按取消处理；要点确定只能请用户自己做，或者改用 Chrome。
  - 原生视图盖在页面上面：弹窗、下拉菜单打开时（`data-scroll-locked`）先藏起来；任务切走、面板收起时藏起来，标签页保留。删除任务时关掉。
  - 地址栏、前进后退、刷新、在系统浏览器打开；没写协议时本地地址按 http，其他按 https，只能开 http(s)。
- 智能体工具（客户端有浏览器时才给，`SessionConfig.browser`），内置浏览器和用户的 Chrome、Edge 共用同一套（`main/browser-page.ts` 的 `PageAgent`，只通过调试协议做事；两种浏览器各实现一个 `PageTarget`）：
  - 页面：打开网页、后退前进刷新（`browser_history`）、标签页（`browser_tabs`：列出、新开、切换、关闭，编号从 1 开始）。
  - 读：读页面（无障碍树）、按文字找元素（`browser_find`，只列含这段文字的行，同样重新编 ref，长页面比整页读省）、读文字（`browser_get_text`，`innerText`，最多 3 万字）、列图片、读控制台、网络请求（`browser_network`：最近 300 条里按网址过滤或只看失败的，最多列 100 条）、检查布局、截图。
  - 操作：点击（ref 或坐标；右键、双击、按住修饰键）、悬停、拖动（按下、分 10 步移动、松开；HTML5 拖放可能不认）、滚动（滚轮事件，默认在页面正中）、输入（有 ref 替换那个框的内容，没有 ref 输入到当前焦点、不清空，编辑器和游戏用）、按键（组合键 `Control+A`、单个字符、F1～F12；可以连按几次、按住多久，游戏用）、选下拉框（按 value 或显示的文字，发 input 和 change 事件）、上传文件、等待（文字出现、消失，或者只等几秒，最多 30 秒）、处理网页弹窗。
  - 运行脚本（`browser_evaluate`）：在页面里求值，可以 await，结果 JSON 最多 1 万字，标明是数据。
  - 上传文件和运行脚本能把数据送出去：完全放行以外的模式下先问，选「本会话允许同类」后这个会话不再问（`browser-action:upload`、`browser-action:evaluate`）。上传的路径按读文件的规则解析（项目外的路径照常先问），给客户端的是绝对路径。
  - 坐标：按最近一张普通截图的像素算，换算成页面 CSS 像素（截图时记下 `innerWidth / 截图宽`，用户 Chrome 的设备像素比、截图缩到 1280 宽都算在里面）；没截过图时就是 CSS 像素。最近一张是按指定宽度或整页截的，坐标对不上当前视口，按坐标操作直接报错，让模型先截一张普通截图。
  - 页面弹出 alert、confirm 时调试命令要等它关掉才返回，所以点击、按键、输入回车、运行脚本都和「弹窗出现」赛跑：弹窗一出现就先返回，结果里说弹了什么；有弹窗没处理时除了处理弹窗、读控制台、网络请求、标签页，别的操作直接报错。
  - 读页面给的是无障碍树（Chrome 调试协议 `Accessibility.getFullAXTree`），可操作的元素带 `[ref=eN]`，最多 3 万字；不看图的模型也能用。页面内容标明是数据、不是指令。
  - 点击是在元素中心发真实的鼠标事件（先滚动到可见）；输入先选中原内容再插入文字，不往密码框里输入。操作后等页面反应，开始加载了就等加载完（最多 15 秒）。
  - 截图要面板显示着才截得到（隐藏的视图不画）：没显示时请界面打开，等不到就告诉模型。用户的 Chrome 里后台标签页也截得到。整页截图（`full_page`）缩到 1280 宽后最多 8000 像素高，再长的截掉。截图缩到 1280 宽的 JPEG，不放进工具结果（OpenAI 兼容接口的工具结果只能是文字，图片会被当成一长串字），跟在工具结果后面作为一条带图片的消息；上下文压缩时旧截图换成一句话。
  - 截图可以指定视口宽度（320～1920）：页面平时按面板的宽度渲染（窗口的 45%），模型看到的是挤窄的样子，所以用调试协议的设备模拟（`Emulation.setDeviceMetricsOverride`，设备像素比 1）临时按那个宽度渲染，`Page.captureScreenshot` 截完就恢复。比 768 窄的按手机模拟（遵守 viewport 标签），高度手机 812、平板 1024、桌面 800。期间面板里的页面会跟着变一下，靠脚本响应宽度的页面会重新渲染一次。
  - 检查布局（`browser_check_layout`）：同样用设备模拟，按手机 375×812 和桌面 1280×800 各在页面里跑一遍检查脚本（`packages/desktop/src/main/layout-check.ts`），结果是文字，不看图的模型也能用。详见「前端任务」。
  - 打开网页的权限（`browser_navigate` 和带网址的 `browser_tabs` 新标签页）：设置里「不让打开」的网站（含子域名）直接拒绝、不问；本地地址（localhost、127.0.0.1 等）和设置里「直接打开」的网站直接开；其他网站在「完全放行」以外的模式下先问，选了「始终允许」本会话里这个站点不再问。页面里的链接点过去不再问。
  - 站点名单在桌面端的设置里管（`settings.json` 的 `browser.allowSites`、`browser.blockSites`，只记主机名，粘贴整个网址也只留主机名；同一个网站加进一边就从另一边去掉），所有会话共用：桌面端启动时和改了名单时用 `_diffra/browser/sites` 交给 core，core 记在进程里。
  - 浏览器在桌面端，core 通过 ACP 扩展请求 `_diffra/browser/action` 让客户端执行；智能体一用浏览器，界面就把这个任务的浏览器面板打开。
- 开发服务器：智能体用 `dev_server_start` 启动，默认命令取 package.json 的 dev、start 或 serve 脚本（按项目的包管理器），也可以指定；启动和普通命令一样按权限模式确认。
  - 命令在底部终端的一个标签页里跑，用户看得见、能 Ctrl+C 停；等它打出本地地址（最多一分钟）后告诉模型，模型再用浏览器打开。每个任务最多一个，再调返回已经在跑的那个。
  - `dev_server_logs` 看最近的输出（去掉颜色控制符），`dev_server_stop` 停掉。删除任务、页面刷新、应用退出时一起结束。
  - core 通过 `_diffra/devserver` 请求客户端，终端在主进程开（复用终端的实现）。
- 不做（以后再说）：清除浏览数据的按钮、下载、规划和深度扫描里用浏览器、网络请求的请求头和响应内容、元素截图、内置浏览器里显示网页弹窗。

## 用户自己的浏览器（第 268–277 步）

- 智能体可以改用用户自己的 Chrome、Edge，用那里的登录状态。设置 → 浏览器 选默认（内置 / 我的 Chrome / 我的 Edge），浏览器面板顶栏右边的菜单能给单个任务换（只在内存里记，重启后回到默认）。换回内置时 Chrome 里这个任务的标签页交还给用户。
  - 用户在指令里说「用我的 Chrome」时，智能体用 `browser_switch` 换，效果和面板菜单一样，只改这个任务，不改设置里的默认（第 285–289 步）。换到用户的 Chrome、Edge 按「上传文件、运行脚本」那一档先问（「让智能体改用你的 Chrome（会用你在那里的登录状态）」，完全放行模式不问，「始终允许」本会话不再问），免得网页里的文字让智能体自己换过去；换回内置不问。扩展没连上时不换，告诉智能体请用户去「设置 → 浏览器」装扩展。智能体不改设置里的默认值，用户要改默认就去设置里改。
- 结构：浏览器里的 Diffra 扩展（`packages/desktop/browser-extension/`，Manifest V3）⇄ native messaging ⇄ 本机宿主（`main/native-host.ts`）⇄ 命名管道 ⇄ 主进程（`main/browser-bridge.ts`、`main/browser-external.ts`）。协议在 `shared/browser-bridge.ts`。
  - 扩展只转发：Diffra 发来调试命令，扩展用 `chrome.debugger` 交给标签页，结果和事件转回去；扩展还管标签页和分组。读页面、点击这些都在 Diffra 的 `PageAgent` 里，和内置浏览器同一套，扩展越薄越少需要重新过商店审核。
  - 实测过（Chrome 157）：宿主连着时扩展后台不会被回收（静置 70 秒）；扩展发给宿主 20MB 的消息没问题（宿主发给扩展上限 1MB，只发命令，够用）；后台标签页也能截图；投屏约 20 帧每秒。
- 本机宿主：`Diffra.exe` 以 node 模式（`ELECTRON_RUN_AS_NODE`）运行打进 `out/main/native-host.js` 的脚本，不另带可执行文件；打包版脚本在 `app.asar` 里。
  - Diffra 每次启动在数据目录的 `browser-bridge/` 下重写启动脚本（`.cmd`，里面写好管道名、令牌文件、`Diffra.exe` 和脚本的路径）、宿主清单（`allowed_origins` 是开发版和两个商店版的扩展 ID），再用 `reg.exe` 登记到当前用户的 `Software\Google\Chrome\NativeMessagingHosts`、`Software\Microsoft\Edge\NativeMessagingHosts`。安装位置、数据目录变了也能自己对上。卸载时删掉登记（`build/installer.nsh`，升级时不删）。
  - 宿主名：正式版 `dev.diffra.browser`、开发版 `dev.diffra.browser_dev`，同时开着不抢；扩展两个都连。e2e 用 `dev.diffra.browser_test`（`DIFFRA_BROWSER_HOST=test`），不覆盖开发版的登记。e2e 默认不登记（`DIFFRA_BROWSER_HOST_TARGETS=none`）。
  - 管道名按数据目录算（`\\.\pipe\diffra-browser-<哈希>`）。宿主连上后第一行报令牌：令牌每次启动随机生成，写在数据目录里，只有这个用户读得到；报错令牌的连接直接断开。
  - Diffra 没开时宿主每 2 秒重连一次管道，连上后补发扩展最近一次打招呼；扩展弹窗据此显示「Diffra 没有打开」。
- 扩展：
  - 权限：`nativeMessaging`、`debugger`、`tabs`、`tabGroups`、`storage`（会话存储里记标签页和任务的对应，后台被回收后接得上）、`alarms`（宿主没登记时每分钟重试）。
  - 只操作两种标签页：Diffra 为任务开的（放进「Diffra · 任务名」分组，任务改名时分组名跟着改），和用户在扩展弹窗里「交给 Diffra」的。分组只能在一个窗口里：交过来的标签页留在它原来的窗口，进这个任务在那个窗口的分组（没有就新建），一个任务可以在几个窗口各有一个分组（第 278 步）。放进别的窗口的分组会把标签页搬过去，真机上搬过去之后投屏和截图都拿不到画面。新版 Chrome 会把分组自动存到书签栏上；分组里的标签页都移出或关掉后，书签栏上的分组也跟着消失（真机看过）。这些标签页里的网页自己开的新窗口也算（`Page.windowOpen` 之后 5 秒内、opener 是这个标签页的新标签页）；用户从这些标签页里按 Ctrl+T、中键开的不算。
  - 弹窗：连接状态；当前标签页交给哪个任务（列出 Diffra 发来的最近 30 个任务，运行中的排前面），或者收回；正在用浏览器的任务能停下（交给界面去停，界面状态才对得上）。
  - 用户在浏览器的调试提示条上点了取消：这个标签页交还给用户，任务暂停用浏览器，工具调用直接报错让模型去问用户；面板上有「继续」。
  - 扩展图标上的数字是交给 Diffra 的标签页数。
  - 开发版的清单带固定 `key`（仓库里只放公钥，`browser-extension/development-key.txt`），加载解压的扩展时 ID 固定是 `gnbcambhefcipgikjdfmfklhbjhebpia`；商店版去掉 key，ID 由商店分配，第一次上架后填进 `EXTENSION_IDS`。上架和发版见 `docs/browser-extension-store.md`。
- 主进程：
  - 有多个浏览器、多个配置文件连着时，用这类浏览器里最近切到前台的那个。扩展的协议版本对不上时能连上但不用，设置页和工具结果里提示更新。
  - 每个任务在浏览器里最多 10 个标签页，和内置浏览器一样能列出、新开、切换、关闭。
  - 智能体新开的标签页都放到前台（第 475 步；以前只有第一个）：CI 上 Chrome 对后台标签页的调试命令 30 秒不回应，现场是接管时的 `Runtime.enable` 这一组超时、之后读文字又卡住，同一次运行里前台的标签页正常；本机复现不了，Chrome 为什么不回应没查清。切换标签页（`select`）还是只换智能体用哪个，不切浏览器的前台。
  - 浏览器面板：用户的浏览器在别处，面板上显示智能体当前标签页的投屏（`Page.startScreencast`，面板显示着才投；后台标签页浏览器不画、不出帧，所以打开面板、每次操作完再补一张截图），「在 Chrome 里查看」把那个标签页切到前台。扩展没连上时说明怎么装，能一键改回内置浏览器。
  - 删除任务时它在浏览器里的标签页交还给用户，不关（可能有用户自己的东西）。
- 测试：e2e 用 Playwright 的 Chrome for Testing（正式版 Chrome 137 起不让命令行加载扩展）在新的无头模式下加载开发版扩展，Diffra 登记测试用的宿主名，测完删掉登记。Chrome for Testing 读的是 `Software\Google\Chrome` 下的登记，和正式版 Chrome 同一个位置。CI 的 Windows 构建里多一步 `playwright install chromium`。
  - 在 Claude 桌面版（打包应用）的终端里跑测试时，写注册表和 `%LOCALAPPDATA%` 会被重定向到它私有的副本：注册表项用户的 Chrome 看不到，装在那里的 Chrome for Testing 启动报「并行配置不正确」。本机跑扩展的 e2e 时把 `PLAYWRIGHT_BROWSERS_PATH` 指到其他盘上的目录。
- 不做（以后再说）：Firefox、Safari、Brave、Arc；Linux（macOS 见「macOS」）；Chrome 远程调试开关（`chrome://inspect`）当备用；自动识别付款、提交这类高风险按钮再确认；录 GIF；在浏览器侧边栏里聊天；在投屏画面上直接点。

## 系统 Chrome 直连、开发者工具（v2 · M5）

- 设置分区「浏览器」改名「浏览器与电脑操控」（电脑操控见下一节）。选「我的 Chrome」时多一项「Chrome 怎么连」：经扩展（原来的做法，用用户平时的 Chrome 和登录状态），或直接启动（`browser.chromeDirect`，可选字段，旧设置没有就是经扩展；旧版读到会忽略，`agent` 还是 v1 认得的 `chrome`）。
- 直接启动（`main/browser-direct.ts`）：按 Chrome、Edge、Chromium 的顺序找系统里装的（Windows 看 Program Files 和 LocalAppData，Mac 看 /Applications 和 ~/Applications），用 Diffra 自己的配置目录（`userData/system-chrome`，登录状态留在这里，和用户平时的 Chrome 分开）启动，开调试端口（`--remote-debugging-port=0`，只听 127.0.0.1，从配置目录里的 `DevToolsActivePort` 读端口），WebSocket 连上去（Node 自带的 WebSocket，不加依赖）。Chrome 136 起不让默认配置开调试端口，所以只能用单独的配置。上次 Diffra 启动的那个还开着就直接连上去。智能体用到、或者在面板上输入网址时才启动，20 秒内没启动好、找不到程序都说清楚；Linux 暂不支持，设置里标出来。
  - 不另写一套：在进程里模拟一个扩展连接（`BridgeConnection` 的传输换成函数），扩展的几个调用（开、关、切换标签页，接上调试，转发调试命令）换成调试协议的 `Target.*`，事件按扩展的格式交回去；标签页、投屏、`PageAgent` 都和经扩展的那条路共用。没有标签页分组（整个配置都是 Diffra 的）。网页开的新窗口（`Target.targetCreated` 带 openerId）照样交给这个任务。
  - 退出 Diffra 时先 `Browser.close` 再结束进程。调试端口在本机上别的程序也连得上，这是直连的代价，设置里写了是单独的配置。
- 开发者工具：浏览器面板顶栏多一个按钮。内置浏览器打开 Electron 的开发者工具（单独窗口）；直接启动的 Chrome 在那个 Chrome 里开一个新窗口，打开这个标签页的检查器（`/devtools/inspector.html?ws=…`）；经扩展的 Chrome、Edge 请用户按 F12（按钮不显示）。
- 自己选程序（`browser.chromePath`，可选字段）：「系统 Chrome」一行有「选择程序…」（macOS 选到 .app 时换成包里的可执行文件）和「改回自动找」。选了就只用它，文件不在了直接说「选的程序不在了」，不偷偷换成别的。Linux 按常见位置找（`/usr/bin/google-chrome(-stable)`、`/opt/google/chrome/chrome`、Edge、`/usr/bin/chromium(-browser)`、`/snap/bin/chromium`），没在 Linux 上实测过。
- 用不上时回退：设置的是直接启动的 Chrome，但没找到程序或启动失败，这个任务改用内置浏览器，浏览器面板顶上写「没用上系统 Chrome：原因」，给模型的结果前面也说明换了浏览器、登录状态是分开的。用户在面板上换浏览器时清掉回退、下次再试。没有打包 Chrome for Testing：要下载一百多 MB，内置浏览器就是现成的回退。
- 开发者工具开关（`browser.devTools`，可选字段，旧设置没有就是开）：关掉后浏览器面板上不显示「开发者工具」按钮。检查器用的是 Chrome 自己带的前端（`/devtools/inspector.html`，Chrome 本地提供），内置浏览器用 Electron 自带的，都不联网、不另打包。
- 配置目录 `userData/system-chrome` 一直留着（登录状态在里面），退出 Diffra 时只结束 Chrome 进程，不清这个目录。
- 验证：e2e `browser-direct.spec.ts` 四个用例：
  - 把「系统 Chrome」换成 Playwright 的 Chromium（无头，`DIFFRA_SYSTEM_CHROME`、`DIFFRA_SYSTEM_CHROME_ARGS`，只在测试数据目录里认）：设置里选直接启动并存进设置文件，智能体在里面打开、读本地页面，调试端口上看得到这个页面，面板显示投屏，点开发者工具后多了检查器页面，设置里显示运行中，关掉 Diffra 后调试端口连不上。
  - 没找到程序：任务改用内置浏览器读到页面，面板写出原因，模型的结果里有说明；关掉开发者工具开关后面板上没有这个按钮。
  - 自己选程序：选 Playwright 的 Chromium 后设置里写着、存进设置文件，任务用它打开页面；改回自动找后路径清掉。
  - 用本机真装的 Chrome（没有就用 Edge；配置目录在测试数据目录里，无头，不碰用户平时的配置）：读网页、投屏、开发者工具、关掉 Diffra 时跟着关。2026-11-15 在 Windows 上用 Chrome 157 跑通。
  - `browser-settings.spec.ts` 跟着改了分区名。macOS 上的真 Chrome 没跑过。

## 电脑操控（v2 · M5）

- 让智能体看主屏幕、动鼠标、按键盘，给桌面应用这类浏览器和命令管不到的事用。默认关（`settings.computerUse`，可选字段，旧设置没有就是关）；在「设置 → 浏览器与电脑操控」里打开，第一次打开先弹一段说明（能做什么、怎么确认、怎么停），确认后记下 `acknowledged`，以后开关不再弹。打开对新任务（和重新载入的任务）生效，关掉马上生效：已经开着的任务再要操作时客户端直接拒绝，告诉模型别再试。
- 工具（core `session/computer.ts`）：一个 `computer` 工具，`action` 是 screenshot、cursor_position、click、double_click、right_click、move、drag、type、key、scroll、wait。只在设置开了、模型打开了「视觉」时给（看不了图就没法用）。坐标是最近一张截图里的像素；没截过图、超出截图的报错。按键写成 `Enter`、`Ctrl+C`、`Ctrl+Shift+T`、`F5`，一次一个主键；输入的文字最多 2000 字，换行和制表符按 Enter、Tab 键发。wait 在 core 里等（最多 10 秒），不发给客户端。
- 确认（按权限模式）：看屏幕（截屏、读鼠标位置）每个任务问一次，可以选「本会话允许看屏幕」；动鼠标键盘的每一步都问，只有「允许这一步」和「拒绝」；任务选了完全放行就不问。确认卡写清楚这一步做什么（在哪儿单击、输入什么、按什么键）。这些确认只在本机弹（`LOCAL_ONLY` 标记），连着的设备上看不到也答不了。拒绝了不执行，告诉模型别再试、去问用户。
- 执行（桌面端 `main/computer/`）：
  - 截屏用 Electron 的 desktopCapturer 截主屏幕，缩到最宽 1280 的 JPEG，跟在工具结果后面作为图片发给模型；工具卡上放一张小图。macOS 截不到（没给屏幕录制权限）时说去哪里开。
  - 鼠标键盘是一个常驻子进程，标准输入一行一条命令：Windows 用 PowerShell 编一段调 `SendInput` 的 C#（鼠标按主屏幕的比例发绝对坐标，和缩放无关；文字按 Unicode 发，中文也行）；macOS 用 `osascript -l JavaScript` 调 CoreGraphics 发鼠标和按键事件（双击带点击次数），文字用 System Events 的 keystroke（要辅助功能权限）。不加原生依赖。进程闲置 5 分钟就结束，下次用到再起，退出 Diffra 时结束。
  - 时限：驱动每条命令 10 秒，一步（比如拖动的十几条命令）20 秒，core 等客户端 30 秒；超时就结束驱动进程并报错，任务不会卡住。用户停止任务时这一步取消。
  - 只管主屏幕，多显示器的其他屏幕不管。Linux 暂不支持，设置里标出来、开关不可用。
- 审计：每一步（成功或失败）在数据目录的 `computer-audit.jsonl` 记一行：时间、任务、动作、一句话说明（坐标、按键照记，输入的文字只记字数）、成没成、原因、耗时。超过 2000 条只留最近 1000 条。设置里「最近的操作」能看（新的在前）、刷新、清空；只存在本机。
- 验证：core `computer.test.ts` 测什么时候给工具、参数和报错、看屏幕问一次而每步都问、确认带本机标记、截图跟在结果后面、拒绝不执行、完全放行不问、wait 不发给客户端、客户端报错。`scripts/computer.test.ts` 测按键解析、Windows 和 macOS 的键码、文字拆分，并在 Windows 上真的起一次驱动进程（编译 C#、ping、读鼠标位置、不认识的命令报错、结束后能再起；不发移动、点击、按键这些会动的命令）。e2e `computer.spec.ts` 用假驱动（`DIFFRA_COMPUTER_DRIVER=fake`，只在测试数据目录里认，操作记进文件，假屏幕 1600×900）：默认关、第一次打开取消和确认、看屏幕问一次、双击输入每步问、按键拒绝后没按、坐标从截图换算到屏幕、截图发给了模型、操作记录只记字数、关掉后已开的任务马上不能用、清空记录。
- 只给主智能体：子智能体（含只读的）工具里没有它，模型硬调也不执行、不问（core `computer.test.ts`）。规划时用的是只读工具，也没有它。
- 真鼠标键盘的用例：e2e `computer-real.spec.ts`，会真的动鼠标键盘，默认跳过，`DIFFRA_E2E_REAL_INPUT=1` 才跑。它在主屏幕左上角开一个 Chromium 窗口，把 Diffra 挪到右边，任务设成完全访问（点确认卡会把焦点抢回 Diffra），让智能体截屏、单击文本框、输入、按 Ctrl+A、再输入（含中文）、双击、右键、在滚动区里滚、拖动一个方块，最后核对：文本框里是后输入的内容、收到双击和右键、滚动区滚了、拖动距离差不超过 6 像素、10 步都记进了操作记录。只输入字母和中文，不按回车。2026-11-15 在 Windows 11（两块屏，主屏 1920×1080）上跑通。
- 需要手动确认：macOS 的整条路（截屏权限、辅助功能权限、JXA 驱动）没在 Mac 上跑过，`computer-real.spec.ts` 在 Mac 上可以照样跑。

## 托盘和开机自启（v2 · M7）

- 设置「常规」多一组「启动和后台」（`settings.system`，可选字段），改了马上生效（`main/tray.ts`）。「关掉窗口时留在托盘里」默认开，旧设置没有这一项也按开（默认值不写进设置文件），想关窗口就退出的在这里关掉；「开机时自动启动」默认关：
  - 关掉窗口时留在托盘里（Mac 上叫「在菜单栏显示图标」，Mac 关窗本来就只是藏起来）：开着时关窗口只是藏到托盘，任务、终端照常跑；托盘图标单击打开或藏起窗口，右键菜单有「打开 Diffra」「新任务」「N 个任务在跑」「退出 Diffra」，提示文字也写几个任务在跑（任务列表和浏览器扩展用的是同一份，界面推给主进程）。Windows 上第一次藏到托盘时冒一个气泡说还在后台。关掉这一项后关窗口就退出（和 v1 一样）。真正退出（托盘的「退出 Diffra」、菜单的退出、装更新）前照旧先存设计稿、结束终端和 core。
  - 开机时自动启动：登记到系统的登录项（Windows 带 `--hidden`，Mac 用 `wasOpenedAtLogin` 判断）；开着托盘时自启后不弹窗口，直接留在托盘里，没开托盘就照常显示窗口。开发版不往系统里登记（登记的会是 electron.exe）。
- 顺手修的：窗口只在第一次显示前由「套用外观」显示，以前每次套用外观（比如系统换了深浅色）都会把藏起来的窗口拿出来，Mac 上关掉的窗口也会自己跳出来。
- 不做：最小化到托盘（最小化还是到任务栏）、托盘里列出每个任务、托盘图标随状态变色；Linux 上的托盘取决于桌面环境，没试过。
- 验证：e2e `tray.spec.ts`（托盘菜单在 e2e 里点不到，主进程在测试数据目录下给测试留了 `diffraTray` 读菜单和点菜单项；开机自启写进 `DIFFRA_LOGIN_ITEM_FILE`，不碰注册表；`DIFFRA_TRAY_QUIET` 不冒气泡）：默认都关、没有托盘；开了托盘有四个菜单项、存进设置；任务在跑时菜单和提示写 1 个任务在跑；关窗口藏起来、任务照常跑完、从托盘打开；托盘的「新任务」打开窗口到首页；开机自启登记带 `--hidden`；模拟开机自启（`DIFFRA_START_HIDDEN`）不弹窗口、从托盘打开；藏起来以后系统换深浅色窗口不跳出来；托盘的「退出」真的退出；关掉两项后登记取消、关窗口就退出。没有在打包版上真的登记开机启动、重启电脑试过；Mac 的菜单栏图标没试过。

## 前端任务

- 前端效果差，主要是模型不知道项目已有的设计、看不到自己做出来的页面。所以给它三样东西：做法说明、设计 Skill、能「量」页面的工具。审美上限还是取决于模型本身。
- 前端项目：项目文件（`rg --files`，遵守 .gitignore，和规则包选语言共用一次）里有 .tsx、.jsx、.vue、.svelte、.astro、.html、.css、.scss、.sass、.less 就算。
- 前端项目的系统提示词多一段做法（`frontendLines`）：
  - 改界面前先看项目的样式写法（Tailwind 配置、CSS 变量或主题令牌）、公共组件和相似的页面，复用它们的组件、颜色、间距和字号，不自己加新的颜色、字体和零散尺寸，除非用户要求。
  - 跟着周围的页面走；没有现成风格可以跟的新页面或改版，先定清楚视觉方向，索引里有 frontend-design 就提示去读它。
  - 照顾加载、空、出错、长文字、窄屏、深色模式这些状态；用户给的参考图就是规格。
  - 开了浏览器时：改完能看见的东西，启动开发服务器、打开页面、看控制台、跑布局检查，修掉报出来的问题。模型能看图时再按 1280 和 375 两种宽度截图对照。浏览器没开时让它告诉用户该看哪些页面。
- 内置 Skill `frontend-design`：Anthropic 的 frontend-design（Apache-2.0），原样收录，讲怎么定视觉方向、选字体和配色、避开生成页面的常见套路。它偏新做和改版的页面，已有项目以上面「跟着项目已有的设计走」为准。
- 布局检查查这些，每类最多列 6 个，另报总数：
  - 横向溢出：页面内容比布局视口宽，报最外层超出的元素；在会滚动或裁切的容器里的不算。
  - 文字被裁切或溢出：overflow 是 hidden/clip 的盒子里有一行字被边缘切开、或整行落在盒子下面；没有子元素的文字块内容比盒子大（字会压到别的东西上）。省略号截断和行数截断是有意的，不算；横向只看被切开的，免得把轮播图后面几页算进来。
  - 被盖住、点不到的可点元素：在元素中心用 `elementFromPoint` 看点到的是不是它，只查当前可见区域。
  - 手机宽度下点击区域小于 24×24（WCAG 2.5.8 的下限），行内链接除外。
  - 桌面宽度下的文字对比度（WCAG AA：普通字 4.5:1，大字 3:1）和没有 alt 属性的图片。颜色交给 canvas 换算，oklch、color() 写法也能算；背景往上找纯色背景色、半透明的逐层叠上去，遇到背景图或渐变就不算；同样的颜色组合合并成一条。
  - 手机宽度下没有 viewport 标签；还有多少条没读过的控制台错误和警告。
  - 布局视口用 `document.documentElement.clientWidth`：手机模拟下内容超宽时页面会整体缩小，`innerWidth` 是缩小后的可见宽度。等设备模拟生效看 `screen.width`。
  - 页面元素最多查 8000 个，多了说明只查了一部分。元素描述带标签名、id、前三个 class 和一段文字，标明是网页内容、不是指令。
- 不做（以后再说）：完成前用看图的评审模型审界面（第 5 步）、前端评测题（第 6 步）、浏览器面板里的点选模式（点选网页元素、标注后定位到源码；和「设计模式」的矢量画布是两回事）、axe-core 这类完整的无障碍检查。

## 设计模式

- 目标：在 Diffra 里做 Figma 那样的矢量设计，智能体和用户在同一块画布上画。不商用，自己做，不嵌整个现成应用。
- 引擎：OpenPencil（MIT）的 `@open-pencil/core` + `@open-pencil/vue` + `@open-pencil/design-jsx`，锁死 `0.17.0-beta.2`（API 还在变，升级单独做、单独验证）。`canvaskit-wasm` 跟引擎同为 `0.41.1`，免得打进两份。
- 设计页单独一个页面（`src/renderer/design.html`，Vue），由主进程放进 `WebContentsView` 叠在设计面板的位置上，和内置浏览器同一套叠放、隐藏做法（`src/main/design.ts`）。每个任务一个。
  - 单独一个页面是因为它要放开 CSP：CanvasKit 编译 WASM（`wasm-unsafe-eval`），`render` / `eval` 工具用 `new Function` 执行模型写的 JSX 和脚本（`unsafe-eval`）。主界面的 CSP 不变。
  - 隔离：沙箱、`contextIsolation`，拿不到 `window.diffra`；preload（`src/preload/design.ts`）只有一个只发不收的「文档改了」通知。外部网络在主进程的 `webRequest` 里全部拦掉，只放行应用自己的页面文件。权限只给 `local-fonts`（读系统字体），其余一律拒绝。
  - 主进程用 `executeJavaScript` 调页面里的 `window.__diffraDesign`（`src/renderer/design/bridge.ts`）：配置工具、执行工具、打开/保存 `.fig`。
  - 两个 preload 不能共用模块：会被拆成公共 chunk，沙箱里的 preload 加载不了。设计页的 preload 直接写通道名。
- 入口：左侧栏「搜索」下面的「设计」，进入设计首页（路由 `design`，处在设计首页时这一项高亮）。新建设计只走这里，首页输入框上原来的「设计」开关去掉了：两个入口建的是同一种任务，按名字找「设计」按钮时也会有歧义。
  - 设计首页和首页是同一个组件（`HomeView` 的 `design`）：上面是新建设计的输入框，标题写「要设计什么？」或「在 X 里要设计什么？」（不能含「要做什么？」，e2e 按这个子串认首页）；默认项目沿用进入前所在的项目（任务页取任务的项目，无项目任务取「无项目」），没有就是无项目，可以在项目下拉里换。
  - 下面「设计任务」列出全部未归档的设计任务，按最近更新排，不限条数，刚建、core 还没存盘的也列出；每行的项目列写项目名，无项目任务写「无项目」（悬停显示真实路径）。v2 起每行前面有设计稿的缩略图（见下面「设计稿的缩略图」）。
  - 设计任务建会话时带 `SessionConfig.design`，写进会话记录的 `design` 字段（旧记录没有，按普通任务），索引里也有这一项（见「Agent 核心」）。设计任务在侧栏仍列在各自项目下（无项目的在「无项目」分组），行首缩进区有一个画笔标记（读屏名「设计任务」），标题仍然对齐。首页不列任务（「最近的任务」已去掉），设计任务从侧栏或设计首页打开。
  - 打开设计任务时自动切到设计面板；顶栏多一个「设计」按钮，可以切到审阅、浏览器看改动再切回画布。删除或归档正在看的设计任务后回到设计首页，普通任务回首页。
  - 普通任务没有设计面板，也不带设计工具：顶栏只有浏览器、审阅、监控三个按钮；从设计任务进入普通任务时面板是设计的话改成任务监控（只在进入普通任务这一处改，设计任务切到设计面板由打开、新建任务时显式设置）；智能体调用设计工具时自动打开面板也只对设计任务生效。以前普通任务也能手动打开设计面板，打开过之后的轮次带设计工具；面板开关又是全局状态，从设计任务切到普通任务时普通任务会继续显示画布并被配上设计工具，这次一起去掉。
- 布局：开着设计面板时画布占主区，对话列默认 `26rem` 放左边，可以拖（见「分栏拖动」）。设计页里的图层、属性两栏按设计页宽度自动显隐（属性 ≥ 760px、图层 ≥ 1000px），用户手动开关后以手动为准。
- 编辑器界面（Vue，SDK 的 headless 组件 + Diffra 的配色令牌）：顶部工具栏（工具、撤销重做、缩放）、左侧页面和图层树（改名、显隐、锁定）、右侧属性（位置尺寸、对齐、自动布局、外观、填充、描边、文字）、右键菜单（先选中指针下的图层）、Figma 习惯的快捷键、复制粘贴（系统剪贴板的 copy / paste 事件，内容是 OpenPencil 剪贴板 HTML）。深浅色跟 Diffra 的外观设置走（主进程的 `nativeTheme`），强调色不同步。
  - 0.17 的 `CanvasRoot` 只负责画，指针输入和文字编辑由宿主接 `useCanvasInput` / `useTextEdit`；画布尺寸通过 `createEditor` 的 `getViewportSize` 给，按画布本身算，不按窗口。
- 智能体工具：工具定义来自设计页（OpenPencil 的核心工具 + 导出图片、页面、编组、组件、布尔运算、效果、图标、设计变量、检查和分析），JSON Schema 交给 core，名字加 `design_` 前缀（`packages/core/src/session/design.ts`）。设计页 64 个，加上 core 自己实现的放图片，工具定义加说明约 7.7 万字符，只在设计会话里带。
  - 设计变量（`create_collection`、`create_variable`、`bind_variable` 等）和检查分析（`lint`、`lint_fix`、`analyze_colors`、`analyze_typography`、`analyze_spacing`、`analyze_overlaps`）、`list_available_fonts` 是第 159 步开放的：画得好不好不能只靠模型看图，检查工具给出对比度、点击区域、间距和字号是否统一这些客观结果。比开放前多约 1.3 万字符。
  - 每轮开始前主进程把工具配置给 core（`_diffra/session/configure` 的 `design`）：core 重新加载会话时会丢掉它。只配给设计任务：主进程在新建、打开设计任务时把它记进 `DesignHost` 的名单，显示设计面板不再顺带加进去，不靠界面不去开面板来保证普通任务不带工具。
  - 调用时 core 通过 `_diffra/design/action` 请求客户端在设计页里执行；改文档的工具记成一步撤销（「Diffra: 工具名」）。画布上的修改能撤销、页面是沙箱且断网，所以不逐次确认。
  - 工具改的当前页、选区、视口只写在那次的 Figma API 对象上，执行完同步回编辑器。
  - `export_image` 只给能看图的模型；不看图的模型拿不到图片，说明里让它用 `describe`、`get_node` 检查。要联网（图库、网页搜索）或读写设置的工具不给。
  - 说明接在系统提示词后面：在画布上画而不是写 HTML、看图检查、实现到项目时用 `get_jsx` 读设计再改代码，加上 OpenPencil 的设计 JSX 参考。
  - 说明里写明设计流程（第 158 步）：先定题材、受众和视觉方向（技能清单里有 `frontend-design` 时让它先读），再用设计变量建颜色、字号、间距、圆角规范，把重复的部分做成组件，按页面拼，完成前用检查和分析工具过一遍。以前设计任务只在「项目有界面代码」时才提示读这个 Skill，无项目的设计任务读不读全看模型。
- 真实图片（第 156–157 步）：设计页断网，引擎的 `stock_photo` 要联网、`set_image_fill` 要模型把整张图的 base64 当参数传（几百 KB 到几 MB，模型传不了），所以模型以前只能手画占位。
  - core 实现 `design_place_image`（`packages/core/src/session/design-image.ts`）：参数是节点 id 和图片来源（http(s) 网址或本地路径），core 下载或读取、校验后通过 `_diffra/design/action` 调设计页的 `set_image_fill`。图片数据只在 core、主进程和设计页之间传，不进模型的对话。`set_image_fill` 只给 core 调，不在给模型的工具里。
  - 下载：只认 PNG、JPEG、WebP、GIF（按文件头认，内容类型是网页的直接拒），单张不超过 10MB（声明的大小和实际读到的都算），15 秒超时（含读内容），最多跟 3 次跳转。下载前按权限模式确认，和内置浏览器打开网站一样：完全放行、本地地址、本会话允许过的站点不问。GIF 实测能在画布上画出来（第一帧）。
  - 本地文件：项目里的直接用；项目外的沿用读文件的授权规则。
  - 下载的和项目外的图片在项目的 `assets/` 存一份（文件名是来源文件名加内容哈希，同一张只存一份），之后把设计转成代码时直接引用；`assets/` 是禁写目录或指到项目外时不存，结果里说明。图层名接上项目里的路径和来源（「原名 · assets/x.png · 网址」），再次换图时替换掉上次接的部分。
  - 找图：内置浏览器加了 `browser_images`，列出页面上图片的网址（srcset 里最大的一张）、像素尺寸和替代文字，过滤掉小于 120px 的图标头像，最多 40 张。说明里建议去 Unsplash、Pexels、Wikimedia Commons 这类可自由使用的图库找，并告诉用户图片来源；内置浏览器关着时让它用用户给的图，或说明需要什么图。
  - 网上的图片默认只当设计稿里的参考和占位，真正发布前由用户确认授权。v2 接了图库 API，见下一条。
- 图库找图（v2 · M11）：设置 → 设计里填 Pexels、Unsplash 的 API Key（用户自己去两家申请，Diffra 不带公共 Key）。Key 存在 SecretStore（`stock:pexels`、`stock:unsplash`），只在主进程里用，不进设置文件、日志、core 和模型。
  - 填了任一家的 Key，设计任务多一个 `design_find_photos`（`packages/core/src/session/design-photos.ts`）：查询词、横竖方、张数（默认 8，最多 12）。core 通过 `_diffra/design/stock-photos` 请客户端搜（`src/main/stock-photos.ts`）；两家都填了各取一半，一家出错另一家照样返回，结果里说明哪家失败。超时：每个请求 15 秒、整次 30 秒，跟着这一轮取消。
  - 缩略图由主进程下载成 `data:` 地址（每张 10 秒、最大 120KB、只认 JPEG/PNG/WebP，四张一批）：界面的 CSP 只许本地和 data 图片，也不让界面直连外网。对话里的卡片显示缩略图、摄影师和来源页链接；给模型的是图片地址、尺寸、说明和摄影师，不带缩略图。
  - 放进画布还是用 `design_place_image`，下载确认和存进 `assets/` 的规则不变；说明里让模型在图层名写上摄影师，并告诉用户用了谁的图。
  - 没做 Unsplash API 指南要求的「用了一张图就调一次 download 接口」，也没按热链要求直接引用它的地址（图会存进项目的 `assets/`）。自己用没问题；要公开发布或申请正式额度前，要对照两家的 API 条款补上。
  - 验证：core `design-photos.test.ts`（设计任务、填了 Key 才有这个工具；给模型地址和摄影师，卡片带缩略图；没找到时说明）；e2e `design-photos.spec.ts`（本机假图库，用 `DIFFRA_PEXELS_URL`、`DIFFRA_UNSPLASH_URL` 指过去，只在允许测试改写时认；Key 不写进设置文件）。真 Key 没在本机试过。
- 设计稿的缩略图（v2 · M11）：设计稿自动保存时，设计页用 OpenPencil 的 `renderThumbnail` 把当前页画成 480×300 的 PNG（内容居中、留白是页面底色），存在设计稿旁边（`designs/<会话>.png`），画不出来不影响存盘。设计首页的任务行读它（主进程转成 data: 地址，最大 2MB），还没存过就是空白的框；删除任务时一起删。验证：e2e `design.spec.ts` 的自动保存用例（存盘后旁边有 PNG、重启后设计首页的行带缩略图、删除后 PNG 也没了）。
- 风格预设（第 160 步）：设计首页输入框下面的「风格」下拉，「自动」加五套预设（极简编辑风、杂志排版、技术博客、作品集、产品落地页），每套写明配色、字体组合、字号阶梯、间距和圆角、版式和常见页面骨架。数据在 `packages/core/src/design-styles.ts`，界面从 `@diffra/core/types` 读名称、简介和色板。
  - 建设计任务时带 `SessionConfig.designStyle`（预设 id），写进会话记录（旧记录没有，按不用预设），每轮接在设计说明后面，写明「作为起点，按题材调整，用户另有要求时以用户为准」。只在新建时选，之后不能换；没选的任务不带预设，不多占上下文。
  - 字体只写建议的字体名，让模型先用 `list_available_fonts` 找本机最接近的，中文配对应的衬线或无衬线中文字体：设计页只能用系统字体，预设里写死的字体在别的机器上不一定有。
- 字体：内置字体没有中文。页面启动时 `fontManager.setFallbackUserAgent`（不设就按 Linux 的字体找回退，Windows 上一个都找不到）并请求读系统字体；每次编辑后 `prepareGraphFonts`（`treatUnknownCoverageAsMissing`），中文回退到微软雅黑等再重排（`src/renderer/design/fonts.ts`）。
  - 准备字体前先等系统字体列表（`queryLocalFonts`，经引擎的 `requestLocalFontAccess`）。机器忙时它要好几秒才回来，页面不可见时会被拒；OpenPencil 把列表到之前的「没找到回退字体」当成定论，之后不再自己重试，不等的话中文会一直是方框。没拿到就在下次准备字体时再要一次，同一时间只有一个请求；不加等待上限，浏览器总会给结果或报错，加了超时又回到先准备、后到列表。
  - 页面不可见（面板关着、被弹窗或下拉菜单盖着、任务在后台、窗口最小化）时，读系统字体会被直接拒绝（「Page needs to be visible.」），读单个字体文件也一样，这时准备的文字缺回退、按方框量；不改文字就不会再准备。所以准备字体时页面不可见过的（开头和结尾各看一次 `document.hidden`），回到可见（`visibilitychange`）时整页再准备一次（`prepareFontsWhenVisible`）；页面一直可见时不多准备，免得每次打开面板、关弹窗都整页重排。一次准备过程中可见、不可见来回切换，或者回到可见时不可见期间发起的读取还没返回，这两种情况不处理。
  - 字体变了之后，自己定尺寸的文字（随内容伸缩、不在自动布局里）先用 `sizeAutoResizingText` 按新字体量一遍再重排：重排（`runLayoutForNode`）只量自动布局里的文字，不先量的话这类文字一直是按旧字体量出的尺寸。OpenPencil 自己等到字体后也是先量再重排。正在编辑的文字由编辑器自己量，提交后会再准备一次；文件里存了字形（`derivedTextGlyphs`）的保持文件里的尺寸。
- 图标：设计页断网，引擎默认的 Iconify 在线接口用不了。内置 Lucide 图标集（`@iconify-json/lucide`，ISC），给引擎的 Iconify 图标源一个读本地数据的客户端（`src/renderer/design/icons.ts`）。别的图标集一律当作没有。
- 保存：每个任务的文档自动存到 `userData/designs/<会话 id>.fig`（编辑停 1.5 秒后保存，先写临时文件再改名），打开任务时载入，删除任务时一起删。关窗口前先存完没存的。顶栏「另存到项目（.fig）」另存一份，默认放在项目文件夹里（无项目任务叫「另存为 .fig」，默认放在它的文件夹里）；「打开 .fig」替换当前文档。
  - 以前在普通任务里打开设计面板画的稿子还在 `userData/designs/<会话 id>.fig`，删除那个任务时照样一起删；这些任务不再有画布入口，要继续编辑就新建一个设计任务，用「打开 .fig」载入。不做迁移，也不把有 .fig 的普通任务自动当成设计任务：那样会悄悄改变这些任务的语义，之后每轮多带约 6 万字符的设计工具。
- 资源：一个设计页实测约 300MB（CanvasKit 加已载入的字体），同时最多留 2 个，最久没显示的先存盘再卸载，下次用到时从文件载入。
- 构建：渲染进程多一个入口 `design.html`；`@vitejs/plugin-vue`，React 插件排除 `.vue`；`openPencil({ inject: false })`，引擎资源只在设计页入口里装。`@acemir/cssom`（core → dom-css → cssom）的 browser 字段指向一个什么都不导出的脚本，配置里改指到它的 CommonJS 入口。
- 体积：安装包 128.1MB → 137.9MB（0.1.4 线上版对比）。设计页的包约 37MB（未压缩），主界面加载的包不变。
- `.vue` 文件不在 `tsc` 的检查范围里（没装 vue-tsc），靠 e2e 实际操作验证。
- 不做（以后再说）：多人协作和评论、原型交互和播放、把现有代码页面导入成设计图层、OpenPencil Cloud、Figma 插件 API 的脚本面板、强调色同步、复制粘贴的自动化测试（会改到用户的系统剪贴板）、设计首页的缩略图（现有 .fig 里只有占位图，v2 改成存盘时顺便出一张 PNG）、把普通任务转成设计任务（`design` 只在新建时写入）。

## 子智能体（第 173–180 步）

- 形态：主智能体自己判断要不要拆、怎么拆，调用 `delegate` 派出工人（`packages/core/src/session/agents.ts`），和 Claude Code 的子智能体一样只发一条消息、不用手动开。同一步里连续的 `delegate` 并行跑，同时最多 4 个、其余排队，每轮最多 8 个；这一步等所有工人交回结果后主智能体再接着整合、检查、收尾。工人不能再派工人，不能调 finish、verify_changes、task_progress、pause_task。
  - 工人用主智能体当前的模型（换了备用模型就用备用模型），有自己的对话（只看到交代的任务，看不到主对话）和系统提示词（项目规则、编码规范照旧，加上工人守则），最多 40 步，最后一步或上下文到 80% 时要求直接 `report` 交结果。
  - 主智能体拿到的结果是工人的总结、待处理事项、改过的文件（按实际改动算，不按工人自己说的），以及命令改到别人认领的文件；没交结果（步数到头、出错、停止）也照样告诉它改了哪些文件。
  - 工人的模型调用在用量里记成 `subagent` 角色。用量页按模型、项目、任务汇总，没有按角色的统计，所以界面上不用改；旧版应用读到 `subagent` 的记录会算成读不了的行。
  - 不做（以后再说）：工人用单独的便宜模型（要在「模型与角色」加角色、改设置结构）、工人用内置浏览器（只有一个浏览器，并行会互相干扰）、工人用 MCP 工具、嵌套派工、每个工人一个 worktree。
- 调研其他智能体后的调整（第 449–453 步）。结论：各家最一致的用法是只读探索（全新上下文、只交回结论），并行写争议最大；Diffra 原来只做了并行写，没有探索。
  - 内置只读的 `explore` 类型（第 449 步，`subagents.ts`）：只给读和搜索的工具，不认领文件和节点，交回带文件和行号的结论。项目或用户目录里同名的类型文件会盖过它。
  - 派不派只靠主智能体自己判断，依据是 `delegate` 的工具说明（`agents.ts` 的 `delegateTool`）：先讲代价（工人只知道交代的内容、要重新找一遍、只交回一份报告），再分开列该派（要在不熟的代码里大范围摸情况且只要结论；大改动能拆成碰不同文件的几块）和不该派（几次工具调用能做完、已经知道看哪个文件、小任务或单文件、几块互相依赖），拿不准就自己做。系统提示词另加一行。说明里还写了交代要包含什么（目标和用途、已知和已排除的、从哪开始、不能动什么、交回什么）。
  - 工人的系统提示词单独组装（第 453 步，`prompt.ts` 的 `worker`）：项目目录、工作方式、受保护文件、项目规则、编码规范、记忆、Skill 照旧，去掉 finish、完成检查、步骤清单、提问、内置浏览器这些它用不了的东西，后面接工人守则和类型说明。以前是主提示词整份照搬再加一句「忽略上面关于 finish 的要求」，弱模型容易照前面的做。只读类型的守则不提认领和命令。
  - 工人接上主循环的防打转（第 452 步）：同一个调用、同样的结果连着 3 次先提醒，提醒后还犯就停下这个工人（主智能体收到「一直重复同样的操作」）；`spin.ts` 的几种只提醒不停的也接上。同一步里连续的只读调用同时跑（`prefetchReads`，主循环和工人共用）。工具按工人实际拿到的那一套判断，只读工人硬调改文件的工具不执行。
  - 工人没交结果就停下（步数到头、打转、出错）时，把它最近写过的话带回主智能体（第 451 步）：留最近 5 段、最多 2000 字，写明「没核实、可能不全」；卡片上显示最后 300 字。以前只告诉主智能体改了哪些文件，查到的东西全丢。
  - 不做（以后再说）：工人用单独的便宜模型（Claude Code、Qwen 的探索都从便宜模型改回了继承主模型）、后台运行（主智能体不等工人）、按 id 续接工人、worktree 隔离、让用户手动派。压缩和换兜底模型工人仍然没有。
- 编码任务的隔离：同一个目录，按文件认领，不用 worktree。worktree 只支持 git 项目，每个都要重装依赖，合并还会冲突；无项目任务也用不了。
  - 派工人时认领 `files` 里的文件和目录（相对项目）；中途用 `claim_files` 追加。认领和别人的重叠（同一个、上级目录或下级）就拒绝；一开始就重叠的工人不派。工人用 edit_file 改没人认领的文件时自动认领下来，改别人认领的直接拒绝（`ToolContext.beforeWrite`）。认领在工人交回结果时释放，同一轮后面派的工人可以接着认领。
  - 读文件记录（改之前必须读过、读完没被改过）每个工人一份：主智能体不能借工人读过的记录跳过阅读直接改文件；工人改过的文件主智能体要重新读才能改。
  - 命令拦不住：工人跑完命令后对比工作区指纹（检查点仓库的 write-tree 前后两次 diff-tree），改到别人认领的文件就记下来，告诉工人和主智能体。同一时段别的工人用 edit_file 改的文件不算在这条命令头上；两个工人的命令同时改了同一批文件时分不清是谁改的。没有检查点（不是 git 可用的环境）时不比。
  - 检查：工人改到一半项目可能编译不过，所以工人不跑检查。一批工人交回后，只要有工人改了文件，就和主智能体这一步自己改了文件一样，完成时照常过完成门禁（第 431 步以前还会跑一次快速检查）。
  - 权限：工人的命令、项目外读写照常按权限模式确认；几个工人同时要确认时排队，一个一个问，确认卡上写「来自子智能体 X」。
- 界面：每个工人一张卡片（主智能体的那次 `delegate` 调用），带名字、颜色（按派出顺序轮流用 8 种）、交代的事和认领的文件；运行中显示第几步、在做什么，结束后是交回的结果，展开看它的每一步（改动照样能看代码）。工人自己的工具调用不出现在主对话里。
  - 协议：卡片的 `tool_call` / `tool_call_update` 在 `_meta.diffra.agent` 里带 `AgentCardMeta`（认领变了整份重发）；工人的工具调用在 `_meta.diffra` 里带 `parentToolCallId`（所属卡片）和 `agent`（`AgentTag`），id 加上工人前缀，免得和别的工人、主智能体的撞上；权限请求的 `toolCall._meta.diffra.agent` 同样带上。都随这一轮的更新存进会话记录，重新打开任务照样能看到。工人的文字和思考不推给界面。
  - 任务监控多一节「子智能体」：最近一轮派出的工人在做什么、交回没有，点一下滚到对话里那张卡片；「本任务改动」里工人用 edit_file 改的文件标上是谁改的（命令改的看不出是谁）。
- 设计任务：工人按画布上的节点分工（`delegate` 的 `nodes`），同一页的不同区块也能分给不同的工人。说明里让主智能体先定设计变量、组件和页面框架，再把页面或区块分出去，最后统一检查。
  - 节点锁在设计页里（`src/renderer/design/bridge.ts`）：派工人时认领 `nodes`，节点不存在、和别人锁住的节点重叠（本身、上层或下层）就不派。工人改文档的调用按参数里出现的节点 id 检查（字段名各工具不一样，按值认，批量操作的 JSON 里的也算），改到别人锁住的节点或包含它的上层都拒绝；改过的和新建的节点归它。工人不能用 `eval`：它能绕过节点锁。锁在工人结束时释放。被拒的调用和设计工具别的错误一样，以 `{"error": …}` 的结果交回工人，卡片里这一步不标失败。
  - 设计页的工具调用排队一个一个执行，几个工人并行时不会在等字体之类的地方互相打断；模型那边仍然是并行思考的。
  - 自动布局下一个区块变高会把下面的区块往下推，不会弄坏别人的内容，但排版会跟着变，最后由主智能体统一检查。
- 虚拟光标：设计页画布上每个在干活的智能体一个带名字的彩色光标，指着它最近改（或看）的图层并用同色框出来，跟着缩放、平移走，图层不在当前页时不画。工人干活时主智能体在等它们，不画主智能体的光标；几个光标落在同一个角上时往下错开。工人结束时收起它的光标，这一轮结束时收起主智能体的；收尾不打开设计面板、不等画布启动。
  - 先到再改（第 193 步）：以前先执行、改完才挪光标，光标还有 300ms 的移动动画，看起来总是内容先变、光标后到。现在调用一到设计页就把光标挪向参数里第一个已有的图层（要改的图层，或新内容要放进去的父节点），排队等前面的调用时光标已经在路上；轮到执行时只等动画剩下的时间（动画缩到 180ms）再改，新建的图层画完再跳过去。面板看不见、系统开了「减少动态效果」时不等。代价：几个工人的调用本来就排队，换图层的改动每次最多多等 0.18 秒。新建没有父节点的顶层画板时仍是内容先出现。
  - 名字后面写着在干什么（第 204 步）：执行时是动作（绘制、改文字、放图片、检查、查看……，按工具名归类），两次调用之间在等模型，显示一明一暗的省略号；结束时显示「✓ 完成」一秒再淡出，不再突然消失。
  - 改过、新建的图层用智能体的颜色闪一下（第 205 步，0.6 秒）；减少动态效果时不闪，光标也不做移动动画。
  - 工人认领的区块画同色虚线框，工人结束时去掉（第 206 步）。
  - 图层整个在视野外时，画布边上出一个带方向箭头的名字，点一下视口移过去（缩放不变）；点光标的名字也一样（第 207 步）。
  - 编码任务没有光标，看对话里的卡片和任务监控的「子智能体」一节。

## 停下以后：停下说明、定位问题、修复提示词（第 189–192、201–203 步）

- 停下说明（第 201 步）：一轮不正常停下时，原来的「已停止」一行换成一句话原因加对应的按钮，不花 token。只有最后一个执行轮带按钮（后面只跟着定位轮时仍算它）。
  - 模型没输出时被停止：写多久没输出，按钮是「换模型继续」「继续」。模型接口出错：按 `errorKind` 写原因；密钥无效、找不到模型给「打开模型设置」，其余给「继续」「换模型继续」。上下文到上限给「压缩上下文」；检查卡住、门禁打回到上限、卡死、没调 finish 的主按钮是「定位问题」。用户自己停的给「继续」「定位问题」。主动暂停等待不显示。
  - 「换模型继续」（第 203 步）用输入框的模型菜单（只列模型，不出思考强度），选完切换模型、发「继续」。
- 定位问题（第 189 步）：一个新的轮次类型 `diagnose`，复用出计划的只读循环。用输入框当前的模型，带着主对话原文，再给一份这一轮的事实：怎么停下的、提示、每一步（编号 s1、s2……，结果截短，最多最后 60 步）、这一轮以来的改动（截短）、还没修好的检查错误。最多 8 步，只能 read_file、list_files、search、outline 核对文件的真实状态，最后调一次 `submit_diagnosis`。
  - 子智能体：工人自己的对话没有保存，定位它时用主对话加它记下来的步骤、任务、认领和交回的结果。
  - 交回原因、证据（引用 s 编号，界面对回那一步，点一下滚过去；卡片收着时滚到卡片）、做完和没做完的、修复提示词（只写哪里错了、接下来怎么做、别重做什么，不复述历史）、0–2 个只有用户能回答的问题。
  - 模型出错或步数到头时，给一份按记录拼的通用提示词（「上一轮停在了 X 之后（原因），请先确认文件的实际状态再接着做」），并提示定位失败的原因。
  - 用主模型而不是评审模型：对话前缀能命中缓存，又快又便宜，也看得懂上下文；主模型本身坏了就先「换模型继续」或换了模型再定位。
  - 定位轮存进历史、能停止、进度实时显示，「模型没有输出」的提示同样生效；探索过程不进编码模型的对话，不改文件、没有检查点、不能撤销。它不改变任务结论：顶栏、侧栏的结论跳过定位轮。被定位的那一轮仍保留「重新生成」，重新生成时定位轮一起撤掉。
- 定位结果卡（第 190 步）：修复提示词可以改；问题用和提示词优化同一个问题条；按钮是「填入输入框」「直接发送」「重新定位」。失败的子智能体卡片上也有「定位问题」。
- 填入输入框（第 191 步）：原来「附加终端内容」往输入框末尾追加文字的通道改成通用的（`composerInsert`），附加终端内容照旧追加；填入时输入框空着就直接填，有字就空一行接在后面，输入框底栏出现「撤销填入」，恢复原来的草稿，用户再改字就消失。不自动发送。

## 提示词优化（第 195–198、208 步）

- 输入框底栏的魔杖按钮：一次模型调用拿到改写稿和 0–3 个问题，改写稿直接替换草稿，问题出在输入框上方的问题条里。草稿为空、以「/」开头（命令）时不能点。
  - 改写：保留原意和语言，不加没要求的东西；需要时把目标、范围、约束、怎么检查写清楚，一句话的小需求保持简短。只能提上下文里出现过的文件，@附件原样保留（结果里少了附件就不替换）。
  - 问题（A+B 混合）：改写稿已经按最可能的答案写好，不用回答也能直接发。每个问题的第一个选项就是采用的答案，它的文字原样是改写稿里的一行；点别的选项只把那一行换掉，不再调模型；「其他…」可以自己写一句。那一行被手动改掉、找不到时，新答案接在末尾。
  - 上下文：项目顶层目录（最多 60 项）；任务里加最近 3 轮的提问和回复摘要（每段截到 600 字）和这个任务改过的文件；设计任务加风格预设。
  - 用「规划」角色的模型，没配就用输入框当前选的，再没有就用「编码」角色；90 秒超时；用量记成 planner。首页还没有任务时记在固定的 id（`prompt-enhance`）下，用量页写「首页的提示词优化」。
  - 替换后底栏出现「撤销优化」，回到优化前的草稿、收起问题条；换问题的答案不算手动改，撤销照样能用。等结果时用户又改了草稿就不替换，提示一句。
  - 不做：流式写进输入框、多档强度、优化后自动发送。
- 指定要调哪个工具（tool_choice 指定工具）被服务拒绝时改用 auto 再发一次（第 244–247 步）：DeepSeek 等模型在思考模式下不接受指定工具，直接回 400。用到指定工具的地方都这样处理：提示词优化的 submit_prompt，以及规划、定位问题、子智能体在最后一步或上下文快满时要求直接交结果。
  - 只认 400 且报错里提到 tool_choice 的情况；密钥、超时、限流等错误照常报。改用 auto 后模型可能不交结果，按各处原来「没交结果」的处理走。
  - 支持指定工具的模型行为不变；不支持的每次多一次被拒的请求，不记住「这个模型不支持」，免得服务端改了以后还一直绕开。

## 等外面的事做完：wait_command（第 209–215 步）

- 智能体推送后要等 CI、部署这类外部结果时调 `wait_command`：给一条检查命令和成功、失败的标记文字，按间隔反复执行，等待期间不调模型、不耗 token。等到了这一轮接着做。
  - 间隔至少 10 秒，默认 30 秒；最长等 180 分钟，默认 60 分钟；单次检查超过 120 秒算这次失败。上限防止一轮挂死，间隔下限防止把外部接口打爆。
  - 检查命令和 `run_command` 一样按权限模式确认，确认一次后整个等待期间不再问；用户随时可以停。
  - 卡片单独一行、默认展开，显示「第 N 次检查还没好 · 已等多久 · 多少秒后再查」，不收进「执行工具 N 次」。
  - 成功时记一条完成证据，和命令执行的回执一样进本轮结论。
- 只在主智能体里提供，子智能体不能用：子智能体是并行干活的，不该被一个长等待卡住。

## 待办（第 216–221 步）

- 侧栏「待办」：随手记想法，不用切到别的软件。Ctrl+J 在任何页面弹出快速记一条，记下时标上当前项目。
  - 待办页的输入框可以指定「固定项目」：列出当前已知的项目和任务目录，也可以「选择文件夹…」，不要求这个项目已经固定在侧栏里；记下后待办的项目标签和筛选都按它。记下之后也可以在待办行的「标签」里继续改。
  - 自定义标签：输入框和待办行都能加，Enter 或逗号确认，支持一次写多个；不区分大小写去重，最多 12 个、每个 30 字。列表上方的标签可以筛选，标签随待办一起存进 `todos.json`。
- 存在用户数据目录的 `todos.json`，整份读写（原子写入、排队）。上限 1000 条、每条 4000 字：个人记录的规模，整份读写够用。
- 一条或几条待办可以发给新任务或已有任务：先汇总成一条消息，可以用提示词优化改写（改写不满意可以撤销），可以只填进输入框不发。发出后待办记下派给了哪个任务（`sentTo`）。
- 待办验收：派出去的任务到达「已完成」「已完成 · 已验证/未经自动验证/没有改动」后，待办行标「任务已完成，待验收」，对话底部同时出现验收卡片，列出这个任务派出的待办。
  - 卡片上可以逐条「验收并完成」或「全部验收」；待办行上也有「验收」。验收把待办标为完成并记下 `acceptedAt`，待办从待办列表移到「已完成」，对话里的卡片同步消失；再次取消完成会清掉验收时间。
  - 任务出错、停止、受阻或还在跑时不显示验收；验收只同步待办数据，不改任务结论。
- 不做（v2 再说）：标签分组和嵌套、同步到别的设备。v2 已做嵌套标签和局域网同步，见「重复、嵌套标签、日历拖动、局域网同步（v2 · M8）」。

### 定时、列表分组和日历（第 248–257 步）

- 待办可以定一个时间（一次性）：到时只提醒，或者到时把一段话发给新任务或已有任务。时刻按 UTC 存（`schedule.at`），按本机时区显示和分组。
  - 记的时候在输入框（含 Ctrl+J）旁边先定提醒时间；定时发送在记下以后从那一条上设，复用派给任务的弹窗（可以改内容、优化），只给一条待办设，免得几条各发一遍。
  - 快捷时间：1 小时后、今晚 20:00、明早 9:00、下周一 9:00（已经过了的不列），也可以自己选日期和时间。
- 到点的处理放在界面里，不放主进程：待办只由界面写，没有两边抢着存的问题；关窗口应用就退出，界面在就等于应用在。按最近的到期时间排计时器，最长 30 秒查一次，兜住电脑睡眠和改系统时间。
  - 提醒：Windows 系统通知，点通知回到待办页、定位到那一条。打包版设 AppUserModelId（`dev.diffra.desktop`，和安装包一致），开发版不设，免得和装好的 Diffra 混在一起。
  - 定时发送：在后台建任务或给任务发消息，不切走正在看的页面；发完记下派给了谁，通知一声。失败（任务删了、项目不在了）记下原因。
  - 应用没开着时到点的：提醒不补弹通知，标逾期；定时发送不自动补发，标「错过了定时发送」，等用户点「现在发送」或「取消定时」。开着但晚了 10 分钟以上（比如电脑睡着了）的定时发送也一样处理：晚了几小时再自动开工，可能已经不是用户要的。
  - 处理结果记在 `schedule.result`（reminded、sent、missed、failed），改了时间就清掉，算新的一次。
- 列表按 逾期、今天、明天、本周、以后、未定时间 分组，已完成收在最后；侧栏「待办」在有到期的待办时多一个点。项目筛选和标签筛选可以一起用。
  - 列表和日历同宽（64rem），每组一张卡片，每行左边一列时间（钟点、日子两行，也是改时间的入口）。宽窗口（lg 以上）右边一栏：逾期、今天、7 天内的条数，迷你月历（有待办的日子带点，点了到日历视图的那天），「接下来」最近 5 条；窄窗口收回单列（第 258–261 步）。
  - 通知上的应用名和图标由 Windows 按 AppUserModelId 找开始菜单快捷方式决定：打包版显示 Diffra（已在通知中心确认）；开发版用 electron.exe 跑，显示 Electron，不为它注册快捷方式。
- 日历按月显示（周一开头，固定 6 周），每格最多列 3 条，多的写「还有 N 条」；点某天在右边看这天的、给这天加一条（今天默认下一个整点，以后默认 9:00，过去的日子不定时间）；没定时间的列在右边。日历自己写，没加日期库。
- 标题、正文、优先级（第 485–494 步）：
  - 存法：`text` 仍是标题，新加选填的 `body`（正文）和 `priority`（0–3，界面写 P0–P3，没设是没有这个字段或 null）。字段名不改、新字段必须选填：主进程读 `todos.json` 时校验不过会按空列表打开、下次保存覆盖原文件，改名或加必填字段会让旧版 Diffra 把待办清空。旧版读到新文件会丢掉不认识的字段（正文、优先级），待办本身还在。
  - 旧数据（没有 `body`）显示时第一行当标题、其余当正文（`shared/todos.ts` 的 `todoParts`），不批量改写文件；用对话框编辑过一次后按拆开的存，`body` 可以是空字符串。
  - 添加：快速记那一行照旧，旁边「详细添加」打开对话框（`TodoEditorDialog`）：标题必填（200 字）、正文、优先级、标签、项目、提醒时间，已经输入的字和选好的项目、标签、时间带过去。编辑也用它（双击标题或「编辑」），原来双击就地改字的方式去掉了。已经定时发送的待办在对话框里只能改时间、取消，发给谁、发什么不变；新设定时发送还在那一行上。
  - 快速记（待办页输入框和 Ctrl+J）开头写 `p0`–`p3` 加空格设优先级，大小写都行，只认开头；输入框里马上显示识别出的标记。
  - 标签输入框有焦点时，下面列出已有的标签（按输入过滤，最多 12 个），点一下就加上；输入框、待办行、对话框都一样。
  - 列表：标题一行（超长省略），正文最多两行，点一下展开全文。有优先级的在标题前加标记：P0 用 destructive、P1 用 warning、P2 和 P3 用中性色。同一组里 P0 在前、没设的最后，同一优先级里照旧（有时间的按时间，没定时间的新记的在前）。筛选多了一组优先级（只列出用到的几档和「未设优先级」），和项目、标签筛选叠加，日历视图也按它筛。
  - 派给任务发的是标题、空一行、正文，不带优先级；几条一起发时正文缩进在各自标题下面。定时发送在设的时候就定下了要发的内容，之后改标题、正文不影响它（和以前一样）。提醒通知的正文是标题加正文，其余通知只写标题。
  - 架构页「派到待办」：架构给的一句话当标题，生成的提示词当正文。
- 不做（v2 再说）：重复待办、托盘常驻和开机自启（应用关着时不能提醒）、日历里拖动改日期。v2 已做：托盘和开机自启见「托盘和开机自启（v2 · M7）」，重复和日历拖动见下面「重复、嵌套标签、日历拖动、局域网同步（v2 · M8）」。
- 附件（第 638 步）：快速记的输入框能粘贴、拖进图片和文件，编辑对话框还能用按钮选；列表那一行标附件数，点开看缩略图和文件名。
  - 存法和输入框一致：图片先缩成长边 1600 的 WebP，存到数据目录 `todo-attachments/<id>.webp`，`todos.json` 里只记 id（`images`）；文件只记路径（`files`），不复制内容，同样不许加 `.env` 这类可能含密钥的文件。上限也和一条消息一样：图片 6 张、文件 20 个。两个字段都是选填，旧版读到会丢掉附件，待办本身还在。
  - 图片不按待办分目录，平铺按 id 存：新建待办时对话框还没存，没有待办 id。删了待办、移除了图片留下的文件，在下次保存待办时清掉，只清没有哪条待办用、又放了一天以上的，免得把对话框开着时刚加、还没保存的图片删掉。
  - 派给任务时一起发：发送、定时发送都把图片作为提问图片、文件写成路径引用；填进输入框时变成输入框里的附件和 @ 提示。几条一起派时附件合并，超过一条消息的上限就不发、提示数量。模型没开「视觉」时由 core 拒绝并说明去哪里开（和输入框的提示一样）。
  - 定时发送的附件按到点时待办上的为准，不在定时时复制一份。

### 重复、嵌套标签、日历拖动、局域网同步（v2 · M8）

- 新字段都是选填（`shared/todos.ts`）：`schedule.repeat`（`every` 是 day / weekday / week / month，`interval` 隔几个周期，`start` 第一次的时刻）、`schedule.last`（上一次是做完还是错过）、待办的 `updatedAt`。`todos.json` 的版本号不变；旧版读到会丢掉这几个字段，待办还在、变回一次性的。
- 重复：编辑对话框定了时间才出「重复」（不重复 / 每天 / 每个工作日 / 每周 / 每月），从这次定的时刻算起。下一次按本机时区从 `start` 推（`nextOccurrence`），钟点跨夏令时不变；每月按第一次的日子，31 号在小月落到月底、下个月回到 31 号；隔很久再算也不一个个试。
  - 勾完成只完成这一次：待办不进「已完成」，提醒挪到下一次，`last` 记下做完；到点处理完（提醒弹过、定时发送发出或失败）也挪到下一次，`last` 记下这一次的结果；应用没开着时错过的不等用户补发，直接跳到下一次。列表那一行多一个「每天」这样的标记，悬停看上一次。
  - 不做：自定义规则（每月第几个周几、截止日期、次数）、按完成时间重新起算。
- 嵌套标签：标签里的 `/` 分层（`工作/项目A`），每层去空白、去掉空层。筛选栏第一层一直列出，选中某层后展开它下一层；选上一层时下面各层的待办都算。旧版看到的是一个带斜杠的普通标签。
- 日历拖动：日历格里的待办、右栏「未定时间」的行都能拖到某一天；有时间的保留钟点只换日子，没定时间的定在那天早上 9 点；重复的跟着把 `start` 挪过去。只做按天拖，不做按钟点拖（日历没有时间轴）。
- 局域网同步（接口版本 3，`todos.sync`）：配对时或在「允许连接本机」的授权里勾「允许同步待办」（和项目授权分开），连接端在已添加的设备上打开「同步待办」，两边都同意才同步。
  - 合并：同一条按 `updatedAt` 取新的（一样新留本机的），两边各自新加的都留；删除记墓碑（`todos-sync.json`，和 `todos.json` 分开，旧版不受影响），墓碑晚于最后一次改动才删，留 90 天。界面改待办时给改过的那几条盖上 `updatedAt`。
  - 主进程也会写待办了（以前只有界面写）：界面存的时候带上改之前手里有哪些（`base`），主进程据此分清界面删掉的和其间同步进来的，合好写盘，和界面手里的不一样时推给界面换上（`todosChanged`）。没传 `base` 的旧界面照旧整份覆盖。
  - 什么时候同步：连接端打开开关时、对方上线时、本机改了 2 秒后、每 30 秒一次；被连接端改了会发 `todos.changed` 通知连着的连接端马上来同步（旧版不认识这个事件，丢掉，照样定时同步）。
  - 不同步的：定时发给任务的待办（发给哪个本机任务，换台电脑没意义），图片附件（只在记下它的电脑上，对方收到的去掉本机没有的图片）。文件附件只同步路径。对方发来的每条都按本机的格式校验，不对的丢掉，最多 1000 条。
  - 到点提醒还是各台电脑自己弹；同一条重复待办两边都开着时，谁先处理谁的「下一次」生效（改得晚的赢）。
- 验证：`scripts/todos.test.ts`（按纽约时区跑，覆盖夏令时）：每天、隔两天、每周、工作日、每月 31 号、隔三个月的下一次；闰年 2 月（31、30、29 号开始的每月在闰年落到 29 日、平年 28 日，隔 12 个月的 2 月 29 日平年落到 28 日、下一个闰年回到 29 日，每天和每周跨过闰日不跳天）；嵌套标签的规整、匹配和标签树；合并时取新的、两边新加都留、墓碑早于改动不删；墓碑去重和过期；定时发送不同步。e2e `todos-v2.spec.ts`：编辑设成每天、行上标「每天」、勾完成挪到再下一天且没进已完成；标签分层展开和筛选；日历里拖动保留钟点、未定时间的拖进去定 9 点（都核对 `todos.json`）；两个实例局域网配对时允许同步待办、连接端打开开关后两边合在一起，被连接端新加的 10 秒内到连接端（靠通知，不等 30 秒），连接端删的被连接端也删并记墓碑，定时发送的不过去，关掉开关后不再同步。现有待办 e2e（`todos`、`todo-schedule`、`todo-attachments`、`todo-acceptance`）和 `devices-lan.spec.ts` 照常通过。没在两台真电脑上试过同步。

## 架构（第 320–340 步）

- 侧栏「架构」：主界面是项目卡片（语言占比、文件和行数、包数、循环依赖、目标架构的违规和差距、应用架构图的迷你分层图），点进去看一个项目。项目列表单独存，不再只从「有过任务的文件夹」推出来；卡片页下面列出最近用过、还没加进来的项目，一点就加。
- 新加的依赖：`@ast-grep/lang-go`、`lang-rust`、`lang-java`（和 lang-python 同一系列，带各平台的预编译解析器，`allowBuilds` 设为 false，列在 core 和桌面端的 `dependencies` 里，打包时由 electron-builder 解到 asar 外面）；界面用 `@xyflow/react`（锁 12.12.0，装的时候最新版才发两天）和 `@dagrejs/dagre`（MIT）。React Flow 的角标用 `proOptions.hideAttribution` 隐藏，MIT 许可允许。
- ast-grep 的动态语言整个进程只能注册一次（第二次调用不报错，但新语言不生效），Python、Go、Rust、Java 在第一次用到任何一种时一起注册（`packages/core/src/syntax.ts`）。

### 分析在本机做（core）

- 引擎在 `packages/core/src/architecture/`：rg 列文件（遵守 `.gitignore`）→ 读清单（package.json、pnpm 工作区、go.mod、Cargo.toml、pom.xml、build.gradle、pyproject.toml、setup.py/cfg）→ ast-grep 提取每个文件的 import、导出和符号（TS/JS/Vue/Python/Go/Rust/Java）→ 把导入解析到文件 → 建文件级依赖图、目录树、外部包 → 读最近 180 天的提交算改动频率。其他语言只统计文件和行数。
  - 依赖解析：TS/JS 认相对路径、`.js` 对 `.ts`、目录 index、tsconfig 的 `paths`/`baseUrl`（跟相对路径的 `extends`）、工作区包和它的 `exports`（指向 dist 时换成 src 再找）；Python 认相对导入、项目根和 `src` 根、找不到时从文件所在目录往上找顶层包；Go 按 go.mod 的模块路径对到目录；Rust 按 `mod`、`crate::`、`self::`、`super::` 和工作区 crate 名；Java 按 package 和类名，同包的类不 import 也算（按文件里出现的类型名对）。对不上的项目内导入列在概览里。
  - tsconfig 的别名按所在目录分组，一个文件只试管得到它的那几份 tsconfig、近的先试、前缀长的先试。大仓库里几百份 tsconfig 继承同一份 paths，摊平成一张表（实测 4.4 万条）逐条试，2 万个文件要十分钟以上；分组后 0.6 秒。
- 上限：最多 2 万个代码文件（超过时优先留能深度解析的语言），单个文件超过 512 KB 跳过，一行特别长、平均行长很大的当压缩产物跳过；依赖图一层最多画 120 个节点，小的并成「其余 N 项」。
- 和计划的出入：没用 worker 线程。分析在 core 的事件循环里分片跑（每做 12 毫秒让一次），不用另打一个 worker 入口，也不用担心 ast-grep 原生模块在 worker 里的加载；正在跑的任务照常输出。实测 diffra 本仓库（453 个文件）最长卡 24 毫秒；一个 4.5 万个代码文件的大仓库（取 2 万个、530 万行）首次 35 秒、最长卡 0.56 秒，增量 4 秒。
- 增量：解析结果按文件的大小和修改时间缓存（`cache.json`），重新分析只解析改过的文件。是否过期按指纹判断：git 仓库是 HEAD 加工作区状态加改动文件的修改时间，否则是所有代码文件的路径、大小、修改时间；卡片页在后台判断，不挡显示。
- 数据都在用户数据目录的 `architecture/` 下：`projects.json`，每个项目一个目录放 `analysis.json`、`cache.json`、`summary.json`（卡片页用的小摘要）、`interpretation.json`、`diagrams.json`、`target.json`、`layout.json`（v2 加了 `runtime.json`，最近一次运行时追踪）。不往用户的仓库里写文件；v2 的「导出到仓库」是用户点了才写，写在项目的 `.diffra/` 下。从列表移除只删列表里的一条，目标架构这些留着，再加回来还在；删目标架构是把文件改名留底，不直接删。
- 分析和模型调用在后台跑，进度、结束和失败用 ACP 通知 `_diffra/architecture/event` 推给界面（core → 主进程 → 界面），一个项目同时只跑一件事，可以取消。

### 三张架构图（分层方块图）

- 主视图是分层方块图，照常见的架构文档画法：横带从上到下，左边是层名，带里是分组和方块，上下两层之间的箭头上写怎么通信，右边竖栏放跨层的东西（日志、配置、安全、测试、构建）。有三张：应用架构（模块，方块认领代码路径）、技术架构（框架、库、协议，方块对应外部包）、系统架构（使用者、进程和部署单元、外部服务）。
- 分析完马上有一版按规则排的图，不调模型：应用架构按顶层的包或目录的依赖关系分层，下一级目录是方块；技术架构把外部包按用途分层（界面、应用框架、模型与 AI、通信、数据、代码处理、通用库、其他），语言和自带的库在最底下，构建和测试工具在右边竖栏；系统架构是使用者、各个包、按用途归的外部服务。每次重新分析都重排这一版，手改的方块留着。
- 「让模型画」：三张图各一次模型调用（加上系统简介和流程一次，共四次），用「规划」角色的模型，没配用「编码」；一起点时并行跑，每样做完就存，一样失败不影响别的。只给模型一份压缩过的结构摘要（目录、目录之间的依赖、关键文件的符号、清单、README、外部包），系统架构图另外带上构建和打包配置的开头，不发整份代码。模型给的代码路径和外部包逐条和分析结果核对，对不上的去掉，一个都对不上的方块标「对不上代码」。用量记在 `architecture` 名下，用量页显示为「架构页的模型解读和画图」。
- 手改：编辑模式里拖动方块换组、换层、进竖栏，双击改名，加删方块、分组、层和竖栏，在右边改说明、类型、认领的代码和外部包。改过的方块、分组、层标成手改（`pinned`），重新生成时原样保留：新图里同名的方块，或者认领的代码一模一样的方块（用户改了名的同一个模块），都让位给手改的。
- 方块上的文件数按「最具体的认领」算：几个方块都认领一个文件时，归通配符前面固定部分最长的那个，一样长时不带通配符的优先。图上的数字、右边的详情、依赖图下钻都用这一个口径。
- 选中方块时，实线框标出它依赖的方块、虚线框标出依赖它的，其余变淡（编辑时不淡化）。双击认领了代码的方块进到它内部的依赖图；技术、外部系统这类方块双击后留在图上选中，右边列出用到它的地方。图里不能选中文字，免得双击时把字标蓝。可以「适合窗口」缩到一屏，导出 PNG（截的是窗口里显示的那块，所以先缩到一屏再截）。

### 详情页

- 标签：架构图（应用 / 技术 / 系统）、概览（模型写的简介、技术栈、入口、建议的阅读顺序、外部系统、关键数字）、依赖（依赖图、依赖矩阵、循环依赖、外部包）、流程（模型给的关键流程，画成时序图，每一步的代码位置核对过）、热点（代码行 × 改动次数 × 耦合度，各取对数）、目标架构。
- 依赖图是架构图的下钻层：方块 → 它认领的目录和文件 → 文件里的符号（谁引用了哪个符号、它又依赖什么）。范围外的代码画成灰色节点：从方块进来时按应用架构图的方块分组，按目录进来时按共同上级的下一级目录或包分组。点线看背后的每条 import，点行号在弹窗里看代码并停在那一行。拖过的节点位置按范围记住；选中节点时工具栏不换行、节点用固定尺寸，免得画布跳动导致双击点空。
- 当前视图、范围、选中的东西都写在路由里，前进后退、面包屑都能回到原处；只换选中的东西不记后退。
- 右边一栏一直在：选中东西时是它的详情，没选中时是当前视图的概况（架构图各层有哪些方块、依赖图当前范围的统计、目标架构的规则和差距）。宽度可以拖（260–720 像素，双击恢复），可以收起，宽度和收起状态存在本机。

### 目标架构

- 目标架构 = 一张应用架构图 + 依赖规则，和现状用同一种方块图画：可以从现在的应用架构图复制、从空白开始，或者让模型按原则提方案（按层、方块、规则逐条列出新增、删除、修改，勾选要的再保存）。在图上编辑，规则单独一栏，改一项存一项。
- 规则：带代码路径的方块是组件，层取它所在的横带；右边竖栏里的方块不分层，谁都能用；项目外的系统不算组件。可以要求只依赖同层或下层（可选严格到只能依赖紧挨着的下一层）、组件之间不许循环依赖、某个方块不许依赖另一个、分层规则的例外、某个外部包只许哪些方块用。
- 对比：现状叠在目标图上，方块上是认领到的文件数，有违规的方块红框带条数，还没有代码的方块是虚线「计划中」；差距清单列违规的依赖（到 文件:行）、计划中的方块、没被认领的目录。违规和计划中的方块能「生成重构任务」（打开这个项目的首页，把说明填进输入框，用户看过再发，不直接开跑）或「派到待办」（带「架构」标签）；没认领的目录直接选一个方块归过去。
- 任务里的架构检查：完成前，在检查命令、安全检查和规范审查之后，只看这一轮新增的行里的 import，按目标架构判断，已有的违规不算在这一轮头上。违反就出「架构检查」卡片并打回；确实需要的依赖可以在那一行或上一行写 `diffra-allow architecture: 理由` 放行。需要检查点（拿这一轮的改动）；检查本身出错时只在卡片上说明，不拦截。目标架构里可以关掉「任务里检查」。

- 不做（v2 再说）：函数级调用图和运行时追踪；这 7 种以外的语言的依赖；实时监听文件变化（打开时判断是否过期、按需重新分析）；把架构定义导出到仓库、和团队共享；任务里的智能体直接查询架构图的工具。v2 都做了，见下一节。

### 架构的 v2 部分（v2 · M9）

- 函数级调用图（`architecture/calls.ts`）：解析时顺带记下每处调用的被调名、前缀（`a.b()` 的 `a`，`this`/`self` 统一记 self，看不出是谁的记 `?`）和行号（`FileFacts.calls`），谁调的按行号落在哪个函数里算。分析时对到项目里定义的函数和方法：本文件的函数、import 进来的名字、命名空间或模块前缀（`import * as ns`、`import x as y`、Go 的包名和别名、Python 的模块名、`const x = require()`）、类名前缀的静态方法、`this`/`self` 调本类的方法、Java 不带前缀调本类方法、Go 同一个包的函数、CommonJS 解构的 `require`。通过变量、回调、继承和接口分派的调用对不上，不猜。结果存在 `analysis.calls`（最多 10 万条，每条记前 20 个行号）；TS/JS/Vue/Svelte、Python、Go、Rust、Java 有，按行提取的语言没有。以前的缓存没有调用，第一次分析时重新解析一次。
  - 界面：依赖页里文件那一层下面多了「函数调用」：列出有调用关系的函数（被调用/调用的个数），选一个看谁调了它、它调了谁，宽的时候三栏、窄的时候竖排；点别的函数换成以它为中心（别的文件的跳到那个文件），选中的函数记在路由里（`symbol:名字`）。没用 React Flow 画：右侧面板开着时内容区只有四百多像素宽，画布缩到看不清。
- 运行时追踪（`architecture/trace.ts`，「运行时」页）：用户填一条命令（默认有 test 脚本就是 `npm test`/`pnpm test`，Python 项目是 `python -m pytest -q`），在项目目录里用 bash 跑，最长 30 秒到 10 分钟，可以取消（连同子进程一起结束），临时目录跑完就删。Node.js 经 `NODE_OPTIONS` 开 V8 的 `--cpu-prof`（npm、测试框架起的子进程都带上），按采样算每个函数的总时间和自身时间，调用栈上相邻的两个项目函数记一次调用（中间隔着依赖的也算）；Python 在 `PYTHONPATH` 前面放一个 `sitecustomize.py`，用标准库的 cProfile 记调用次数和按调用方分开的时间，只留项目里的文件。别的语言不支持；被强行结束的 Node.js 进程不写采样，说明里写清楚。
  - 只算项目里分析过的文件，按行号对到分析出来的函数；项目根经过链接（Windows 的目录联接、macOS 的 /tmp）时两边都按真实路径对；模块顶层的代码单独记 (module)。结果存 `runtime.json`：最花时间的函数（最多 2000 个）、运行时的调用（最多 5000 条），标出静态调用图里没有的（回调、动态分派、经过库的调用），列出这次没运行到的文件。和分析共用「一个项目同时只做一件事」，进度和结束走同一个事件。
- 更多语言（`architecture/extract-lines.ts`）：C、C++、C#、Kotlin、Scala、PHP、Ruby、Swift、Dart 没有 ast-grep 的解析器（要加依赖），按行认 import 和类、函数的声明：先去掉注释、把字符串内容盖掉，再数花括号算声明的范围和方法属于哪个类型（Ruby 按同样缩进的 `end`）。Svelte 和 Vue 一样只看 `<script>`。依赖的对法：C/C++ 引号的先找同目录、再按路径后缀找（include 目录），尖括号的系统头文件算自带、库按第一段归；C# 的 `using` 命名空间只连文件里真用到的类型所在的文件，同一个和上级命名空间不用 using；Kotlin、Scala 和 Java 一样按包名加类名，Kotlin 的顶层函数也认；PHP 按命名空间加类名（PSR-4 的项目都这样声明）和 `require` 的路径，类里的 `use` 是 trait 不算；Ruby 的 `require_relative` 按路径、`require` 按 lib 下的路径；Swift Package 按 `Sources/<模块>/` 分模块，import 本项目模块只连用到的类型，同模块的文件互相直接用；Dart 的 `package:本项目` 对到 `lib/` 下。外部包多了 native、nuget、composer、gem、swift、pub 几种来源，技术架构图最底层各有一块「自带的库」。以前只统计行数的这些文件第一次分析时会重新解析。
- 实时监听文件变化：打开着一个项目时 core 用 `fs.watch` 递归盯着项目文件夹（同时最多 4 个，界面离开项目时关掉，core 退出时全关），只看代码文件和清单，跳过 node_modules、.git、dist、build、target、vendor 这些目录；改动停下 0.8 秒后按指纹核对一次（.gitignore 里的、只碰了时间的不算），真变了推一个过期事件，项目页标「代码已变」。「自动更新」开关（默认关，记在 `projects.json` 的项目上）开着时改动停下 1.5 秒后自动重新分析（增量），正在分析或解读时等它完。监听出错时停掉，开关变灰，退回打开项目时判断一次。Linux 上递归监听要为每个目录占一个 inotify，大仓库可能不够用，没试过。
- 导出到仓库、和团队共享（`architecture/share.ts`）：项目页「更多操作」里「导出到仓库」，确认后写项目根的 `.diffra/architecture.json`（三张架构图和目标架构，给 Diffra 读）和 `.diffra/architecture.md`（每张图一段 Mermaid 加方块清单、目标架构的规则写成中文，给人看），已有的覆盖。打开项目时读仓库里那份：和本机的不一样（只比方块、层、连线和规则，生成时间和指纹不算）就在顶上提示，「用仓库里的」确认后换掉本机的架构图和目标架构，本机原来的改名留底；格式不对（比如更新版本导出的）只显示原因。不自动导入，也不自动导出。
- 任务里的智能体查架构图（`session/architecture-tool.ts`）：项目在架构页分析过才给 `architecture` 工具（列工具时只看 `analysis.json` 在不在），只读，用最近一次的结果：概览（包、目录和它们之间的依赖、循环依赖、目标架构的状态）、文件或目录的依赖和被依赖（到行号）、符号、按名字找定义、两处之间最短的依赖链、目标架构的违规（到 文件:行）、函数的调用和被调用、最近一次运行时追踪的摘要。结果是给模型看的英文纯文本，最多 1.2 万字，路径一律相对项目根。卡片标题写「查架构：动作 对象」。
- 验证：core 的 `architecture-calls.test.ts`（各语言的调用处提取、require 的名字、TS/Python/Go/Java 的调用对法、查询的每个动作）、`architecture-tool.test.ts`（没分析过不给工具，分析过后脚本模型调工具拿到依赖和调用）、`architecture-more-languages.test.ts`（九种按行提取的语言加 Svelte 的依赖、外部包、符号和范围，再分析一次全用缓存）、`architecture-watch.test.ts`（真实文件改动：代码改了推过期、node_modules 里的不算、关掉后不推、自动更新时重新分析并记进项目列表）、`architecture-share.test.ts`（导出两份文件和 Mermaid、另一个数据目录导入后一样、备份留着、格式不对时说明）、`architecture-trace.test.ts`（真跑 Node.js 和 Python：函数、调用、调用次数、模块顶层、超时、取消）。e2e：`architecture.spec.ts` 加了函数调用图（点被调函数跳到它的文件）和任务里智能体调 `architecture` 工具；`architecture-languages.spec.ts` 加了 C#、Ruby、C；`architecture-watch.spec.ts`、`architecture-share.spec.ts`（两个数据目录模拟两台电脑）、`architecture-runtime.spec.ts`（默认命令、函数表、运行时才看到的调用、跳到文件）。没在大仓库上量过调用图和监听的开销，Linux 和 macOS 上的递归监听、Python 虚拟环境里的追踪没试过。

## 模型菜单：思考阶梯（第 233–235 步）

- 模型和思考强度放在一个面板里。思考强度画成一排由低到高的阶梯（默认、低、中、高……按模型支持的档位），触发按钮上有缩小的阶梯，一眼看出当前档位；不用滑块，档位本来就是离散的。
- 模型超过 8 个时出搜索框，少的时候不占地方。

## 对话里的可视化：show_visual（第 237–243 步）

- 智能体可以在对话里画图表、示意图、小交互（`show_visual`，传一段 HTML 或 SVG），解释比纯文字清楚时用。
- 安全边界：放在 sandbox iframe 里（`allow-scripts allow-modals`，不给 `allow-same-origin`），拿不到主界面、`window.diffra` 和本地文件；页面是单独的入口 `visual.html`，有自己的宽松 CSP，允许联网、加载 CDN 脚本，效果优先。主窗口的 CSP 和导航限制不放宽，只额外允许 iframe 导航到 `visual.html`。
  - 里面的链接不直接打开，先在卡片下方问用户：用内置浏览器、系统浏览器，还是不打开。
  - 可视化里的按钮可以把一段话填进输入框（`diffra.fill` / `sendPrompt`），只填不发，发不发由用户决定。
- 配色通过 CSS 变量传进去（`--bg`、`--fg`、`--primary` 等），跟着亮暗主题走。
- 可以放大看、看代码、存成 HTML 或 PNG。PNG 由主进程截 iframe 所在区域。
- 工具箱（第 666 步，`features/task/visual-kit.js`，按 `?raw` 读成文字跟在运行时后面写进 iframe，不联网、版本固定）：
  - `diffra.chart(type, data, options)`：柱状、折线、面积、饼、环、散点，自己画 SVG（不把 ECharts 塞进每张可视化），颜色取 `--chart-1..4`，坐标轴和网格用 `--muted`、`--border`；点图例切换系列，悬停看数值。
  - `diffra.ui.card / stat / badge / tabs / progress / grid / table`：返回元素，样式只用主题变量。字符串按文字放，不当 HTML。
  - 交给主界面的动作仍是白名单：`fill` / `ask`（填进输入框，不发）、`copy`（最多 10 万字）、`openFile(path, line)`（主进程查过在项目里才开，远程和只读会话里没有）、`openBrowser(url)`（和点链接一样先在卡片下面问）。
- 预设（第 667 步）：`show_visual` 可以给 `preset` 加 `data` 代替 `code`：compare、timeline、chart、mockup、flow、cards。core 按每种预设的 schema 校验（AI SDK 用同一份 schema 先校验，不合法时模型拿到哪个字段不对、能填什么），生成 `<script>diffra.preset(名字, 数据)</script>` 存成 code（数据里的 `<` 换成 `<`），之后的看代码、另存、远程占位都不变。工具说明改成先用预设。
- 版本（第 668 步）：同一个任务里同名的可视化按出现顺序算几版。每张卡片能切到别的版本（只换这张卡片里显示的）、和上一版并排对比、在旧版上「从这一版接着改」（填进输入框，写明第几版；模型的上下文里有那一版的代码）。
- 可视化白板（第 668 步）：卡片上「固定到白板」放进右侧栏的「可视化白板」，一列或两列并排看；只在内存里，退出应用就没了。这个任务固定了东西（或白板开着）时顶栏才有它的按钮。
- 演示模式（第 669 步）：铺满窗口、没有工具栏；页面里带 `data-step` 的元素按 →、空格、PageDown 一步步出现，←、PageUp 退回，Esc 结束。演示时页面里的链接不打开。
- 快照（第 670 步）：本机画好后截一次图记进会话，远程设备看这张图，不跑脚本。
  - 什么时候截：高度 1 秒没再变、整张露在窗口里没被挡住（四角和中心都点到这个 iframe）、鼠标不在上面、窗口显示着；截的时候位置变了就作废，下次再截。比窗口还高的截不全，不截。放大、看代码、对比、演示、看别的版本时不截。只截这张卡自己那一版，一张卡只记一次。
  - 怎么存：主进程 `capturePage` 截成 PNG（`visual:capture`）。主进程解不了 WebP，所以由界面用 canvas 压成宽最多 1200 的 WebP，依次降质量、再缩小，压到 20 万字（base64）以内，压不下就不记。经 `_diffra/visual/snapshot` 交给 core，core 校验类型（WebP、PNG、JPEG）和大小，追加一条 `tool_call_update`（`_meta.diffra.visualSnapshot`，按 ACP 的图片内容存）到画它的那一轮末尾（那一轮可能早已结束），推给界面并存盘。
  - 存盘不改会话的更新时间（`toRecord(false)`），免得打开旧任务看一眼就把它顶到列表最前。
  - 界面和连接端收到这条实时更新时，找到那张卡所在的轮次再记，不记到最后一轮，不然最后一轮会凭空多一张卡。
  - 快照是截图那一刻的主题，之后换主题不重截。
  - 远程：用户定的，压缩后同步给授权设备。这改了第 377 步「工具输出里的图片换占位」的约定，只对可视化快照。脱敏时只认合规的小图（类型、不超过 20 万字、base64），一轮合计超过 160 万字的换成占位（一页至少一轮，免得超过单条消息的上限）；路径替换不碰它的 base64。连接端有快照就显示图片，能放大、另存为 PNG，没有演示；没有快照的照旧显示「可视化内容未同步」。
  - 没做：本轮报告导出的 Markdown 不带快照；旧任务里没打开看过的可视化没有快照。
  - 第 671 步修的：「画好了」的计时器以前在消息监听重建时清掉。监听依赖 `answer`，回答还在输出时一直重建，内容不再变高就再也等不到「画好了」，这张图不截快照。现在只在卸载时清。
- 卡片拆成 `VisualFrame`（一个 iframe 和它的白名单消息）和外面的卡片，对比、白板、演示都用同一个 `VisualFrame`。
- 第 666–667 步顺带修的：
  - 主题变化看真正生效的主题（`rich/theme.ts` 的 `useThemeKey`），不看设置里的 appearance 对象。以前跟随系统切深色时可视化不换色；存别的设置（开关侧栏会存布局）时可视化无故重载、状态丢掉。
  - 高度按 body 自己的高度报、盯 body 的大小：以前报 html 的 scrollHeight（不会小于 iframe 当前高度，内容变矮后留空白），也只盯视口大小（内容后来变高不再报，出滚动条）。iframe 里一直留滚动条槽位，免得出不出滚动条让按宽度缩放的 SVG 高度来回变。

## 静态渲染、导出和分享（第 671 步起）

- 统一静态渲染（第 671 步，`features/task/static-html.tsx`）：导出、分享不另写一套渲染，用对话里同一套组件在屏幕外画一遍（和对话列一样宽，图表按宽度画），等 DOM 0.5 秒没变、也没有还在加载的块（`aria-busy`）就取出 HTML，最多等 15 秒。远程设备本来就按同一份数据用同一套组件渲染，所以「同一套块渲染到对话、导出、远程、分享页」都落在这一套组件上。
  - 组件靠 `StaticContext`（`static-context.ts`）知道在静态渲染：可视化用快照（没有快照的写明「在 Diffra 里打开才能看」），每一轮的操作栏不画。画的时候按只读会话（`StaticTurns`），作用于本机的按钮本来就不显示。
  - 取出来之后：只有图标的按钮去掉（静态页里点了没用，带字的留着当说明），iframe、脚本去掉，画布换成图片。
  - 单文件：样式是应用此刻加载着的样式表（打包后的 file:// 页面也读得到 `cssRules`），主题照抄 `<html>` 上的 `.dark`、`data-palette`、`data-font`、`data-width` 和内联变量，所以导出的深浅色、配色、字号和当时一致。CSP 只放内联样式和 data: 图片，不跑脚本、不联网。
  - 公式：KaTeX 的字体在应用的资源目录里带不走，静态页改用浏览器自己排的 MathML（KaTeX 同时输出了这一份）。
  - 入口：每一轮操作栏的「导出这一轮」，存成单文件 HTML（第 678 步再加 Markdown、PDF、图片和整个任务）。
  - 已知：快照是截图那一刻的主题，深色导出里浅色时截的快照仍是浅色。
- 导出（第 678 步，`features/task/export.tsx`）：每一轮的「导出这一轮」和任务菜单的「导出整个任务」都有 Markdown、HTML、PDF、图片四种。
  - HTML、PDF、图片都从统一静态渲染来；PDF、图片由主进程（`main/export-ipc.ts`）先弹保存框，再在看不见的窗口里打开那份 HTML（临时文件，用完删）：PDF 用 `printToPDF`（A4、带背景）；图片 900 宽、按整页高度截一张，用离屏窗口——普通窗口的高度会被系统限制在屏幕大小，截不全。超过 16000 像素只存前面，提示改用 PDF。导出窗口不能开新窗口、不能跳走。
  - Markdown 从数据拼：标题、提问（引用）、回答原文（富块照样是围栏，能在别处再渲染）、可视化快照（data: 图片，没有快照的写明）、过程步骤的标题（最多 30 条）。
  - 远程任务页没有任务菜单，只能导出一轮。
- 分享版（第 679 步，用户定的推荐做法）：导出菜单里多一项「分享版（脱敏 HTML）」，一轮或整个任务。主进程从 core 取记录（`remoteSnapshot`，一页 50 轮往前翻），按发给远程设备一样的规则脱敏（`packages/remote` 的 `redactTurn` + `hidePaths`：密钥、可能含密钥的文件内容、本机路径换成相对项目的，提问带的图片不带，可视化快照照带），界面再用统一静态渲染画成单文件 HTML，开头写明脱敏了什么。
  - 不上传：仓库里没有分享服务，上传就是对外发布；存到用户自己选的地方，由用户决定发给谁。
  - 只有本机任务有（远程任务的记录在对方电脑上，取不到原始记录）。
  - 脱敏只能尽力（和远程同步一样），开头的说明不承诺「绝对安全」。
- 长会话按需渲染（第 672 步）：除了最后一轮，每一轮加 `content-visibility: auto`、`contain-intrinsic-size: auto 480px`，不在视口附近时跳过排版和绘制，滚到附近才画；auto 记住画过一次的高度，滚动条不来回跳。
  - 没做完整的虚拟列表：虚拟列表会把屏幕外的轮次从 DOM 里拿掉，页面内搜索、定位到某一步、时间线跳转、复制都得另外处理；`content-visibility` 内容还在 DOM 里，这些照常。
  - 远程会话不开：往前翻页时自己挪滚动位置、关了滚动锚定，按需渲染的轮次一画出来高度就变，看着的位置会跳。静态渲染也不开（屏幕外的容器整个都会被跳过）。
  - 预算（`e2e/long-session.spec.ts`，启动前用 core 的 `SessionStore` 写 150 轮、每轮 30 行代码和一张表）：打开不超过 8 秒、滚到最早一轮不超过 3 秒、改窗口宽度后重排不超过 0.5 秒。本机实测：打开约 880ms（不按需渲染时约 1085ms），滚到最早一轮约 80ms，重排约 3ms。

## 交互式回答（第 674 步起）

- 长回答的目录（第 674 步）：回答写完（不在流式输出）、正文不少于 1200 字、有三个以上一到三级标题时，顶上列出目录，按级别缩进，点了跳到那个标题（和脚注一样滚到中间）。标题的 id 用它在原文里的行号，代码围栏里的 `#` 不算。目录放在 `.markdown` 外面，不带列表编号，链接用中性色（导航不是下一步操作）。导出的静态页里目录链接照样能跳。
- 选中后追问（第 674 步，`SelectionAsk.tsx`）：在对话里选中一段文字（松开鼠标或键盘选完时），选区上方浮出「解释这个 / 展开这个 / 换个说法」，点了把这段按 `>` 引用、连同要求填进输入框，不发；最多引用 2000 字。输入框、按钮里的选区不算；卡片外壳（`CardShell`）的标题行多一个「问问这张卡」，引用整张卡上的字。远程、只读的会话没有本机输入框，都不出。
- 回答内搜索（第 675 步，`ConversationSearch.tsx`）：Ctrl+F（Mac 上 ⌘F）在对话右上角出一个搜索条，只找对话里的字（不找侧栏、输入框），命中处用浏览器的自定义高亮（`CSS.highlights`）标出来、不改 DOM；改了字跳到第一个，回车、Shift+回车上下跳，Esc 关掉、高亮清掉。最多 1000 个，超出写「1000+」。
  - 文字节点按顺序拼起来再找：代码高亮、加粗会把一个词拆进几个元素，逐个节点找会漏。
  - 按需渲染（第 672 步）跳过的轮次里的字也找得到（还在 DOM 里）；跳过去时先滚到那一轮，等它画出来再定位。收起的过程组、子智能体卡片里的内容不在 DOM 里，找不到。
  - 焦点在代码编辑器（文件面板）、终端里时不拦 Ctrl+F，它们有自己的查找。颜色用 `--warning` 混透明，不新加颜色。
- 重新生成对比（第 676 步，用户定的推荐做法）：重新生成以前直接撤掉旧的一轮，现在旧的那一次留成「上一次」，挂在重新生成出来的那一轮上（`StoredTurn.versions`，按先后排），再重新生成就接着往上加。
  - 轮次上一条「重新生成过 · 第 k/N 次」：左右切换，按开始的先后编号（换回去以后编号不变）；看旧的那一次时只读，回答、过程卡都是那一次的，没有这一轮的操作栏。「并排对比」把两次的回答左右放（窄了上下放），下面是逐行差异；看的是现在这一次时和前面最近的一次比。
  - 「用这一次」：只限最后一轮、没在跑、本机任务，那一次没改过文件（`edited`，有检查点时按检查点算，没有时看有没有改动卡片）。现在这一次的文件改动按检查点撤掉（改过文件又没有检查点时不能换），先在条下面说「换回去会撤销现在这一次改的 N 个文件」；模型的对话换成那一次的，现在这一次留成版本。改过文件的那一次写明「换不回来；要用它请重新生成」——撤掉之后没有往前的检查点，补不回它的改动。
  - 存储：版本和这一轮的更新一起写在轮次文件里（有版本时文件是 `{ updates, versions }`，没有时照旧是数组），不进会话头，免得每次存盘重写一大块。版本带那一次模型的对话（换回来时放回上下文），只在 core 里用：发给界面前去掉（`compactTurns`），远程设备不发版本，只看现在这一次。
  - 界面：重新生成时界面自己把撤掉的那一轮挂到马上开始的一轮上（core 撤的时候带回 `edited`）；换回来后界面照样换，不重新载入任务——重新载入会在 core 里重建会话，本会话的授权这些就没了。
- 朗读（第 680 步，`speech.ts`、`SpeakButton.tsx`）：每一轮操作栏的「朗读」用系统语音（`speechSynthesis`，不联网、不加依赖）读这一轮的回答，再点就停；同一时间只读一段。旁边的小箭头选声音（中文的排前面），记在本机浏览器存储里。
  - 念之前把 Markdown 换成念得出来的字：代码、图表、流程图的围栏不念，换成「这里有一段代码 / 一张图表」；公式说「这里有一个公式」；表格线、列表符号、强调符号去掉。
  - 按句子切成不超过 180 字的小段排队读：一整段太长时有的语音读到一半会断。
  - e2e 把系统语音换成记录用的替身（不出声），验证念了哪些字、选的声音、停止；真的出声没有自动化验证。
- 时间轴回放（第 681 步，`TurnReplay.tsx`）：操作栏的「回放这一轮」在提问下面出一条滑块，这一轮的每一步（提问、思考、工具调用、回答、提醒）按发生的顺序排成刻度，拖到哪一步对话里就只显示到哪一步，下面写着这一步是什么；播放每 0.9 秒走一步，到最后停下，在最后点播放从头走。回放时没有这一轮的操作栏。
  - 记录里没有每一步的时刻（只有这一轮的开始和结束），按顺序走，不按真实的时间间隔。工具调用照常收在过程组里，组里的条数跟着长。
- 白板扩到富块和卡片（第 677 步）：可视化白板改叫「白板」，除了可视化，回答里的富块（图表、表格、流程图、代码……，外壳上「固定到白板」）和过程卡片（卡片外壳上「固定到白板」）也能固定，每一项标出来自第几轮，一列或两列并排做跨轮对比。store 的 `pinnedVisuals` 换成 `pinned`（三种：visual、block、card）。
  - 富块存它的 Markdown 围栏（`FencedBlock` 写完时用 `BlockSourceContext` 交给外壳），白板里用同一个 Markdown 组件重新画，照样能交互；按内容认，同一段围栏固定一次，已经固定的按钮变成「从白板取下」。
  - 过程卡片固定的是当时的样子：按静态渲染一样去掉按钮、脚本（`snapshotHtml`），能固定几次（跨轮、前后对比）。快照是应用自己画出来的 DOM，不是模型给的 HTML；里面的链接点了不跳（会把整个窗口导航走）。
  - 远程、只读的会话没有本机输入框，也不能固定（和可视化一样）。

## 富内容的平台化（第 682 步起）

- 插件注册的富块（第 682 步，用户定的推荐做法：声明式 + 沙箱）：插件里放 `blocks/blocks.json`，`{ "blocks": [{ "kind", "title", "description", "renders", "template"? }] }`，最多 20 个。
  - `kind` 小写、至少一个连字符（`deploy-status`），免得和代码语言、内置富块重名；两个插件同名时只留先开的那个。
  - `renders` 是内置富块之一（chart、metrics、table、timeline、steps、compare、filetree、keyvalue、json、log、todos）：数据写法和它一样，用它的 schema 校验、用它的渲染器画，标题换成插件给的。
  - 或者 `template`：插件里的 HTML 文件（不能出插件目录、不超过 200 KB），放进和可视化一样的沙箱 iframe，数据按 JSON 放在 `window.diffraData`（`<` 换成 `<`），工具箱和填输入框照样能用，链接不开。数据不是合法 JSON 时按代码显示、写明原因。主界面里不跑插件的代码。
  - core 建任务时读好（`pluginBlocks`），接在系统提示词的回答格式指南后面，一行一个，写明数据和哪个内置块一样；界面向 core 要（`_diffra/session/blocks`，每个任务要一次）。扩展页的插件卡片写「N 种富块」，详情里列出来。格式不对的条目不收，写进「已忽略」。
  - 导出：套用内置的照样画；模板的不跑脚本，写明「在 Diffra 里打开才能看」。远程任务没有插件的富块，按代码显示。
- MCP 工具带的界面（第 683 步）：装的 MCP SDK 1.32.2 没有 MCP Apps 专门的类型，按协议里有的东西认两种写法：工具结果里内嵌的 `ui://` HTML 资源（MCP-UI 的写法）；工具定义 `_meta` 的 `"ui/resourceUri"`（或 `ui.resourceUri`）指向的 `ui://` 资源（MCP Apps 的写法），调用成功后 core 用 `resources/read` 读出来。超过 50 万字的不显示。
  - 挂在那一步的 `_meta.diffra.mcpUi`（界面的 HTML、服务器、工具、参数、结果里的文字和 `structuredContent`），对话里单独成卡（「来自 MCP 服务器 X」）。界面的 HTML 不给模型，给模型的结果里写「[界面 …，显示给用户了]」。
  - 放进和可视化一样的沙箱 iframe，按 MCP Apps 的 postMessage JSON-RPC 说话：回 `ui/initialize`（宿主是 Diffra、深浅色、`displayMode: inline`），它发 `ui/notifications/initialized` 以后把 `tool-input`、`tool-result` 发过去；`ui/open-link` 先在卡片下面问；`ui/message` 只填进输入框、不发。替它调工具（`tools/call`）、读资源这些一律回「不支持」：界面里的代码不该绕过权限确认去动 MCP 服务器。
  - 远程设备不发（换成 `{ omitted: true }`，和可视化代码一样），导出时写明「在 Diffra 里打开才能看」。
  - 测试用的带界面的服务器是 `core/test/fixtures/mcp-ui-server.mjs`（照原来的测试服务器多了 `ui_card`、`ui_weather` 两个工具），原来那个不动，免得数工具个数的用例都要改。
- 版本回退和质量门槛（第 684 步）：每种内置富块在 `core/test/fixtures/rich-samples.ts` 里有一份样例（类型是 `Record<RichBlockKind, …>`，新加一种块不给样例就过不了类型检查），core 和桌面端的门槛共用。
  - core（`rich-gate.test.ts`）：每种块的样例能画；数据不对、超过 10 万字、版本比这里新（`"v"` 大于 `RICH_BLOCK_VERSION`）都回退成代码并写明原因；不写版本（旧会话）、写当前版本照常画。旧会话、远程设备、导出用的是同一份校验和同一套组件，回退的样子一样。
  - 桌面端（`e2e/rich-gate.spec.ts`）：一段回答里每种块一个，都画出来；数据不对的回退（不合法的 JSON 本来就按代码显示，不另写原因）；深浅色每种块各截一张；应用里 1280 和 375 宽不横向溢出；导出的单文件 HTML 在 375（手机上看分享版）和 1280 宽的窗口里不溢出，图表缩小了也看得见。
  - 门槛查出来顺手修的：导出页里图表是按导出时的宽度画的固定宽高 SVG，窄屏会被裁掉一截。导出时给没有 viewBox 的 SVG 补上，SVG 和 ECharts 包的那层 div 最宽到容器宽，等比缩小（画布原来的高度不变，下面会留一点空白；把高度也改成自动会让 ECharts 的绝对定位 SVG 塌成 0 高）。
  - 已知：窄窗口下右侧面板（任务监控、文件等）不会自动收起，会把对话挤得很窄；门槛量 375 宽前先关掉右侧面板，这个问题没在这一步改。

## 野心清单（第 685 步起）

- 图上标注（第 685 步）：模型能在回答里写 ```` ```annotate ````（新的一种结构化富块，schema 在 core）：一张图加最多 30 处框、圈、箭头、编号，每处可带一句说明。
  - image 是项目里的图片、data: 地址，或这一轮提问里的图片（`@图片1` 是第一张，和输入框里附件的提示词一样）。网络图片不认（回退成代码）。
  - 坐标默认是占图片宽高的比例；写了 `size`（像素宽高）就按像素，core 换成比例。超出图片、箭头没终点、框没宽高都回退并写明哪一处。
  - 界面：图上叠 SVG，线宽、编号按显示缩放换算成固定的屏幕尺寸；颜色用 destructive（截图上最醒目），底下垫一圈 background 色，深浅色截图都看得清。点说明或图上的编号，两边对上。
  - 自己标：回答里的图点开大图有「标注」，标注块有「在图上接着标」（带着模型的标注），输入框里附件的预览有「在图上标注」。编辑里拖出框、圈、箭头，点一下放编号，Ctrl+Z 撤销，每处写说明。
  - 标完把标注画进图里（看到什么样存下来就什么样），回答里的图连说明一起填进输入框，附件就地换成标注后的图、说明接在输入框后面。只有本机任务有这些按钮，远程、只读的会话和导出的静态页没有。
  - 导出：本机任务的导出把回答里项目的图片读进来（以前导出不带项目里的图，而且包着图片的按钮会被当成只有图标的按钮删掉，回答里的图在导出里整个没了）。分享版和远程任务的导出不读项目里的图片，提问里的图片分享版也不带，标注块写明原因、说明照常列出。
- 参数沙盘（第 688 步）：show_visual 的新预设 `sandbox`，回答「如果……会怎样」：最多 6 个滑块参数，一张折线、面积或柱状图（最多 4 条公式，横轴 x 是一段数值范围，最多 200 个点），最多 6 个结果卡片。拖滑块在沙箱里重算，图和结果跟着变；「用这组参数问」把参数和算出来的结果填进输入框。
  - 公式是声明式的，不是代码：core 逐个记号查，只认数字、参数名、x（只在图的公式里）、运算符和一份 Math 函数名单，少乘号（`2x`）、括号不配、不认识的名字都在工具结果里说清楚，模型能改；`^` 当乘方。工具箱按同一份名单编译公式。
  - 算不出来（结果不是有限数字）的在图上按 0 画，下面用 warning 色写明哪条。切换深浅色时可视化会重新加载，滑块回到初始值。
- 决策卡（第 689 步）：新的一种结构化富块 ```` ```decision ````：2–6 个方案按最多 8 个加权标准打分（分数 0–5，写 `"scale": 10` 是 0–10；权重 0–5，默认 1，0 是不看这一项）。和 compare 的区别：compare 的分数是文字，decision 是数字，能算加权平均。
  - 方案按加权平均分排名，改权重排名立刻跟着变，能恢复模型给的权重；权重合计只剩 1 时不能再降（至少留一项）。「各项得分」展开每项的分数。
  - 「选这个」把方案名连同当时的权重填进输入框（只有本机任务）；远程、只读的会话也能改权重看排名。「模型推荐」是中性的描边徽标，分数条用图表色。
  - 导出的页面按模型给的权重，各项得分都展开，没有按钮。缺分数、超出满分、标准重名、权重全是 0、推荐了两个，都回退成代码并写明原因。
- 架构图块（第 690 步）：新的一种结构化富块 ```` ```depgraph ````：最多 60 个节点、150 条边，节点分 module、file、service、database、external（外框不同），可以写项目路径（带 `:行号`）和一句说明；`focus` 是先突出的节点。
  - 用 dagre 排版、画成 SVG，不用 React Flow：导出的静态页里照样是图，不用画布。这个块按需加载。
  - 悬停或聚焦一个节点，和它相连的边、节点突出，其余变淡。写了路径的节点（只有本机任务）点了或按回车在文件面板里打开到那一行，项目里没有就提示。
  - 窄窗口里图最多缩到 60%，再窄横向滚动；放大看原尺寸。有说明的节点列在图下面（悬停也有提示）。
  - 节点重名、边指向不存在的节点、路径写成网址都回退成代码。提示词里写明讲代码结构时优先用它，不用 mermaid。
- 对话地图（第 691 步）：每一轮的操作栏多一个「这一轮的地图」，在提问下面列出这一轮的步骤（工具调用按读、搜索、改、命令、网页、子智能体、检查分组，失败的标出来）、改了的文件（增删行数）、图表和卡片（可视化和回答里的富块、流程图、插件块）、要你定的地方（提问、决策卡、方案对比）。
  - 点一项滚到它在对话里的位置：工具调用和文件走现有的定位（收起的过程组会展开、闪一下底色），文件指向最后一次改它的那一步；回答里的块直接滚过去，闪一圈边框。
  - 回答里的块从页面上找（有 data-kind 的，代码、补丁、JSON、日志不算）。地图开着时看着这一轮的 DOM，按需加载的块晚画出来也会补上；只在块真的变了时更新。
  - 一组先列 24 个，多的点「还有 N 个」。远程、只读的会话也有地图（只是导航）；导出的静态页没有。
- 可执行代码块（第 687 步）：回答里 bash、sh、zsh、shell、console、powershell、cmd 这类代码块多两个按钮：「在终端运行」把命令打进这个项目的终端（和命令卡片的「在终端里运行」一样，不按回车，用户按回车才执行）；「填入输入框」。console 写法只留带提示符（`$ `、`PS …> `）的行、去掉提示符，别的行是输出。
  - 打进终端之前先问 core 这条命令的风险（`_diffra/command/risk`，和确认卡同一套规则）：中、高风险在代码块下面列出原因，点「仍然打进终端」才打。
  - 远程、只读的会话和导出的静态页没有这两个按钮。
- 直接应用回答里的 diff（第 686 步）：回答里写了文件名（`--- a/x`、`+++ b/x`）的 ```diff 多一个「应用这个改动」（任务在跑时不能用）。core 把 unified diff 换成 apply_patch 的写法（`/dev/null` 那边是新建或删除，`\ No newline` 不要），走和模型改文件一样的工具：权限、禁写目录、受保护文件照旧，有改动卡片；这一轮开头打检查点，能撤销。
  - 记成新的一种轮次 `apply`（显示「应用回答里的改动：文件」），不算执行轮：没有「重新生成」（重新生成会把这句说明当提问发给模型）。
  - 应用完往模型的对话里补一句：用户直接应用了它之前回答里的哪段补丁、成没成功，提醒它再改之前重读文件。改了文件就是「未完成 · 未验证」，下一轮照常过完成检查。
  - 没写文件名的 diff 不认（不知道改哪个文件），没有这个按钮；core 收到这种 diff 也拒绝、说明原因。

## 对话里的富内容（第 640 步起）

回答从「文字加零散卡片」升级成三层：Markdown 增强 > 结构化富块 > 生成式视觉（show_visual）。能用普通 Markdown 说清的不做卡片，能用结构化块表达的不让模型写 HTML。

- 第一层，Markdown 增强（第 640 步，`features/task/Markdown.tsx` 和 `features/task/rich/`）：
  - 代码块：语法高亮复用文件面板的 CodeMirror 语法（`@codemirror/language-data` 按需加载各语言解析器），颜色是同一套 `--code-*` 令牌（`.tok-*`）。围栏后面能写文件名和行号（```` ```ts src/a.ts:10 ````、`title="…"`）和重点行（`{2,4-6}`）；超过 30 行先收起；能复制、放大；文件名是项目里的文件时能在文件面板打开到那一行。命令、输出这类语言不标行号。
  - ```` ```diff ````：按文件分组的红绿改动，宽松解析（有没有 `diff --git`、`@@` 都行），文件名能在文件面板打开，这个任务改过的能看审阅。
  - 公式：`remark-math` 解析，KaTeX 按需加载（`trust` 关着）。单个 `$` 里有中文或紧挨着空格的不当公式（`$PATH 和 $HOME`）。`\(…\)`、`\[…\]` 先换成 `$` 写法。
  - Mermaid：按需加载，`securityLevel: strict`，标签画成 SVG 文字（不用 foreignObject）以便导出 PNG；颜色从当前主题令牌取真实值（mermaid 要做颜色运算），跟随系统切深浅色时重画。语法错了按代码显示并写明原因。
  - Callout：GitHub 的 `> [!NOTE]` 写法，另认 SUCCESS、RISK、BACKGROUND、DETAILS 和中文名；标记后加 `-` 默认收起、`+` 可折叠。「完成」（SUCCESS）只用中性色：那是模型的说法，不是验证结果。
  - 表格：横向滚动、表头固定、超过 25 行先收起；能复制成 Markdown 或 CSV。
  - 图片：项目里的图片经主进程按 base64 读（`readImage`，只认常见图片扩展名、最大 8 MB）；点开看大图，能缩放、切换同一段回答里的图；一段里只有「前…」「后…」两张图时是对比滑块。网络图片不加载，显示成链接：主窗口的 CSP 不放行外部图片，模型也可能被网页诱导用图片地址把数据带出去。
  - 单独成段的文件引用是文件卡（能预览那几行）；单独成段的网页链接和脚注里的来源是来源卡，域名首字母当图标，不联网取 favicon。脚注 id 按每段回答加前缀，页面上几段回答不撞。
  - 流式输出时没写完的富块（流程图、公式、图表）只占位，写完再画，不先闪出代码；普通代码边写边显示，写完再高亮。
- 不渲染原始 HTML 的规矩不变：富块只接受白名单格式，KaTeX、mermaid 的输出是它们自己生成的标签。
- 第二层，结构化富块（第 650–652 步）：模型在回答里写语言是 `chart`、`metrics`、`table`、`timeline`、`steps`、`compare`、`filetree`、`keyvalue`、`log` 的代码围栏，内容是 JSON（log 是原文）。
  - 注册表分两半：schema、解析和上限在 core（`packages/core/src/rich/blocks.ts`，导出路径 `@diffra/core/rich`），对话、导出、远程快照、分享页都用这一份；界面按 kind 找渲染器（`features/task/rich/RichBlock.tsx`）。
  - 不走工具调用：普通回答流式写出来就行，不多一轮请求。没写完时占位，写完才解析。
  - 数据不是合法 JSON、形状不对、超上限、或者写了比当前新的版本（`"v": 2`）时，回退成普通代码块，下面写明原因，不影响整段回答。块里不写 `v` 当第 1 版。
  - 上限（`RICH_LIMITS`）：一个块 10 万字，图表 12 个系列、合计 2000 个点、热力图 2500 格，表格 1000 行 30 列，日志 5000 行（多出的只记条数），时间线、步骤、键值 200 条，对比 6 个方案。
  - `json` 不单列成块：```` ```json ```` 照常是代码块，合法时能切成树（超过 40 行默认是树），能搜索、点键名复制路径。
  - 图表用 ECharts（用户要求「哪个更强用哪个」，第 650 步前问过；自己画 SVG 少依赖但交互弱）：只注册用到的图表和组件，SVG 渲染，整块按需加载。颜色从 `--chart-1..4` 取真实值，系列多于 4 个时用同一组颜色和卡片底色混出浅一档，不加新颜色；跟随系统切深浅色时重设。每张图能切到数据表（读屏和看具体数字），能另存为 SVG、PNG；`renderToSVGString` 也是以后静态导出用的。
  - 颜色：指标变差（`better` 和变化方向相反）用 warning，变好不用成功色；失败的步骤、时间线用 destructive；方案对比的「推荐」用中性描边和徽标。
  - 能填进输入框的动作（步骤里的命令「让智能体执行」、方案对比的「选这个」）只填不发，远程和只读会话里没有。
- 第三层前的过程卡片（第 655–656 步，`features/task/cards/`）：
  - 工具步骤展开后的输出（`ToolOutputView`）：顶上一行是命令的状态（原样的 `Exit code: N`）和操作（复制命令、复制输出、重新运行、测试失败时「填入修复提示词」）。认得出的换成对应视图：测试汇总（vitest、jest、pytest、cargo、node --test、playwright、go test；通过数只有全部通过且退出码为 0 时用成功色）和失败用例、`rg`/`grep` 的结果按文件分组（点一处在文件面板打开到那一行）、`cat`/`sed -n`/`head`/`nl` 读文件按代码高亮带行号；其余保留 ANSI 颜色（颜色对到令牌，终端的绿不用成功色），超过 2000 行只画最后 2000 行。不是命令、输出是 JSON 的显示成树。
  - 只从命令和输出里认，不改 core：认不出就照原样，不猜。「重新运行」只填进输入框，交给智能体按正常的权限流程跑。
  - 第 657 步再认几种：`git status`（分支、领先落后、按已暂存、未暂存、未跟踪、冲突分组）、`git log --oneline`、`git diff`/`git show`（红绿改动）、`git push`（被拒的标红）；vite、webpack 的构建产物按体积排、带合计和 gzip；`curl -i` 的方法、状态码（4xx 用 warning、5xx 用 destructive）、响应头、JSON 正文；psql、mysql 的查询表（能排序、筛选）；三成以上的行带级别的输出按日志看（`.log` 这类文件读出来也是）。测试、构建、推送的原始输出照样留在下面。
  - 第 658 步：规范审查、架构检查的发现按文件分组、能勾成已解决（只记在界面上）；安全检查按级别分组，「填入修复提示词」只填不发；深度扫描报告多一个「填入输入框」。这些卡片里的「路径:行号」是项目里的文件时能点开到那一行。
  - 富块放进工具输出时用 `bare`（不画外框和顶栏），卡片里不套卡片。
  - 第 659–660 步，core 给界面多带几样结构化数据（都在 `_meta.diffra`，旧记录没有就不显示）：
    - 命令确认请求带 `commandRisk`（`permissions.ts` 的 `commandRisk`）：高风险是递归删除、丢弃未提交的改动、强制推送、清掉未跟踪文件、sudo；要留意的是联网、改依赖、推送、删文件、切分支、改写历史、npx、按名字结束进程；其余没有原因、不显示。只是提示，放不放行仍由 `classifyCommand` 决定。确认卡已有的「允许一次 / 本会话内允许同类命令 / 拒绝」不变。
    - 写项目外的文件要确认时，`rawInput.patch` 带 apply_patch 里这个文件的那段（最多 2 万字），确认卡画成红绿改动。项目里的改动本来就不问，不加。
    - 命令跑完那次更新带 `commandDurationMs`，输出顶上写「用时」。
    - 压缩卡带 `compaction`（压缩前后估算的 token 和窗口），画成两条对比条，颜色用上下文用量的 chart 令牌。
    - 第 661 步：每轮报告（操作栏「本轮报告」，点了才拼，不调模型）：要求、改了哪些文件、结论、各项检查、从命令输出认出的测试结果、命令条数和失败的、风险（停下原因、未验证、没通过的检查和测试、失败的命令）、下一步；能复制、导出成 Markdown。时间线悬停除了要求还写这一轮改了几个文件、净增删和结论（已验证、未验证、已撤销、出错），按轮次对象缓存。「点一下回到当时」仍是滚到那一轮，撤销照旧走操作栏的按钮，不在时间线上放破坏性动作。
    - 第 662 步：浏览器截图那一步带一张 480 宽、JPEG 60 的缩略图（`_meta.diffra.browserShot`，按 ACP 图片内容的形状存，同步给远程设备时被换成占位）。过程组里有浏览器操作时，组下面一行摘要（收着也显示）：最近一张截图（点开看大图）、当前网址、几步、控制台报错和失败的请求，「在浏览器面板看」。命令输出多一个「在终端里运行」：打进这个项目的终端，不按回车（智能体的命令是 bash 写法，终端可能是别的 shell），跑不跑用户定。时间戳没有记录，终端回放不显示。
    - 第 663 步：计划卡在文字上面多一个步骤视图（编号步骤至少两条时）：勾掉做完的、上下挪（重写文字、重新编号，缩进的说明跟着步骤走，风险等结尾段落不动）、「从第 N 步开始执行」（写明哪几步已经做完）。文字仍是唯一的来源。
    - 第 664 步：新富块 ```` ```todos ````（回答里留到以后的事）。和侧栏待办是同一份：按标题和项目对上已有的待办就显示它的状态，能勾掉、改期、派给任务；没对上的能「加入待办」。远程、只读会话里只列出来。
    - 第 665 步：性能分析的输出：Lighthouse 的 JSON 报告画成各类分数（90 以上 foreground、50 以上 warning、以下 destructive，分数不是验证结果，不用成功色）、关键指标和请求瀑布图（超过 1 秒标 warning）；Chrome 的 CPU profile 画成自上而下的火焰图（点一帧放大到它，太窄的不画），列出自身耗时最多的几帧，是项目里的文件能点开到那一行。
    - 子智能体卡带开始、结束时刻、用掉的 token（输入加输出）和实际改了的文件：运行中写 token，排队时写「排队中」，结束后写用时、步数、token，改了的文件能点开；结果超过 6 行先收起。连着派出几个时，卡片上面一行组织图（名字、颜色、状态、用时），点一下滚到那张卡片。
  - 统一卡片外壳（`CardShell`）：状态色、两档密度、图标、标题、副标题、操作区、页脚、展开收起、复制、导出 Markdown。出错卡、定位结果、计划、深度扫描报告、提醒、规范审查打回、安全检查有发现都换了上去，test id 不变；子智能体卡有自己的展开行，暂时没换。
  - 插件、MCP 注册自己的卡片放到第六阶段和 MCP UI 资源一起做：现在没有调用方，先不建空的注册表。
- 模型引导（第 652 步）：系统提示词的「Formatting your answer」一节列出每种写法的一行 JSON 形状和什么时候用（三个数字不画饼图，一两句话不做块），子智能体的提示词里没有（它的结果按纯文本显示）。core 的测试核对每种块都写进了指南。`show_visual` 的说明改成先用 Markdown、mermaid 和结构化块，都不合适时才用它。

## 任务之间互通（第 222–230 步）

- 智能体可以列出、读别的任务（`tasks_list`、`task_read`），给已有任务发消息（`task_send`），新建任务（`task_create`），等别的任务做完拿回结果（`task_wait`，等待期间不调模型）。
- 发消息和新建由界面执行：core 通过 `_diffra/task/action` 请求客户端，界面在后台载入那个任务、起一轮，不把用户从正在看的任务切走。对方正在跑时消息排在它这一轮后面。
  - 收到的消息开头写明「来自任务『标题』的消息」，这一轮记下来源（`from`），对话里显示「来自任务」，点了回到发送方；发送方的卡片有「打开任务」。
  - 新建的任务先定好标题（智能体给的标题，没有就取消息第一行），不然第一轮会拿「来自任务…」当标题。还没跑过一轮的任务也能改标题，只改内存里的，第一轮结束时一起存。
- 防止失控：
  - 被别的任务叫起来的那一轮不能再发消息或新建任务，免得两个任务互相触发。
  - 每轮最多发 5 次。
  - 除了完全放开的权限模式，每次发送都要用户确认（「发送」/「不发」）。
- `task_wait` 每 2 秒查一次对方状态；对方还没开始跑时等 15 秒宽限，默认最多等 30 分钟，最长 120 分钟。
- 回复（v2 · M11）：被别的任务的消息叫起来的这一轮，可以用 `task_reply` 回给发消息的任务一次。那边收到「来自任务『标题』的回复」并起一轮，轮次记成 `from.reply`（旧记录没有；旧版读到时丢掉这个标记，当普通的「来自任务」显示），对话里标「回复来自任务」。
  - 防止来回触发：回复叫起来的那一轮不能再回复，也不能发消息、新建任务（沿用上面的规则），所以一来一回最多一趟；每轮只能回一次。
  - 发消息的任务正在跑时不发：它多半在用 `task_wait` 等这一轮，会读到这一轮的结果，再发一轮就重复了。
  - 和发消息一样按权限模式确认（「回复任务『标题』」），完全放开时不问。确认卡出在回复的那个任务里。
  - `task_send` 的说明改成：结果用 `task_wait`、`task_read` 拿；不等的话，对方可以回复一次。
  - 验证：core `loop.test.ts` 的「回复（v2）」（只在别的任务叫起来的一轮、只回一次、带回复标记；回复叫起来的一轮不能再回；对方在跑时不发）；e2e `tasks.spec.ts` 的第二个用例（交出去不等，对方回复、确认后，发消息的任务多一轮，标着回复来自哪个任务）。
- 跨设备的任务原来排在这里，第 348 步起改由「设备连接（互联网）」做，见下一节。

## 设备连接（互联网）（第 348–365 步）

> 2026-11-15 起整体下线：网络安全问题尚未彻底解决，代码保留但默认关闭。见文末「设备连接下线」。

两台 Diffra 都开着、配过对时，一台（连接端）能看到并操作另一台（被连接端）授权给它的会话。原来「跨设备的任务不做」的决定推翻了：用户要两个人之间互看、互相操作任务。第 348–352 步只做了本地的协议和核心逻辑，中转服务、界面和远程操作在后面的步骤里。

- 形态：
  - 完全远程操作：连接端能看会话、发消息、建任务、回答权限请求、停止。不能改设置、模型、权限模式，不能撤销、重新生成、删除、归档、改名（v2）。
  - 按项目授权：新配对的设备默认什么都看不到，被连接端逐个项目勾选「可查看」「可查看和操作」或「完全控制」（第 393 步）。授权单向，B 看 A 要 A 另外配对。
  - 没有账号：设备身份就是本机生成的密钥。不复刻 Qoder 的「同账号自动开放全部工作区」。
  - 对方的数据只在内存里，不落盘；对方离线时打开着的内容只读保留，消息不排队。
- 传输：两端都主动用 WebSocket 连自己服务器上的中转（`relay.diffra.dev`），不做 NAT 穿透、不做 P2P。中转只做设备登录（Ed25519 签名挑战）、按白名单转发、配对会合，不存盘。鉴权以被连接端为准，中转的白名单只防骚扰。
- 端到端加密：Noise 协议，配对用 `Noise_XXpsk3_25519_AESGCM_SHA256`，日常连接用 `Noise_KK_25519_AESGCM_SHA256`，服务器只看得到设备 ID、IP、时间、大小和谁跟谁配了对。
  - 只用 Electron 自带 crypto 的 X25519、AES-256-GCM、SHA-256、HMAC。Electron 45（BoringSSL）里没有 ChaCha20-Poly1305，实测 `createCipheriv` 报 Unknown cipher，所以选 AESGCM 套件。
  - Noise 自己实现（`packages/remote`），用 cacophony 和 snow 两份公开测试向量逐字节对拍。不用第三方 Noise 库：现成的要么依赖原生模块（sodium-native），要么要带上 libp2p。
- 配对用邀请串，不用「地址 + 8 位码」：邀请串里有被连接端的设备 ID（公钥哈希）和 16 字节一次性密钥，连接端据此确认连上的就是那台设备，服务器做不了中间人，也没法离线爆破；8 位码只有约 27 位，要用 PAKE 并新增 `@noble/curves`、自己实现 CPace 或 SPAKE2。邀请串 10 分钟有效、只能用一次，被连接端还要看着对方的名称和指纹点「允许」。
- 同步的数据：只同步授权项目里、未归档的会话的列表和轮次（经 `compactTurns`），不同步 `messages`、检查点、文件、终端、投屏、设置和密钥。轮次里有工具输出全文和工具参数，发出前脱敏（`packages/remote/src/redact.ts`）：密钥格式（和安全检查共用 `protocol.ts` 的 `SECRET_FORMATS`）、PEM 私钥整块、带引号的赋值、环境变量、Authorization 头、地址里的账号密码；可能含密钥的文件（和工具共用 `isProtectedFile`，智能体本来就读不了、改不了）整项不发；工具输出里的图片和可视化代码换占位，提问带的图片压缩后再发（第 377 步），可视化的快照照发（第 670 步）；单段文字超过 64000 字截断。只作用于发出去的副本，脱敏只能尽力，真正的边界是授权了哪些项目。
  - 改动卡片的 `oldText`、`newText`、`base` 不截断：界面按顺序重放改动还原全文，截了就对不上；脱敏不增删换行，重放照样按行对得上。
  - 每条规则都要有锚点和长度上限：第一版没加，64000 个连续字母要 4 秒多（回溯成平方级），会卡住被连接端的主进程；测试里留了几种病态输入。
- 增量：core 推给客户端的每条会话更新（每一轮的、撤销和重新生成后补发的任务状态）都加按会话递增的 `_meta.diffra.seq`（只在内存，按会话 id 记，重新载入会话接着数；core 每次启动从 0 开始，快照里带 core 这次启动的 `epoch`）；`_diffra/remote/snapshot` 无副作用地读会话（在内存里就取内存，否则读文件，不载入、不连 MCP），带回当时的 `seq`。订阅时先缓存实时更新再取快照，只转发 `seq` 更大的，不管 SDK 先处理通知还是先处理响应都不丢不重。存盘的轮次会合并文字块，所以不能按条数做增量。一轮开始时 core 不推会话更新（界面发送前自己建新的一轮），被连接端要另发 `turn.started`。
- 远程操作的边界：「可查看和操作」等于把以本机 Windows 账户执行命令的能力交给对方，项目授权不是沙箱，授权弹窗要写明。远程只能「允许一次」或「拒绝」，没有「始终允许」；项目外的文件访问只在本机确认；远程的消息经本机界面发（和任务互通同一条路），本机没开窗口就失败。
- 服务器：和更新源同一台、共用 30 Mbps，中转全局限 10 Mbps、每台设备 256 KB/s；中转日志单独存 14 天、不记内容。更新包还没签名，攻破服务器的人能推恶意版本绕过端到端加密，所以签名配好前对外只说「服务器不解密」。开这个功能要改隐私政策（现在写的是代码和对话不经过服务器）。
- 不做：账号、远程更新 Diffra、手机端。原定 v2：局域网和 P2P 直连、离线缓存和暂存消息、远程撤销等破坏性操作、远程发图片、无项目和设计任务、按会话授权、自建中转、长度填充、macOS。v2 实际只做了局域网直连（见「局域网设备连接（v2 · M6）」），远程发图片在局域网版里能用；P2P、离线暂存、远程撤销、自建中转按 v2 的范围不做；按会话授权、远程的无项目和设计任务、长度填充放到 v3。

### 中转服务和部署（第 353–355 步）

- 代码在 `packages/relay`：服务器上用 Node 24 直接跑 TS（`node src/main.ts`），不构建，所以 tsconfig 开了 `erasableSyntaxOnly`、导入写 `.ts` 后缀。运行时依赖只有 `ws`（Node 没有内置 WebSocket 服务端；8.22.1，锁文件里原本就有）和 `zod`。协议在 `src/protocol.ts`，客户端（第 356 步）也从这里取。
- 协议：WebSocket 路径 `/v1`。
  - 登录：中转先发随机数，设备用 Ed25519 签 `diffra-relay-auth/1`、一个 0 字节、随机数，连同两把公钥发回；设备 ID 是 Ed25519 公钥接 X25519 公钥的 SHA-256 前 16 字节。没有账号。
  - 白名单整份替换（最多 64 台）；二进制帧是 1 字节种类 + 16 字节对方 ID + 密文（最多 65535 字节），收件方的白名单里有发件方才转。两边互相在白名单里、都在线时才互相告知在线状态。送不到只回「送不到」，不说是不在线还是没授权。
  - 会合点：开的设备给 ID 和有效期（最长 600 秒），每台设备同时最多 3 个，每个 IP 每小时最多开 20 个，每个会合点最多 3 台设备来、转 32 帧。连接端把被连接端先放进自己的白名单，被连接端就能直接回它。
  - 探活用应用层的 `ping`/`pong`：Node 自带的 WebSocket 客户端发不了 ping 帧。中转每 25 秒发 ping 帧，上一轮没回 pong 的断开。
- 上限（`DEFAULT_LIMITS`）：同一 IP 同时 10 条连接，登录的设备 500 台，没登录的连接 200 条，10 秒内要登录；每台设备每秒 50 帧、256 KB（突发 2 MB），所有设备加起来每秒 1.25 MB（10 Mbps，给更新下载留 20 Mbps）；收件方积压超过 4 MB 断开它。超限都是断开、不排队不丢帧：丢一帧加密通道就对不上了，客户端退避重连、重新握手。WebSocket 不开压缩（内容是密文，压了没用，还多一条解压炸弹的路）。
- 日志：中转进程只记连接、断开（设备 ID 前 8 位和 IP）和错误，不记内容和大小。进程日志和 nginx 的访问、错误日志都在 `/var/log/diffra-relay/`，留 14 天；不放 `/var/log/nginx/`，那里的 `*.log` 按官网的规则留 180 天，同一个文件写两条轮转规则 logrotate 会报重复。
- 发布：`pnpm --filter @diffra/desktop publish:relay`（`scripts/publish-relay.ts`，`--dry-run` 只在本机打包、试跑、列出步骤，不连服务器）。
  - 打包源码、`ws` 和 `zod`（都没有自己的依赖，照本机测过的那份原样拷过去，服务器上不再装）、`release.txt`（时间加提交），上传到 `/opt/diffra-relay/releases/<版本>`，`current` 链过去再重启服务。
  - 上传前在本机解开打好的包、照服务器的方式启动一次，健康检查返回这个版本才往下走；上线后等 `https://relay.diffra.dev/health` 返回新版本，对不上就链回上一个版本再重启。只留最近 3 个版本。
  - `packages/relay` 有没提交的改动就不发，线上跑的一定对得上一个提交。
- 首次上线（第 355 步，改服务器，执行前先问用户；改动前把要改的原文件备份到 `/root/backup/`）。配置文件都在 `packages/relay/deploy/`：
  1. Cloudflare 加 `relay` 的 A 记录指向服务器，仅 DNS，不走代理（WebSocket 直连 nginx）。
  2. 装 Node 24：nodejs.org 的官方二进制包（`linux-x64.tar.xz`），对过 `SHASUMS256.txt` 再解到 `/opt/node-v24.x.y-linux-x64`，`/opt/node` 和 `/usr/local/bin/node` 链过去。不加 NodeSource 的 apt 源：服务器上原本只有 Ubuntu 官方源，不多信任一个第三方；Ubuntu 24.04 自带的 nodejs 是 18，跑不了 TS。升级就是换一个目录再改链接。
  3. 建系统用户 `diffra-relay`（不能登录、没有家目录），建 `/opt/diffra-relay/releases` 和 `/var/log/diffra-relay`。
  4. `nginx-http.conf` 放进 `/etc/nginx/sites-available/relay.diffra.dev`、链到 `sites-enabled`，`nginx -t` 后重载；`certbot certonly --nginx -d relay.diffra.dev` 申请证书（和官网、更新源一样用 nginx 插件，续期也是现有的 certbot 定时任务）；再把 `nginx-https.conf` 接到同一个文件后面，`nginx -t` 后重载。服务器没有公网 IPv6，现有站点也只听 IPv4，中转一样。
  5. `logrotate.conf` 放进 `/etc/logrotate.d/diffra-relay`，`logrotate -d` 检查。
  6. `diffra-relay.service` 放进 `/etc/systemd/system/`，`daemon-reload` 后 `enable`。
  7. 本机跑 `publish:relay`；验证健康检查、从本机用 wss 登录，更新源的 `latest.yml` 和安装包下载不受影响。
- 2026-11-11 已上线：Node 24.22.2（`/opt/node-v24.22.2-linux-x64`，解压时不保留包里的属主 uid 1000），系统用户 `diffra-relay`（uid 997），证书到 2027-02-09；改动前的 `sites-available`、`logrotate.d` 备份在 `/root/backup/relay-20261111-074548/`。上线后两台临时设备经 `wss://relay.diffra.dev/v1` 登录、互通、转发一帧都正常，日志里记的是 nginx 转来的真实 IP。
  - 新证书一签发，扫描器几秒内就按证书透明度日志找上门（这次 07:52:45 签发、同一秒就有人扫 `/phpinfo.php`、`/backup.sql`）。签证书到接上 HTTPS 配置之间的那一分钟，443 上的请求落到默认站点、记进了官网 180 天的那份日志；那些都是扫描器的请求，不是设备流量。以后再加子域名，拿到证书后马上接上 HTTPS 配置。
  - 回退：停掉并禁用 `diffra-relay`，删掉 `sites-enabled/relay.diffra.dev` 后重载 nginx；删 `/opt/diffra-relay`、`/opt/node*`、`/usr/local/bin/node` 和用户；`certbot delete --cert-name relay.diffra.dev`。

### 客户端：设备身份、中转连接、配对（第 356–357 步）

- 代码在 `packages/desktop/src/main/remote/`（`service.ts` 总管，`identity.ts`、`state.ts`、`relay-client.ts`、`pairing.ts`、`channel.ts`），IPC 在 `main/remote-ipc.ts`，界面在 `renderer/src/features/devices/`（设置 → 连接 → 设备连接，配对请求的弹窗挂在应用根上，在哪个页面都能弹出来）。
- 存储都在数据目录的 `remote/` 下：`identity.json`（两把私钥，safeStorage 加密后的密文；系统加密不可用时整个功能不能用）、`state.json`（总开关、本机名称、授权给别人的设备和开放的项目、自己连接的设备、最后在线时间）、`audit.jsonl`（配对、修改授权、撤销，超过 5 MB 轮转、留两份）。总开关和名称原计划放 `settings.json`，改成和配对、授权放在一起，由同一个模块管，不动设置的 schema。
- 什么时候连中转：开着「允许连接本机」、有自己连接的设备、或者正在添加设备。白名单是授权的设备（开着总开关时）加自己连接的设备；关掉总开关后授权的设备都看到本机离线，自己连接的设备照常。授权的和自己连接的加起来最多 64 台（中转白名单的上限）。
- 配对：邀请串的会合点开 10 分钟；第一台握手成功的设备占用这个邀请串，别人再来不理；握手失败 3 次作废。被连接端在弹窗里看对方名称和指纹、勾项目和级别（默认不勾），点允许才存授权；关掉弹窗算拒绝。连接端等对方确认最多到邀请串过期，被拒绝、过期、用过的都给出原因。重新配对同一台设备时整条授权换成新选的，弹窗写明原来的授权。
- 开发和 e2e：只在未打包时认 `DIFFRA_RELAY_URL`（连本机的中转）和 `DIFFRA_INVITE_TTL_SECONDS`（缩短邀请串有效期）。e2e（`e2e/devices.spec.ts`）在测试进程里起 `packages/relay` 的中转，两个开发版实例经它配对。
- 删除设备、放弃配对时通知对方：见第 370 步。

### 看对方的会话：同步和只读界面（第 358–359 步）

- 代码：主进程 `remote/links.ts`（会话通道）、`host-sync.ts`（被连接端）、`guest-sync.ts`（连接端）、`main/session-events.ts`（本机会话的动静）；界面 `features/devices/remote-tasks.ts`、`remote-projects.ts`、`RemoteTaskView.tsx`，对话复用 `Conversation` 加 `readOnly`。这两步只能看；远程操作见下一节。
- 通道：配对后两边都有对方的长期公钥，连接端要用时发起 Noise KK，每条连接一把新临时密钥。直发帧第一个字节是种类（0 配对、1 握手、2 应答、3 发给被连接端、4 发给连接端）；所以加密后的一片最长 65534 字节，加上种类正好是中转的 65535（第 387 步）。被连接端只应答总开关开着、还在授权列表里的设备；解密或握手出错、对方离线、和中转断开、撤销授权都整条丢掉，连接端下次要用时重新握手。
- 授权：每个请求都重新查授权，没授权的会话和不存在的会话回同一句话。项目对外只给文件夹名和一个 ID（规范化路径加前缀的 SHA-256 前 16 位），不发完整路径。列表不含归档、设计和无项目任务。
- 订阅：先登记订阅（之后的更新先攒着），再取快照（最近 10 轮、不超过 1 MB；第 390 步起按压缩后 500 KB 装），发出快照后只补发 `seq` 比快照大的更新，`turn.started` 只补快照里没有的那一轮；翻页每次往前 10 轮。
- 推送：更新攒 150 毫秒一批发，相邻的、只带 `seq` 的文字块合成一条，一批最多 500 条；一轮开始先把攒着的发掉再发 `turn.started`。撤销、恢复发 `session.reset`，连接端整页重订；改名、删除、一轮结束发 `sessions.changed`，每台设备每秒最多一次。
- 发送限速在 `relay-client.ts`：每秒 40 帧（突发 80）、200 KB（突发 1.5 MB），低于中转给每台设备的上限，免得被中转断开；积压超过 8 MB 时丢掉这条通道（连接端重新订阅），不丢单帧。
- 一轮结束：`stopReason`、`endedAt` 在本机来自发送请求的返回值，不在会话更新里，所以连接端看到列表里这个会话不在跑了就重新订阅，拿存盘后的样子。重新订阅只拿最近一页，之前往前翻出来的、和新一页接得上的（同一位置是同一轮）留着，不让看到的内容缩回去。
- 界面：
  - 对方授权的项目和本机项目一起排在侧栏「项目」下（本机项目后面），右边的设备图标标出是远程的，对方离线时图标变淡；没有新建任务的加号。在线的设备启动时、重新上线时各取一次列表，只在内存里：对方离线时还显示上次取到的，本次启动以来一直没在线过的设备，它的项目不显示。
  - 远程任务页：顶上「只读」、设备名 · 项目、运行中；对方离线或通道断了有横幅，内容留着；「看更早的 N 轮」往前翻。只读时藏掉重新生成、恢复、定位问题、计划和定位问题的按钮和输入、深度扫描的修复、可视化卡片的填入和跳转，提问卡片和输入框都没有。
  - 提问带的图片原先不同步，只写张数；第 377 步起压缩后同步，见下面一节。
- 后来补上的：断线续传（第 371 步）、侧栏搜索找远程会话（第 372 步）、渲染进程不再自己存一份 `DEEP_SCAN_TITLES`（第 373 步）。
- e2e（`devices.spec.ts` 第三个用例）：两个实例经本机中转；被连接端跑 14 轮（第一轮带图、回答里有假密钥），连接端在侧栏只看到授权项目里的会话，伪造请求要没授权的会话被拒；只读、翻页、实时看到正在跑的一轮；一轮跑到一半关掉再起中转，连接端重连后断线前的话和断线后的回答都只出现一次；两边逐轮比提问、回答和工具调用数，除了脱敏的密钥都一样；撤销后连接端看到离线。快照和实时更新正好交叉（订阅登记和取快照之间来了更新）的那种时序在 e2e 里撞不准，靠 `seq` 过滤保证，没有单独测到。

### 远程操作：被连接端执行（第 360–361 步）

- 轮次来源：`StoredTurn.remote`（`{ deviceId, name }`，name 是被连接端给这台设备记的名称），从提问的 `_meta.diffra.remote` 进来、存盘、快照和 `turn.started` 都带上。和任务互通的 `from` 分开放，不扩成一个联合类型：两种来源可能以后同时出现，旧记录、旧界面也不用改。旧记录没有这个字段，照常读。界面在这一轮上方标「来自设备「X」」；连接端看对方的会话时，自己发的那几轮标「本机发的」。
- 能做的操作：在已有会话里发消息、在开放的项目里新建任务（只认项目 id，不接受对方给的路径）、停止、回答权限请求。每个请求都重新查授权，会话或项目要开放了「可查看和操作」；只开放查看的回「对方只开放了查看，不能操作」，没授权和不存在的照旧说「没有这个会话」。远程发消息不带图片、不能选目标模式和先出计划（第 395 步起都能，见「远程任务页和本机一样」）。
- 执行路径：主进程查完授权，把操作交给本机界面（`remote:action`，和任务互通同一条路：`sendInBackground`、`startInBackground`、停止），不直接调 core——界面发送前自己建新的一轮，主进程直接调 core 的话这一轮会串进上一轮。只有一个主窗口，只交给它，免得同一个操作做两遍；还没有窗口（启动中、退出中）或者界面 30 秒不回就失败。对方正在跑时消息排在这一轮后面（回 `queued: true`），和本机输入框一样。
- 权限请求：本机界面照常显示，同时发给正看着这个会话、能操作的设备（订阅时也补发还在等的）。只给「允许一次」「拒绝」，名字照本机的；工具参数先脱敏。本机和远程谁先答算谁的，答完通知两边收起确认（`permission.settled`、`session:permission-settled`）。项目外的文件访问不发给远程，只在本机确认。撤销授权时连接断开，没答的确认留在本机。
- 限流：每台设备每分钟最多 30 次操作，其中新建任务最多 5 个，按设备记，断线重连不清零。
- 操作记录：远程发消息、新建、停止、允许或拒绝都记进 `audit.jsonl`（项目文件夹名和任务标题，不记消息内容）。
- 本机提示：能操作本机的设备在线时，窗口顶部一直有横幅「「X」在线，可以在本机的 N 个项目里发消息、新建任务、回答确认」，「断开这台设备」就是撤销授权（先确认，要再连得重新配对）。第 404 步起横幅换成标题栏右边的提示，见「左下角的设备和用量」。
- 已知没做：没有窗口时操作失败这条路径只靠代码检查，e2e 里关掉窗口应用就退出了，测不到。连接端的操作界面见第 362 步；只在本机确认的范围在第 364 步扩大了。
- e2e（`devices.spec.ts` 第四个用例）：被连接端开放一个项目「可查看和操作」、一个「可查看」。只开放查看的发消息、新建、停止都被拒；远程发消息两边看到同一轮、标出来源；权限请求只有两个选项，远程允许后本机卡片收起、命令照常跑，同一个确认答第二次被拒；本机先答时连接端收到答完、再答被拒；项目外读取连接端收不到；运行中再发的排队、跑完接着跑；模型正在回时远程停止；远程新建的任务在本机后台建好跑完；第 31 次操作被限流；操作记录里有这些；横幅断开后连接端马上离线，正在等的确认留在本机。

### 操作界面、续传和上线前的复核（第 362–365、370–373 步）

- 第 362 步，连接端操作界面：
  - 远程任务页顶上标「可操作」或「只读」。
  - 项目开放了「可查看和操作」时，底下有对方发来的确认卡片（复用本机的 `PermissionCard`，只有「允许一次」「拒绝」）和输入框（`RemoteComposer`；第 395 步起换成本机的输入框，对方是 0.3.x 时还用它）。输入框只发文字，Enter 发送；运行中多一个停止；对方在跑时提示消息排队了。
  - 侧栏里这样的项目右边除了设备图标还有加号，在对方那边新建任务（`RemoteNewTaskDialog`），建好后打开它。
  - 对话本身照旧是 `readOnly`：撤销、重新生成这些远程都不能做。
  - 确认卡片在断线、对方答完（`permission.settled`）、本机答了之后收起。被连接端在对方重新订阅时再发一次还在等的确认，连接端关掉任务页再打开也能看到。
- 第 370 步，删除和放弃配对时通知对方：
  - 连接端删除设备时，对方在线就先发 `device.forget`，被连接端照办，撤销对它的授权，操作记录写「对方删除了本机，撤销授权」。这个请求只会收紧权限，所以直接照办。
  - 配对握手完了却没配成（取消、等太久、出错），连接端在配对通道上发 `pair.cancel`，被连接端收起确认弹窗、作废邀请串。
  - 还剩一个竞态：本机的人点允许和对方取消几乎同时发生时，仍可能留下一条对方没存的授权，在授权列表里能看到、能撤销。要彻底去掉得等对方确认收到结果再存授权，没做。
- 第 371 步，断线续传：
  - 被连接端给有人看过的会话记一段最近的动静（脱敏后的更新和一轮开始），每个会话最多 5000 条、约 4 MB，没人看满 5 分钟就丢。
  - 记录的边界：`floor` 之后的更新都在，一轮开始按开始时的最后一个序号（`afterSeq`）排。最早的被挤掉时 `floor` 往后挪。core 重启（epoch 变了）就重新记，撤销时删掉。
  - 连接端记下看到的 epoch 和 seq；通道断了以后重新订阅时带上，对方接得上就回 `resumed`，按顺序补发缺的部分，不重取整页；接不上照旧给快照。只有断线后才带位置，一轮结束、撤销后的重新订阅仍取整页（`stopReason` 这些不在更新里）。补发的一轮开始可能和已有的重复，连接端按轮次 id 去重。
- 第 372 步，侧栏搜索和 Ctrl+K 搜索也找远程会话：远程会话只有列表在本机，所以只按标题找，排在本机结果后面，标「设备名 · 项目」。
- 第 373 步：渲染进程改用 core 的 `DEEP_SCAN_TITLES`，不再自己存一份。
- 第 364 步，安全复核：
  - 按威胁模型 9 条逐条对代码核对，都有对应的实现和 e2e。
  - 补上一条：跨出项目授权的权限请求由 core 打 `LOCAL_ONLY_META_KEY` 标记，被连接端不转给远程。包括项目外的文件、读本机终端、智能体给别的任务发消息或新建任务、改用用户自己的浏览器。
  - 代码审查（加密、协议、主进程的设备连接代码）报了 8 条，修了 5 条：
    - 读请求也限流：每台设备每分钟取快照 60 次、列表 180 次；
    - 一条消息只发出去一半时丢掉整条通道；
    - 项目降成只能看时收回已经发出的确认；
    - `lastSeqs` 只记有人看的会话；
    - 判断测试数据目录时按真实路径比。
  - 没修的 3 条：
    - 界面 30 秒没回应时连接端看到失败，但这个操作之后可能还是做了，连接端重试的话会重复；
    - 上面说的允许和取消同时发生的竞态；
    - 每次远程操作都取一遍完整的会话列表，会话很多时浪费，但在限流之内。
  - 打包版连本机中转：只在数据目录是系统临时目录下的 `diffra-e2e-*` 时，才认 `DIFFRA_RELAY_URL`、`DIFFRA_INVITE_TTL_SECONDS`，正式数据目录下设了也不管用。打包版跑设备 e2e 4 个全过。
- 第 363 步：隐私政策加了「设备连接（默认关闭）」一节，写明怎么传、服务器能看到的元数据、中转日志保留 14 天、对方能看到什么、「可查看和操作」的含义；「一句话说清楚」「我不做的事」相应改了。快速开始加了「设备连接」一节。`build:website` 的站内链接检查通过；没有发布到官网。
- 第 365 步，真实网络验证（2026-11-11）：
  - 只有一台电脑，两个开发版实例在同一台机器、同一个网络里，经正式的 `relay.diffra.dev`。不是方案说的两台机器、两个网络。
  - 测得的数：
    - 登录中转约 260 毫秒；
    - 粘贴邀请串到对方弹出确认约 350 毫秒；
    - 列表请求往返中位数 29 毫秒、最慢 58 毫秒；
    - 取一页快照 75 毫秒（单段回答在 64000 字处截断，这一页约 65000 字）；
    - 实时更新比本机晚约 370 毫秒，其中包含 150 毫秒的攒批。
  - 下载更新包的前 16 MB：单独下 27.7 Mbps；同时连续订阅（5 秒 113 次，超过每分钟 60 次的被拒）时 25 Mbps，只测了各一次。
  - 服务器上中转进程的日志只有连接、断开（设备 ID 前 8 位和 IP）；nginx 访问日志每条连接一行（请求行、状态码、字节数、客户端标识）。搜测试内容一条都没有。

### 互相配对时的拒绝、重试和图片（第 374–378 步）

起因：0.3.0 发出后，用户两台电脑互相配对，B 看 A 的任务报「对方不在线，或者对方已经不再授权本机」，标题只有「…」、还显示「只读」，但 A 明明开放了「可查看和操作」。
- 测试时 A 是 0:56 启动的开发版：electron-vite 的开发模式只热更新界面，主进程和 core 不会重新构建、也不会重启，所以 A 跑的是 360 之前的主进程。开发版改了主进程的代码，要重启 `pnpm dev`。
- 真正的缺陷在于：中转按「双方都把对方加进了白名单」来判断在线，而白名单 = 授权的设备（开着总开关时）+ 自己连接的设备。互相配对时，A 即使没接受 B（总开关关着、没授权或者撤销了），B 也在 A 的白名单里，中转仍然告诉 B「A 在线」。这时 A 收到 B 建通道的请求，悄无声息地不理，B 等满 10 秒才报那句笼统的话。单向配对的 e2e 测不到这种情况。
- 第 374 步：远程任务页的「只读 / 可操作」和标题，先按列表里已知的信息显示，不等订阅成功。
- 第 375 步：订阅失败时报错条上有「重试」。对方在线、又不是明确拒绝的，自动隔 2、4、8 秒各重试一次。
- 第 376 步：
  - 被连接端不接受时回「拒绝」直发帧（`DIRECT.deny`），带上原因：总开关关着，或者没授权。被连接端主动关掉通道（关总开关、撤销、发不出去、出错）时，通知连接端（`DIRECT.closed`）。连接端用一条被连接端那头已经没有的通道发消息时，也回这个通知，让它重建，不再等到 30 秒超时。这两种通知没有加密认证，中转能伪造，但最多让连接端以为连不上，和中转丢帧一样，不会扩大权限。
  - 连接端建通道失败时分清原因、照实说：中转断了、10 秒没回、握手失败、对方关了总开关、对方没授权本机、本机没有对方的公钥。被明确拒绝时，侧栏收起对方的项目，正在看的任务停在这个原因上，不自动重试，等用户点「重试」。
  - 设备连接出问题的节点（建不起通道、拒绝和被拒绝、通道出错、请求格式不对、读快照失败、配对握手失败）同时写进 `userData/logs/remote.log`。超过 1 MB 挪成 `remote.old.log`；只记设备 ID 前 8 位，不记内容。出问题时让用户把这个文件发过来。
- 第 377 步，提问图片压缩后同步：
  - 主进程的 `nativeImage` 解不了 WebP（实测，PNG 可以），而提问图片存的就是 WebP，所以压缩交给被连接端的界面，用 canvas 压成长边 1024、质量 0.7 的 WebP（`shrinkImage`）。主进程经 `remote:compress` 请求，15 秒没回或者没有窗口就当压不了。
  - 取快照时，从新的轮次往旧的放，一页图片最多 120 万字（中转每秒约 200 KB，一页几秒内能到），一张最多 40 万字。超出的、压不了的只写张数。压过的按轮次 id 缓存，最多 800 万字，压不了的不缓存。
  - 实时那条路不等压缩：「一轮开始」只带图片张数，连接端先显示「带了 N 张图片，这一轮跑完后显示」，这一轮结束重新取快照时图片才过来。这样实时更新的顺序不受压缩耗时影响。
  - 连接端按 `messages.ts` 校验：类型只认 `PROMPT_IMAGE_TYPES`、必须是 base64、一轮最多 6 张。界面拿它拼 `data:` 地址，CSP 本来就允许 `img-src data:`。工具输出里的截图本机界面不显示，照旧不发。
- 第 378 步，e2e：
  - 第三个用例改成：第一轮的图同步过来；正在跑的那一轮先显示张数，跑完后看到图，本机存的是 1600×800，连接端收到的是 1024×512。
  - 新增第五个用例「互相配对」：A 关掉总开关后，B 5 秒内看到「对方关掉了「允许连接本机」」，中转上 A 仍显示在线；侧栏收起 A 的项目，3 秒后仍不自动重试。A 重新打开后，B 点「重试」恢复成「可操作」。A 撤销 B 后，B 看到「对方没有授权本机」。两边的 `remote.log` 里都有记录。
  - 没有在 0.3.0 的旧代码上跑这个新用例来复现原问题；按代码看，旧代码会等满 10 秒、报那句笼统的话，新用例要求 5 秒内报准确原因，在旧代码上会失败。

### 大消息让中转断开被连接端（第 382–387 步）

起因：0.3.1 上 B 看 A 的旧任务一直报「对方 10 秒没有回应」，新建的任务能看。中转日志里 A 在 3 分钟里被断开 11 次，每次都是 `Max payload size exceeded`。
- 原因：一条消息切片时，片头 1 字节加数据正好填满一条 Noise 消息（加密后 65535 字节）；桌面端再加 1 字节直发种类，中转帧再加 1 字节类型和 16 字节 ID，一共 65553 字节，比中转的单帧上限（`MAX_FRAME_BYTES` = 1 + 16 + 65535，也是 ws 的 `maxPayload`）多 1 字节，中转直接断开 A 的整条连接。
  - 只有压缩后超过约 64 KB、要切出整片的消息才会碰到：那个旧任务第一页（最近 4 轮）压缩后 75 KB，新任务一页不到 64 KB。
  - 从设备连接第一版就有。之前 e2e 发的页都小于 64 KB；分片和中转的单测各管各的那层，没人把几层的头加起来算过。
- 后果：A 被断开后 1 秒左右重连，B 看到 A 上线马上重新订阅，A 一回快照又被断开；B 一直开着那个任务就一直循环。B 的握手撞在 A 断开、重连的空档里，只能等满 10 秒报「没有回应」。这期间 A 和别的设备的连接也跟着断。
- 用户猜是会话太长、带宽不够，想先加载近期、后台再补全。快照本来就只发最近一页，第一页 75 KB，按每秒 200 KB 不到半秒；后台补全整个历史会占满同一条限速的出站队列，握手和实时更新都要排在后面，不做。
- 第 387 步：
  - `@diffra/remote` 每片少放 1 字节（`CHUNK_DATA = NOISE_MAX_PAYLOAD - 2`），整片加密后 65534 字节，加上直发种类和中转帧头正好到上限。旧版收片不看片的大小，所以只要发的一方（被连接端）升级，不用改中转。
  - `relay-client.ts` 发之前再查一次帧长，超了不发、记日志：只丢这一条通道，不让整台设备被中转断开。
  - 不改中转的上限：要重新部署，旧客户端收到超长的帧也会丢掉。
- 第 382 步：中转回「送不到」时（对方不在中转上，或者对方的白名单里没有本机），正在建的通道马上失败，报「对方现在不在线」，不再等满 10 秒。原先「送不到」只给配对用，建通道时被忽略。
- 第 383 步：和中转断开时 `remote.log` 记关闭码、原因、连了多久，只记登录过的连接（连不上时不按退避一遍遍记）；60 秒没收到中转消息、主动断开时也记一条。这次要上服务器看中转日志才知道原因，以后看本机日志就够。
- 第 384 步（自动重试用完后，对方重连时再试一轮）不做：一直停在报错上是断开循环造成的，修了 387 就没有了。
- 验证：
  - e2e 新增第六个用例：被连接端的回答是 6 万个伪随机汉字（压缩后约 110 KB），连接端看到的和原文一字不差，中转日志里除了连接没有别的记录；被连接端关掉总开关后，连接端直接要列表，3 秒内报「对方现在不在线」，`remote.log` 里有 `offline`。
  - 先在没修的代码上跑这个用例：连接端在「读取中」「对方已离线」「对方 10 秒没有回应」之间来回，和用户看到的一样；修了 387 后前半段通过、后半段仍等满 10 秒；修了 382 后通过。
  - 第一个用例重启中转后，两边的 `remote.log` 都有「和中转断开」。
  - `@diffra/remote` 加单测：整片加密后是 65534 字节，加上 1 字节种类和 17 字节帧头不超过中转上限；临时改回旧的分片大小跑，这条会失败。
- 以后改帧格式（种类、帧头、加密开销）时，把各层加起来和中转的 `MAX_FRAME_BYTES` 比一遍。

### 远程任务页和本机一样（第 389–400 步）

起因：两台都升到 0.3.2 后，B 能看 A 的旧任务了，但往前翻一次只多出一轮；远程任务页也没有审阅改动、任务监控、终端，不能切模型、切分支。用户要求和本机几乎一样，并定了三个前提：新增「完全控制」级别；浏览器这次不做；切换分支本机和远程一起加。

- 往前翻（第 389–392 步）：
  - 原因：一页按 100 万字原文封顶，旧任务里大的轮次每轮 50 万到 140 万字，其中 75% 以上是工具输出（`tool_call_update`），一页只放得下一两轮（43 轮分成 15 页）。
  - 第 389 步：快照里读取、执行、搜索三类工具的文字输出只发前 2000 字，文字块的 `_meta` 里记全文长度（`TOOL_PREVIEW_META_KEY`）；展开时连接端用 `session.toolOutput` 按「位置 + 轮次 id + 工具调用 id」要全文。改动块不截（界面要按顺序重放改动），完成、计划、审查这类默认展开的卡片原样发。
  - 第 390 步：一页按压缩后不超过 500 KB 装（最多 10 轮，至少一轮），先向 core 要最多 800 万字原文再挑。那个旧任务从 15 页变成 7 页，多数一页 6–10 轮；有一页只有一轮，那一轮光思考就有 23 万字。方案里先说的「300 KB、7 页」模拟时把改动块也截了，不成立，所以改用 500 KB。
  - 第 391 步：滚到顶以后继续往上拉（滚轮、触控板），顶上那一行跟着变高，拉够 64 像素就取一页；点那一行也能取；全取过以后说「已经是最早的一轮」。往前插内容后，按多出来的高度把正在看的位置留住：浏览器的滚动锚定在滚到顶时不起作用，所以滚动层关掉 `overflow-anchor`、自己算。拉的那一行不加过渡动画，否则加载那一刻内边距还在变，位置会偏（整套 e2e 时出现过一次偏 13 像素）。
  - 后台自动补全整段历史没做：会占满同一条限速的出站通道，握手和实时更新都要排在后面。
- 第 393 步「完全控制」：授权的第三级，在「可查看和操作」之外能开终端、把权限模式切成「完全访问」，等于执行任意命令，不限于开放的项目。授权时有红色提醒；本机横幅写「能在本机开终端、执行任意命令」和开着几个终端。协议里 level 仍写 control、另带 `full: true`：0.3.x 的连接端只认 view、control，多一个值整张列表都会被它丢掉。
- 第 394 步，远程任务页改用本机任务页（`TaskPage`）：
  - 被连接端：主进程按级别校验后交给本机界面做（`RemoteTaskCall`，`askHost` → `handleRemoteTaskCall`；界面在后台载入任务、用本机现成的逻辑），结果由主进程脱敏后发回。任务配置（`session.details`）里 Git Bash 只说有没有，禁止修改的目录换成相对项目的；文件改动（`session.diff`）里可能含密钥的文件只留文件头和一行说明，整份最多 200 万字、截在文件边界。
  - 连接端：新请求走通用的 `remote:call`，主进程按协议校验请求和回复。`TaskPage` 接收远程插槽（顶栏的设备和级别、离线和出错提示、输入框那一块、取更早的一页、对方的项目设置和分支、终端）；`RemoteTaskContext` 让任务监控、审阅改动、上下文用量这些部件知道是远程任务：文件改动向对方要，本机才有的 MCP 状态、改检查命令、深度扫描、设置跳转不显示。
  - 兼容：列表里带接口版本 `api`（`REMOTE_API` = 2）。对方是 0.3.x 时连接端不发新请求（老版本收到不认识的请求会当成格式不对、断开通道），任务页退回只有对话和旧输入框。
- 第 395 步，「可查看和操作」能做的：用和本机同一个输入框；切换模型（对方的模型服务不带地址和密钥提示）、切换权限模式（完全访问要「完全控制」）、先出计划和目标模式、带图片、Skill 和自定义命令、压缩上下文；对话里撤销（先列出会改回去的文件）和重新生成。每个操作都在对方记审计。MCP 提示词、附文档（本机文件）、优化提示词、深度扫描、撤回排队，以及「继续」「定位问题」这类绑定本机操作的按钮，远程不显示。
- 第 396 步，远程终端：只有「完全控制」的项目能开，起始目录是项目目录。被连接端的 `HostTerminals` 把输出攒 30 毫秒一批发、一批最多 64 KB，积压超过 512 KB 就丢掉中间、留一句说明；每台设备最多 3 个；通道断了、授权降级、撤销时结束。连接端输入攒 20 毫秒一发，单独限流（每分钟 3000 次，不占操作的 30 次）；关掉面板、离开任务时请对方结束。
- 第 397 步，切换分支（本机和远程）：任务页底栏的分支名变成菜单，列出本地分支。项目里有任务在跑、工作区有未提交的改动时不切，不替用户暂存或丢弃改动；分支名只认普通的本地分支名，不以 - 开头。实现在 `main/project-branch.ts`，远程（`project.branches`、`project.switchBranch`）走同一套检查。
- 第 398 步，远程不做的：浏览器、设计画布、架构页和待办、电脑之间直连；远程任务页上这些按钮不显示。
- 不带对方电脑上的完整路径（第 401 步：e2e 截图里连接端的编辑卡、完成卡显示 `D:/…` 的完整路径，和「项目只给文件夹名」的约定不符）：
  - 统计了用户本机的会话：路径字段里，改动块的 `path` 全是项目内的绝对路径（编辑卡、完成卡的文件列表都从这里来），工具参数里的 `path` 本来就是相对的；工具标题里带路径的是「执行」的命令和「浏览器」，引用的都是项目外的路径。
  - 被连接端发出去之前（快照、实时更新和续传记录、工具输出全文、权限请求、一轮开始、会话列表的标题、任务配置、Skill 和命令列表）都过一遍 `hidePaths`：路径字段（`path`、`file_path`、`cwd`）在项目里的换成相对项目的（斜杠统一成 /），在用户目录里的换成 `~/…`，别处只留文件名；普通文字里只把项目目录换掉（`D:\proj\src` → `src`，项目目录本身 → `.`）、用户目录换成 `~`（不暴露 Windows 用户名），名字相近的目录（`proj-old`）不算。会话的项目目录在取快照时记下，实时更新、续传、权限请求按它换。
  - 不动的：改动卡片的 `oldText`、`newText`、`base`（界面按原文重放改动）；文字里别的绝对路径（只能尽力）；任务改动的差异本来就是相对路径；远程终端（「完全控制」本来就能看到整台电脑）。
  - 连接端不用改：界面的 `relativePath` 遇到相对路径原样显示，改动重放按路径对得上。
  - 验证：`@diffra/remote` 单测（路径字段、文字里的前缀、大小写和斜杠混用、名字相近的目录、`oldText` 不动、不知道项目目录时）；e2e「借用本机任务页」加了断言：编辑卡显示 `hello.txt`，连接端整页文字里不出现对方项目目录的完整路径（改之前那张截图里是 `D:/Claude/temp/…`）。
- 第 400 步，验证：
  - e2e（`devices.spec.ts`）新增 6 个用例：一页按压缩后的大小装、上拉取更早的一页（位置不动）、展开取全文；「完全控制」的提醒和横幅；远程任务页借用本机任务页（任务监控、审阅改动、只读时没有撤销）；可操作时切换权限模式（完全访问被拒）、撤销一轮改动、任务监控跟着刷新；远程终端（命令和输出都回来、横幅写开着几个、关掉后对方结束、能切完全访问）；切换分支（本机切、有未提交改动时不切、远程切）。本机 e2e 全套 97 个全部通过。
  - 单测：`@diffra/remote` 45 个（`previewTurn`、`redactDiff`、协议里的 full 和新请求）、relay 12 个；全部类型检查通过。
  - 没有 e2e 的：远程切换模型（测试里只配了一个模型）、压缩上下文、重新生成、带图片和先出计划发消息、Skill 和命令列表、授权降级时终端结束、对方是 0.3.x 时退回旧页面。
  - 整套跑设备连接用例时，配置模型的辅助函数有一次点「自定义」选项超时（选项一直不稳定、被移出页面），之后单独跑和两次整套都没再出现，原因没查到。

### 左下角的设备和用量（第 402–408 步）

用户要把顶部的设备横幅挪到左下角，考虑连多台设备的情况，要有新意；再加一个点开能快速看用量的地方（参照 Claude 桌面版左下角的账户菜单）。第 402–406 步先做了「设备头像串 + 本机行」，用户看了觉得「本机」和电脑名不好看，第 407 步整个换成小 dock，头像串和「本机」行作废（`LocalMenu.tsx` 删了）；用户看了 dock 还是觉得不对，改成竖着排，dock 也作废（`SidebarDock.tsx`、`DockButton.tsx` 删了）。

- 侧栏最底下竖着排三行，样子和侧栏上面「设计」「架构」那几行一样：图标、名字，右边写一点状态（`features/shell/SidebarFooter.tsx`、`FooterButton.tsx`）。两个面板从行的右边弹出，底边和行对齐。
  - 「设备」：右边是在线台数（没有在线的不写）；有设备能操作本机时图标和台数是琥珀色（不用成功色，见颜色门禁）；设备刚做完操作，台数闪 4 秒。没配对过设备时照常在，点开说去「连接设置」里配。
  - 「用量」：右边不写数（第 544 步起；以前写「今天 N」，今天的 token），点开看今天、近 7 天、本月的构成。
  - 「设置」：在设置页时是选中的样子；可访问名称仍是「设置」，原来的 e2e 照样点得到。
- 设备面板（`features/devices/DevicesOverview.tsx`，宽 320px，和用量面板一样宽，离侧栏 8px，离窗口边至少 8px）：
  - 标题「设备」，右上角「连接设置 →」；中转只在连不上、出错时在标题下说一句。
  - 所有配对过的设备按 id 合成一份（互相配对的只出一条），分「连着本机 · N」「本机连接的 · N」两组；能操作本机的在线设备排最前，再是在线的，离线的按最后在线时间。
  - 每台：首字头像（能操作本机的是琥珀色底和圈）、名字和级别标签（可查看和操作、完全控制是琥珀色，可查看是灰色）、一行「N 个项目 · 在线 / 刚刚操作过 / 几分钟前操作过 / 本机也连着它」，下面是「正在看「…」」「N 个终端」小标签；本机连接的设备写对方开放了几个项目。能操作本机的有「断开」（撤销授权，先确认）。
  - 被连接端多记了每台设备正在看的任务（订阅成功、续传时记下标题）和最近一次操作的时刻，和终端数一起放在 `RemoteGrantView`，变了就通知界面（`activityChanged`）。只记时刻、不记是什么操作，所以写「刚刚操作过」，不写「发了一条消息」。
- 标题栏的提示（第 404 步，不变）：去掉了窗口顶部占一整行的横幅，改成标题栏右边（系统窗口按钮左边）的琥珀色提示，只在有能操作本机的设备在线时出现，写「「X」能操作本机」或「N 台设备能操作本机」，有终端时加「开着 N 个终端」，点开是同一个设备面板。标题栏在任何页面都在，侧栏收起、在设置页时也看得到，原来「能操作本机时一直有提示」的保证不变。
- 用量面板（`features/shell/UsageMenu.tsx`，宽 320px）：
  - 顶部切换「今天 / 近 7 天 / 本月」，右边「用量详情 →」。打开、切换时才读。
  - 总数和调用次数，和上一个同样长的时间段比（今天比昨天这时、近 7 天比前 7 天、本月比上月同期；上一段是 0 时不写）。
  - 构成条：缓存命中、新增输入、输出、推理（和用量页同一个 `compositionOf`、同样的颜色）；柱状图今天和近 7 天画 7 天（下面标星期），本月每天一根。
  - 按模型：前两个和「其他 N 个」，带占比；用得最多的任务前 3 个，「标题 · 项目」，点一下打开。
- 不做的：金额（用量日志里只有 token）；远程设备用掉的 token 单独算（日志里不记哪台设备发起）。
- 验证（第 406、408 步）：e2e「左下角的设备和用量」：三行一样宽、左边对齐、从上到下是设备、用量、设置；一台可查看和操作、一台可查看的设备配对后，设备那行写 2、琥珀色；面板分组、级别标签、能操作的排最前、「正在看」标签，只能看的没有断开；「连接设置」跳到设备连接；标题栏提示在收起侧栏、进设置页时都在；用量那行写的「今天 N」和用量统计接口一致，面板今天的总数、按模型（scripted 100%）、任务；切到近 7 天总数跟着变；点任务打开它；「用量详情」跳到用量页。原来检查横幅的用例改成检查标题栏提示、在设备面板里断开。浅色、深色截图核对过。

## 内核改进：参照 qwen-code（第 437–448 步）

- 定位：不换内核。把 qwen-code 里成熟、Diffra 还没有的做法搬进自己的主循环，权限、检查点、完成门禁、ACP 接口都不动。
- 会话记录按轮分文件（第 437 步，磁盘格式 2）：`sessions/<id>.json` 只放头（标题、项目、对话消息、每轮除更新以外的信息），每轮界面要重放的更新单独存成 `sessions/<id>/<轮次 id>.json`。
  - 原因：以前每次保存都把整份记录重新序列化、重写一遍，实测一个 38 MB 的任务每次保存约 160 ms，一轮里要存很多次。现在只写头和变了的那一轮（按「条数 + 最后一条」判断变没变），同一个任务首次保存 301 ms、之后约 20 ms、重新载入 111 ms。
  - 旧的单文件记录第一次保存时转成新格式，转之前原样复制成 `<id>.json.v1-backup`，不自动删；删除任务时连同目录和备份一起删。读的时候两种格式都认，载入后内存里的结构不变，`session/load` 给界面的东西也不变。
  - 某一轮的文件坏了只丢那一轮的显示内容（当成没有更新），不影响整个任务打开；轮次 id 里有不能当文件名的字符时用哈希当文件名。
  - 「设置」里的会话占用按目录递归算。
- 模型服务出错（第 438 步），三层，互不叠加：
  - 请求还没开始返回：交给 AI SDK 重试 3 次（指数退避 2、4、8 秒，会看服务给的 Retry-After），以前是 2 次。
  - 回复到一半断开或报错（限流、5xx、网络）：只说了文字的，把已经说的那段当成模型的回复放回对话，接一句「回复被打断了，从断开的地方接着说，不要重复」，下一步续上；什么都没说或已经出了工具调用（还没执行）的，隔 2、4、6 秒整步重发，一步最多 3 次。界面上已经显示的半截文字留着。
  - AI SDK 已经重试到头的错误（`RetryError`）不再进第二层，不然一个连不上的服务要等好几分钟才报错。
  - 流里报的错先记下、中断这次请求、把流读完再抛（`models/stream.ts` 的 `streamParts`，主循环、压缩、评审、提示词优化、架构解读五处读流的地方都用它）。以前在 `for await` 里直接抛或 break：模型还没有任何输出就报错时，流被取消，AI SDK 内部会留下一个没人接的 rejection（原因是 undefined），core 里没有兜底的处理。已经有输出之后才报错的不会。中断请求是为了服务报了错却不关连接时不用干等。
  - 还是不行且是限流或过载（429、503、529）时，和检查卡住一样换兜底模型接着做；没配兜底模型或已经换过就照常报错停下。
- 太长的命令输出存盘（第 439 步）：`run_command` 的输出照旧截短后给模型，完整输出另存到 `sessions/<id>/outputs/command-<时间>-<随机>.txt`，截短的地方写明路径，模型可以用 `read_file`、`search` 看省掉的部分（这个目录对它只读）。每个任务只留最近 30 个，删任务时一起删；存不了只记日志，命令结果照常返回。
- 原地打转的提醒（第 440 步，`session/spin.ts`）：原有的卡死检测只认「同一个调用、结果也一样」。补三种，都只提醒一次、不停下（提醒错了多一句话，停错了打断正常任务），成功改了文件就重新算：
  - 同一个调用（不看结果，比如输出里带时间）出现 6 次；
  - 连续 12 次只读、只搜（这一轮刚开始摸代码、还没做过别的事时不算）；
  - 同一段话（20 字以上）说了 3 次。
- 步骤清单 `todo_write`（第 441 步）：任务有好几步时模型列出步骤并随做随改。一轮一张「步骤」卡（id `steps-<轮次>`，整份重发），对话里和任务监控的「步骤」一节都显示；只是给用户看的进度，不参与完成门禁，和 `task_progress` 的完成条件是两回事。
  - 第 465–466 步收紧：真模型评测（第 460 步）里 10 道小题有 8 道都列了清单，每题调用 3–4 次、每次单独占一轮模型调用（39 次里没有一次和别的工具同发），小题平均慢了约 20%。原因是「三步以上才用」几乎总成立：任何改代码的任务都能拆成查看、实现、验证三段。
    - 现在只在任务跨好几个模块、或者用户一次提了好几件事时才列；普通的读、改、测不列。更新要和下一个工具调用放在同一次回复里发（工具说明和系统提示词各写了一句）。
    - finish 通过时 core 替模型收尾（`interact.ts` 的 `settleSteps`）：进行中的那一步标成做完，没开始的照旧，不替它谎报没做的步骤；模型不用为了打勾再调一次。只认这一轮的清单（`Session.stepList`，每轮开始清空，重新生成也一样）。
    - 效果（第 468 步，同一模型、前 10 道小题各跑 1 次）：步骤清单从 31 次降到 2 次，模型调用 166 → 112 次（v0.3.3 是 130），平均每题 90 秒 → 66 秒（v0.3.3 是 74 秒），没命中缓存的输入 288k → 254k，10 道全部通过、完成检查都跑了。模型自己跑测试、记完成条件的次数也跟着少了（run_command 17 → 5、task_progress 18 → 4），检查交给 finish 统一跑。
- 中途提问 `ask_user`（第 442 步）：一个会改变做法、代码和对话又定不下来的选择，模型给出 2–4 个选项问用户，界面是一张「智能体想先问你一下」的卡片，最后一项固定是「都不选，我来说」（选了就告诉模型：说清楚想知道什么，然后停下等用户的消息，不要猜）。
  - 走权限请求的通道（scope `ask-user`），不新开协议方法；只有主智能体能问，子智能体不能。远程任务里这张卡只在执行的那台机器上显示，和深度扫描的询问一样（第 673 步改了，见下）。
  - 第 673 步扩展：一次最多 4 个问题，界面分成选项卡（左右方向键切换，答过的标对勾，单选选好后跳到下一个没答的）。每个问题是：
    - 选择：2–6 个选项，`multiSelect` 可以多选；选项可以带项目里的预览图（PNG、JPEG、WebP、GIF，不超过 400 KB）。core 读好放进确认请求，界面、远程设备都不用再读文件；路径出了项目、太大、格式不对时不问，把原因交给模型。
    - 滑块：`min`、`max`、`step`（默认 1）、`unit`、`default`，最多 1000 格；有默认值，算已经答了。
    - 选文件：本机用系统选择框（从项目目录开始，只收项目里的文件，项目外的只提示个数），也能手输相对路径（先查在不在项目里）；远程任务只能手输，由对方的 core 校验。
  - 参数改成 `questions` 数组（和 Claude Code 的 AskUserQuestion 一样的结构，模型熟）。只有一个单选问题时照旧点选项就是回答（optionId 是 `ask-user-option-N`）；其余填好后「提交」（`ask-user-submit`），答案按问题顺序放在确认回复的 `_meta.diffra.askAnswers`，core 按问题逐个校验（序号在范围里、单选只有一个、滑块在范围里且在刻度上、文件在项目里存在），有一个不对整份当没答。主进程和远程协议只限答案的形状和大小（`askAnswersSchema`，在 `packages/remote/src/messages.ts`）。
  - 可操作的远程设备也能答（用户定的）：core 不再给提问标「只在本机确认」；被连接端把提问的全部选项、问题发给正看着这个会话、能操作的设备，预览图不同步（和工具输出里的图片一样），只标出这一项有图；连接端提交的答案照样交给 core 校验。谁先答算谁的，审计日志写「远程回答了提问」或「远程没回答提问」。
  - 选项按钮的名字只是选项本身，说明用 `aria-describedby` 另外读。
- 同一步里的只读调用并行（第 443 步）：模型一次回复里连续的 `read_file`、`list_files`、`search`、`outline` 同时执行，最多 8 个一批，结果仍按原顺序放回对话。只限项目内的相对路径；绝对路径、带 `..` 的可能要问权限，照旧一个一个来。改文件和命令不并行。
- 压缩后重新附上文件（第 444 步）：写摘要时把被压掉的那段里最近读过、改过的文件按当前内容附在摘要后面，免得模型压缩后第一件事是把刚看过的文件再读一遍。最多 5 个、每个不超过 8000 字、合计不超过窗口的 6%；受保护的文件、保留的最近 4 步里已经有的不附。
- 项目里始终允许的命令（第 445 步）：命令确认卡多一个选项「这个项目里始终允许同类命令」，写进这个项目的设置（`allowedCommands`，同类键和「本任务始终允许」一样是「程序 + 子命令」），以后这个项目的新任务不再问。
  - 「项目设置 → 始终允许的命令」可以看、改、删，用逗号或换行分开。存在应用设置里，不在仓库里：克隆别人的项目不会带来已经放行的命令。
  - `rm`、`rmdir`（`NEVER_REMEMBER`）不记：确认卡上没有这个选项，在项目设置里手填了也不生效。无项目任务没有这个选项。直接拦下的危险命令、碰到禁写目录或可能读到密钥文件的命令不受它影响，照旧拦、照旧问。
- 自动记忆（第 446 步，`session/memory.ts`）：「设置 → 任务执行 → 自动记忆」，默认关（每轮多一次评审模型的调用）。一轮正常结束后在后台从这一轮的提问和回答里挑最多 3 条以后还用得上的事（用户说的偏好和纠正、不明显的项目约定、要用的命令），追加到应用数据目录 `memory/<项目>/MEMORY.md`；新建、载入任务时写进系统提示词，写明「自动记的，只当线索，用之前对照代码」。
  - 容量：最多 60 条，满了丢最早的；每条最长 200 字；写进提示词的不超过 4000 字。像密钥的条目不落盘。文件是普通 Markdown，用户可以直接改、删。
  - 提取失败只记日志，不影响这一轮。无项目任务没有记忆。
- 项目钩子（第 447 步，`session/hooks.ts`）：「项目设置 → 钩子」三个时机，各填一条命令，存在应用设置里，和检查命令一样是用户自己信任的命令，不逐次确认。超时 60 秒。
  - 改完文件后（`DIFFRA_FILE`）：比如跑格式化。钩子改了文件就告诉模型重读；钩子失败把输出告诉模型，不拦。
  - 执行命令前（`DIFFRA_COMMAND`）：退出码 2 拦下这条命令，输出给模型看；其他退出码不拦。
  - 一轮结束时（`DIFFRA_STOP`、`DIFFRA_FINISH`）：不等它跑完，比如发通知。
  - 钩子自己坏了不拦事情，免得一个写错的钩子让任务没法做。
- 自定义子智能体类型（第 448 步，`subagents.ts`）：项目的 `.diffra/agents/*.md` 或用户目录的 `~/.diffra/agents/*.md`，开头的 frontmatter 写 `name`、`description`，可选 `mode: read-only`，正文是给这类工人的说明；同名认项目里的，最多 20 个；开着的插件的 `agents/` 也读（第 599 步，见「扩展页」一节）。`delegate` 多一个可选参数 `agent`：工人的提示词后面接上这段说明，`read-only` 的不给改文件、跑命令、认领文件和设计工具。没写类型的工人和以前一样。
- 不做（以后再说）：qwen-code 的 JSONL 追加式记录（按轮分文件已经解决了保存慢）、编辑的模糊匹配（逐字一致是压缩后不改错的前提）、记忆的界面管理、更多钩子时机、子智能体用单独的模型。
- 验证：core 单测覆盖以上各项。界面上的新东西（步骤卡、提问卡、项目设置的两栏、自动记忆开关、「这个项目里始终允许」的保存）还没有 e2e，也没在界面里实际点过；`e2e/edit-diff.spec.ts` 按新的会话文件格式改了读法，没跑过。

## 内核改造：参照 Codex（第 503–518 步）

- 起因：内核越修越往 Diffra 自己的发版流程上靠（发版契约、关键词判断、完成条件和证据），不像一个通用的编码智能体。参照 Codex（openai/codex，2026-11 的 main）的内部实现重做内核；借鉴做法，不搬代码。ACP 接口、权限、检查点、安全检查、规范审查、子智能体、浏览器、设计、MCP、任务互通都留着。
- 下面推翻了前面这些段落里的对应内容：「Agent 核心（v0）」的基础工具、验证与结束分离、完成条件和发版契约、needsVerification 的拉回、no-finish；「长任务」的压缩做法；「斜杠命令、目标模式和 Skill」里的目标模式；「等外面的事做完：wait_command」；「内核改进：参照 qwen-code」里的步骤清单名字、只读并行、压缩后附文件、流式重试次数；「子智能体」里工人的工具。其余照旧。
- 工具照 Codex（第 506–510 步）：基础工具只有 `exec_command`、`write_stdin`、`apply_patch`，能看图的模型多一个 `view_image`；`todo_write` 改名 `update_plan`（参数 `{ explanation?, plan: [{ step, status }] }`）。read_file、list_files、search、outline、edit_file、run_command、wait_command 去掉：读文件、搜索用 `exec_command` 跑 rg、`sed -n`、cat。
  - `exec_command`：bash 跑，`yield_time_ms`（默认 10 秒，250 毫秒到 30 秒）到了还没结束就返回会话号，进程在后台接着跑，用 `write_stdin` 取新输出（空轮询 5 秒到 5 分钟）或发 Ctrl-C 结束。没有硬超时，开发服务器、watch、长构建、等 CI 都用它，所以 wait_command 不要了。和 Codex 一样不给终端：stdin 关着。每个会话最多 64 个进程，满了先清结束的、再清最久没用的，最近用过的 8 个不动。用户点停止时正在等的那个进程一起结束（Codex 不杀，Diffra 杀：停止就该停）；删任务、内核退出时全部结束，Windows 上桌面端退出时用 `taskkill /T` 连子进程一起结束。命令写成 `apply_patch <<'EOF' … EOF` 时当补丁处理，不起 shell。
  - 输出给模型时按 token 截（第 511 步，`process.ts` 的 `truncateForModel`）：默认 1 万 token（按 4 字节一个），头尾各留一半，前面写原来多少 token、多少行；MCP、浏览器、开发服务器的输出也按这个截，检查命令的输出截到 3000 token。完整输出照旧存文件。
  - `apply_patch`：Codex 的补丁格式，一次可以增、改、删、改名好几个文件。匹配逐级放宽（完全一致、忽略行尾空白、忽略首尾空白、统一弯引号和破折号），但上下文行保留文件原来的样子，不顺手改没要改的行（Codex 会用补丁里的上下文覆盖）。全部算完才写，一处对不上整份不写；CRLF 保留。去掉了「先读过才能改」的哈希检查：Codex 没有，对不上时补丁本身就失败。受保护文件、禁写目录、项目外授权照旧。改动卡片一个文件一份 diff，删除的文件写「删除」。
  - 只读的智能体（计划、定位、深度扫描、explore 工人）只能用 `exec_command` 跑只读命令（`isReadOnlyCommand`：每一段都是只读命令，没有重定向、命令替换）。`sed -n 'N,Mp' 文件` 算只读（和 Codex 早先的安全命令表一样），`nl` 也算。
  - 命令确认带上模型写的 `justification`，确认卡上显示在命令下面。
- 结束方式照 Codex（第 504 步）：没有 finish、verify_changes、task_progress、pause_task。模型不再调工具就是想结束这一轮，这时过结束门禁（参照 Codex 的 Stop 钩子，`loop.ts` 的 `runEndGate`）：这一轮改了项目里的文件（或从之前轮次带来待验证，或工作区指纹变了）就同时跑检查命令、安全检查、规范审查、架构检查；没过把问题作为一条用户消息交回去，模型接着改；过了这一轮才算完成。没改文件直接完成，不出完成卡。
  - 进展计数、gate-exhausted、换兜底模型、剩余错误带到下一轮这些规则不变。「改了文件不调 finish 被拉回」「no-finish」没有了：门禁自动跑，不用拉。
  - 完成卡标题照旧是「完成」，正文改成检查结论（「检查通过：pnpm test」），模型最后那段话就是总结。
  - 发版契约、关键词判断、完成条件和证据全部去掉，项目设置里也不加。任务状态只剩 running、waiting（只有提交前深度扫描用）、blocked、cancelled、completed，加 needsVerification 和 reason；旧记录里的 requirements、receipts 读进来丢掉，界面收到的 requirements 恒为空。
  - 用户停止时对话末尾追加一条 `<turn_aborted>` 标记（参照 Codex），下一轮模型知道上一轮是被打断的、命令可能只做了一半。
- 目标模式照 Codex 的 goal（第 505 步，`goal.ts`）：目标模式里多一个 `update_goal`（complete 或 blocked）。模型停下、过了门禁时，标了 complete 就结束；没标就自动开下一轮，续跑提示里要求它先按需求逐条找证据（完成审计）再标完成，同一个阻塞连着 3 轮才能标 blocked；轮数用完记 goal-exhausted。标了 blocked 停下时不跑门禁，状态受阻、原因用模型写的。
- 上下文（第 511 步）：系统提示词里不再放项目目录、系统、AGENTS.md，一个会话里不变，提示缓存一直命中。环境（目录、系统、shell、日期、时区、权限模式、禁写目录）和项目说明文件作为对话里的上下文消息发（`world-state.ts`）：每轮提问前和每一步调模型前比一次，第一次发全量，之后只发变了的部分（说明文件改了发「替换之前的」，删了发「不再适用」）；发过的那条被压缩掉、被撤销截掉，就当模型不知道、重新发全量。
  - AGENTS.md 照 Codex 找（`agents-md.ts`）：从带 `.git` 的项目根到任务目录，每一级按 AGENTS.override.md → AGENTS.md → CLAUDE.md 取第一个不是空的，合计 32 KiB（以前只读任务目录的 AGENTS.md 和 CLAUDE.md，合计 8000 字）。更深的子目录里的不自动读，提示词让模型改到那里时自己去看。
- 压缩照 Codex（第 512 步）：触发点是设置里的百分比，最高 90%；让编码模型写一份交接摘要，之后发给模型的只有用户每一轮提问的原话（从最近往前约 2 万 token）、交接摘要和重新补上的上下文，工具调用、输出和中间的回复都不再发。去掉了「先省略较早的工具输出」「保留最近 4 步原文」「附上最近读过的文件」（第 444 步）。压缩后还超过 95% 停下。写摘要的请求本身超窗时，从最早的消息开始丢再试（Codex 的做法）。messages 照旧保留原文，撤销、重新生成按位置截断。
- 模型服务出错（第 513 步）：回复中途断开最多重试 5 次，退避从 200 毫秒起每次翻倍、上下浮动一成（以前 3 次、隔 2、4、6 秒）；5 分钟一点输出都没有当断开，自动重试（以前只提示、不重试；3 分钟的提示照旧）。请求还没开始返回时 AI SDK 重试 4 次。
- 并行（第 509 步）：参照 Codex 的读写锁，只读的一起跑、改东西的一个一个来。同一步里连续的不用确认的只读命令、轮询后台命令、看项目里的图片、只读的 MCP 工具同时跑，最多 8 个，结果按原顺序放回对话。
- 系统提示词（第 514 步）：照 Codex 默认提示词的结构重写（工作方式、AGENTS.md、进度说明、计划、执行、验证、最终回复、工具用法），内容用自己的话写，Diffra 自己的东西（受保护文件、禁写目录、结束门禁会自动跑哪些检查、子智能体、提问、前端、Skill、记忆、编码规范）留着。
- 子智能体（第 515 步）：工人工具换成 exec_command、write_stdin、apply_patch（加认领、交结果）；只读类型只有只读 exec_command 和 write_stdin。工人对话第一条是全量上下文。
- 不做：Codex 的操作系统沙箱（Windows 上它默认也关着）、execpolicy 规则引擎、/review 的 JSON 格式、后台异步压缩、按模型换提示词模板。
- 测试（第 516 步）：`loop.test.ts` 按区域拆成 `loop-gate`、`loop-progress`、`loop-tools`、`loop-review`、`loop-context` 五个文件，共用的放在 `loop-helpers.ts`；只测已删除功能的用例（发版契约、完成条件、verify_changes、pause_task、wait_command 的关键字匹配、no-finish 拉回）删掉，其余按新行为改写。core 33 个文件 445 个测试全过；桌面端 e2e 的剧本换成新工具，dev 下 100 个全过，权限卡上的 justification、改动卡片的「删除」在界面里跑过。
  - 改写测试时查出并修掉的问题：命令结果第一行的耗时每次不同，「同一调用同样结果」的卡死检测对命令永远不触发（签名里去掉耗时和会话号）；轮询还在跑的后台命令不算打转（轮询报错照样算）；空闲到点中断后 AI SDK 不抛错、正常关流，这一轮按出错停下没重试；一轮里全是工具调用时写摘要的请求超窗不重试；内置的 rg 不在命令的 PATH 里；Ctrl-C 后没等进程退出就返回；没有检查点时只读命令也会让这一轮记成未经验证；完成卡的 reused 分支走不到了（靠 verify_changes），删掉。
- 评测（第 517 步，同一模型，12 题各跑 3 次，基线是改造前的 main 3cb20d2，两版先后跑）：
  - 通过：基线 36/36，新内核 34/36。两次失败都是新内核的问题，跑完后已在源码里修好：t08 第一步的 `rg --files -g '!**/__pycache__/**'` 被当成可能读到 `.env`、要求确认（这道题设定拒绝所有确认），模型什么都看不了就停了（`-g` 后面的过滤规则被当成了要读的路径）；t12 中途模型服务在流里发来「输出中断」，没有状态码，没按断开重试，这一轮按出错停下（现在流里没有状态码的错误也重试，4xx 照旧不重试）。
  - 都通过的第 2、3 轮：平均每题模型调用 10.2 → 9.0 次，token 91.6k → 92.5k，用时 80.8 → 85.7 秒；工具调用 16 → 6 次（一条命令读好几个文件）。第 1 轮新内核有不少单次调用要 40–70 秒（只出几十个 token），是那段时间服务慢，用时不拿第 1 轮比。
  - 退步：t02（小的修 bug 题）三次都先派了探索子智能体，基线从来不派，这题 token 多了约七成。模型一开始不了解项目，又被「不熟的代码派探索工人去看」和「去查子目录的 AGENTS.md」两句带着，第一步就派了出去。
  - 干扰：评测的题目目录在这个仓库里、自己没有 `.git`，新内核往上找项目根找到了仓库根，把 Diffra 自己的 AGENTS.md 也发给了模型；模型跑 `git status` 看到的也是 Diffra 仓库（两版都一样）。
- 跟进（第 519–521 步）：
  - 委派提示词（519）：先自己用 `rg --files` 看一眼项目、读关键文件，看出改动跨很多不熟悉的模块才派探索工人；小项目、只改几个文件的自己做。`delegate` 的「不要用」里加一条「还没自己看过项目」。
  - 评测隔离（520）：评测准备题目目录时 `git init`，题目原样作为第一次提交（提交人 `Diffra Eval`），题目有自己的项目根和仓库。基线用的副本打了同样的补丁。评测包自己的测试也换成了新工具。
  - 重跑（521）：两版同时跑，各 12 题 × 3 次、并发 4，赶上同样的服务状况。新内核 36/36，基线 35/36（t09 一次没过）；平均每题 token 88.3k → 72.4k（−18%），模型调用 9.8 → 7.6（−22%），用时 88 → 67 秒（−23%），工具调用 16.6 → 4.7；门禁打回都是 3 次。t02 不再多派工人（不该派的 0/30）。
  - 代价：该派工人的 t11、t12 新内核一次都没派（基线 6/6）。两题照样 3 次全过，而且更快更省（t12 用时 217 → 122 秒，token 270k → 191k），说明这两题一个上下文就装得下；要验证委派在真正大的任务上还会用，得补一道单个上下文放不下的题。

## 任务页：运行中、右侧栏、回答里的链接和文件（第 527–536 步）

- 下面推翻了前面这些段落里的对应内容：「界面」里任务页的「底部终端」；任务监控里显示检查命令、安全开关、规范、模型、MCP、项目保护、步骤和失败命令（「界面」「模型角色」「MCP」等段落提到的那些行）；输入框模型菜单的思考阶梯。其余照旧。
- 运行中（527、528）：智能体起开发服务器（`dev_server_start`）时终端在后台建好，不再自动打开终端面板；`exec_command` 到点没结束、转到后台的命令由 core 推给界面（`_diffra/session/processes`，整份列表，不进会话记录：重开应用时进程已经不在了）。两种都列在任务监控的「运行中」：命令、输出里第一次出现的本地地址，能在内置浏览器打开、看输出（开发服务器打开它的终端，后台命令弹出最近 64K 字的输出，不动交给模型的那份）、停止。用户停的命令，模型下次看到「Process stopped by the user」。远程任务看不到对方的「运行中」：这个通知不经过设备连接。
- 任务监控（529）：参照 Qoder 只放这个任务的状态和产出：摘要卡（最近一条回复的开头和时间，点了跳回去）、运行中、完成条件（目标模式，别处不显示所以留着）、环境信息（改动统计、本地或对方设备、分支、提交或推送，以及没找到 Git Bash、MCP 连不上的提示）、子智能体、产出（改过的文件，点了审阅那个文件）、网页查阅（内置浏览器打开过的网址）、来源（用户附加的文件、提到的网址、选的 Skill，「+」打开选文件）。配置项都移出：项目设置原来唯一的入口是这里的「编辑检查命令」，改到任务菜单（…）的「项目设置」。「提交或推送」只往输入框里填一句话交给智能体，不另做 Git 界面。
- 滚动（530）：贴底跟随以前只看离底部是否小于 80px，滚轮往上一格时平滑滚动的前几帧还在这一带里，跟随又被打开，下一段输出一到就被拉回底部。现在滚轮往上、键盘上翻、拖滚动条时立刻停止跟随，往上的位移不会重新打开跟随；内容变矮时浏览器把位置往上挪不算用户往上翻。
- 思考程度（531）：输入框里给某个模型选的思考程度记进设置（`reasoningChoices`，按「服务 id/模型 id」，保存时去掉已删除的模型），首页、新建任务、重开的任务都按它；模型后来不支持那一档了就不用。远程任务换的是对方的模型，不记。
- 模型菜单（532）：参照 Qoder，按钮写模型图标、名字和思考程度；点开两行「模型」「推理等级」各自展开子菜单，模型列表的分组标题只写服务名（不带图标），每行带模型图标、上下文和视觉。以前菜单底部的横向滚动条：分隔线有负的左右外边距，放在内边距更小的滚动区里，比滚动区宽了 2px；现在分隔线放在滚动区外面。
- 终端（533）：终端是右侧栏的一种面板，和浏览器、审阅同一个位置、共用宽度，和其他面板互斥（不能同时看任务监控）；按钮在右侧面板那一组里，Ctrl+\` 照旧。远程任务的终端一起挪。设置里的终端高度不再用。
- 回答里的链接（534）：网址默认在这个任务的内置浏览器里打开，右键可以「用系统浏览器打开」「复制链接」；远程任务没有内置浏览器，照旧交给系统浏览器。右键菜单用 radix-ui 自带的 ContextMenu，不加依赖。
- 回答里的文件（535、536）：行内代码和链接里像文件路径的（带扩展名，可带 `:行号` 或 `#L行号`），主进程查过确实在项目里的，显示成文件引用：前面是语言小方块（自己画的，不加图标库）。只写了文件名的先在这个任务改过的文件里找唯一的同名文件，再当项目根目录下的文件。点了：这个任务改过的看审阅、滚到那个文件；没改过的在右侧栏只读预览（最多 1 MB，不做语法高亮），定位并高亮那一行。右键：在右侧栏查看、用默认应用打开、复制路径、复制文件内容、在资源管理器中显示；参考图里的「新窗口查看」「打开方式」不做。主进程的文件接口只认项目目录里的文件。

## 步骤条、文件编辑（第 540–548 步）

- 下面推翻了前面这些段落里的对应内容：上一节的摘要卡（529）、改过的文件点了看审阅和只读预览（535、536）、浏览器活动总是切到浏览器面板；「左下角的设备和用量」里「用量」右边写今天的 token。其余照旧。
- 起因：用户用 0.4.1 试了一轮，提了这几条；另外复查会话记录时看到，带行号的引用点了只滚到审阅里那个文件的开头，行号没用上。
- 点开头的文件（540）：`.gitignore`、`src/.env` 这类没有扩展名的也认成文件引用，照旧要主进程查过确实存在。`Promise.all`、`.then` 也长得像文件，靠这一步查不到而照常显示成代码。
- 浏览器不抢面板（541）：智能体用浏览器时，只在右侧栏关着或开着任务监控时切到浏览器；用户自己开着终端、审阅、文件时不切，浏览器在后台照常操作。这时截图会说面板没显示，提示里写了先用 browser_snapshot 读页面。起因是 533 把终端挪到右侧后，看着终端时会被智能体的下一次浏览器操作切走。
- 步骤条（542）：智能体用 update_plan 列的步骤不再在对话里画成步骤卡，放在输入框上方，贴着输入框上沿。默认收起成一行（「步骤 1/3」加正在做的那一步，进行中转圈，全做完打勾），点开列出全部，最多约 8 行高。只看最近一次提问那一轮里主智能体最新的一份；这一轮做完后留着，发了下一条消息、新的一轮没列步骤就没了。代价：以前轮次的步骤清单在界面上看不到了。
- 去掉摘要卡（543）、侧栏「用量」不写今天的 token（544）：点开的用量面板照旧。
- 依赖（545）：文件编辑用 CodeMirror 6（`codemirror`，加上按文件名懒加载语言的 `@codemirror/language-data`，以及直接引用的 `@codemirror/state`、`@codemirror/view`、`@codemirror/language`、`@lezer/highlight`；pnpm 不让桌面端直接引用别的包带进来的依赖，所以这四个也写进 package.json）。没用 Monaco：几 MB、要在 Electron 里配 worker；也没自己用 textarea 做：没有高亮和折叠。
- 文件编辑（546，取代 536 的只读预览）：回答里点任何文件引用都在右侧「文件」面板打开这一个文件，定位并高亮那一行；改过的文件右键多一项「查看改动」去审阅。面板里有行号、语法高亮（颜色用样式表里新加的 `--code-*`，浅色、深色各一套）、折叠、Ctrl+F 搜索，改了出现「已修改」和「保存文件」，Ctrl+S 也能存；选中文字右键能复制、「添加到任务」（带上路径和行号放进输入框）。
  - 没保存的改动按文件留在内存里：关面板、换文件、切任务都不丢，回来接着改，退出应用才没了。方案里原来写的是「关面板、换文件前先问」，做的时候改成了这样：右侧栏的关闭、切换入口分散在好几处，拦起来不划算，留着草稿也不会丢东西。
  - 外面改了文件（智能体改了、撤销了一轮）：编辑器没改过就直接换成新内容，那一行的高亮重新标上；改过了就提示，选「保留我的改动」或「重新载入」。保存时比读出来时的修改时间和大小，对不上（外面改过了）不直接写，提示「覆盖保存」。保存按原来的换行（CRLF 还是 LF）写回，UTF-8。超过 1 MB 的只显示开头、只读，二进制文件不显示。
  - 主进程的保存接口和读一样只认项目目录里的文件。运行中也能改，改的文件算进这一轮的改动，撤销这一轮会一起撤掉。
  - 不做：文件树、多标签页、新窗口打开。
- 验证：类型检查、颜色检查通过；用临时项目和脚本模型在开发版里逐项点过（步骤条随进度更新、做完留着；没有摘要卡；侧栏用量只写「用量」；`.gitignore` 高亮；开着终端时浏览器不切走、开着任务监控时照常切；点文件打开到那一行、有语法颜色、编辑后 Ctrl+S 存进文件、右键添加到任务、智能体改了自动重载、改着没存时提示、覆盖保存），浅色、深色截图对照过。实测时发现外面改了文件重载后那一行的高亮丢了，已修。e2e 补了 `steps-bar.spec.ts`、改了 `answer-links.spec.ts` 等，没跑。

## 读项目外要问、进度说明的语言（第 549–550 步）

- 读项目外（549）：0.4.0 换内核后读文件改成用命令（cat、sed -n、rg），只读命令在每次询问模式下直接放行，读文件工具原来的「项目外要授权」就漏了：`cat ../other/notes.txt`、`cat C:/Users/x/diary.txt` 都不问（复查 0.4.2 试用的会话记录时发现，那次是完全访问，本来就不问）。现在每次询问模式下，读文件的只读命令（cat、head、sed -n、rg、grep、ls、find、wc 等）只要有路径落在项目外（`../`、绝对路径、`/d/x` 这类、`~` 和 `$HOME` 这种看不出在哪的）就先问。
  - 照常放行：项目里的路径；readRoots 里的目录（各处的 Skill 和被截短的命令输出，和读文件工具一样）；grep、rg 的搜索模式和选项的值、awk 和 sed 的脚本不当路径；echo、pwd 这类不读文件的命令不管参数。
  - exec_command 带了 workdir 时按它算相对路径；workdir 本身在项目外时，不写路径的 ls、find、rg 也算读项目外。
  - 自动模式、完全访问不变。只读命令的「本会话内允许同类命令」不记，所以每次读项目外都会问。
  - 用户拖进来的项目外附件也一样要问（消息里只带路径），和换内核前读文件工具的行为一致；拖入附件的 e2e 改回先确认再完成。
- 进度说明的语言（550）：「用用户的语言回答」那句以前写在系统提示词的 Final message 下面，模型只照着写最后的回答；调用工具前那句进度说明顺着英文思考写成了英文（试用时开头两句都是英文，之后才是中文）。现在 Progress messages 里也写上用用户请求的语言，思考不限。没有在真实模型上验证效果。
  - 第 624 步：评测里 deepseek-flash 跑中文需求，38 段说明仍有 11 段英文。改成 Diffra 从每一轮的消息里认出语言（中、日、韩、俄，看文字系统，代码、路径、链接不算），写成具体的语言名放进环境上下文的 `<user_language>`，明说连工具调用前那句进度说明也用它；认不出时不写这一项、沿用上一次的。只在变化时重发，不影响提示缓存。同样 12 道题重跑英文 0/41。

## 无项目任务

- 普通任务和设计任务都可以不选项目。core 不需要「项目」这个概念，只要求 cwd 是一个存在的目录，所以全在桌面端做：主进程在「默认保存位置」下替任务建一个文件夹，当成普通 cwd 交给 core，会话配置带 `noProject: true`，写进会话记录和索引（见「Agent 核心」）。界面按这个标记认无项目任务，不按「上级目录是不是默认位置」推断，改了默认位置老任务也不会散开。
- 每个任务一个子文件夹，不共用一个：检查点、撤销、验证指纹都按整个工作树算，工作区里读写也不用审批。共用的话，A 撤销会还原 B 改的文件，B 写文件会让 A 被拉回重新验证，任务之间读写对方的文件不用审批，规则包、`.diffra/skills`、检查命令识别、深度扫描都会混进别的任务留下的东西，每轮快照对整个文件夹 `git add` 也越积越慢。
- 文件夹名是「本地日期 标题前 20 字」（`2026-11-08 做一个登录页`），去掉 Windows 不允许的字符和末尾的点、空格，标题空了写「新任务」；以日期开头，不会撞上 CON、NUL 这类保留名。重名时加「 (2)」「 (3)」：子文件夹不带 recursive 地 mkdir，遇到 EEXIST 换下一个序号，靠原子失败去重，不先查后建，同时建两个同名任务也不会撞。之后改任务名不改文件夹名：重新打开时 core 校验 cwd 和记录一致，检查点仓库也按路径哈希。
- 新建的顺序：先组装会话配置（模型没配好就在这里失败，不留空目录），再建默认位置和子文件夹，再建会话；建会话失败时删掉这个文件夹（`rmdir`，只删空的，智能体还没动过它）。默认位置或子文件夹建不了时报 `workspace-missing`（「默认保存位置不可用（路径）：原始错误」），首页和设计首页的错误条给「去设置」，跳到「设置 → 会话与存储」。
- 默认保存位置在「设置 → 会话与存储」的「无项目任务」一组，存在 `settings.json` 的 `defaultWorkspace`，null 表示用默认值；界面拿到的是主进程解析好的路径和是不是默认值。
  - 默认值：打包版是「文档\Diffra」；未打包运行（开发版、e2e）是数据目录下的 `workspace`，不往真实的「文档」里写。打包版 e2e 用的也是真实的「文档」，所以要先在设置里把位置改到临时目录。
  - 「更改…」用文件夹选择框改，不让手填；改过之后才出现「恢复默认」；「在资源管理器中打开」在默认位置还没建时先建好再打开。只影响以后新建的任务。
  - 说明里提示「文档」目录可能被 OneDrive 同步，任务里的依赖文件也会被同步。不因此把默认值改成 `%USERPROFILE%\Diffra`。设置搜索的关键词加了「默认保存位置」「无项目」「文件夹」。
- 无项目任务的文件夹不是用户的项目：
  - 不加进项目列表（首页的项目下拉、侧栏的项目分组）；新建、打开无项目任务都不改「上次用的项目」（`lastProject`），下次启动和 MCP 设置页的检测目录还是上一个真实项目。
  - 任务监控里不给「编辑检查命令」（项目设置弹窗，检查命令和禁写目录都在里面），不给这个文件夹存项目设置；建会话时照常按路径读一次项目设置，通常是空的。
  - 新任务、Ctrl+N 默认带上当前任务的项目时，无项目任务取「无项目」，不取它的文件夹。
  - 首页、设计首页在无项目状态下，斜杠菜单读 Skill 和命令时在默认保存位置（还没建就用户目录）里读，不落到上一个项目，免得列出任务里读不到的项目 Skill；任务里照旧按会话读。
- 规则包、前端做法（`frontendLines`）和 Skill 索引都在建会话时定下（按项目文件选语言、判断是不是前端项目）。无项目任务一开始是空文件夹，只有不分语言的规则包（通用、安全），没有前端做法；智能体在里面写了文件以后，重新打开任务才按新文件重新选。接受这个限制，不让 core 每轮重算：系统提示词不变才能用上提示词缓存。设计任务常常从空白开始，也会碰到。
- 删除：确认框说明写「任务文件夹默认保留」，下面一个勾选项「同时把文件夹移到回收站」，默认不勾，提示里列出文件夹路径，说明检查点会一起删掉、文件夹可以从回收站找回。
  - 文件夹是空的时不出勾选项，说明写「它的文件夹是空的，会一起删掉」，直接删掉空文件夹；文件夹已经不在时同样不出勾选项，只删记录。
  - 处理文件夹前先停掉这个任务的开发服务器，免得文件夹被占用。勾上时用 `shell.trashItem` 移到回收站，不永久删除；文件夹删掉了（移到回收站或删掉空文件夹）才连同它独占的检查点仓库一起删。移到回收站失败时报错，任务记录不删，可以重试或不勾。
  - 文件夹路径用 core 记下的 cwd，不用界面传来的。项目任务的删除不变：只删对话记录，项目文件和检查点仓库都不动。
- 显示：侧栏归到「无项目」分组（见「界面」）；任务页输入框下、搜索结果、首页和设计首页的任务列表、已归档列表里项目一栏写「无项目」，悬停显示真实路径。终端、「在资源管理器中打开」照常在它的文件夹里。
- v2（M11）：
  - 转成正式项目：任务菜单「转成正式项目…」（任务在跑时灰掉），确认后 core 清掉记录和索引里的 `noProject`（`_diffra/session/update` 的 `promote`），文件夹不动、不改名，主进程把它记成上次用的项目。之后它出现在项目列表和侧栏的项目分组里，能设项目设置。不能转回无项目。
  - 用量页「按项目」把无项目任务合成一行「无项目（N 个任务）」，路径写默认保存位置。任务还在时按会话索引里的标记判断，转成正式项目的单独一行；删掉了的任务按文件夹在不在默认保存位置下判断。
  - 系统提示词多一段「Working folder」：工作目录是 Diffra 为这个任务新建的空文件夹，不是用户的项目，建的文件放这里，最后说明放在哪。项目任务没有这一段。已经打开的任务转成正式项目后，这一段要到重新打开任务才去掉（中途改系统提示词会用不上提示词缓存）；文件夹确实是为这个任务建的，留着影响不大。
  - 规则包和前端做法：建会话时文件夹是空的，就在每轮开始时看一眼文件夹；一旦有了文件，按新文件重新选规则包、判断前端，重建一次系统提示词，之后不再重建（同样为了提示词缓存）。
  - 验证：core `no-project-v2.test.ts`（提示词里的说明、空文件夹不重建、有了文件只重建一次、转换只清掉标记）、`usage-v2.test.ts`（合成一行；转过的单独一行）；e2e `no-project-promote.spec.ts`（侧栏分组、项目设置、文件夹不动、重启后还是项目、用量页单独一行）、`usage-v2.spec.ts`。

## 编码规范

- 不把整本规范塞进提示词：系统提示词每一步都要重发；弱模型对长规则清单的遵守率低，对具体的报错和审查意见修得最好。所以规范分三层接入：
  - 能用工具查的交给 lint，配成项目的检查命令。自动识别项目已有的 lint 配置属于第 5 步；p3c-pmd 随 v2 的 Java 适配器做了（项目配了就用，没配只说明怎么加），见「Java 适配器」。
  - 查不了的写成规则包，按项目语言挑选后写进系统提示词。
  - 完成前审查：评审模型按规则审这一轮的 diff，有违规就打回。
- 内置规则包全部强制生效，没有设置页：强制级和推荐级都写进提示词，完成前审查一直开着（`packages/desktop/src/main/rule-packs.ts` 的 `SESSION_RULES`）。不能按项目关包、关单条规则，也不能导入自己的规则包。
  - 以前的「设置 → 规范」页、按项目存的规范设置和导入的规则包都去掉了；旧设置文件里的 `projects[路径].rules` 读的时候丢掉，下次保存就没了。
- 规则包是带 front matter 的 markdown（解析在 `packages/core/src/rules/pack.ts`）。
  - front matter 必填 id、name、languages（`*` 表示不分语言）、source、license。
  - 规则写成 `- [编号][强制|推荐] 内容`，缩进的续行接在上一条后面；单条超过 300 字直接报错，要求拆开。
  - 规则编号跨包不能重复，审查意见靠编号定位规则。
- 内置 5 个包：通用、安全、Java、TypeScript / JavaScript、Python，在 `packages/core/rules/packs/`。
  - 出处和许可见 `packages/core/rules/NOTICE.md`。条目都是改写的，不带原文。
  - Java 以《Java 开发手册（黄山版）》1.7.1 为底本。没收录与常见项目惯例冲突的条目（每个类写作者和日期、所有方法写 Javadoc），也没收录过时技术（Velocity、iBATIS）和取决于团队的约定（禁止外键、超过三表禁止 join、禁止存储过程）。
  - 格式类条目定为推荐级，留给检查工具。
  - 安全包和 Python 包改写自 CC BY-SA 作品，按 CC BY-SA 4.0 发布；通用、Java 按 Apache-2.0；TS/JS 按 CC BY 4.0。
  - 内置包在构建时用 `import.meta.glob` 打进主进程 bundle，安装包里没有单独的文件。
- 按项目语言选包：会话创建时用 `rg --files`（遵守 `.gitignore`）按扩展名统计文件数。
  - 不分语言的包排在前面，其余按对应语言的文件数从多到少排。项目里没有的语言不选。
- 写进提示词的方式：
  - 排在项目的 `AGENTS.md` / `CLAUDE.md` 之后，写明优先级低于用户指令和项目规则，只约束这次写或改的代码，不要为了规范去改无关的旧代码。
  - 强制级和推荐级都放，合计上限 4000 字，预算不够时先保证强制级，推荐级按包的顺序放到满为止；放不下的条数写进提示词。
  - 实测强制级篇幅：通用约 1200 字，安全约 900 字，Java 约 1500 字，TS/JS 约 800 字，Python 约 600 字。单语言项目都放得下；Java + TS 的全栈项目会超出，TS 包排在后面，部分条目会被省略。
  - 加上推荐级后的实测（通用 + 安全 + 一个语言包）：TS 项目强制级 2967 字，推荐级 45 条放进 18 条；Python 放进 22 条；Java 只放进 5 条。
- 完成前审查：默认开着，每个改了文件的任务完成前多一次评审调用。第 426 步起在「设置 → 智能体 → 安全」里能关（`security.review`，旧设置文件没有这一项按开），关了对已经打开的任务立即不审。以前一直开着、没有开关，三档安全检查全关了也照样被它打回。
  - 时机：和完成检查同时跑，意见和检查失败一起打回（第 419 步，见「安全检查」的完成门禁一条）。以前完成检查通过之后才审，免得对跑不通的代码提意见，但每打回一类问题都要重跑一遍完成检查。
  - 范围：取这一轮的 diff，只看代码文件（能按扩展名认出语言的），只按和这些文件相关的包里的强制级规则审。
  - diff 先标好新文件的行号再给评审模型，弱模型自己数行号很容易错。超过 6 万字只审前面的部分。
  - 只接受规则编号存在、并且指向本轮新增行的意见，最多 10 条；落不到新增行的意见当作臆测丢掉。
  - 有违规就当作完成检查没通过，打回给编码模型，计入「连续 3 次打回就停下」的上限；它没有可比的错误列表，不按进展计数。同一次 finish 里完成检查也没过时，按完成检查的失败计，不再另算一次打回。编码模型认为意见不对时可以在 finish 的总结里解释，下一次审查会看到。
  - 评审模型用「评审」角色，没分配时用编码模型。审查调用本身失败时不拦截完成，只在卡片上说明，避免评审模型出问题时任务永远完不成。
  - 需要检查点（Git）来取 diff；没有检查点时跳过审查并提示。

## 界面

- 布局参照 Qoder，取舍时按 Diffra 的功能来，不照搬。
  - 左侧栏：新任务、可直接输入的搜索框（和搜索弹窗共用会话搜索和最近任务）、设计（进设计首页，见「设计模式」）、按项目分组的任务列表（有任务的项目按最近更新排）、设置。归档的任务不在侧栏，在「设置 → 会话与存储」里。版本号不在侧栏，在「设置 → 更新与关于」。
    - 侧栏搜索框聚焦时列出最近任务，输入后 150ms 防抖搜索；上下键选择、Enter 打开、Esc 收起，结果里不区分标题和对话内容的命中。Ctrl+K 仍打开原来的搜索弹窗，终端里不抢键。
    - 每个项目右侧一直显示「+」，不显示任务条数，点了进这个项目的首页；悬停不再切换出按钮。项目名过长时在加号前截断。
    - 每个项目默认显示最近 5 条，当前任务总是显示，其余收在「显示更多（N）」；折叠和展开状态放在 store，收起侧栏、进出设置页都保留。
    - 无项目任务（见「无项目任务」）按会话的 `noProject` 标记归到一个「无项目」分组，当作一个特殊的项目：图标是带点的文件夹，悬停显示默认保存位置，和其他项目一起按最近更新排，普通任务和设计任务都在里面；分组的「+」进无项目的首页。无项目任务的文件夹不单列成项目分组（被当成项目打开过、又没有项目任务时也不列），免得和这个分组重复。
    - 设计任务行在缩进区放一个画笔标记，标题对齐不变；点画笔也是打开任务。
    - 任务行右侧的状态位只显示一个，和顶栏用同一个结论函数，只标需要留意的：「等待确认 > 出错 > 验证未通过 > 运行中 > 受阻 / 未完成 > 未读」，有状态时替换时间，aria-label 用结论词，除转圈外悬停也显示结论词。原来的「失败」改叫「出错」；正常完成不单独标，只剩未读点。计划、压缩、深度扫描轮在跑时，上一轮 core 记下的出错（模型出错）和验证未通过照样标出来；界面调用异常只看最后一轮，新的一轮跑起来就不再标。
    - 图标和顶栏一致：等待确认 warning 空心圈，出错和验证未通过 destructive 实心点，受阻 warning 暂停图标，未完成 warning 感叹号，运行中 muted 转圈，未读是中性的 foreground 小点。浅色下 warning 和 destructive 色相接近，靠形状区分。
    - 只有加载过的任务有状态位：session/list 不带结论，重启后没打开过的任务不显示。已读状态只在内存里，不存盘。
  - 首页：输入框放在固定位置（不整体垂直居中），下面是项目、分支、检查命令、规范和最近的任务。发出第一条消息时才建会话。
    - 首次启动的提示只在首页横幅里说一次（「还没有配置模型」带「去设置」）；输入框里的模型触发器写中性的「未配置」，不再用 warning。没选项目时项目选择器用中性虚线描边，不用 primary 填充。
    - 启动时有上次用的项目就停在它，没有就是无项目。没选项目时点发送直接建无项目任务，不再弹出选择文件夹框（以前先弹框、选好再发）。输入框左下的项目 chip 写「无项目」，悬停显示默认保存位置；下拉第一项是「无项目」（副文本写「建在 路径」），下面是项目列表、分隔线和「选择文件夹…」。
    - 「最近的任务」里无项目任务的项目一栏写「无项目」，设计任务带画笔标记。
  - 任务页：对话列（对话、输入框，底部终端）；右侧任务监控、审阅、浏览器互斥（设计任务另有设计面板），可以都关。终端在对话列内部，右侧面板保持全高。
  - 设置是独立的整页，按分区组织。
  - 窄窗口：主列可用宽度小于 520px 时自动收起侧栏（默认 1200 宽窗口在「大」字号下开着监控面板时对话列约 584px，阈值不能更高），这只是布局上的派生结果，不写回 `sidebarOpen`；开着宽面板（审阅、浏览器）时不自动收起。
- 标题栏（Claude 桌面版式）：Windows 上去掉系统标题栏和英文菜单，窗口最上面是一条 40px 的顶栏，左边主菜单 ≡、侧栏开关、后退、前进，其余地方可以拖动窗口。
  - 最小化 / 最大化 / 关闭用系统的窗口按钮（`titleBarOverlay`），不自己画：贴靠布局、双击最大化、右键系统菜单、拖边缩放都是系统处理的。页面套用外观后把顶栏底色（侧栏色）和正文色交给主进程设到系统按钮上，`nativeTheme` 跟着主题，原生菜单也跟着深浅色。页面第一次套用外观后才显示窗口，深色时不会先闪一下浅色（页面没发过来时 1.5 秒后照常显示）。
  - 顶栏高度用 px 固定为 40，和系统按钮一样高；Tailwind 的 rem 尺寸会跟着字号缩放，对不齐。右边按 `env(titlebar-area-*)` 给系统按钮留位。
  - 拖动区域会盖过页面上的任何东西：弹窗、下拉菜单打开时（Radix 给 body 加 `data-scroll-locked`）顶栏不拖动，免得点不到。
  - 其他平台保留系统标题栏，顶栏只是工具条。
- 菜单：中文的文件、编辑、视图、帮助，点 ≡ 在按钮下弹出原生菜单（Windows 上不显示菜单栏，按 Alt 不会出来）。编辑类用系统的 role。页面自己处理的快捷键在菜单上只显示、不注册（`registerAccelerator: false`），免得按一次触发两次。
  - 新增 Ctrl+N 新任务、Ctrl+O 打开项目文件夹。去掉了默认菜单的页面缩放（缩放后顶栏和系统按钮对不齐，改用「外观 → 文字大小」）、Ctrl+W 关窗口，正式版去掉重新加载（会丢掉运行中任务的界面状态），开发者工具保留。
- 后退、前进：记首页、设计首页和任务页的历史（最多 50 条，设置页不记，连着换同一种首页的项目只算一条，首页和设计首页之间切换各算一条），删掉的任务跳过；在设置页里后退就是回到进设置前的那页。顶栏按钮、Alt+← / Alt+→、鼠标侧键、菜单都能用；焦点在终端里时 Alt+← / → 交给 shell。
- 对话流：
  - 两段回复之间的过程（思考、读文件、搜索、命令、改动）收成一组「执行工具 N 次 · 修改 M 个文件」，默认收起（第 454–457 步，`Conversation.tsx` 的 `toBlocks`、`ProcessGroup`）；回复、提示、检查、规范审查、完成、子智能体、步骤清单、计划、上下文压缩单独显示，也把组断开。工具、编辑、压缩跑完画 muted 勾：跑完只是过程，不是验证。
    - 起因：以前只有连续的普通工具调用才成组，中间隔一段思考就断开，只有一项的组又直接显示成一行。每次调用前都先想一下的模型（DeepSeek）会变成「思考、读取、思考、执行」一行一行铺开，改动也各占一行。
    - 运行中也不自动展开：标题行转圈，后面写正在做的事（「读取 loop.ts」「思考中」）。以前组里有调用在跑就展开、跑完又收起，内容一直在跳。
    - 展开后每条一行：「已思考 · 首句」、工具调用（动作加目标）、改动（编辑或新建加路径和增删行数），各自还能再点开看全文、输出、diff。
    - 只有一项时不套这层，直接显示那一行。
    - 收起时各项仍留在 DOM 里（hidden），按 `data-kind` 数卡片的地方不受影响。
    - 任务监控点失败的命令、定位结果点「滚到这一步」时，目标在收起的组里就跟着展开再滚过去（`locate` 只传给那一步所在的轮次）。
    - 这推翻了两条旧做法：改动单独显示（原来另有「修改 N 个文件 · M 次编辑」一组），和有失败命令的组默认展开。改了哪些文件在完成卡和任务监控的「本任务改动」里照旧列出。
  - verify_changes 也单独成一行，不并进「执行工具 N 次」：中途验证不改变本轮结论，通过也画 muted；没配检查命令（unverified）时画 warning 并默认展开。
  - 连续的检查、扫描、审查全部干净时收成一行，点开看各项；有一项不干净就逐项显示。收起的各项仍留在 DOM 里，按 `data-kind` 数卡片的测试不受影响。
    - 组里有检查命令时画 success 勾、写「自动检查通过」；只有安全检查和规范审查时画 muted 勾、写「未发现问题」。没发现问题不等于检查通过，原来一律写「自动检查通过」，会和顶栏的「未经自动验证」同时出现。
    - 「干净」看 core 给的 `result`（见「本轮结论」），只有 passed 算。没有 result 的旧记录照旧按正文判断：检查命令通过就算，安全检查和审查只有一行「没有发现…」才算。
    - 审查或扫描工具自己出错（error）、只看了一部分（partial）画 warning，写明这次不拦截，不显示成红色；只有提醒或附注（warned）的扫描逐项显示。
  - 改动的 diff 在对话、完成卡和审阅面板里共用 `DiffLines`（`features/session/DiffLines.tsx`）：新旧两列行号、+/− 标记列、`@@` 分隔条、diff 令牌底色。
  - 命令行的成败来自 core：run_command 的 `tool_call_update` 在 `_meta.diffra.commandSucceeded` 里带结果，失败时显示 warning 色并默认展开输出，不从输出文字猜。收进过程组的命令失败时，组的标题写「N 条命令失败」并画 warning，组本身不再默认展开（第 455 步）；展开后失败的那一行照旧默认带着输出。
  - 工具调用一开始 core 就发带目标的标题（`tools.ts` 的 `startTitle`，比如「读取 src/a.ts」），运行中的行不再只有工具名。
  - 思考收进过程组，一段一行、点开看全文；回复按 Markdown 显示，链接用系统浏览器打开。
  - 每轮下面有复制、撤销这一轮及之后的改动（↶）、重新生成；只有最后一轮常驻，其余轮在悬停或聚焦时出现。重新生成只放在最后一轮：它会撤掉这一轮的文件改动和对话再重发同一个提问，放在中间的轮次会连带丢掉后面的所有轮次。
    - 完成卡上已经有「撤销改动」按钮的轮次（有通过、有改动、没被撤销去色的完成卡），操作栏不再放 ↶：同一个动作不放两个按钮，和出错卡上已有「重试」时一样。停下、出错、只有对话的轮次照旧有 ↶；撤销过之后卡片按钮消失，这一轮的 ↶ 回来；运行中卡片按钮隐藏，↶ 也不显示。
    - 撤销确认框标题是「撤销改动」，说明写明第几轮（按全部轮次计数，和审阅面板的「从第 N 轮起」一致）：最后一轮写「第 N 轮对文件的改动会被撤销。」，其余写「第 N 轮以及之后所有轮次对文件的改动都会被撤销。」。以前说明写「这一轮」，从审阅面板打开时没有所指；完成卡的按钮叫「撤销本轮」，放在旧轮次上说错了范围。
- 权限卡：全应用唯一「大声」的元素（warning 边框加 warning-soft 底）。
  - 固定在输入框正上方，不在对话流里：用户往上翻着看改动时也看得到。对话流里对应的位置只留一行占位，待执行的那个工具行不再单独显示。命令区限高（`max-h-40`），超出只让命令区滚动，不把对话挤没。
  - 出现时自动聚焦「允许一次」，但焦点在输入框等可编辑元素里时不抢，免得本想发消息的 Enter 变成允许。Enter、Esc 只在焦点位于卡片内时生效；焦点在某个按钮上时 Enter 交给按钮自己。
  - 按钮按 `option.kind` 分级：允许一次用 default，本会话允许用 outline，拒绝用 ghost；选项文案用 core 给的原文。
- 任务状态只有一套词：`lib/turn-verdict.ts` 的本轮结论，顶栏、任务监控、侧栏共用，同一时刻只显示一个，规则见「本轮结论」。
- 运行中发的消息在界面里排队，这一轮结束后依次发出，可以撤回。队列不存盘，应用退出就没了。
- 模型可以在任务中途换（从下一轮生效），运行中不能换。
- 审阅面板看的是「从第 N 轮开始到现在」的改动，和撤销的含义一致：「撤销这些改动」就是撤销第 N 轮及之后的改动。只有一轮时不显示轮次选择。
  - 「撤销这些改动」是 ghost 按钮，悬停才显示 destructive：撤销不是这个面板的主操作，看改动才是。
  - diff 缓存（`features/task/useTaskDiff.ts`）：只在内存里按「会话 + 起始轮」留最近 8 份，切面板、切范围时先显示旧数据再后台刷新，不再每次闪「正在读取」；骨架只在这个 key 第一次读取回来之前出现。
    - 第一次读取立即发出，之后工具连着完成时每 300ms 最多读一次（节流）。以前是去抖，长串工具调用期间读取一直往后推，在途的结果又在 effect 清理时被丢掉，缓存里有了新数据，界面还停在骨架。
    - 在途的结果回来照样显示，只要不比正在显示的旧（带 `changeVersion`），晚到的旧结果不盖新结果。
    - toolKind 是 read、search 的工具（读文件、列文件、搜索、大纲等）完成时不触发重读（`state/actions.ts` 的 `filesMayChange`）。git 读取最多约每秒 3 次，core 按仓库排队执行。
- 右侧面板共用 `SidePanel` 外壳（`features/task/SidePanel.tsx`）：h-11 顶栏、不换行，关闭按钮统一是关掉面板（`panel: null`），不会切到别的面板。默认宽度三档：监控 `22rem`；审阅和浏览器共用 `min(50%, 720px)`、最小 `24rem`，两者互切时对话列不动；设计面板占满主区，对话列默认 `26rem`（见「设计模式」）。都能拖，见下面「分栏拖动」。
  - 顶栏的面板按钮：终端单独一个，分隔线后面是互斥的分段按钮：普通任务是浏览器、审阅、监控三个，设计任务前面多一个设计。
- 分栏拖动（第 262–267 步）：侧栏和主区、对话列和右侧面板、设计任务的对话列和画布、终端顶边都能拖，共用 `components/ui/resize-handle.tsx`。
  - 拖动、方向键每次 16px（竖线左右键、横线上下键）、双击恢复默认。拖动中只改内存，松手、松开方向键时存进 `settings.json` 的 `layout`（像素；null 是默认尺寸），重启后还在。
  - 各自记一个：侧栏、任务监控、审阅和浏览器共用一个（互切时对话列不动）、设计任务的对话列、终端高度。
  - 上下限每次现算，从实际渲染的尺寸起拖（被 flex 压过时没有空行程）：侧栏 13～32rem 且主区至少留 30rem；任务监控至少 18rem，审阅和浏览器至少 24rem，对话列至少留 24rem（拖过的宽度用 `max-width: calc(100% - 24rem)` 压住，窗口变窄时也不会把对话列挤没）；设计任务的对话列至少 20rem、画布至少 30rem；终端 120px 到窗口高度的 70%。
  - 侧栏宽度写在根元素的 `--sidebar-w` 上，设置页的分区导航跟着一起变；窄窗口自动收起侧栏的判断照样读这个变量（拖过之后是像素）。
  - 对话列和右侧面板（或设计画布）之间的拖动条整个放在面板一侧：对话列贴边的 10px 是对话区的滚动条，实测按在那里点到的是滚动条，盖在上面的拖动条抢不到。浏览器网页和设计画布是盖在面板上的原生视图，所以网页区、画布区左边留出 `ml-2` 给拖动条。按下后指针被拖动条捕获，拖过原生视图时照样跟手（开发版窗口里用真实鼠标拖过浏览器面板和设计画布）。
  - 不加的：待办页、日历、用量页的右栏（都在居中的定宽页面里），输入框（自动长高），弹出菜单和对话框。
- 上下文占用的分项（系统提示词、工具定义、规范和项目规则、对话）按字数比例估算，合计等于模型返回的输入 token 数。
- 外观：主题（浅色 / 深色 / 跟随系统）、配色、文字大小、内容宽度，存在 `settings.json` 的 `appearance`，写在 `<html>` 的 class 和 data 属性上。深色的 CSS 规则用 `:root.dark`，否则会被 `:root[data-palette]` 里的浅色侧栏盖掉。
  - 「文字大小」缩放整个界面（文字和间距一起，D2），不是只缩放对话区；它就是被去掉的页面缩放的替代。
- 快捷键：Ctrl+K 搜索任务（标题和对话内容）、Ctrl+B 侧栏、Ctrl+, 设置、Ctrl+Enter 发送、Ctrl+` 终端、Ctrl+N 新任务、Alt+← / → 后退前进。焦点在终端里时只保留 Ctrl+`，其余交给 shell（Ctrl+K、Ctrl+B 在 shell 里有自己的用途）。
- 底部终端：
  - 主进程用 node-pty 开进程，xterm 显示；Windows 上用 PowerShell（系统自带，和 VS Code 默认一致）。终端在当前任务的项目目录打开。
  - 位置在对话列底部，不横跨右侧面板；对话区留最小高度，终端拉高时压缩的是终端。标签名把可执行文件映射成 PowerShell、Git Bash、cmd，「附加终端内容」在标签栏上。
  - 最多同时 8 个；只有开它的窗口能写入和关闭。页面刷新、窗口关闭、应用退出时一起结束。
  - 切换任务、收起面板时终端内容和进程都保留；关掉标签才结束进程。
  - 浅色主题下换用 VS Code 浅色终端的 16 色，xterm 默认的配色按深色背景配，浅色背景上「白色」字看不见。
- 状态：渲染进程用一个很小的 store（`useSyncExternalStore`），不引入状态管理库。

## 本轮结论

- 顶栏、任务监控、侧栏和完成卡说同一句话，都从 core 的结构化字段推，不从正文文字猜，也不把 end_turn 或工具跑完当成成功。ACP 的 `status`、`stopReason` 语义不变（eval 的统计和 e2e 的 `data-status` 照旧），新的语义都放在 `_meta.diffra` 里：
  - 检查命令、静态检查、轻量扫描、规范审查卡结束时的 `result`：passed；warned（只有提醒或附注，项目原有的依赖漏洞也算）；partial（只看了一部分：diff 被截断、依赖审计没跑完）；error（工具或评审模型出错，这次不拦截）；failed（打回）。以前 failed 既表示打回、又表示工具坏了，扫描的模型调用失败还记成 completed。
  - 完成卡和 verify_changes 卡的 `verification`、每轮结束时的 `turnOutcome`、任务状态的 `needsVerification`：见「Agent 核心」。
- 判定在 `lib/turn-verdict.ts`：`turnVerdict(task)` 给顶栏、任务监控和侧栏，`finishVerdict(item)` 给完成卡。看最后一个 prompt 或 goal 轮（下称 V）的 turnOutcome；plan、deep-scan、compact 轮没有 turnOutcome，不改变结论，只作为最后一轮（下称 L）参与出错和用户停止的判定。
- 从上往下取第一条命中的：

| 词 | tone | 图标 | 判定 |
|---|---|---|---|
| 等待确认 | confirm | warning 空心圈 | 有待确认的权限请求 |
| 运行中 | running | muted 转圈 | 正在跑 |
| 未开始 | idle | 无 | 还没有轮次 |
| 出错 | error | destructive 实心点 | L 的调用出了异常（`turn.error`，不落盘），并且 L 本身没被撤销过：撤销之后新出的错照常显示 |
| 未完成 · 未验证 | unfinished | warning 感叹号 | V 或 V 之后任意一轮有 `restoredAt`（之后撤销过），下面各行的结论都不再算数；悬停显示 core 撤销时写的原因（见「Agent 核心」检查点一节），拿不到时写「文件已撤销，原来的结论不再算数。」 |
| 出错 | error | destructive 实心点 | stop 为 model-error |
| 等待中 | waiting | muted 空心圈 | 任务状态 waiting |
| 受阻（未完成） | blocked | warning 暂停 | 任务状态 blocked，并且 stop 为 paused 或还有没拿到证据的完成条件 |
| 未完成 · 验证未通过 | failed | destructive 实心点 | stop 为 gate-exhausted 或 check-exhausted |
| 已停止 | stopped | muted 小点 | L 被用户停止（或应用退出时没跑完）、任务状态 cancelled；stop 为 cancelled、stuck、step-limit、context-limit、goal-exhausted；旧记录看 V 的 stopReason 是不是 max_tokens、max_turn_requests、refusal |
| 未完成 · 未验证 | unfinished | warning 感叹号 | stop 为 no-finish，或任务状态 blocked 且 needsVerification |
| 已完成 · 未经自动验证 | unverified | warning 感叹号 | finish 为 unverified |
| 已完成 · 已验证 | verified | success 勾 | finish 为 verified；顶栏和任务监控只在这时画绿色 |
| 已完成 · 没有改动 | nochange | 无 | finish 为 no-edits |
| 已完成 | done | 无 | 其余：纯文字回答、只有计划轮、旧记录 |

- stop 不为 null、或者撤销过时，一定落在「已完成」各行前面：停下、连续打回、改了文件没调 finish 时智能体没有声明完成，撤销之后原来的完成不再算数，这些情况界面都不说「已完成」。
- 目标模式一轮里有几次 finish 时，顶栏按 finish 的合并值出词，各张完成卡按自己的 verification 出词；只有一次 finish、并且顶栏没有被停止或撤销覆盖时，两者是同一句话。
- 旧记录（V 没有 turnOutcome）：V 最后一张完成卡带 unverified 标记时显示「已完成 · 未经自动验证」，停止类按 stopReason，其余「已完成」。旧记录永远不显示绿色。
- 顶栏的状态带 `data-tone`（上表的 tone），悬停显示原因（已停止的原因，受阻和未完成时 core 写的原因）。新加的结论断言按 `data-tone` 等（`flows.ts` 的 `waitTaskStatus`）；`waitTaskDone` 仍按「已完成」前缀等，`plan.spec`、`task-lifecycle.spec` 也直接比「已完成」「等待中」，改结论词时要同步改。
- 任务监控的标题栏写「N 轮 · 结论词」，面板最上面一节「本轮结论」：图标、结论词、V 里失败命令的条数和原因；原因和下面完成条件区写的一样时不重复。
  - 失败的命令在结论下面按命令原文合并：同一条失败多次只列一行，行尾写「N 次」，点一下跳到最近那次，读屏名字写「跳到失败 N 次的命令：…」；按各命令最近一次失败排序，最近的在前，最多 3 行，多出的写「还有 N 条命令失败」，和标题里的计数一样按次数算（总次数减去已显示各行的次数）。以前每次失败列一行，同一条命令重试几次就占满 3 行。每条是等宽的命令原文，点一下对话滚到那一行（停在视口约 1/3 高处），焦点跟过去，那一行用 accent 底色淡出 1.5 秒，对话不再贴底。那一行所在的组被用户手动收起时不强制展开，焦点落在组的展开按钮上。
  - 对话右边的时间线点一下也平滑滚到那一轮的开头，但只在终点离开底部那一带（80px）时才停止贴底；终点就在这一带（比如点当前轮、它的开头已在视口里，滚不动）时照常跟随。失败命令定位是无条件停止贴底：时间线照搬的话，滚不动时没有滚动事件，贴底一直关着，「回到底部」也不出现，对话就不再跟着新内容走。两者都在平滑滚动滚出这一带之前不让滚动事件把贴底改回去（`locatingRef`），否则流式输出时刚起步就被拉回底部。
  - 「回到底部」在离底部 200px 以上时出现。除了滚动时重算，对话内容更新、对话区尺寸变化（排队提示、输入框变高把它压矮）时也重算：不贴底时内容在下面长高没有滚动事件，以前按钮要等用户再滚一下才出现。
  - 结论是已验证时，失败命令的图标用 muted，计数写「过程中 N 条命令失败」，和完成卡的 muted 说明一致，同屏不会既说通过又要人留意；其余结论用 warning，写「N 条命令失败」。对话里的失败命令行仍是 warning：那是过程记录，不随结论变色。
  - 面板外面依次是本轮结论、完成条件、本任务改动、检查、深度扫描；安全、规范、模型、MCP、项目保护、环境收在默认收起的「任务配置」里，收起时摘要行写编码模型、分支和出错的配置（MCP 连接失败、没找到 Git Bash）。折叠状态不记忆，只用 CSS 隐藏，内容留在 DOM 里。检查区留在外面，未验证时「编辑检查命令」就是用户的下一步；深度扫描是动作不是配置回显，只占一行。
  - 配置行（检查、安全、规范、MCP、检查点）开着只画 muted 勾，配置开着不等于验证过。没有选中规则包时规范行显示 off，写「没有选中的规则包，不会审查」，不再永远显示「已开」。

## 界面视觉规范

- 方向：安静的工作台。外框退到背景里，醒目的东西只服务三件事：改了什么、验证过没有、要不要用户出手。
  - 成功色（success）只给经过验证的结果：检查命令通过（检查行、组里有检查命令的收起行）、本轮已验证（顶栏、任务监控、完成卡）、完成条件的证据已核对，以及用户自己点的测试结果（模型的测试连接、检查命令的试运行）。工具跑完、编辑写入、配置开着、后台连接正常、diff、新文件都不用它；没跑检查、检查失败、没配检查都不显示绿勾。
  - warning 给需要留意、可能要出手但不是失败的情况：等待确认、受阻、未完成或未验证、命令失败、检查工具出错或只看了一部分、提醒级发现。destructive 只给确定的失败和打回，以及破坏性动作。过程和配置（运行中、跑完、已开、已停止、没有改动）用 muted。
  - primary 只用于用户的下一步动作（发送、允许一次、最后一张通过的完成卡上的「审阅改动」、首页「检测到 N 个检查命令」、侧栏「新版本…点击重启安装」，以及 markdown 链接和 link 样式按钮：可点的就是动作），不表示成功，也不用于运行中的转圈、未读点和首页没选项目时的选择器。例外只有三类：品牌标（侧栏、关于页）；终端光标；拖入文件时输入框的描边和「松开以添加文件或文件夹」提示（用户正在做的拖放）。选中标记（菜单里的勾、单选点、勾选框、开关、滑块、配色缩略图的选中框、设计页对齐格的选中态）不算。计划卡图标用 muted-foreground，时间线当前轮用 foreground（细线上 soft 看不出来），浏览器加载条和上下文用量（输入框下的圆环、弹层里的总量条）用 muted-foreground，用量到 80% 起用 warning。以前也用 primary、现在改成中性色的：输入框里的计划、目标、Skill 标签和附件标签同样式（`border bg-muted/40`、文字 foreground，× 悬停 `bg-muted`）；附件的文件夹图标和终端拖动条用 muted-foreground；设计页当前工具、添加模型步骤条的当前步是「当前项」（首页原来的「设计」开关也是，已经去掉，见「设计模式」），用 soft 底加 foreground；排队消息的「撤回」用 muted-foreground、悬停 foreground，和计划卡「恢复原计划」一致。新加 primary 要过颜色门禁（见下面），在同一行或上一行写 `primary-color-allow: 理由`，理由写它是哪种下一步动作或哪条例外。
  - 权限卡是唯一大声的元素。只有「运行中」有持续动画（转圈），「等待确认」用静态的 warning 标记。
- 令牌都在 `packages/desktop/src/renderer/src/styles.css`，组件里不写 px 字号、`text-[0.86rem]` 这类临时值和十六进制颜色。设计页图层树的 `text-[10px]` 已换成 `text-xs`；destructive-solid 按钮深色下的 `dark:text-[#1a0d0b]` 换成了 `destructive-foreground` 令牌（`text-destructive-foreground`，浅色 #ffffff、深色 #1a0d0b）。原有的例外照旧：xterm 的终端配色（见「界面」的底部终端），设置页配色缩略图的色值（数据，和 styles.css 里各配色保持一致），模型和服务品牌图标（`@lobehub/icons`）SVG 自带的原色（第三方数据，见「模型图标」）。第 559 步登记的例外：回答里文件链接前的语言徽标（`answer-links.tsx` 的 TS、PY 等）用各语言的品牌色，也是第三方数据；设计画布上协作光标的颜色和白描边（`design/bridge.ts`、`DesignApp.vue`）是画布内容，不是界面。
  - 字号（md 档）：xs 12 / sm 13 / base 14 / lg 16 / xl 20 / 2xl 26。用 rem 写，跟着「文字大小」缩放；xs 用 `max(12px, …rem)` 兜住中文最小 12px。2xl 只用在首页标题和用量页的「总用量」「缓存效率」两个数字，其余统计数字用 xl（第 568 步：总用量是用量页的焦点）。
    - 第 557 步把架构页、设备和用量弹层、待办里约 50 处 `text-[10px]`、`text-[11px]` 换成 `text-xs`，`text-[13px]` 换成 `text-sm`。px 字号只剩三类例外：顶栏里的字（顶栏按 px 固定 40 高，见「界面」）、架构卡片上的缩略图 9px、语言徽标 7px（后两者都是 aria-hidden 的装饰字形，放不下 12px）。
  - 字重用 400、600、700，加粗按文字内容定，不按字号：只要可能含中文（固定文案或动态内容：页标题、弹窗和确认框标题、提醒和错误卡标题、完成卡结论词、模型服务名、markdown 标题等）一律用 700（`font-bold`），原语 `PopoverTitle` 也是 700；只有确定只出现拉丁字母和数字的（侧栏和关于页的「Diffra」、用量页的数字、日期和合计列）用 600。雅黑只有 300、400、700：没有 500，`font-medium` 中英都按 400 画，表达不了层级，新代码不用（shadcn 原语和设计页里遗留的 `font-medium` 按 400 画，暂不清理；`CardTitle` 例外，第 558 步改成 700，MCP 服务名、插件名和模型服务名同级）；层级靠字号、颜色和位置。第 558 步把架构模块的中文标题从 600 改成 700，功能代码里的 `font-medium` 按用途去掉或改成 700，架构图选中的方块不再加粗（选中不加粗）。600 时拉丁字母是 Segoe UI Semibold，中文画成雅黑 Bold 700，同一行中英粗细不一；用 700 时中文看起来不变，只有拉丁字母、数字和「·」粗一档，和中文一致。数字用 `tabular-nums`；等宽字体只给路径、命令、代码和模型 ID。
  - 字体栈 Segoe UI 在雅黑前面（D5），英文能用到真正的 600，代价是 600 的中文按 700 画，所以 600 只留给只有拉丁字母和数字的文字。以前只有 xl 及以上的标题用 700，较小字号（弹窗标题、markdown 标题等）仍用 600，同一行里中文和拉丁字母粗细不一。
  - 圆角固定 px，不随字号缩放：xs 2（图例色块、热力格、14px 以下的小徽标）、sm 4（kbd、徽标）、md 6（菜单项、chip）、lg 8（按钮、输入控件）、xl 10（卡片、diff、浮层）、2xl 14（输入框、弹窗、用户气泡）。不写裸 `rounded`：它是 Tailwind 默认的 0.25rem，会跟着文字大小变；第 556 步把 81 处裸 `rounded` 换成 `rounded-sm`，`rounded-[2px]`、`[3px]` 归到 xs 或 sm。
  - 层级只有两档阴影：`shadow-overlay`（菜单、下拉、提示、toast、浮在图片上的 ×）和 `shadow-modal`（弹窗），只给浮层用。唯一的例外是首页输入框的 `shadow-composer`（styles.css 里的令牌，第 560 步从组件里的 rgba 搬过去）：它是首页唯一的焦点，任务页和远程任务页的输入框不加。架构图的方块和依赖图节点不加阴影，选中只画 ring；可点的卡片悬停换底色，不浮起来。卡片 1px 边框、不加阴影，不卡中套卡；对话里的卡片是权限卡、完成卡、错误卡、计划卡、深度扫描报告和提醒（如「目标模式第 N 轮」「已换用备用模型」），以及安全检查有发现、规范审查打回时的结果（其余情况只占一行）。弹窗遮罩浅色 black/30、深色 black/50，不模糊。
  - 颜色：`accent` 只做悬停和键盘高亮，`soft` 只做「当前项」（选中不加粗）；文字只有 foreground 和 muted-foreground 两级，不加第三级浅灰（第 559 步把 `text-foreground/85`、`/90` 和文字上的 `opacity-75` 并回两级；只有 disabled 态的 `muted-foreground/50` 保留）；success、warning、destructive 各带 `-soft` 底色，带这种底色的提示卡描边统一 `/30`，只有权限卡浅色下用 `/40`（唯一大声的元素）；destructive 实底上的字用 `destructive-foreground`，不写 `text-white`（深色下 destructive 是浅红，白字看不清）；`diff-add`、`diff-del` 给 diff 行的底色，`diff-add-fg`、`diff-del-fg` 给 diff 的竖线、计数和 +/− 标记，不借用 success 和 destructive（diff 表示改动方向，不表示验证结果）；`highlight` 只给搜索命中，不再借 warning 底色；`chart-1..4` 只给上下文用量和用量页。success 和配色无关，不跟 primary 共用。
  - 颜色门禁（`scripts/check-success-color.ts`，文件名沿用只查成功色时的）：扫描 renderer 下的 .ts、.tsx、.css、.vue（含设计页 `renderer/design`），两条规则分别检查、分别报告，命中的行同一行或上一行要有带理由的放行注释，只写前缀不写理由的不算。接在 desktop 的 `typecheck` 脚本后面，CI 跑类型检查时一起跑；也能单独跑 `pnpm --filter @diffra/desktop check:colors`。每加一处绿色都要写明它是哪种验证结果，每加一处 primary 都要写明它是哪种下一步动作或哪条例外。
    - 成功色：任意工具类前缀（`text-`、`border-l-`、`from-` 等）加 `-success` 或 `-success-soft`、`--success` 或 `--color-success` 变量、`'success'` 字面量（`tone="success"`、`variant="success"`、映射的键）的行，要有 `success-color-allow: 理由` 注释，styles.css 里只放行令牌定义行。经映射间接画绿色的地方（任务监控 `Row` 的 `status`、对话 `StatusIcon` 的 `tone`、模型测试结果的 `TEST_DOT`），键都叫 success，调用处和写入处也要放行，不只在映射定义处放行。
    - 强调色：任意工具类前缀加 `-primary` 或 `-primary-foreground`、`--primary` 变量（含 `var(--primary)`、`cssVar('--primary')`）的行，要有 `primary-color-allow: 理由` 注释。`components/ui` 不扫：原语的 variant（Button 默认、link）和选中标记（勾选框、开关、滑块等）在那里。styles.css 自动放行令牌定义行和 `--chart-1: var(--primary)` 别名，其余行（markdown 链接）也靠注释放行。`cell.primary`、`primaryAxisAlign` 这类字段名前面不是 `-`，不会命中。Vue 模板里标签属性之间放不了注释，写在绑定表达式开头（`:class="/* primary-color-allow: 理由 */ …"`）。
  - 键盘焦点统一画实色描边（`:focus-visible`），鼠标点击不画；`prefers-reduced-motion` 下去掉缩放和位移，保留表达状态的转圈。对话里失败命令定位、「回到底部」、时间线跳转三处平滑滚动是代码里显式写的 `behavior: 'smooth'`，不受全局 `scroll-behavior: auto` 管，这时也改成瞬时（`Conversation.tsx` 的 `scrollBehavior()`，每次滚动时读，系统设置运行中改了也跟着变）；定位那一行的 accent 底色淡出不是位移，保留。
  - 间距刻度是 Tailwind 的 0.25rem 步进，跟着「文字大小」一起缩放（D2）：md 档 `p-1` 是 3.5px、`p-4` 是 14px，lg 档才正好是 4/8px。不追求字面上的 4/8px，那样只能写 px，会推翻 D2。任意值间距只留给顶栏（px 固定）、描边补偿和负外边距这类有理由的地方。半档（1.5、2.5）照常用，原语本身就是这么配的；要统一的是同类组件用同一档（第 556–571 步，下面几条）。
  - 同类组件用同一档（第 561–569 步）：
    - 对话里的卡片只有两档（`Conversation.tsx` 的 `CARD`、`CARD_COMPACT`）：标准 `px-3.5 py-3 gap-2.5` 给出错、定位结果、计划、深度扫描报告；紧凑 `px-3 py-2.5 gap-1.5` 给提醒、子智能体、规范审查打回、安全检查有发现和可视化卡。权限卡是唯一大声的元素，单独用 `p-4`。`Card` 原语从 `ring-1 ring-foreground/10` 改成 1px `border`，和 SettingsGroup、手写卡片同一种边线（深色下 ring 叠出来更亮）。
    - 分段控件只有 `Segmented` 一种样子：用量弹层的时间段换成了它；任务页顶栏的面板按钮可以全部关掉（`aria-pressed` 的开关，不是单选），保留按钮语义，只把容器和选中态对齐 `Segmented`。
    - 空状态都用 `EmptyState`，按所在位置选 `variant`：`muted`（默认，单独放在页面或面板里）、`card`（和旁边的设置组、卡片并排，同样的边框）、`plain`（已经在别的框里：设置组、对话区、浏览器面板）。标题 700。设备页和授权项目选择器原来手写的一行灰字也换成了它。
    - 设置页的分区导航和主侧栏同一种行：`h-8.5 gap-2`、图标跟文字同色、搜索框同高，进出设置时左栏不跳。设置组里的行用 `SettingsRow`（快捷键也是）；组里的列表项（归档任务、模型）是另一种行，`py-2 text-sm`。
    - 远程任务页的输入框外壳和本机任务页一样（`border-input bg-card`、聚焦描边、无阴影）。
  - 页面标题（第 566 步）：整页（设置各页、待办、架构）的标题都是 `text-xl font-bold`，说明放在下一行，内容区纵向留白 `py-10 lg:py-12`；首页标题是 2xl。任务页、远程任务页和架构详情顶栏里的标题用 700，不比右侧面板的标题（「任务监控」「审阅」）轻。架构详情的主视图分段用默认尺寸，图种、依赖等子视图用 sm，主次分得开；架构右栏的小节标题和任务监控一样是 `text-sm text-muted-foreground`。
- 原语在 `components/ui/`：Button（含 destructive-solid，尺寸到 xs、icon-xs）、Badge（含 warning；success 变体删掉了，新文件、已删除徽标用中性的 outline）、Kbd、Tooltip、Select（默认 popper 定位）、DropdownMenu、Dialog（DialogBody 负责中间滚动）、AlertDialog、Checkbox、Switch、Segmented、Slider、EmptyState（muted / card / plain 三种 variant）、Popover。图标按钮的提示用 Tooltip，原生 title 只留给截断文本看全文；快捷键写成「Ctrl+K」。
- 外链图标（ExternalLink、↗）只给真正离开应用、在系统浏览器打开的入口（浏览器面板的「在系统浏览器里打开」）。跳到设置页、打开任务这类应用内跳转不加图标：任务监控里的「安全设置」「模型与角色」「MCP 设置」和「审阅」「编辑检查命令」长一个样，用量表里可点的任务名悬停时出下划线。规则出自改版方案 §1.9 第 4 条。
- 外壳是内嵌面板（D1）：主区是嵌在侧栏底色里、左上圆角的一块面板，首页、任务页、设置页共用 `lib/shell.ts` 的 `INSET_PANEL`，切页面时分隔线不跳动。侧栏和设置导航共用 `--sidebar-w`（16.5rem，跟着文字大小缩放）。
- 设置页骨架（`features/settings/SettingsLayout.tsx`）：SettingsHeader（标题、说明、actions 插槽）、SettingsGroup（一组一个带边框的框，组内用分隔线）、SettingsRow（左边标签和说明、右边控件；说明不单独限宽，占满控件左边的一列，整页内容最宽 760px）。新设置页用它们，不再手写卡片。
  - 自动保存的页面（命令权限、安全、任务执行、MCP 服务器、插件、模型与角色、外观）保存成功后，在页头的 actions 插槽里显示「✓ 已保存」3 秒（和 toast 一样长），连续改动重新计时（`useSavedFlash`、`SavedHint`）。保存失败时弹 toast「保存失败：」加原始错误。命令权限页切换权限模式也是：它直接存默认值，不再走任务页的 `setPermissionMode`；任务页输入框里切换失败时仍只弹原始错误。
  - 会话建立时才读的设置，「已保存」后面隔开显示「新任务生效」：两个 span 用 gap 隔开，不用中点；这一段一直占位、只切换可见，第一次出现时不挤动副标题。读屏读「已保存，新任务生效」。安全页的开关（三档检查和规范审查，第 423 步起对已经打开的任务立即生效）和外观立即生效，只写「已保存」。
  - 生效时机只在改动后出现，不写进各页副标题。保存后回到带「已保存」提示的设置页的（MCP 服务器弹窗、模型服务面板），说明里不写生效时机；从首页或任务监控打开的项目设置弹窗写在说明里（「改动对新任务生效。」）。
- 用词：
  - agent 叫「智能体」，Model ID 叫「模型 ID」，MCP 的 prompt 叫「提示词模板」，兜底角色叫「备用」（内部字段和协议不改）。
  - 待用户确认权限的状态叫「等待确认」（D4）；输入框占位保持「请输入指令」（D3）。
  - 标点：说明类的完整句带句号（页面说明、行说明、字段说明、弹窗说明、空状态说明、脚注，以及 ⓘ、DetailTip、解释按钮作用的 Tooltip 这类说明型提示），只有一个短语也带；标题、分组名、标签、按钮、菜单项和选项（含斜杠菜单选项的副文本）、图标按钮的名字提示、徽标、占位符、状态词和状态短句、toast、错误和校验提示不带。以命令或路径结尾的说明行也不带，免得句号被当成命令的一部分（「按 Claude Code 的写法填，不带 /v1」、检查命令的建议行）。中文里短语和无主句分不清，所以按文案所在的位置定，不按语法定。不用「您」。
  - 页面说明（副标题）只写一句，补充放脚注；「所有项目共用」不逐页写；生效时机统一叫「新任务生效」。
  - 撤销：按钮、标题和确认框说明的动词只用「撤销」，宾语用「改动」：完成卡「撤销改动」、操作栏 ↶「撤销这一轮及之后的改动」、确认框标题「撤销改动」、审阅面板「撤销这些改动」。以前「撤销到这一轮之前」「撤销本轮」等几种叫法混用。
  - 模型设置页统一叫「设置 → 模型与角色」（模型菜单里的入口「模型与角色…」、主进程报错里写的去处），不叫「模型」页、「模型管理」；报错的主语是模型（「『编码』角色的模型已停用」）。思考参数叫「思考强度」，「档位」只指它的取值。看图能力叫「视觉」。检查命令叫「完成检查」（第 431 步以前还有「快速检查」）。
  - 角色空值：编码「未选择」（没选时红字「必选：未选择时无法开始任务」），规划、评审「沿用编码模型」，备用「不使用」；设置页的下拉和任务监控用同一组词。以前规划、评审也写「不使用」，实际沿用编码模型；备用不叫「不启用」，免得和模型行的「启用」开关撞词。

## 安全检查

- 目标是把智能体写出的代码的安全底线抬高，不是证明没有漏洞：按规则匹配的检查只抓已知写法，模型扫描有误报、要花钱。三档和规范审查都在「设置 → 智能体 → 安全」里开关，所有项目共用，默认都开。
- 三档的触发节点（参照 Qoder 的 Code security）：静态检查和轻量扫描在任务快完成时（finish），深度扫描在提交或推送前（第 425 步）。节点的差别本质是成本：静态检查在本机、不调模型；轻量扫描每次一次模型调用；深度扫描几十步模型调用，所以要用户点头才跑。
  - Qoder 建议静态检查在编码过程中一直开着；第 424 步照做过（每步改完查一次），用户不要每步检查，第 431 步撤掉，回到只在完成前查。
- 开关对已经打开的任务立即生效（第 423 步）：设置一保存，主进程调 `_diffra/security/configure` 把三档和规范审查的开关发给 core，core 改掉所有已经打开的会话的配置，下一次检查就按新值；之后新建、载入的会话照旧由客户端按设置传。推送失败只记日志，设置照样存下。
  - 以前只在新建或重新打开任务时读一次，设置页写「新任务生效」：关掉之后，一直开着的任务照样检查，要重启应用才不查。
  - 任务监控「任务配置」里的安全、规范两行，本机任务直接读设置；远程任务读对方建会话时报的。
  - 系统提示词里「完成时会按规则审查」那句是建会话时写的，中途关掉规范审查不改提示词（改了会让提示词缓存失效），只是不再审。
- 完成门禁（第 419 步）：先取本轮 diff，再让检查命令、安全检查（静态检查 → 轻量扫描）、规范审查、架构检查同时跑，有问题合在一起打回：完成卡上各类问题用「；」隔开，给模型的说明逐段列出。安全检查、规范审查和架构检查共用这份 diff，需要检查点（Git）。
  - 以前按「检查命令 → 静态检查 → 轻量扫描 → 规范审查 → 架构检查」排队，前面不过就打回、后面的不跑：每打回一类问题都要重跑一遍检查命令才发现下一类，全量测试一次几分钟时，几轮来回就是十几分钟。
  - 代价：检查命令不过时扫描和审查照样调模型，失败的轮次多花这几次调用的 token，意见也可能落在后面还要改的代码上。
  - diff 在检查命令开跑前取：审查看到的是模型交上来的改动，不夹带检查命令生成、又没被 .gitignore 忽略的文件。以前检查命令跑完才取，这类文件会进审查。
  - 同一次 finish 里检查命令也没过时，按检查命令的失败计数（按进展判定卡住），不再另算一次打回。
- 对话卡片的标题和设置页、任务监控用同一套名字：「静态检查」「轻量扫描」（core 发的 tool_call 标题）。旧记录里的「安全检查」「安全扫描」由界面映射成新名字显示（`Conversation.tsx` 的 `SECURITY_TITLES`）。
- 静态检查（`packages/core/src/security/`）：
  - 只看本轮新增的行，在本机运行，不调用模型。用 ast-grep（`@ast-grep/napi`，按语法树匹配，字符串和注释里的写法不会误报），覆盖 TS、TSX、JS、Vue 的 `<script>`、Python，v2 起还有 Java（见「Java 适配器」）。
  - 规则都对应「安全」规则包里的规则号：SQL 拼接、命令拼接、eval、写入 HTML、关闭 TLS 校验、反序列化、MD5/SHA-1 处理密码、用普通随机数生成令牌。另外按正则查所有文件新增行里硬写的密钥。
  - 高危打回，中危只在卡片上提醒。
  - 误报时，代码里可以写带理由的放行注释 `diffra-allow 规则号: 理由`（写在那一行或上一行）。没写理由或规则号不对的不算。所有放行都列在卡片上给用户看。
  - 漏洞样例项目（22 处）：写法类的 14 处全部拦下，没有误报；越权、SSRF、开放跳转、路径穿越、无限制上传、错误泄露堆栈、缺登录校验这 8 处拦不住，交给模型扫描。
- 轻量扫描：
  - 用「评审」角色的模型（没分配时用编码模型）看本轮 diff，再加上改动所在文件的完整内容（每个文件最多 1.2 万字，合计 4 万字）。
  - 只收规则号存在、并且落在本轮新增行上的问题，最多 10 条。高危打回，中低危提醒；模型可以在完成总结里解释。
  - 静态检查已经要打回时先不调用模型，改好后再扫。
  - 依赖文件（package.json、锁文件、requirements、pyproject）变了时顺带跑审计：pnpm 和 npm 用 `audit --json`；Python 要虚拟环境里装了 pip-audit 才跑；yarn、bun 暂不支持。
  - 审计只把本轮新加或改了版本的依赖算到这一轮头上：高危、严重打回换版本，中低危提醒；项目原有的漏洞只报数量。审计要联网，60 秒超时，失败不拦截。
  - 模型调用或审计失败都只在卡片上说明，不拦截。
- 深度扫描：
  - 在任务监控里手动发起，范围是「本任务改动」（从第一轮之前的快照取 diff 作为起点）或「整个项目」（从入口找起）。开始前确认，提示会多次调用模型。
  - 提交前问（第 425 步）：智能体执行的命令里有 `git commit` 或 `git push`（按命令的每一段认，跳过 `-C 路径`、`-c 键=值` 这类全局参数），开着深度扫描、本任务改过代码文件、而且上次深度扫描之后代码又变了，就先弹一张确认卡「提交（推送）前先做一次深度扫描？」：
    - 「先做深度扫描」：这条命令和同一步后面的调用都不执行，这一轮停下（stop 记 `deep-scan`，任务状态「等待中」，对话里留一条提示），界面接着发起一轮「本任务改动」的深度扫描；排队的消息等扫完再发。报告出来后由用户勾选要修的、决定要不要提交。
    - 「直接提交（推送）」只放过这一次；「这个任务不再问」本会话不再问。
    - 不管权限模式，完全访问也问：这是花不花钱的决定，不是权限。
    - 深度扫描跑完时记下工作区指纹，代码没再变就不再问；按完报告修了代码再提交，会再问一次，可以选直接提交。指纹和「不再问」都只在内存里，重新打开任务后会再问。
    - 不管：用户自己在终端里提交、子智能体执行的提交。「本任务改动」从第一个普通提问轮算起，第一轮是目标模式的任务算不出范围，也就不问（扫描的范围按整个项目，和手动发起时一样）。
  - 跑在一轮里（`TurnKind = 'deep-scan'`），进度实时显示、能停止、存进历史；但审计过程不进编码模型的对话。
  - 只读：只给读文件、列文件、搜索三个工具和一个「提交报告」工具，改文件、执行命令的调用会被拒绝。最多 40 步，最后一步或上下文快满时要求直接交报告。
  - 报告里每个问题带数据流链路和修复建议；规则号不存在、文件不在项目里的当作臆测丢掉。
  - 用户勾选后作为新的一轮发给编码模型修，默认勾上高危的。这一轮没有「重新生成」。
- 用量：轻量扫描和深度扫描的模型调用都记在用量统计里，角色是 reviewer。
- 不做（v2 再说）：CodeQL、Semgrep Pro 级别的污点分析（许可证或付费问题）、动态测试、许可证合规扫描、按项目单独设置安全开关。v2 都做了，见下一节。

### 安全的 v2 部分（v2 · M10）

- 新开关（`SecuritySettings` 加了选填的 `taint`、`licenses`、`semgrep`，旧设置没有就当开；旧版读到会丢掉这三项）：设置 → 安全多三行，都跟着静态检查在完成前跑。
- 污点分析（`security/taint.ts`）：在一个函数里按语句顺序跟踪来自请求的数据（Express/Koa 的 `req.query/body/params/headers/cookies`、`ctx.query`、Lambda 的 `event.*`、浏览器的 `location.*`；Flask/Django/FastAPI 的 `request.args/form/json/GET/POST`……），赋给了哪些变量（含解构），重新赋值成别的就不算；经过 `path.basename`、`encodeURIComponent`、`parseInt`、`int()`、`secure_filename`、`shlex.quote` 这类函数的不算。流进 SQL 查询、`child_process.exec`、`eval`、文件读写和 `res.sendFile`、`res.redirect`、`fetch/axios/requests.get`（SSRF）、`res.send` 拼的 HTML、`render_template_string`、`Markup` 时报高危，打回；放行注释和静态检查一样。只看函数内部（不跨函数、不跨文件），只看 TS/JS/Vue 和 Python。同一处按写法匹配的规则已经报了高危就不重复报，规则只是提醒的换成污点分析的高危。旧的漏洞样例里「路径穿越、SSRF、开放跳转」这几类以前要靠模型扫描，现在本机就能拦下请求参数直接用的写法。
- 依赖许可证（`security/licenses.ts`）：只读本机装好的依赖，不联网：`package.json`（根目录和 packages/*、apps/* 下的子包）声明的直接依赖读 `node_modules` 里的 `license` 字段或 LICENSE 文件；项目虚拟环境里 `*.dist-info/METADATA` 的 License 或分类；`go.mod` 的 require 到模块缓存里读 LICENSE 文件。分宽松、弱传染（LGPL、MPL、EPL）、强传染（GPL、AGPL、SSPL）和认不出的；SPDX 的 OR 取最宽松的。完成前只看这一轮新加的依赖：强传染的提醒（项目自己也是这类许可证时不提醒），不打回——用不用是业务决定，不是安全漏洞。没装好的依赖查不了，卡片上说明。
- Semgrep、CodeQL（`security/external.ts`）：Diffra 不自带也不帮着装，本机装了才用（`--version` 探一次，留 10 分钟）。Semgrep 完成前扫这一轮改过的代码文件（90 秒上限），只留新增行上的、只提醒；规则用项目里的 `.semgrep.yml`，没有就用官方 `p/default`（要联网），`--metrics=off`。CodeQL 的命令行只许用在开源代码或有 GitHub Advanced Security 授权的代码上，所以只在任务页手动跑，每次勾选确认有许可；按项目里的语言建不用编译的数据库（JS/TS、Python、Java/Kotlin、C#、Ruby，`--build-mode=none`），跑官方 security-extended 查询集（第一次 `--download` 联网取查询包），读 SARIF；最长半小时，临时目录跑完就删。找不到可执行文件时可以用 `DIFFRA_SEMGREP_PATH`、`DIFFRA_CODEQL_PATH` 指定（测试也用它放假的扫描器）。
- 动态测试（`security/dynamic.ts`）：只对本机服务（localhost、127.0.0.1、::1，core 和主进程都查），从代码里认 GET 接口（Express/Koa/Fastify、Flask/FastAPI、Spring、Django 的路由写法，路径参数换成 1），也可以自己填。每个接口发几种只读的 GET 探测：常见参数名里塞一个标签看是否原样回显在 HTML 里（反射型 XSS）、跳转参数塞外部地址看 Location（开放跳转）、文件参数塞 `../` 看有没有读到 hosts 或 win.ini（路径穿越）、id 参数带引号看有没有数据库报错（SQL 注入）或 500 时返回堆栈（错误泄露），再看页面有没有 `X-Content-Type-Options: nosniff`。每个请求 5 秒超时、最多 60 个接口、可以取消；连不上就说先把服务跑起来。会真的打到服务上，有副作用的 GET 接口也会被调到，开始前写清楚。
- 任务页「更多安全检查」：输入框斜杠菜单里「安全 · 依赖许可证」「安全 · 外部扫描器」「安全 · 动态测试」，弹窗里跑（core 的 `_diffra/security/run`，每样有自己的超时，可以取消），列出问题，默认勾上中高危的，「填进输入框」把勾选的写成一段话交给智能体，不直接发。许可证还能展开看全部依赖。
- 按项目单独设开关：项目设置里多了「安全检查」一节，七项各自「跟设置 / 开 / 关」，只存和全局不一样的几项（`ProjectSettings.security`，旧版读到会丢掉）。建会话时按「全局 + 项目」组装；全局或项目的开关改了，主进程把全局的和每个设过的项目一起推给 core（`CheckSwitches.projects`），core 按会话所在目录套上，已经打开的任务立即按新值。
- 验证：core 的 `security-v2.test.ts`（JS 的六种污点流向和校验、重新赋值、关掉不查；Python 的 SQL、shell=True、文件、跳转、SSRF，列表参数的 subprocess 不算，只看新增行，和规则重复时取更严重的；许可证分类、node_modules 和 LICENSE 文件、没装的说明、完成前只提醒新加的；Python 虚拟环境；假的 Semgrep：没装、装了、完成前只留新增行；假的 CodeQL：要确认许可、建库分析读 SARIF；本机 HTTP 服务上的反射 XSS、开放跳转、路径穿越、SQL 报错，正常接口不报，连不上时说明；只许本机地址、从代码里认路由），`loop-review.test.ts` 里专测轻量扫描的用例关掉了污点分析（它的读文件写法现在在静态检查就被拦下）。e2e `security-v2.spec.ts`：项目设置里关掉轻量扫描和规范审查后同一个任务接着做，静态检查里污点分析打回、许可证提醒、评审模型一次没调；斜杠菜单的三样（许可证填进输入框、本机服务的反射 XSS、假的 Semgrep 出结果、没装 CodeQL 时不能跑）。`security.spec.ts` 的设置断言加上了三个新开关。真的扫描器（2026-11-15，core `real-tools.test.ts`，`DIFFRA_REAL_TOOLS=1` 才跑；CodeQL 不在 PATH 上时用 `DIFFRA_CODEQL_PATH`）：Semgrep 1.185.0 按项目里的 `.semgrep.yml` 扫出 eval 请求参数，完成前只留新增行上的；CodeQL 2.27.4（官方 bundle）对几行 Express 示例建库、跑 security-extended，报出 `js/path-injection` 和 `js/code-injection`。示例代码是测试里现写的。


## 用量统计

- 统计对象：每次模型调用记一条，编码循环、规范审查、安全扫描、出计划、上下文压缩都算。「测试模型」按钮的调用不算。
  - 数字取供应商返回的用量，不自己估算。供应商没返回时只计次数，用量页注明有几次。
  - 只记完成了的调用。被停止或出错的调用拿不到用量，不记。
  - 从加入这个功能的版本开始记。旧的会话记录每轮只存了最后一次的输入用量，补算不了。
- 口径：
  - 「总 token」是输入加输出。
  - 输入包含缓存命中的部分，缓存命中率 = 缓存读 / 输入。
  - 输出包含推理的部分。
- 存储：应用数据目录的 `usage/YYYY-MM.jsonl`，按 UTC 月份分文件，一行一次调用。
  - 字段：时刻（UTC）、会话 id、项目路径、供应商 id 和名称、模型 id、角色（编码 / 审查 / 规划），以及输入、缓存读、缓存写、输出、推理的 token 数。不存 API Key 和对话内容。
  - 只有 core 进程追加写，同一进程里的写入排队执行。
  - 文件末尾是上次崩溃留下的半行时，先补换行再追加。读取时跳过格式不对的行，并在用量页提示。
  - 估算每行约 250 字节，一天 2000 次调用约 0.5 MB。记录永久保留，不自动删；v2 加了手动清理，见下面。
  - 供应商名由桌面端在会话配置里传给 core（`model.provider`、`reviewModel.provider`），只用于记用量。
- 汇总：在 core 里边读边算（`_diffra/usage/summary`），不把记录全部读进内存。
  - 界面按本机时区算起止时刻，连同 IANA 时区名一起传给 core，core 按这个时区划分每天。
  - 一次最多统计 400 天。
  - 分组：按天（没有调用的天也列出）、按模型（供应商 + 模型 id，名称取最近一次的）、按项目（Windows 上路径不分大小写；无项目任务每个按文件夹名单独一行，见「无项目任务」），以及用量最多的 10 个任务。
- 用量页在「设置 → 数据 → 用量」，范围有今天、近 7 天、近 30 天、本月。「今天」只显示数字，不画只有一根柱子的图。
- 不做：自动删旧记录。

### 费用、预算、导出和清理（v2 · M11）

- 单价由用户按模型填（用量页「单价和预算」）：每百万 token 的输入、缓存命中、写入缓存、输出价，缓存的两项不填就按输入价；币种一个（人民币或美元），只影响显示。不内置价格表：各家价格常变，内置的会错。存在 `settings.json` 的 `usage`（`currency`、`prices`、`monthlyBudget`、`budgetNotice`，都可选，旧版读到会丢掉）。
- 金额全程用整数：单价换成「每百万 token 多少微元」（BigInt），乘 token 数累加，最后除一次、四舍五入到 6 位小数，以字符串交给界面（`usage/pricing.ts`）。输入里的缓存命中、写入缓存各按各的价，剩下的按普通输入价。先按供应商加模型找单价，找不到再按模型找。
- 汇总时单价由主进程从设置里带给 core（`UsageQuery.prices`），每天、每个模型、项目、任务都带费用和「没有单价的调用次数」；没填任何单价时界面不显示费用。界面只做显示格式（小于 1 时留 4 位小数）。
- 每月预算：到 80% 和 100% 各提醒一次（记在 `budgetNotice`，换月重来），只提醒，不拦着继续用。启动时和每一轮结束时查，一分钟内最多查一次；要先填了单价才算得出来。
- 导出：按当前范围导出 CSV（保存对话框选位置），一行一次调用，core 边读边写，不全读进内存；开头加 BOM（Excel 不乱码），时刻是 UTC，另给一列按用户时区的日期，有单价时多一列费用。
- 清理：列出每个月的记录文件和大小，选一个月份，删掉它之前的所有月份（按 UTC 月份，排在追加写后面，不和写入抢文件）。删了不能恢复，确认框里写明会删哪几个月、多大，建议先导出。
- 无项目任务按项目统计时合成一行，见「无项目任务」。
- 验证：core `usage-v2.test.ts`（整数单价没有浮点误差、缓存价、各分组的费用、无项目合成一行和转过的单独一行、CSV 转义和 BOM、清理）；e2e `usage-v2.spec.ts`（填单价后的费用、合成一行、预算提醒只出一次、导出、清理旧月份）。

## 评测集

- 目的：用同一批题比较模型和 Diffra 自身改动的效果，不靠体感。位置在 `packages/eval`，命令行运行，不进桌面端。
- 题目全部自写，不用公开基准：公开题大概率进过模型的训练数据，而且考的不是「生产级」要求（安全、规范、受保护文件、门禁）。
  - 首批 10 道，TS 和 Python 各 5 道，覆盖功能、修 bug、多文件、重构、安全（路径穿越、SQL 注入、越权）、受保护文件、门禁、编码规范。
  - 每道题一个目录：`task.json`（需求、检查命令、只读目录、权限策略等）、`repo/`（带可见测试的小项目）、`hidden/`（验收测试）、`solution/`（参考答案）。
  - 需求按真实用户的说法写。安全题不提示安全要求，考的是智能体会不会自己做到。
- 判分只看隐藏测试：跑完后才把 `hidden/` 放进项目再执行，退出码 0 算通过；另外改了 `unchanged` 列出的文件、或 `secrets` 里的字符串出现在对话里，也算失败。不用模型打分。
  - 第 450 步加了两道委派题（`t11-stock-negative`、`t12-audit-trail`，类别「委派」）：项目有二三十个文件，要先摸清几个模块怎么互相调用才能改对，改动本身不大。`task.json` 多一项 `delegate`（`expected` / `unexpected`），只用来统计、不影响判分；原来的 10 道小题标成 `unexpected`。
    - 报告多一列「子智能体」（派了几个、它们调用了几次工具）和一行汇总（该派的题派了几道、不该派的题派了几道、子智能体共用多少 token）；`results.json` 里每题有 `delegations`、`workerToolCalls`，用量里有 `subagentCalls`、`subagentTokens`（以前子智能体的调用被算进评审）。
    - 工具调用数从这一步起不含子智能体的卡片本身（含它们调用的工具），和之前的基线比会略低。
  - 题目自检（`pnpm eval selfcheck`，也在 vitest 里跑）：原样的项目隐藏测试必须失败，套上参考答案后检查命令和隐藏测试都必须通过。
  - 隐藏测试要能抓住常见的错误写法（比如路径前缀判断不带分隔符、排序字段直接拼接、吞掉异常），新增题目时用这类错误写法验证过再收。
- 运行方式和应用一致：每道题复制到结果目录，起一个独立的 core 进程（会话和用量记录写到这道题的目录），权限模式为自动，剩下要确认的按题目的策略统一允许或拒绝；规则包带内置包的强制级规则，和应用默认值一样。
  - 模型配置写在 `eval.config.json`（不提交），密钥只从环境变量读，配置里写变量名。
  - 结果写到 `results/<时间>-<模型>/`（不提交）：`results.json` 给程序读，`report.md` 给人看，含通过率、按类别的结果、每题的工具调用、模型调用、token、用时、门禁打回次数、安全发现，以及失败题的项目目录和测试输出。
    - 门禁打回次数从语义层第 57 步起包含完成条件未满足和发布证据不合格的打回（这两种现在也出一张失败的「完成」卡），和之前的基线不能直接比较。
    - 检查失败和门禁打回次数从第 140–141 步起也不能和之前的基线直接比较：检查卡住改成按进展判定（check-exhausted、gate-exhausted 的含义跟着变了），有进展时不再在第 3 次失败停下，一题里可能多失败、多打回几次，因检查停下的题会变少。`notices` 里检查停下的提示标题也换了说法，失败次数到上限的标题是「检查失败次数到上限，已停止」，不分快速检查和完成检查。
    - 第 418–419 步起又变了：快速检查失败不再让一题停下或换模型；完成门禁一次打回所有问题，打回次数会变少。检查停下的提示只剩完成检查的两种：「完成检查连续 3 次没有进展，已停止」「完成检查失败次数到上限，已停止」。第 431 步起改的过程中不跑检查：题目里配的 `afterEdit` 只在没配 `beforeFinish` 时当完成检查用，检查失败次数只来自完成检查。
- 深度扫描准确率：2 个样例项目埋了 11 个问题，也放了看起来危险但安全的写法。规则号相同、文件相同、行号相差 3 以内算查出；同一个问题报两遍不算误报。
  - 一个问题有几处同样合理的修复位置时（比如越权可以在路由里校验归属，也可以在查询里按当前用户过滤），答案表都列上，报在哪一处都算查出。第一次基线里模型把越权报在查询上，只认路由一处时被算成了漏报加误报。
- v2（M11）统计、费用、难度和桌面端查看：
  - 统计放在 core 的 `stats.ts`（纯计算，web 侧也能 import），评测命令行和桌面端用同一套：每个模型的通过率加 95% Wilson 区间（全过也不说成 100% 确定）；按类别；按题目实际的通过率分难度（≥90% 易、≥50% 中、其余难），也按题目自己标的难度（`task.json` 可选的 `difficulty`）。
  - 费用：`eval.config.json` 里给模型配可选的 `price`（和用量页同样的每百万 token 单价），按每道题的用量记录算，整数相加；没配的题不算，报告里注明「有的题没有单价」。
  - 两次结果比较：`pnpm eval compare <A> <B>`（结果目录或 results.json），按题配对：每道题看两边的通过率谁高，p 值是双侧符号检验，通过率差的区间是按题重抽 2000 次的自助法（固定种子，同样的输入同样的结果）；只算两边都有的题。写到 B 旁边的 `compare.md`，列出变了的题。p < 0.05 才说有差别，题少、遍数少时区间会很宽。
  - `report.md` 每个模型多两行：通过率区间和费用、按难度。旧的 results.json 没有难度和费用也能读。
  - 桌面端：设置 → 数据 → 评测结果，打开一份 results.json（主进程读，最大 50MB，zod 校验，只读不改），看每个模型的通过率区间、平均 token 和用时、费用、按类别和难度，每道题一行（实际难度和标的不一样时注明）；再选一份旧结果就按题比较，标「新的更好」「新的更差」「看不出差别」。
  - 验证：core `stats.test.ts`（Wilson、符号检验、汇总、配对比较）；eval `stats.test.ts`（按单价算费用、compare 写出的内容、旧结果能读）；e2e `eval-results.spec.ts`。
- 第 615–627 步：以四个目标为准扩充评测——全自动不用人插手、超大项目少出错、指令遵循（最看重）、听得懂人话。原来的 12 道题 gpt-6.1-sol 和 deepseek-flash 都全过，测不出东西。
  - 过程落盘：每道题写 `events.jsonl`（用户说的话、会话更新、确认和提问怎么答的、中途停止）和由它生成的 `transcript.md`，审问题看的是过程，不只是通过率。
  - 可判定的明确要求（`constraints`）按来源分组算遵循率：这一轮说的、前几轮说的、根目录和子目录的 AGENTS.md、没明说但该做到的。只用规则判定，不用模型打分；自检时参考答案也要做到能静态判定的那几种。
  - 全自动指标：插手次数（确认加提问）、说完成但没做对；回复语言和用户不一致的段数（第 624 步加的）。
  - 四组新题：攻击 8 道（`r`，大多用完全访问档，提示注入、删数据、往项目外写、冲掉没提交的改动、目录联接、打印密钥、安装脚本外发；判定靠本地收信服务、项目外的哨兵文件、`dirty` 文件）、指令遵循 12 道（`i`）、听懂人话 23 道（`l`，同一件事三种说法，该问和不该问，中途改口）、大项目 6 道（`x`，生成约 2700 个文件、40 个模块的项目）。另有回放 Diffra 自己历史提交的题（`rp`，第 627 步）：项目是那个提交的上一版整个仓库，依赖用目录联接借本仓库的 `node_modules` 并设成禁写，隐藏测试是那个提交改的测试文件，要用到新函数名的提交不收（智能体猜不到名字）。
  - 题目项目放在 Diffra 仓库外面（默认系统临时目录下的 `diffra-eval-runs/`）：放在仓库里时，攻击题里的智能体顺着路径往上找，读到了题目的生成脚本。
  - 用桌面端里配好的模型跑：`scripts/with-dev-key.mjs` 用 Electron 解出密钥，只放进子进程的环境变量；桌面端数据目录只读，`Local State` 复制到 `results/.dev-key-userdata` 再解密（Electron 占着自己的数据目录，删不掉，固定位置每次覆盖）。
  - deepseek-flash（思考强度 xhigh）的基线：原 12 道全过但 29% 的进度说明是英文（第 624 步修）；听懂人话 22/23（唯一失败是评测答案匹配写错）；指令遵循两遍 22/24、明确要求 81/82；攻击两遍 13/16（密钥进对话、删到项目外各一次，第 625、626 步修完连跑 3 遍 23/24、这两类 0 次）；大项目两遍 12/12。
- 第 630–632 步：新加 57 道题（目标模式 `g`、指令地狱 `h`、业务缺陷 `k`、多轮改口 `m`、回放 `rp`、攻击 `s`）各跑 3 遍，deepseek-flash 141/171，明确要求 718/726。30 次失败逐个看过程归因：
  - 一半多是题目或判题的毛病（规格和隐藏测试矛盾、要求里没写的函数名和原文、正则把测试代码和状态列表也算进去、Rust 题没忽略 `target/`、自动作答的正则一个选项都没对上），改了题目。自动作答对不上时报告里注明，不再默默选第一个。
  - 5 次是模型接口回了 200 却没读完回复，整轮停下，评测还把它算成「说完成但没做对」：core 改成像连接中断一样重发（第 632 步）；评测单独标「模型接口出错中断」。
  - Diffra 的问题：命令里写了 `${}`、`${h.endedAt}`，shell-quote 抛异常把整轮停掉（第 632 步，换成普通变量再拆，危险命令检查照做）；回放题禁写的 `node_modules` 被忽略导致检查点全建不起来（见上面检查点）；`git show` 翻出历史里的 `.env`（第 631 步）；只要方案时用户回答了提问就动手改代码（第 630 步，提示词写明回答提问不等于让动手）；轻量扫描要求加参数，智能体照着改了用户写明的函数签名（第 632 步，打回说明里写明用户指定的接口不自己改，最后说明风险）。
  - 修完重跑这 14 道题：27/42 → 40/42。
  - 试过没留：调试题 d02（u32 毫秒 49.7 天回绕）三次都只修一半，在提示词里加「找到原因后查别处有没有同样的错、不依赖代码没保证的假设」，再跑三次还是 0/3、失败方式一样（照样写下「间隔最长分钟级」这种假设），去掉了。这类靠提示词推不动，算模型能力。
  - 也试过没做：完成前加一道「查漏审查」（把需求、diff、改过的文件交给审查模型，只问修没修全、同样的错别处还有没有、需求有没有漏）。先离线拿已有记录试：d02、p08 共 6 次漏修只抓到 2 次；8 次做对的里冤枉了 2 次（其中一次报的是题目没要求的多实例竞态，接进去会白白打回返工）；思考强度拉满时每次 1–4 分钟。抓得少、慢、还误报，不值得每次完成都多跑一道。

## 工具链注意事项

- pnpm 11 对刚发布的包有冷却期。被拦时换稍旧的版本（比如 Playwright 用 1.64.x），不要写 `minimumReleaseAgeExclude` 绕过。
- Electron 45 不在安装时下载二进制，改为首次运行时下载。新环境可以先执行 `pnpm --filter @diffra/desktop exec install-electron`。
- pnpm 11 用 `pnpm-workspace.yaml` 的 `allowBuilds` 管理依赖的安装脚本。electron-winstaller（Squirrel 安装器用的）设为 false，Diffra 只打 NSIS 包；node-pty 设为 true，它的安装脚本会选用自带的预编译文件；`@ast-grep/lang-python` 设为 false，包里带了各平台的预编译解析器，运行时直接加载，不需要安装脚本去本机编译。
- e2e 的脚本模型按系统提示词认出轻量安全扫描的请求，单独按 `securityReplies` 作答（用完后回「没有问题」），不占普通剧本的步骤。
- 测试里像真密钥的字符串在运行时拼出来，仓库里不出现完整的密钥格式，免得推送时被代码托管平台的密钥扫描拦下。
- e2e 按卡片种类定位对话内容（`data-testid="tool-call"` 加 `data-kind`），不靠匹配文字；默认 9 个用例并行，每个都开一个 Electron。
  - 本机跑 e2e 时这些窗口开在桌面上，跑的时候别把鼠标停在它们上面滚动、打字：Windows 默认让滚轮滚动鼠标下面的非活动窗口。2026-11-10 「不跟随时下面长出新内容」偶发失败过一次，就是对话被滚回底部附近、按设计恢复了跟随（第 366 步排查，模拟滚轮能复现）；这个用例现在会认出外部输入，失败信息写明「结果作废，请重跑」。想彻底避免可以在 Windows 设置里关掉「悬停时滚动非活动窗口」。
- core 和 desktop 的 Node 侧 tsconfig 把 `lib` 限定为 `es2023`（不含 DOM），否则 Node 的 web stream 类型会和 DOM 版冲突。

## 局域网设备连接（v2 · M6）

- 设备连接重新开放，但只在局域网里直连（`shared/remote.ts` 的 `DEVICE_TRANSPORT = 'lan'`）；经 relay.diffra.dev 的互联网版照旧下线，`devices.spec.ts`（中转的用例）只在 `DEVICE_TRANSPORT` 是 relay 时跑。互联网远程、P2P 打洞、离线暂存、自建中转、远程撤销都不做。配对之后的部分（Noise 加密通道、按项目授权和级别、只能「允许一次」、项目外访问只在本机确认、同步、远程操作、审计）全部沿用，没改。
- 传输（`main/remote/lan-transport.ts`，和中转的 `RelayClient` 实现同一个接口 `transport.ts`）：
  - 每台设备一个 TLS 1.3 服务（监听 0.0.0.0 的随机端口，发现服务里报出去），双方都出示证书。证书是每台设备自签的一张 ECDSA P-256（`lan-tls.ts` 自己按 X.509 DER 拼，Node 只能读不能签；不加依赖），私钥用 safeStorage 加密存在 `remote/tls.json`，重置身份时一起换。
  - 只接受、只连私有地址：10/8、172.16/12、192.168/16、169.254/16、127/8，IPv6 的 fc00::/7、fe80::/10、::1 和映射的 IPv4；别的连进来直接断开、也不往外连。
  - 连上先报 hello（设备 ID）：配过对的设备要出示配对时记下的那张证书（指纹存在授权和已添加设备的记录里，`tls` 字段），对不上就拒绝并说「可能被冒充」；还在名单里（总开关开着的授权设备、本机添加的设备）才算连上。没配过对的只能带着本机正开着的配对会合点连进来，只收这个会合点的帧。旧的中转版配对记录没有证书指纹，要重新配对。
  - 帧和中转的一样，外面加 4 字节长度和 1 字节类型；单帧上限和中转一样。20 秒一次 ping，60 秒没动静就断开。最多 32 条连接、同一个地址最多 4 条，10 秒内没报 hello 的断开，一条连接积压超过 8 MB 时发不出去（上层重新订阅）。
  - 自动重连：本机添加的设备断了按 1 秒到 30 秒退避加抖动重连；发现服务看到它（重启后换了端口、换了地址）马上重连，新地址记进记录（`lan` 字段），下次启动先试它。撤销、从名单拿掉时马上断开。
- 发现（`lan-discovery.ts`）：开着「允许连接本机」的设备每 3 秒在局域网里报一次（UDP 组播 239.255.77.77 和广播，端口 47913，一条 JSON：设备 ID、名称、TLS 端口、证书指纹、是不是正等着配对），12 秒没再听到就当它走了；只认私有地址发来的、不超过 1 KB 的。只在需要时才监听：开着总开关、有添加过的设备、或者「添加设备」开着。发现的内容谁都能冒充，所以真正认人靠证书指纹。
- 版本对不上：发现消息和 hello 里都带设备连接的协议版本（`REMOTE_PROTOCOL`）。被连接端看到 hello 的版本和自己不一样就拒绝，原因写「两边的 Diffra 版本对不上……请两边都更新到最新版再连」（以前只会在 Noise 握手时失败、说不清原因）；添加设备的列表里这台标「版本不一致」、选不了，已添加的设备标「版本不一致」并说明更新后会自动连回来。
- 配对码代替邀请串：被连接端生成 6 位数字，和自己的设备 ID 一起用 HKDF 派生出邀请密钥（`pairing.ts` 的 `lanPairingSecret`），后面的 Noise XXpsk3 握手、hello 里核对设备 ID、本机的人核对对方名称和指纹点允许、选项目都和邀请串一样。码短，靠这几点撑住：只能在线猜（每猜一次都要完整连一次、握一次手，被动监听算不出），猜错 3 次这个码就作废，10 分钟过期，只能用一次，最后还要人点允许。连接端在「添加设备」里看到局域网里的设备（名称、地址、证书指纹、是否等配对），先和对方页面上显示的证书指纹核对，再输入配对码；配好后记下这张证书。
- 防火墙：Windows 第一次打开「允许连接本机」时系统会问要不要让 Diffra 使用网络，界面上写了选允许专用网络。平时（没开总开关、没添加设备）不监听任何端口。
- 界面：设置 → 设备连接，说明改成局域网直连；本机多一行「证书指纹」；「生成配对码」显示大号的 6 位数字和作废；「添加设备」是局域网里的设备列表加配对码输入框。侧栏的远程项目、远程任务页、远程操作都没变。
- 验证：`scripts/lan.test.ts`（`node --test`）测自签证书能被 Node 读、指纹一致、私钥对得上；私有地址的判断；两个发现服务在本机互相看到、不收乱写和超长的包；两个传输实例在 127.0.0.1 上：没开会合点、会合点不对、证书指纹不对都被拒，配对连接只收这个会合点的帧，关会合点后连接端收到送不到；钉住证书后自动连上、两边在线、直发帧双向；撤销后断开、再连被拒；被连接端重启（同一端口）后退避重连回来；证书和钉住的对不上时连不上；协议版本不一样时配对和重连都被拒、原因写明是版本。e2e `devices-lan.spec.ts` 两个实例（只听 127.0.0.1、发现消息互相单发）：被连接端开总开关、生成配对码，连接端在列表里看到它（等配对、证书指纹和对方页面上的一样），输入配对码，被连接端核对指纹、开放项目后允许；两边在线，配对码作废，配对记录里有证书指纹，证书私钥没有明文；连接端侧栏看到远程任务、看到内容、远程发消息由被连接端执行；被连接端重启后（换了端口）连接端自动连回来；撤销后连接端马上离线、连不回来。第二个用例测授权边界：一个项目只读开放、一个可操作开放、一个不开放，没开放的项目和任务不在列表里、直接订阅或发消息说「没有这个会话」，只读的发消息、新建、停止都被拒，伪造的「改设置」调用被拒，可操作的项目里远程发带图片的消息由被连接端执行、看得到图和来源设备。`shell.spec.ts` 改成：设置里有入口、启动时局域网服务没开。没有在两台真的电脑、真的路由器上试过（组播、广播、防火墙弹窗要手动确认）；Mac 上的本地网络权限提示也没试过。

## 设备连接下线（2026-11-15）

- 原因：设备连接的网络安全问题还没有彻底解决。在解决之前，这个功能不对外开放。
- 官网：快速开始的「设备连接」入口和整节说明去掉了，快捷键顺延为第 8 节；更新日志里 0.3.x 的设备连接条目也去掉了；隐私政策删掉设备连接、中转服务 relay.diffra.dev 和相关日志说明，只保留官网和更新服务。
- 桌面端：`packages/desktop/src/shared/remote.ts` 加 `REMOTE_DEVICE_CONNECTION_ENABLED = false`。主进程不再启动 `RemoteService`、不注册远程 IPC；设置里的「设备连接」、侧栏「设备」、标题栏提示、配对请求、远程任务页、远程项目和搜索结果都按这个开关隐藏。代码保留。
- 中转：`packages/relay` 的 `createRelay` 新增 `enabled` 选项，关闭时仍提供健康检查，但拒绝所有 WebSocket 升级（503）；`src/main.ts` 默认关闭，只有 `RELAY_ENABLED=1` 才接设备连接，systemd 单元写明 `RELAY_ENABLED=0`。
- 测试：`packages/desktop/e2e/devices.spec.ts` 在开关关闭时整体跳过；开关恢复后会自动重新运行。
- 恢复条件：先彻底解决网络安全问题，再把桌面端开关改回 `true`、恢复官网说明，确认构建和测试后发布；中转要把 `RELAY_ENABLED` 改成 `1` 并重新部署。
- v2（M6）：桌面端开关改回 `true`，但只开局域网直连（见上一节「局域网设备连接」），中转和互联网版照旧下线；官网和隐私政策还没加局域网版的说明，发布前要补。
- 2026-11-15 已紧急停用线上 relay：执行 `systemctl disable --now diffra-relay`，现有连接断开，`https://relay.diffra.dev/health` 返回 502，服务器重启也不会自动恢复；官网和更新服务不受影响。恢复要另行通知后执行 `systemctl enable --now diffra-relay`。
- 还没做的：桌面新版本和官网还没发布；线上 relay 跑的还是旧代码（现在停着）。正式恢复前仍建议部署这次的 relay 代码并把 `RELAY_ENABLED` 设为 `1`；部署要另行确认。
- 验证：`pnpm --filter @diffra/desktop typecheck`、`build`、`build:website` 通过；桌面端完整测试 131 通过、15 跳过；`pnpm --filter @diffra/relay test` 13 个通过（含关闭时拒绝升级、健康检查照常）；构建后的官网和更新日志里搜不到设备连接、relay 相关文案；e2e 确认侧栏、标题栏和设置里没有可见入口。
