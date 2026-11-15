# 第三方组件的出处和许可

打进应用、需要注明出处的第三方组件。设计页的见 `docs/decisions.md` 的「设计模式」，模型图标见「模型图标」：

| 组件 | 许可 | 出处 | 用法 |
|---|---|---|---|
| `@open-pencil/core`、`@open-pencil/vue`、`@open-pencil/design-jsx` 及其子包 | MIT，Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors | https://github.com/open-pencil/open-pencil | npm 包原样使用，版本 0.17.0-beta.2 |
| `canvaskit-wasm` | BSD-3-Clause | https://skia.org | npm 包原样使用，版本 0.41.1 |
| `@iconify-json/lucide`（Lucide 图标） | ISC | https://github.com/lucide-icons/lucide | 图标数据原样内置，版本 1.2.150 |
| `@lobehub/icons`（Lobe Icons） | MIT，Copyright (c) 2023 LobeHub | https://github.com/lobehub/lobe-icons | 模型和服务的品牌图标（主界面），构建时打包进渲染进程，版本 6.15.0 |

## 扩展目录品牌图形

扩展页目录里的服务、插件品牌图形取自各官方站点或官方仓库，只用于标识对应服务，商标归各公司所有。图形在 `src/renderer/src/features/extensions/brand-icons.tsx` 里统一改成 `currentColor` 单色；来源也写在该文件的 `BRAND_ICON_SOURCES` 里：

| 图形 | 来源 |
|---|---|
| GitHub | https://github.com/primer/octicons/blob/main/icons/mark-github-24.svg |
| Linear | https://linear.app/brand |
| Supabase | https://github.com/supabase/supabase/blob/master/apps/studio/public/supabase-logo.svg |
| Neon | https://github.com/neondatabase/website/blob/main/public/brand/neon-logomark-dark-mono.svg |
| Railway | https://github.com/railwayapp/railway-skills/blob/main/plugins/railway/assets/logo.svg |
| Sentry | https://s1.sentry-cdn.com/_static/3cf024a06ebdfcd62d2fbf824afba9db/sentry/images/logos/logo-sentry.svg |
| Vercel | https://vercel.com/brand |
| Context7 | https://github.com/upstash/context7/blob/master/public/context7-icon.svg |
| Tavily | https://tavily.com/logos/tavily-mark-black.svg |
| Exa | https://exa.ai/images/logo/exa-logo-blue.svg |
| Firecrawl | https://github.com/firecrawl/firecrawl/blob/main/apps/test-site/src/assets/firecrawl-logo.svg |
| Chrome DevTools | https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/Images/src/devtools.svg |
| Playwright | https://github.com/microsoft/playwright/blob/main/packages/web/src/assets/playwright-logo.svg |
| Superpowers | https://github.com/obra/superpowers/blob/main/assets/superpowers-small.svg |
