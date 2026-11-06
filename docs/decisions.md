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
- 打包和更新：electron-builder + electron-updater。electron-updater 打进主进程的 bundle。安装包里的 node_modules 只有 node-pty：原生模块打不进 bundle，所以它是桌面端唯一放在 `dependencies` 里的包。
- 界面：Tailwind 4 + shadcn/ui（radix-nova 样式，底层是 Radix）。
  - shadcn CLI 识别不了 electron-vite 项目，`components.json` 和主题变量是手写的；之后加组件用 `pnpm exec shadcn add <名字>`。
  - 合并 class 用 shadcn 作者发布的 `cn` 包，代替 clsx + tailwind-merge。
  - CLI 加依赖时会写进 `dependencies`，要挪到 `devDependencies`：界面代码打进 bundle，安装包里不需要它们。
- 模型调用：AI SDK 7（`ai` 和 `@ai-sdk/*`），只在 core 里用。
- 其他运行时依赖：
  - core：`@vscode/ripgrep`（搜索）、`shell-quote`（拆分命令做权限分级）。
  - 桌面端：`diff`（渲染 diff）、`react-markdown` + `remark-gfm`（回复按 Markdown 显示，不渲染原始 HTML）、`@xterm/xterm` + `@xterm/addon-fit`（终端界面）、`node-pty`（终端进程）。
- 运行前提：Windows 上需要 Git for Windows，检查点要用 git，命令执行要用它自带的 bash。

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
- 角色：编码必选；规划、评审不选就用编码模型；兜底不选就不升级。供应商或模型被删除后，指向它的角色会自动清空。

## 发布与更新

- 打包：electron-builder 打 NSIS 一键安装包（每用户安装，x64），配置在 `packages/desktop/electron-builder.config.ts`。
  - electron-builder 只会自动找 `electron-builder.yml/json/ts` 这类文件名，所以 `package` 脚本里用 `--config` 显式指定配置文件。
  - `npmRebuild: false`：唯一的原生依赖 node-pty 自带 N-API 预编译文件，Electron 能直接用。打包时默认会用 node-gyp 重新编译，本机没装 VS 编译工具就会失败。
  - node-pty 的原生文件由 electron-builder 自动解到 `app.asar.unpacked`（约 8.5MB）。
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

## Agent 核心（v0）

- 结构：core 实现 ACP 的 `session/new`、`session/prompt`、`session/cancel`，过程通过 `session/update` 推给界面，需要确认的命令通过 `session/request_permission` 询问。
  - 桌面端在 `session/new` 的 `_meta.diffra` 里传入编码模型、评审模型、检查命令、禁写目录、规则包、权限模式和检查点目录（类型见 `packages/core/src/protocol.ts`）。
- 会话持久化（推翻了原来「会话只存在内存里」的做法）：
  - core 把会话存到应用数据目录的 `sessions/<id>.json`，另有 `index.json` 做列表；目录由桌面端通过 `DIFFRA_SESSIONS_DIR` 告诉 core。
  - 每轮开始和结束时保存；还没开始过任务的会话不保存，免得每次打开项目都留下空记录。
  - 存的是：标题、项目、每轮的提问和界面要重放的会话更新、发给模型的对话消息、每轮的检查点和对话起点（撤销、重新生成要用）。不存模型地址和 API Key。
  - 用 ACP 标准的 `session/load`、`session/list`、`session/delete`；改名、归档、搜索、重新生成、取 diff 走 `_diffra/session/*` 扩展方法。历史放在 `session/load` 响应的 `_meta.diffra` 里一次给界面，不逐条回放 `session/update`。
  - 打开旧任务时，模型、检查命令、禁写目录、规范都按当前设置重新组装，只有对话历史来自记录。
  - 写文件先写临时文件再改名、按会话排队；`index.json` 丢失或损坏时从各个会话文件重建。
  - 应用退出时没跑完的一轮，重新打开后显示为「已停止」。
