# Diffra 项目约定

## 提交信息

- `feat:`、`fix:` 提交的主题就是用户看到的更新日志（`packages/desktop/scripts/changelog.ts` 从提交信息生成，客户端、官网、更新包都用它）：用中文，写给用户看，不写内部实现。
- 一件事一条，几件事用「；」分开。末尾可以加「（第 x–y 步）」，生成日志时会去掉。
- 只改测试、文档、构建或发布脚本的，用 `test:`、`docs:`、`ci:`、`chore:`，这些不进更新日志。
- 发版提交固定写「chore: 发布 vX.Y.Z」，不要写成 `feat:`。
- 打 tag 发版时 CI 检查这一版至少有一条日志、每条都是中文，有英文条目就失败。

## 发版

- 流程见 `docs/decisions.md` 的「发布与更新」：改 `packages/desktop/package.json` 的版本号并提交，打 `vX.Y.Z` tag 推送，等 CI 通过，再运行 `publish:release` 和 `publish:website`。
- 推送、打 tag、上传更新源和官网之前，先问用户。
