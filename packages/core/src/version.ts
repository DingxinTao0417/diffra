// 和 package.json 的 version 保持一致，由 test/version.test.ts 校验。
// 不在运行时读 package.json：core 打进桌面端后，旁边没有这个文件。
export const CORE_VERSION = '0.0.1'
