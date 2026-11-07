# 内置规则包的出处和许可

`packs/` 下的规则包由 Diffra 根据下列公开规范改写、合并和删减而成，没有收录原文。
每个包的 front matter 写明了它的出处（`source`）和发布许可（`license`）。应用里不显示这两项。

| 规则包 | 发布许可 | 改写自 |
|---|---|---|
| `universal.md` 通用 | Apache-2.0 | 《Java 开发手册（黄山版）》 |
| `java.md` Java | Apache-2.0 | 《Java 开发手册（黄山版）》 |
| `security.md` 安全 | CC BY-SA 4.0 | 腾讯《代码安全指南》、《Java 开发手册（黄山版）》、OWASP Secure Coding Practices |
| `typescript.md` TypeScript / JavaScript | CC BY 4.0 | Google Style Guides、Airbnb JavaScript Style Guide、React 文档 |
| `python.md` Python | CC BY-SA 4.0 | PEP 8、Google Python Style Guide、腾讯《代码安全指南》 |

## 来源

- 《Java 开发手册（黄山版）》1.7.1，全球 Java 社区开发者，https://github.com/alibaba/p3c 。
  手册自 1.3.1 起采用 Apache License 2.0（见手册附 1 版本历史）：https://www.apache.org/licenses/LICENSE-2.0
- 《代码安全指南》（Secure Coding Guide），THL A29 Limited, a Tencent company，https://github.com/Tencent/secguide ，
  CC BY-SA 4.0：https://creativecommons.org/licenses/by-sa/4.0/
- OWASP Secure Coding Practices Quick Reference Guide，OWASP Foundation，
  https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/ ，CC BY-SA：https://creativecommons.org/licenses/by-sa/4.0/
- Google Style Guides（TypeScript、JavaScript、Python），Google，https://github.com/google/styleguide ，
  CC BY 3.0：https://creativecommons.org/licenses/by/3.0/
- Airbnb JavaScript Style Guide，Copyright (c) 2012 Airbnb，https://github.com/airbnb/javascript ，MIT License
- React 文档（Rules of React），Meta Platforms, Inc.，https://react.dev ，CC BY 4.0：https://creativecommons.org/licenses/by/4.0/
- PEP 8 – Style Guide for Python Code，Guido van Rossum、Barry Warsaw、Alyssa Coghlan，https://peps.python.org/pep-0008/ ，公有领域

## 改动说明

所有条目都经过改写：合并了相近的条目，删去了只适用于特定公司流程、已经过时或与常见项目惯例冲突的条目，
并按 Diffra 的需要重新划分了「强制」和「推荐」两级。规则编号是 Diffra 自己的编号，和原规范的条目编号没有对应关系。
