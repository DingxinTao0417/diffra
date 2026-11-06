---
id: java
name: Java
languages: java
source: 改写自《Java 开发手册（黄山版）》1.7.1（https://github.com/alibaba/p3c）中 Java 专属的条目
license: Apache-2.0
---

只收录 Java 专属的条目，跨语言的条目在「通用」「安全」包里。格式类条目（大括号、L 后缀、缩进等）
定为推荐：它们更适合交给 p3c-pmd、Checkstyle 这类检查工具，不占提示词篇幅。
没有收录：每个类写作者和日期、所有方法写 Javadoc（和多数项目惯例冲突）；Velocity、iBATIS 等过时技术的条目；
禁止外键、超过三表禁止 join、禁止存储过程等取决于团队约定的条目。

## 命名
- [JAVA-NAME-1][强制] POJO 的布尔字段不加 is 前缀，否则部分框架序列化时会解析错字段名。
- [JAVA-NAME-2][推荐] 类名 UpperCamelCase（DO、BO、DTO、VO、PO、UID 等后缀除外），方法、参数、变量 lowerCamelCase，包名全小写且用单数。
- [JAVA-NAME-3][推荐] 抽象类以 Abstract 或 Base 开头，异常类以 Exception 结尾，测试类以被测类名开头、以 Test 结尾。
- [JAVA-NAME-4][推荐] Service、DAO 对外暴露接口，实现类加 Impl 后缀；查单个用 get、查列表用 list、计数用 count 做方法前缀。

## 格式
- [JAVA-FMT-1][推荐] if、else、for、while、do 都带大括号，即使只有一行。
- [JAVA-FMT-2][推荐] long 字面量用大写 L，浮点字面量后缀用大写 D、F；数组写成 String[] args。
- [JAVA-FMT-3][推荐] 4 个空格缩进，单行不超过 120 个字符。

## 面向对象
- [JAVA-OOP-1][强制] equals 用常量或确定非空的对象调用（"x".equals(v)）或用 Objects.equals；包装类型比较值用 equals，不用 ==。
- [JAVA-OOP-2][强制] BigDecimal 比较用 compareTo 不用 equals；不用 new BigDecimal(double)，用字符串构造或 valueOf。
- [JAVA-OOP-3][强制] POJO 属性和 RPC 参数、返回值用包装类型，POJO 属性不设默认值；DO 属性类型与数据库字段一致。
- [JAVA-OOP-4][强制] 覆写 equals 必须同时覆写 hashCode。
- [JAVA-OOP-5][强制] 外部在用的接口不改方法签名；要废弃时加 @Deprecated 并写明替代方案；不调用已废弃的方法。
- [JAVA-OOP-6][推荐] 构造方法里不放业务逻辑；序列化类新增字段时不改 serialVersionUID，完全不兼容的升级才改。
- [JAVA-OOP-7][推荐] 覆写方法都加 @Override；通过类名访问静态成员。
- [JAVA-OOP-8][推荐] 循环中拼接字符串用 StringBuilder；工具类的构造方法设为私有；成员的访问范围从严。
- [JAVA-OOP-9][推荐] POJO 写 toString；不同时提供同一属性的 isXxx() 和 getXxx()。

## 日期时间
- [JAVA-TIME-1][强制] 日期格式里年份用 yyyy 不用 YYYY（周所在的年）；分清 M 月和 m 分钟、H 和 h。
- [JAVA-TIME-2][强制] 用 java.time（Instant、LocalDateTime、DateTimeFormatter），不用 java.sql.Date/Time/Timestamp 和共享的 SimpleDateFormat。

## 集合
- [JAVA-COLL-1][强制] 不在 foreach 里增删元素，用 Iterator.remove 或 removeIf。
- [JAVA-COLL-2][强制] Arrays.asList、Collections.emptyList、Map 的 keySet/values 返回的集合不能增删；subList 不能强转 ArrayList。
- [JAVA-COLL-3][强制] Collectors.toMap 要传合并函数处理重复 key，value 为 null 时会抛 NPE。
- [JAVA-COLL-4][强制] Comparator 要满足对称和传递，相等时返回 0。
- [JAVA-COLL-5][推荐] 修改原列表后，之前取得的 subList 不能再用；addAll 之前对传入的集合判空。
- [JAVA-COLL-6][推荐] 判断集合为空用 isEmpty()；集合转数组用 toArray(new T[0])。
- [JAVA-COLL-7][推荐] 集合初始化时指定容量；遍历 Map 用 entrySet 或 Map.forEach；ConcurrentHashMap、Hashtable 不能存 null。

## 并发
- [JAVA-CONC-1][强制] 线程池用 ThreadPoolExecutor 并指定有界队列，不用 Executors 的工厂方法，不自行 new Thread。
- [JAVA-CONC-2][强制] lock() 紧挨着放在 try 之前，在 finally 中 unlock；tryLock 成功后才进入业务代码。
- [JAVA-CONC-3][强制] ThreadLocal 用完在 finally 中 remove。
- [JAVA-CONC-4][强制] 多个定时任务用 ScheduledExecutorService，不用 Timer。
- [JAVA-CONC-5][推荐] 单例的获取和它的方法都要线程安全；双重检查锁的字段加 volatile。
- [JAVA-CONC-6][推荐] 计数用 AtomicLong 或 LongAdder；CountDownLatch 的子线程在 finally 中 countDown。

## 控制语句
- [JAVA-FLOW-1][强制] switch 的每个 case 以 break 或 return 结束（穿透要注释），必须有 default；外部传入的 String 先判空。
- [JAVA-FLOW-2][强制] 三目运算符两个分支类型不一致或含基本类型时会自动拆箱，分支值为 null 会抛 NPE。

## 异常与日志
- [JAVA-ERR-1][强制] 不 catch NullPointerException、IndexOutOfBoundsException 这类能预先检查的异常。
- [JAVA-ERR-2][推荐] 捕获的异常类型要和抛出的一致或是它的父类；调用 RPC、二方包或动态生成的类时用 Throwable 捕获。
- [JAVA-LOG-1][强制] 用 SLF4J 等日志门面和 {} 占位符；不用 System.out、e.printStackTrace()，不把对象整个转 JSON 打日志。
- [JAVA-LOG-2][推荐] 不直接用 Log4j、Logback 的 API；trace、debug、info 日志的参数有计算开销时先判断级别。

## 数据访问与依赖
- [JAVA-DATA-1][强制] MyBatis 的 SQL 参数用 #{}，不用 ${}。
- [JAVA-DATA-2][强制] 返回给前端的超大 Long（超过 2^53）用字符串类型。
- [JAVA-DATA-3][推荐] 查询结果映射到明确的类型，不直接用 HashMap 或 Hashtable 接收。
- [JAVA-DEP-1][推荐] 线上应用不依赖 SNAPSHOT 版本；同一组依赖用统一的版本变量；子模块之间不出现同一依赖的不同版本。

## 其他
- [JAVA-OTHER-1][推荐] 正则用预编译的 Pattern 常量，不在方法体里反复 Pattern.compile。
- [JAVA-OTHER-2][推荐] 枚举的字段私有且不可变。
- [JAVA-OTHER-3][推荐] 不用 Apache BeanUtils 拷贝属性；取当前毫秒数用 System.currentTimeMillis()。
- [JAVA-OTHER-4][推荐] 随机整数用 Random 的 nextInt、nextLong，或 ThreadLocalRandom，不用 Math.random() 放大取整。
