import type { StockPhoto } from '@diffra/core/types'
import { Images } from 'lucide-react'

export type PhotoView = Pick<StockPhoto, 'provider' | 'thumb' | 'alt' | 'photographer' | 'photographerUrl' | 'pageUrl' | 'width' | 'height'>

// 设计任务里找图（v2 · M11）：缩略图和署名；点图在系统浏览器里打开图库上的页面（摄影师、许可证都在那里）
export function PhotosCard({ title, photos }: { title: string; photos: PhotoView[] }) {
  return (
    <div className="rounded-lg border p-3" data-testid="photos-card">
      <div className="mb-2 flex items-center gap-1.5 text-sm">
        <Images className="size-4 text-muted-foreground" />
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{photos.length} 张</span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo, index) => (
          <a
            key={`${photo.pageUrl}:${index}`}
            href={photo.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="group min-w-0 overflow-hidden rounded-md border bg-muted"
            title={`${photo.alt || '图片'} · ${photo.width}×${photo.height} · ${photo.photographer}（${photo.provider === 'pexels' ? 'Pexels' : 'Unsplash'}）`}
            data-testid="photo-thumb"
          >
            {photo.thumb ? <img src={photo.thumb} alt={photo.alt} className="aspect-[4/3] w-full object-cover" /> : <div className="aspect-[4/3] w-full" />}
            <span className="block truncate px-1.5 py-1 text-xs text-muted-foreground group-hover:text-foreground">
              {photo.photographer} · {photo.provider === 'pexels' ? 'Pexels' : 'Unsplash'}
            </span>
          </a>
        ))}
      </div>
    </div>
  )
}
