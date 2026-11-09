// 设计任务的风格预设：设计首页选一套，建任务时存进会话（SessionConfig.designStyle），每轮接在设计说明后面，作为模型的起点。
// 界面用名称、简介和色板；instructions 给模型（英文，和其他提示词一样）。只放数据，桌面端界面也从 @diffra/core/types 读它
export interface DesignStyle {
  id: string
  name: string
  summary: string
  // 色板预览：背景、面、正文、强调色、辅助色
  swatches: [string, string, string, string, string]
  instructions: string
}

const FONT_NOTE =
  'Fonts: call list_available_fonts first and use the closest available family to the ones named here; for Chinese text pair the Latin face with a matching CJK face (serif with Source Han Serif SC / Noto Serif SC / SimSun, sans with Microsoft YaHei / PingFang SC / Noto Sans SC).'

const BLOG_PAGES =
  'Pages: Home (masthead and navigation, one featured post, then the post list with dates and short excerpts), Article (title block with date and reading time, body with headings, images with captions, quotes), ' +
  'About (portrait, short bio, what the blog covers, contact), Archive (posts grouped by year or by topic).'

export const DESIGN_STYLES: DesignStyle[] = [
  {
    id: 'editorial-minimal',
    name: '极简编辑风',
    summary: '纸感底色、衬线标题、大留白，像一本安静的读物',
    swatches: ['#FAF9F6', '#F1EFEA', '#1C1B19', '#A23B2A', '#6F6A62'],
    instructions: [
      'Style preset: Editorial minimal. A quiet, bookish page that lets the writing lead.',
      'Palette: background #FAF9F6, surface #F1EFEA, text #1C1B19, secondary text #6F6A62, accent #A23B2A (links and small marks only), rules #E2DED6. No gradients, no shadows.',
      `Type: serif headlines (Source Serif / Georgia), a calm serif or neutral sans for body at 17-18px with line height 1.7. Scale 13 / 15 / 17 / 21 / 28 / 40 / 56. ${FONT_NOTE}`,
      'Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 72 / 112; radius 0-2. Generous vertical whitespace between sections.',
      'Layout: a single reading column about 680px wide inside a 1200px frame, thin 1px rules between sections, small left-aligned navigation, dates and metadata in secondary text.',
      BLOG_PAGES,
    ].join('\n'),
  },
  {
    id: 'magazine',
    name: '杂志排版',
    summary: '大图、大标题、多栏网格，版面有节奏和对比',
    swatches: ['#FFFFFF', '#F3EFE8', '#111111', '#D9482B', '#1F4E5F'],
    instructions: [
      'Style preset: Magazine. Strong hierarchy, big photography and an asymmetric grid, like a printed feature spread.',
      'Palette: background #FFFFFF, surface #F3EFE8, text #111111, secondary text #5C5C5C, accent #D9482B, second accent #1F4E5F, rules #111111 at 1-2px.',
      `Type: a high-contrast display serif or condensed sans for headlines at 56-96px with tight leading, a readable serif for body at 17px. Scale 12 / 14 / 17 / 22 / 32 / 48 / 72 / 96. ${FONT_NOTE}`,
      'Spacing: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96; radius 0. Let images run full bleed; use pull quotes and captions.',
      'Layout: 12-column grid with 24px gutters in a 1280px frame; mix wide and narrow columns; a lead story with a large image, secondary stories in two and three columns; section labels in the accent color.',
      BLOG_PAGES,
    ].join('\n'),
  },
  {
    id: 'tech-blog',
    name: '技术博客',
    summary: '清爽中性色、等宽代码、目录和标签，读长文不累',
    swatches: ['#FFFFFF', '#F6F8FA', '#1F2328', '#2F6FEB', '#57606A'],
    instructions: [
      'Style preset: Technical blog. Clear, neutral and built for long articles with code.',
      'Palette: background #FFFFFF, surface #F6F8FA (code blocks, cards), text #1F2328, secondary text #57606A, accent #2F6FEB (links, active states), borders #D8DEE4. Syntax colors for code: #CF222E, #0550AE, #116329, #8250DF.',
      `Type: a neutral sans for UI and body at 16-17px with line height 1.65, a monospace (JetBrains Mono / Cascadia Code / Consolas) for code at 14px. Scale 12 / 14 / 16 / 18 / 22 / 28 / 36. ${FONT_NOTE}`,
      'Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64; radius 6 for code blocks, cards and tags.',
      'Layout: a 1200px frame with a 720px article column and a sticky table of contents on the right; tags as small outlined chips; code blocks with a filename bar and copy button.',
      `${BLOG_PAGES} Add a tag page that lists posts for one tag.`,
    ].join('\n'),
  },
  {
    id: 'portfolio',
    name: '作品集',
    summary: '深色底、作品大图网格，突出作品本身',
    swatches: ['#121212', '#1E1E1E', '#F2F2F2', '#E9B872', '#8C8C8C'],
    instructions: [
      'Style preset: Portfolio. Dark, gallery-like pages where the work is the hero.',
      'Palette: background #121212, surface #1E1E1E, text #F2F2F2, secondary text #8C8C8C, accent #E9B872 used sparingly, borders #2A2A2A.',
      `Type: one confident sans or grotesk for everything; name and section titles at 40-72px, body 16px. Scale 13 / 16 / 20 / 28 / 40 / 56 / 72. ${FONT_NOTE}`,
      'Spacing: 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128; radius 4 on images and cards.',
      'Layout: a 1280px frame; a short intro line, then a project grid (two or three columns, large images with title and role under each); generous gaps.',
      'Pages: Home (intro and project grid), Project case study (hero image, role and timeline, problem, process images, result), About (portrait, bio, skills, clients), Contact.',
    ].join('\n'),
  },
  {
    id: 'product-landing',
    name: '产品落地页',
    summary: '产品截图主视觉、功能分区、价格和行动按钮',
    swatches: ['#FFFFFF', '#F5F5FA', '#0E0E16', '#5B5BD6', '#18A57A'],
    instructions: [
      'Style preset: Product landing page. Clear story from the problem to the call to action, with the product shown, not described.',
      'Palette: background #FFFFFF, surface #F5F5FA, text #0E0E16, secondary text #5A5A6E, primary #5B5BD6 (buttons, highlights), success #18A57A, borders #E4E4EE.',
      `Type: a modern sans; hero headline 52-64px, section titles 32-40px, body 17px. Scale 13 / 15 / 17 / 20 / 28 / 40 / 56. ${FONT_NOTE}`,
      'Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128; radius 12 for cards and screenshots, 8 for buttons.',
      'Layout: a 1280px frame; hero with headline, one sentence of value, primary and secondary buttons and a large product screenshot; then social proof, three or four feature sections alternating text and screenshots, pricing cards, FAQ and a closing call-to-action band; simple footer.',
      'Pages: Home (the full landing page), Pricing (plans compared in a table, FAQ), About (mission, team), Blog list.',
    ].join('\n'),
  },
]

export function designStyleById(id: string | null | undefined): DesignStyle | null {
  return DESIGN_STYLES.find((style) => style.id === id) ?? null
}