- 任务标题取第一次提问的第一行，最长 40 字，可以重命名。
- 主循环自己写，不用 AI SDK 的 agent 循环：每一步调一次 `streamText`，工具由我们执行，这样权限、检查点、检查和门禁都在我们手里。
  - 上限：每轮最多 50 步；上下文用到 80% 就停下（压缩在第 7 步）；模型请求失败重试 2 次。
  - 参数不合法的工具调用，AI SDK 会自己在返回消息里补错误结果，主循环不再重复补，否则同一调用会有两个结果。
  - 系统提示词用英文，回复语言跟随用户；会读入项目根目录的 `AGENTS.md`、`CLAUDE.md`（合计最多 8000 字）。
- 工具 6 个：read_file、list_files、search、edit_file、run_command、finish。
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
  - 完全访问：不再询问。
  - 三种模式下，直接拒绝的命令清单都照旧；命令里提到受保护文件、改动禁写目录时总要问。
- 检查点：每轮开始前打快照，存在应用数据目录 `checkpoints/<项目路径哈希>` 下的裸仓库里，用 `--work-tree` 指向项目，不碰项目自己的 `.git`。
  - 仓库配置关掉 autocrlf，按原样保存字节；遵守项目的 `.gitignore`，并总是排除 `node_modules/`。
  - 「撤销到这一轮之前」只动这一轮之后有变化的文件：改过和删掉的恢复，新建的删掉；执行前先列出文件让用户确认。这段时间里用户手动改过的文件也在列表里。
  - 需要系统装有 git；没有时会话照常运行，界面提示改动无法撤销。
  - 同一个仓库上的 git 操作（快照、列变化、取 diff、还原）在 core 里按仓库目录排队执行。它们都要写仓库的索引文件，同时跑会撞上 `index.lock`；同一项目的多个任务共用一个仓库，界面上任务监控、审阅面板、撤销确认框也会同时来读。
  - 一轮刚开始、快照还没打好时来要这一轮起的 diff，返回空：快照在任何工具运行之前打，这时还没有改动。
- 检查命令按项目路径存在应用设置里（`settings.json` 的 `projects`），不往用户仓库写文件。新建或重新打开任务时传给 core，改了对已经打开的任务不生效。
  - 快速检查：某一步改了文件后自动跑，失败输出交给模型修；连续 3 次失败就停下。
  - 完成检查：finish 时跑，不填就用快速检查；不过就打回，连续 3 次不过就停下。改了文件却没调 finish 的，会被拉回来要求调用。
  - 都没配时 finish 照样通过，但界面标注「改动未经自动验证」。
  - 系统提示词会写明哪些检查命令会自动跑、要求模型不要自己再跑。真实模型试跑时发现，不写这条的话模型会自己再跑一遍测试，还会多弹一次权限确认。
  - 「完成」卡片在完成检查跑完后才显示，界面上的先后顺序和实际执行一致。
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

## 编码规范

- 不把整本规范塞进提示词：系统提示词每一步都要重发；弱模型对长规则清单的遵守率低，对具体的报错和审查意见修得最好。所以规范分三层接入：
  - 能用工具查的交给 lint，配成项目的检查命令。自动识别项目已有的 lint 配置属于第 5 步；p3c-pmd 跟 Java 适配器一起放在 v2。
  - 查不了的写成规则包，按项目语言挑选后写进系统提示词。
  - 可选的完成前审查：评审模型按规则审这一轮的 diff，有违规就打回。
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
- 用户可以导入自己的规则包：存到应用数据目录的 `rules/<id>.md`。
  - id 不能和内置包重名，规则编号不能和已有的包冲突。同 id 的导入视为更新。
  - 目录里解析失败的文件跳过，并在规范页提示。
- 按项目语言选包：会话创建时用 `rg --files`（遵守 `.gitignore`）按扩展名统计文件数。
  - 不分语言的包排在前面，其余按对应语言的文件数从多到少排。项目里没有的语言不选。
