import { useSyncExternalStore } from 'react'

// 朗读（第 680 步）：用系统的语音（浏览器的 speechSynthesis）读回答。同一时间只读一段，读别的或点停止就停。
// 代码、图表这些围栏不读（念出来没法听），说一句「这里有一段代码」；长文按句子切成小段排队读，一整段太长时有的语音读到一半会断
const VOICE_KEY = 'diffra.speechVoice'
const MAX_CHUNK = 180

let reading: string | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

// 正在读哪一段（调用方给的 id），没在读是 null
export function useReading(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => reading,
  )
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

// 中文的排前面
export function speechVoices(): SpeechSynthesisVoice[] {
  if (!speechAvailable()) return []
  return [...window.speechSynthesis.getVoices()].sort((a, b) => Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh')) || a.name.localeCompare(b.name))
}

export function storedVoice(): string | null {
  try {
    return localStorage.getItem(VOICE_KEY)
  } catch {
    return null
  }
}

export function storeVoice(voiceURI: string | null): void {
  try {
    if (voiceURI) localStorage.setItem(VOICE_KEY, voiceURI)
    else localStorage.removeItem(VOICE_KEY)
  } catch {
    // 记不住只是下次用默认的声音
  }
}

// Markdown 换成念得出来的字
export function speakableText(markdown: string): string {
  return markdown
    .replace(/^(`{3,}|~{3,})([\w-]*)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (_match, _fence: string, language: string) => (/^(chart|metrics|table|timeline|mermaid)$/.test(language) ? '\n这里有一张图表。\n' : '\n这里有一段代码。\n'))
    .replace(/\$\$[\s\S]*?\$\$/g, '这里有一个公式。')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/\|/g, '，')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function chunks(text: string): string[] {
  const sentences = text.split(/(?<=[。！？!?；;\n])/).map((part) => part.trim()).filter(Boolean)
  const result: string[] = []
  for (const sentence of sentences) {
    for (let start = 0; start < sentence.length; start += MAX_CHUNK) {
      const piece = sentence.slice(start, start + MAX_CHUNK)
      const last = result.at(-1)
      if (last && last.length + piece.length <= MAX_CHUNK && start === 0) result[result.length - 1] = `${last}${piece}`
      else result.push(piece)
    }
  }
  return result
}

export function stopSpeaking(): void {
  if (!speechAvailable()) return
  reading = null
  window.speechSynthesis.cancel()
  emit()
}

export function speak(id: string, markdown: string): void {
  if (!speechAvailable()) return
  window.speechSynthesis.cancel()
  const parts = chunks(speakableText(markdown))
  if (parts.length === 0) return
  const voiceURI = storedVoice()
  const voice = voiceURI ? window.speechSynthesis.getVoices().find((item) => item.voiceURI === voiceURI) : undefined
  reading = id
  emit()
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part)
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? 'zh-CN'
    // 读完最后一段、或者出错了：不在读了（被别的朗读顶掉的不改）
    const finish = () => {
      if (reading !== id) return
      if (index === parts.length - 1) {
        reading = null
        emit()
      }
    }
    utterance.onend = finish
    utterance.onerror = () => {
      if (reading !== id) return
      reading = null
      emit()
    }
    window.speechSynthesis.speak(utterance)
  })
}
