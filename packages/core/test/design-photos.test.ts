import { describe, expect, test } from 'vitest'
import type { StockPhotoResult } from '../src/protocol.js'
import { FIND_PHOTOS_TOOL } from '../src/session/design-photos.js'
import { runTurn } from '../src/session/loop.js'
import { makeSession, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 设计任务里找图（v2 · M11）：用户填了图库 Key 才有工具；搜索交给客户端，模型拿到地址和署名，卡片带缩略图
useTempProject()

const DESIGN = { tools: [{ name: 'get_node', description: 'Get a node', inputSchema: { type: 'object' }, readOnly: true }], instructions: '' }
const THUMB = 'data:image/jpeg;base64,/9j/4AAQ'
const RESULT: StockPhotoResult = {
  photos: [
    { provider: 'pexels', url: 'https://images.pexels.com/photos/1/large.jpg', thumb: THUMB, width: 1920, height: 1280, alt: 'Coffee cup', photographer: 'Ann', photographerUrl: 'https://www.pexels.com/@ann', pageUrl: 'https://www.pexels.com/photo/1/' },
    { provider: 'unsplash', url: 'https://images.unsplash.com/photo-2', thumb: THUMB, width: 3000, height: 2000, alt: '', photographer: 'Bo', photographerUrl: 'https://unsplash.com/@bo', pageUrl: 'https://unsplash.com/photos/2' },
  ],
  errors: [],
}

describe('design_find_photos', () => {
  test('设计任务、填了 Key 才有工具；结果给模型地址和摄影师，卡片带缩略图；没找到时说明', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: FIND_PHOTOS_TOOL, input: { query: 'coffee shop', orientation: 'landscape', count: 2 } }] },
      { toolCalls: [{ name: FIND_PHOTOS_TOOL, input: { query: 'nothing here' } }] },
      { text: '找到了' },
    ])
    const session = await makeSession(model)
    expect(Object.keys(session.toolSet())).not.toContain(FIND_PHOTOS_TOOL)
    session.design = DESIGN
    expect(Object.keys(session.toolSet())).not.toContain(FIND_PHOTOS_TOOL)
    session.config = { ...session.config, stockPhotos: true }
    expect(Object.keys(session.toolSet())).toContain(FIND_PHOTOS_TOOL)

    const asked: unknown[] = []
    const io = Object.assign(recordingIO(), {
      stockPhotos: async (params: unknown) => {
        asked.push(params)
        return asked.length === 1 ? RESULT : { photos: [], errors: ['Unsplash：Key 不对或没有权限'] }
      },
    })
    await runTurn(session, { id: 't', text: '找张咖啡馆的图' }, io)
    expect(asked[0]).toEqual({ query: 'coffee shop', orientation: 'landscape', count: 2 })
    const toModel = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(toModel).toContain('pexels 1920x1280 \\"Coffee cup\\" by Ann — url: https://images.pexels.com/photos/1/large.jpg')
    expect(toModel).toContain('photos from Pexels and Unsplash')
    // 缩略图只进卡片，不进模型的对话
    expect(toModel).not.toContain(THUMB)
    const card = io.updates.find((update) => update.sessionUpdate === 'tool_call_update' && update._meta?.diffra && 'stockPhotos' in (update._meta.diffra as object))
    expect((card?._meta?.diffra as { stockPhotos: unknown[] }).stockPhotos).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('No photos found for \\"nothing here\\" (Unsplash：Key 不对或没有权限)')
  })
})