- 写进提示词的方式：
  - 排在项目的 `AGENTS.md` / `CLAUDE.md` 之后，写明优先级低于用户指令和项目规则，只约束这次写或改的代码，不要为了规范去改无关的旧代码。
  - 默认只放强制级。合计上限 4000 字，预算不够时先保证强制级；放不下的条数写进提示词。
  - 实测强制级篇幅：通用约 1200 字，安全约 900 字，Java 约 1500 字，TS/JS 约 800 字，Python 约 600 字。单语言项目都放得下；Java + TS 的全栈项目会超出，TS 包排在后面，部分条目会被省略。
- 项目设置存在 `settings.json` 的 `projects[路径].rules`：关掉的包（disabledPacks）、关掉的单条规则（disabledRules）、推荐级是否也写进提示词（includeRecommended）、是否审查（review）。
  - 新加的包默认启用。改了对新建或重新打开的任务生效。
- 完成前审查：项目级开关，默认关。误报率还没在评估集上测过，第 6 步测完再决定默认值。
  - 时机：完成检查通过（或没配检查）之后再审，免得对跑不通的代码提风格意见。
  - 范围：取这一轮的 diff，只看代码文件（能按扩展名认出语言的），只按和这些文件相关的包里的强制级规则审。
  - diff 先标好新文件的行号再给评审模型，弱模型自己数行号很容易错。超过 6 万字只审前面的部分。
  - 只接受规则编号存在、并且指向本轮新增行的意见，最多 10 条；落不到新增行的意见当作臆测丢掉。
  - 有违规就当作完成检查没通过，打回给编码模型，计入「连续 3 次不过就停下」的上限。编码模型认为意见不对时可以在 finish 的总结里解释，下一次审查会看到。
  - 评审模型用「评审」角色，没分配时用编码模型。审查调用本身失败时不拦截完成，只在卡片上说明，避免评审模型出问题时任务永远完不成。
  - 需要检查点（Git）来取 diff；没有检查点时跳过审查并提示。

## 界面

- 布局参照 Qoder，取舍时按 Diffra 的功能来，不照搬。
  - 左侧栏：新任务、搜索、按项目分组的任务列表（有任务的项目按最近更新排）、设置。归档的任务不在侧栏，在「设置 → 会话与存储」里。
  - 首页：居中的输入框，下面是项目、分支、检查命令、规范和最近的任务。发出第一条消息时才建会话。
  - 任务页：对话，输入框，右侧任务监控或审阅面板（二选一，可以都关），底部终端。
  - 设置是独立的整页，按分区组织。
- 对话流：
  - 连续的读文件、搜索、命令收成「执行工具 N 次」；改动、检查、规范审查、完成单独显示。
  - 思考默认折叠；回复按 Markdown 显示，链接用系统浏览器打开。
  - 每轮下面有复制、撤销到这一轮之前、重新生成。重新生成只放在最后一轮：它会撤掉这一轮的文件改动和对话再重发同一个提问，放在中间的轮次会连带丢掉后面的所有轮次。
- 运行中发的消息在界面里排队，这一轮结束后依次发出，可以撤回。队列不存盘，应用退出就没了。
- 模型可以在任务中途换（从下一轮生效），运行中不能换。
- 审阅面板看的是「从第 N 轮开始到现在」的改动，和撤销的含义一致：「撤销这些改动」就是撤销到第 N 轮之前。
- 上下文占用的分项（系统提示词、工具定义、规范和项目规则、对话）按字数比例估算，合计等于模型返回的输入 token 数。
- 外观：主题（浅色 / 深色 / 跟随系统）、配色、文字大小、内容宽度，存在 `settings.json` 的 `appearance`，写在 `<html>` 的 class 和 data 属性上。深色的 CSS 规则用 `:root.dark`，否则会被 `:root[data-palette]` 里的浅色侧栏盖掉。
- 快捷键：Ctrl+K 搜索任务（标题和对话内容）、Ctrl+B 侧栏、Ctrl+, 设置、Ctrl+Enter 发送、Ctrl+` 终端。焦点在终端里时只保留 Ctrl+`，其余交给 shell（Ctrl+K、Ctrl+B 在 shell 里有自己的用途）。
- 底部终端：
  - 主进程用 node-pty 开进程，xterm 显示；Windows 上用 PowerShell（系统自带，和 VS Code 默认一致）。终端在当前任务的项目目录打开。
  - 最多同时 8 个；只有开它的窗口能写入和关闭。页面刷新、窗口关闭、应用退出时一起结束。
  - 切换任务、收起面板时终端内容和进程都保留；关掉标签才结束进程。
  - 浅色主题下换用 VS Code 浅色终端的 16 色，xterm 默认的配色按深色背景配，浅色背景上「白色」字看不见。
