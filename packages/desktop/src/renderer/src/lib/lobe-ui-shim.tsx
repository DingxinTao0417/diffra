// @lobehub/ui 的占位：渲染进程构建把 '@lobehub/ui' 指到这里（electron.vite.config.ts 的 alias）
// @lobehub/icons 的品牌入口会顺带导入 Avatar、Combine，它们依赖 @lobehub/ui；我们只用图标本身，不用 Avatar、Combine，
// 这里只为让构建能解析，没有装那一整套 UI 库。模型匹配表（modelConfig）导入的是品牌入口，所以绕不开
// 只导出从品牌入口、toc、modelConfig 能走到的名字；升级 @lobehub/icons 后构建报缺少导出，再按报错补
import type { CSSProperties, HTMLAttributes } from 'react'

interface FlexboxProps extends HTMLAttributes<HTMLDivElement> {
  horizontal?: boolean
  align?: CSSProperties['alignItems']
  justify?: CSSProperties['justifyContent']
  flex?: CSSProperties['flex']
}

export function Flexbox({ horizontal, align, justify, flex, style, ...rest }: FlexboxProps) {
  return <div style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: align, justifyContent: justify, flex, ...style }} {...rest} />
}

export function Center(props: FlexboxProps) {
  return <Flexbox align="center" justify="center" {...props} />
}

export function useThemeMode(): { isDarkMode: boolean } {
  return { isDarkMode: document.documentElement.classList.contains('dark') }
}
