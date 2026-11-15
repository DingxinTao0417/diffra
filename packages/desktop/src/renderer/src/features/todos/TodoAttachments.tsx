import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from 'react'
import type { PromptImage } from '@diffra/core/types'
import { File as FileIcon, Folder, X } from 'lucide-react'
import { type FileReference, MAX_PROMPT_FILE_REFERENCES } from '../../../../shared/attachments'
import { TODO_MAX_IMAGES } from '../../../../shared/todos'
import { cn } from 'cn'
import { errorMessage } from '@/lib/errors'
import { imageUrl, prepareImage } from '@/lib/images'
import { showToast } from '@/state/store'

export interface TodoAttachmentState {
  images: string[]
  files: FileReference[]
}

// 待办的附件：图片和输入框里一样先缩小，再存进数据目录换成 id；文件只记路径，同样不许加可能含密钥的文件
export function useTodoAttachments(initial: TodoAttachmentState) {
  const [images, setImages] = useState(initial.images)
  const [files, setFiles] = useState(initial.files)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const add = async (picked: File[]) => {
    if (picked.length === 0) return
    if (busyRef.current) return showToast('正在处理上一批附件，请稍后再添加')
    busyRef.current = true
    setBusy(true)
    try {
      const pictures = picked.filter((file) => file.type.startsWith('image/'))
      const documents = picked.filter((file) => !file.type.startsWith('image/'))
      const imageRoom = TODO_MAX_IMAGES - images.length
      if (pictures.length > imageRoom) showToast(`一条待办最多带 ${TODO_MAX_IMAGES} 张图片，多出来的没有加`)
      const addedImages: string[] = []
      for (const file of pictures.slice(0, Math.max(0, imageRoom))) {
        try {
          addedImages.push(await window.diffra.saveTodoImage(await prepareImage(file)))
        } catch (error) {
          showToast(`${file.name || '图片'}：${errorMessage(error)}`)
        }
      }
      if (addedImages.length > 0) setImages((current) => [...current, ...addedImages])
      const fileRoom = MAX_PROMPT_FILE_REFERENCES - files.length
      if (documents.length > fileRoom) showToast(`一条待办最多引用 ${MAX_PROMPT_FILE_REFERENCES} 个文件或文件夹`)
      const wanted = documents.slice(0, Math.max(0, fileRoom))
      const paths = wanted.map((file) => window.diffra.getPathForFile(file)).filter((path) => path !== '')
      if (paths.length !== wanted.length) showToast('无法获取部分附件的本地路径，请从文件管理器拖入')
      if (paths.length > 0) {
        const references = await window.diffra.describeAttachments(paths)
        setFiles((current) => [...current, ...references.filter((file) => !current.some((item) => item.path === file.path))].slice(0, MAX_PROMPT_FILE_REFERENCES))
      }
    } catch (error) {
      showToast(`添加附件失败：${errorMessage(error)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    event.preventDefault()
    void add(pasted)
  }
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    void add([...event.dataTransfer.files])
  }

  return {
    images,
    files,
    busy,
    add,
    removeImage: (id: string) => setImages((current) => current.filter((item) => item !== id)),
    removeFile: (path: string) => setFiles((current) => current.filter((item) => item.path !== path)),
    clear: () => {
      setImages([])
      setFiles([])
    },
    handlers: { onPaste, onDragOver, onDrop },
  }
}

// 读过的图片留在内存里，列表来回滚动、重开对话框不用再读文件
const loaded = new Map<string, Promise<PromptImage>>()
function loadImage(id: string): Promise<PromptImage> {
  let image = loaded.get(id)
  if (!image) {
    image = window.diffra.readTodoImage(id)
    image.catch(() => loaded.delete(id))
    loaded.set(id, image)
  }
  return image
}

function TodoImage({ id, label, className }: { id: string; label: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    loadImage(id).then(
      (image) => alive && setUrl(imageUrl(image)),
      () => alive && setMissing(true),
    )
    return () => {
      alive = false
    }
  }, [id])
  if (missing) return <span className={cn('flex items-center justify-center rounded-lg border bg-muted text-[10px] text-muted-foreground', className)}>读不到</span>
  return url ? <img src={url} alt={label} className={cn('rounded-lg border object-cover', className)} /> : <span className={cn('block rounded-lg border bg-muted', className)} />
}

// 图片缩略图和文件名；传了 onRemove 的可以移除
export function TodoAttachmentList({
  images,
  files,
  onRemoveImage,
  onRemoveFile,
  className,
}: {
  images: readonly string[]
  files: readonly FileReference[]
  onRemoveImage?(id: string): void
  onRemoveFile?(path: string): void
  className?: string
}) {
  if (images.length === 0 && files.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-2', className)} data-testid="todo-attachments">
      {images.map((id, index) => (
        <div key={id} className="relative" data-testid="todo-image">
          <TodoImage id={id} label={`图片 ${index + 1}`} className="size-14" />
          {onRemoveImage && (
            <button
              type="button"
              aria-label={`移除图片 ${index + 1}`}
              className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-overlay hover:text-foreground"
              onClick={() => onRemoveImage(id)}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      {files.map((file) => (
        <div key={file.path} title={file.path} className="flex max-w-full items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1 pl-2.5 text-xs" data-testid="todo-file">
          {file.kind === 'directory' ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
          <span className="max-w-52 truncate">{file.name}</span>
          {onRemoveFile ? (
            <button type="button" aria-label={`移除附件 ${file.name}`} className="rounded-sm p-1 hover:bg-muted" onClick={() => onRemoveFile(file.path)}>
              <X className="size-3" />
            </button>
          ) : (
            <span className="pr-1.5 text-muted-foreground">{file.kind === 'directory' ? '文件夹' : '文件'}</span>
          )}
        </div>
      ))}
    </div>
  )
}