- 状态：渲染进程用一个很小的 store（`useSyncExternalStore`），不引入状态管理库。

## 用量统计

- 统计对象：每次模型调用记一条，编码循环和规范审查都算。「测试模型」按钮的调用不算。
  - 数字取供应商返回的用量，不自己估算。供应商没返回时只计次数，用量页注明有几次。
  - 只记完成了的调用。被停止或出错的调用拿不到用量，不记。
  - 从加入这个功能的版本开始记。旧的会话记录每轮只存了最后一次的输入用量，补算不了。
- 口径：
  - 「总 token」是输入加输出。
  - 输入包含缓存命中的部分，缓存命中率 = 缓存读 / 输入。
  - 输出包含推理的部分。
- 存储：应用数据目录的 `usage/YYYY-MM.jsonl`，按 UTC 月份分文件，一行一次调用。
  - 字段：时刻（UTC）、会话 id、项目路径、供应商 id 和名称、模型 id、角色（编码 / 审查），以及输入、缓存读、缓存写、输出、推理的 token 数。不存 API Key 和对话内容。
  - 只有 core 进程追加写，同一进程里的写入排队执行。
  - 文件末尾是上次崩溃留下的半行时，先补换行再追加。读取时跳过格式不对的行，并在用量页提示。
  - 估算每行约 250 字节，一天 2000 次调用约 0.5 MB。记录永久保留，不自动删；清理功能放到 v2。
  - 供应商名由桌面端在会话配置里传给 core（`model.provider`、`reviewModel.provider`），只用于记用量。
- 汇总：在 core 里边读边算（`_diffra/usage/summary`），不把记录全部读进内存。
  - 界面按本机时区算起止时刻，连同 IANA 时区名一起传给 core，core 按这个时区划分每天。
  - 一次最多统计 400 天。
  - 分组：按天（没有调用的天也列出）、按模型（供应商 + 模型 id，名称取最近一次的）、按项目（Windows 上路径不分大小写），以及用量最多的 10 个任务。
- 用量页在「设置 → 数据 → 用量」，范围有今天、近 7 天、近 30 天、本月。「今天」只显示数字，不画只有一根柱子的图。
- 不做（v2 再说）：费用和单价、预算提醒、导出。

## 工具链注意事项

- pnpm 11 对刚发布的包有冷却期。被拦时换稍旧的版本（比如 Playwright 用 1.64.x），不要写 `minimumReleaseAgeExclude` 绕过。
- Electron 45 不在安装时下载二进制，改为首次运行时下载。新环境可以先执行 `pnpm --filter @diffra/desktop exec install-electron`。
- pnpm 11 用 `pnpm-workspace.yaml` 的 `allowBuilds` 管理依赖的安装脚本。electron-winstaller（Squirrel 安装器用的）设为 false，Diffra 只打 NSIS 包；node-pty 设为 true，它的安装脚本会选用自带的预编译文件。
- e2e 按卡片种类定位对话内容（`data-testid="tool-call"` 加 `data-kind`），不靠匹配文字；默认 9 个用例并行，每个都开一个 Electron。
- core 和 desktop 的 Node 侧 tsconfig 把 `lib` 限定为 `es2023`（不含 DOM），否则 Node 的 web stream 类型会和 DOM 版冲突。
