// 设备连接的传输层：Noise 握手和加密、邀请串、分片。不依赖 core，中转服务也能用；
// 应用层消息在 @diffra/remote/messages，发出前的脱敏在 @diffra/remote/redact
export * from './noise.js'
export * from './invite.js'
export * from './frames.js'
