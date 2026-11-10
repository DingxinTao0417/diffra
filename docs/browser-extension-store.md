# Diffra 浏览器扩展：上架和发布

扩展源码在 `packages/desktop/browser-extension/`，协议和设计见 `docs/decisions.md`「用户自己的浏览器」。

## 第一次上架（手动，只做一次）

1. 注册开发者账号：Chrome 应用商店（一次性 5 美元，要做身份验证）、Microsoft 合作伙伴中心的 Edge 计划（免费）。
2. 把隐私政策页（`website/pages/browser-extension-privacy.html`）随官网一起发布（`pnpm --filter @diffra/desktop publish:website`），网址是 `https://diffra.dev/browser-extension-privacy.html`。
3. 打商店包：`pnpm --filter @diffra/desktop package:extension`，得到 `packages/desktop/release/diffra-browser-extension-<版本>.zip`。
4. 在两个商店后台新建条目，上传这个 zip，按下面的文案填写，提交审核。
5. 商店分配的扩展 ID 填进 `packages/desktop/src/shared/browser-bridge.ts` 的 `EXTENSION_IDS.chromeWebStore`、`EXTENSION_IDS.edgeAddons`，发一版 Diffra。之后 Diffra 的本机宿主才会允许商店版扩展连接，设置页的「去安装」按钮才会出现。
6. 配自动发布要用的 GitHub Actions secrets：
   - Chrome：`CWS_CLIENT_ID`、`CWS_CLIENT_SECRET`、`CWS_REFRESH_TOKEN`（Google Cloud 里给 Chrome Web Store API 建 OAuth 客户端，按官方文档换出 refresh token，权限 `https://www.googleapis.com/auth/chromewebstore`）、`CWS_PUBLISHER_ID`、`CWS_EXTENSION_ID`。
   - Edge：在合作伙伴中心「Publish API」里启用新版，记下 `EDGE_CLIENT_ID`、`EDGE_API_KEY`，再加上 `EDGE_PRODUCT_ID`（扩展概览页里的产品 ID）。

## 之后每次发版

1. 改 `packages/desktop/browser-extension/manifest.json` 的 `version`（商店要求比线上的大）。改了协议的话同时改 `BRIDGE_PROTOCOL`，并且先发 Diffra。
2. 提交后推 `ext-v<版本>` 的 tag。工作流 `.github/workflows/release-extension.yml` 会打包、放进草稿 Release，再传到两个商店提交审核；哪个商店的 secrets 没配就跳过哪个。
3. 本地也可以手动传：配好上面的环境变量，跑 `pnpm --filter @diffra/desktop package:extension` 再跑 `pnpm --filter @diffra/desktop publish:extension`。

## 商店文案

- 名称：Diffra
- 简短说明（132 字以内）：让 Diffra 桌面应用里的 AI 智能体在你的浏览器里打开网页、读页面、点击和输入。需要电脑上装着 Diffra。
- 分类：开发者工具（Developer Tools）
- 详细说明：

  > Diffra 是 Windows 上的编程智能体。装上这个扩展后，Diffra 的智能体可以直接用你的 Chrome（或 Edge）：用你已经登录的网站、调试你本地开着的页面、帮你在网页上完成操作。
  >
  > - 智能体为每个任务开一组「Diffra · 任务名」标签页，只操作这些标签页和你在扩展里交给它的标签页。
  > - 读页面、点击、输入、截图都在你的电脑上完成，页面内容只发给同一台电脑上的 Diffra。
  > - 操作时浏览器顶部会显示调试提示条，点「取消」或在扩展弹窗里点「停止」就会停下。
  > - 需要先在电脑上安装并打开 Diffra（https://diffra.dev），在「设置 → 浏览器」里选「我的 Chrome」或「我的 Edge」。

- 单一用途说明：把 Diffra 桌面应用连接到浏览器，让它的智能体在用户指定的标签页里打开网页、读取内容并操作页面。
- 权限理由：
  - `debugger`：智能体要读页面结构、点击、输入、截图，只用在 Diffra 开的和用户交给它的标签页上。
  - `nativeMessaging`：和同一台电脑上的 Diffra 应用通信，不连任何服务器。
  - `tabs`、`tabGroups`：为任务开标签页、放进「Diffra · 任务名」分组，知道这些标签页什么时候被关掉。
  - `storage`：在会话存储里记下标签页和任务的对应关系，扩展后台被浏览器回收后还能接上。
  - `alarms`：Diffra 没开时定时重试连接。
- 数据使用声明：处理「网站内容」；不出售、不用于和单一用途无关的目的、不用于信用评估。
- 隐私政策网址：`https://diffra.dev/browser-extension-privacy.html`
- 截图：至少一张 1280×800，建议放 Diffra 任务页（右边是投屏画面）和浏览器里「Diffra · 任务名」分组的样子。
