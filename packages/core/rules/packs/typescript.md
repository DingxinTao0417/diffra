---
id: typescript
name: TypeScript / JavaScript
languages: typescript, javascript, vue, svelte
source: 改写自 Google TypeScript Style Guide、Google JavaScript Style Guide（https://google.github.io/styleguide/）、Airbnb JavaScript Style Guide（https://github.com/airbnb/javascript）和 React 官方文档的 Rules of React（https://react.dev）
license: CC-BY-4.0
---

格式类问题（分号、引号、缩进）交给项目的 Prettier / ESLint，这里不收录。

## 类型
- [TS-TYPE-1][强制] 不用 any 掩盖类型问题；来源不确定的数据用 unknown，在入口处校验后再收窄类型。
- [TS-TYPE-2][强制] 不用非空断言 ! 或 as 强转绕过类型检查，除非能确定一定成立。
- [TS-TYPE-3][强制] 不用 @ts-ignore、@ts-nocheck 压制错误；确实需要时用 @ts-expect-error 并写明原因。
- [TS-TYPE-4][推荐] 导出的函数写明参数和返回类型；有限的取值用联合类型或字面量类型表达，不用随意的字符串。

## 语法
- [TS-SYN-1][强制] 用 const 和 let，不用 var；不会重新赋值的变量用 const。
- [TS-SYN-2][强制] 比较用 === 和 !==；只有同时判断 null 和 undefined 时可以写 == null。
- [TS-SYN-3][强制] 给可能是 0、false 或空字符串的值设默认值用 ??，不用 ||。
- [TS-SYN-4][强制] 不用 eval、new Function、with，不修改内置对象的原型。
- [TS-SYN-5][推荐] 用可选链 ?. 代替层层判空；用模板字符串代替字符串拼接。

## 异步与错误
- [TS-ASYNC-1][强制] Promise 都要被 await、返回或接上 .catch，不留没人处理的 Promise；事件回调和定时器里的异步错误也要处理。
- [TS-ASYNC-2][强制] 只抛 Error 或它的子类，不抛字符串或普通对象。
- [TS-ASYNC-3][推荐] 互不依赖的异步操作用 Promise.all 或 Promise.allSettled 并发执行，不在循环里逐个 await；想清楚部分失败时怎么处理。

## 数值
- [TS-NUM-1][强制] 超过 2 的 53 次方的整数（订单号、雪花 id 等）用字符串或 BigInt 处理，不转成 number。
- [TS-NUM-2][强制] 解析数字用 Number() 或 parseInt(x, 10)，并检查 NaN。

## 界面
- [TS-UI-1][强制] React 列表的 key 用稳定的 id；列表会增删或重排时不用数组下标。
- [TS-UI-2][强制] React Hook 只在组件或自定义 Hook 的顶层调用；useEffect 的依赖写全，订阅和定时器在清理函数里释放。
- [TS-UI-3][强制] 不直接修改 React 的 state、props 和 Vue 的 props，用新的值更新或通知父组件。
- [TS-UI-4][推荐] 可交互元素能用键盘操作并有可读的名称；用 button、a 等语义元素，不用 div 模拟按钮。

## 其他
- [TS-OTHER-1][推荐] 用 ES 模块的 import / export；导入路径和项目已有的写法保持一致。
- [TS-OTHER-2][推荐] 提交的代码不留 console.log 调试输出和 debugger。
