// 读 streamText 的 fullStream，不把 error 这一项交给调用方：流里报的错先记下、中断这次请求、把流读完再抛。
// 模型还没有任何输出就报错时，直接从 for await 里抛出去（或 break）会取消这个流，AI SDK 内部留下一个没人接的 rejection（原因是 undefined）。
// abort 要能中断这次请求：服务报了错却不关连接时，靠它让流马上结束
export async function* streamParts<Part extends { type: string }>(stream: AsyncIterable<Part>, abort: () => void): AsyncGenerator<Exclude<Part, { type: 'error' }>> {
  let failure: { error: unknown } | null = null
  for await (const part of stream) {
    if (failure) continue
    if (part.type === 'error') {
      failure = { error: (part as { error?: unknown }).error }
      abort()
      continue
    }
    yield part as Exclude<Part, { type: 'error' }>
  }
  if (failure) throw failure.error
}
