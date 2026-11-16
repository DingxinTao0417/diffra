import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 本机装了 Semgrep、CodeQL 时，完成前的静态检查会顺带跑它们（几秒），测试结果就随这台机器装了什么变。
// 单测默认当没装（指到不存在的程序）；要测的用例自己指到假的，real-tools.test.ts（DIFFRA_REAL_TOOLS=1）用真的
if (process.env.DIFFRA_REAL_TOOLS !== '1') {
  process.env.DIFFRA_SEMGREP_PATH ??= join(tmpdir(), 'diffra-no-such-semgrep')
  process.env.DIFFRA_CODEQL_PATH ??= join(tmpdir(), 'diffra-no-such-codeql')
}
