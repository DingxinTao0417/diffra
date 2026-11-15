import { useEffect, useState } from 'react'
import { ChevronDown, Square, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { speak, speechAvailable, speechVoices, stopSpeaking, storedVoice, storeVoice, useReading } from './speech'

// 每一轮操作栏的「朗读」和选声音（第 680 步）
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const reading = useReading() === id
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => speechVoices())
  const [voice, setVoice] = useState(() => storedVoice() ?? '')

  // 系统的语音列表是慢慢加载的
  useEffect(() => {
    if (!speechAvailable()) return
    const update = () => setVoices(speechVoices())
    window.speechSynthesis.addEventListener('voiceschanged', update)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])

  if (!speechAvailable() || !text.trim()) return null
  return (
    <span className="flex items-center">
      <Button variant="ghost" size="icon-sm" aria-label={reading ? '停止朗读' : '朗读'} title={reading ? '停止朗读' : '朗读'} aria-pressed={reading} onClick={() => (reading ? stopSpeaking() : speak(id, text))}>
        {reading ? <Square className="size-3.5" /> : <Volume2 className="size-4" />}
      </Button>
      {voices.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="选择朗读的声音" title="选择朗读的声音" className="-ml-1 w-4">
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>朗读的声音</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={voice}
              onValueChange={(next) => {
                setVoice(next)
                storeVoice(next || null)
              }}
            >
              <DropdownMenuRadioItem value="">系统默认</DropdownMenuRadioItem>
              {voices.map((item) => (
                <DropdownMenuRadioItem key={item.voiceURI} value={item.voiceURI}>
                  {item.name}
                  <span className="ml-2 text-xs text-muted-foreground">{item.lang}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  )
}
