---
id: python
name: Python
languages: python
source: 改写自 PEP 8（https://peps.python.org/pep-0008/）、Google Python Style Guide（https://google.github.io/styleguide/pyguide.html）和腾讯《代码安全指南》Python 部分（https://github.com/Tencent/secguide）
license: CC-BY-SA-4.0
---

本包按 CC BY-SA 4.0 发布：引用的来源里有 CC BY-SA 许可的作品，改写后的条目沿用同一许可。
格式类问题交给项目的 Ruff / Black，这里只收录对正确性有影响的条目和少量风格约定。

## 异常与资源
- [PY-ERR-1][强制] 不写裸 except: 或 except BaseException 吞掉所有异常；捕获具体的异常类型，转换后重新抛出时用 raise ... from e 保留原因。
- [PY-ERR-2][强制] 文件、锁、连接等资源用 with 语句管理。

## 常见陷阱
- [PY-PIT-1][强制] 不用 list、dict、set 等可变对象做参数默认值，用 None 再在函数里创建。
- [PY-PIT-2][强制] 和 None 比较用 is 或 is not；判断类型用 isinstance，不用 type(x) == ...。
- [PY-PIT-3][强制] 不用 from module import *。

## 数值与时间
- [PY-NUM-1][强制] 金额用 Decimal 计算，并用字符串构造（Decimal("0.1")），不用 float。
- [PY-TIME-1][强制] 表示时刻用带时区的 datetime，比如 datetime.now(timezone.utc)，不用 utcnow() 产生的无时区对象。

## 安全
- [PY-SEC-1][强制] 不对外部数据用 eval、exec、pickle.loads、yaml.load / yaml.unsafe_load（用 yaml.safe_load）。
- [PY-SEC-2][强制] subprocess 传参数列表，不用 shell=True 拼接外部输入。
- [PY-SEC-3][强制] 生产环境关闭 Flask、Django 的调试模式。

## 风格
- [PY-STYLE-1][推荐] 遵循 PEP 8：4 空格缩进，函数和变量 snake_case，类 CapWords，常量 UPPER_SNAKE_CASE。
- [PY-STYLE-2][推荐] 导入放在文件开头，按标准库、第三方、本地模块分组。
- [PY-STYLE-3][推荐] 公开函数写类型注解；格式化字符串用 f-string。
- [PY-STYLE-4][推荐] 日志用 logging 的参数形式 logger.info("x=%s", x)，不提前格式化；正式代码不用 print 调试。
- [PY-STYLE-5][推荐] 模块顶层不执行有副作用的代码，入口放在 if __name__ == "__main__": 下面。
- [PY-STYLE-6][推荐] 循环里拼接大量字符串用列表收集后 "".join(...)。
