import { cn } from 'cn'

// 单色品牌标（侧栏、关于页），跟配色走；源文件在 build/brand/mark.svg
export function BrandMark({ className }: { className?: string }) {
  return (
    // primary-color-allow: 品牌标
    <svg viewBox="0 0 32 32" className={cn('shrink-0 text-primary', className)} aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.14 3H13.565A13 13 0 0 1 23.444 7.55H6.14Q5.44 7.55 5.44 6.85V3.7Q5.44 3 6.14 3ZM6.14 10.15H25.174A13 13 0 0 1 26.5 14.7H6.14Q5.44 14.7 5.44 14V10.85Q5.44 10.15 6.14 10.15ZM6.14 17.3H26.5A13 13 0 0 1 25.174 21.85H6.14Q5.44 21.85 5.44 21.15V18Q5.44 17.3 6.14 17.3ZM6.14 24.45H23.444A13 13 0 0 1 13.565 29H6.14Q5.44 29 5.44 28.3V25.15Q5.44 24.45 6.14 24.45Z"
      />
    </svg>
  )
}
