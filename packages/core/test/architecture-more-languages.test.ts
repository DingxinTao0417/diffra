import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeProject, type ParseCache } from '../src/architecture/engine.js'
import type { ArchitectureAnalysis } from '../src/architecture/model.js'
import { findRipgrep } from '../src/environment.js'

// 更多语言（v2 · M9）：C、C++、C#、Kotlin、Scala、PHP、Ruby、Swift、Dart 按行提取，Svelte 按 script 块
const FILES: Record<string, string> = {
  'native/include/util.h': '#pragma once\nint add(int a, int b);\n',
  'native/src/util.c': '#include "util.h"\n#include <stdio.h>\n// #include "commented.h"\nint add(int a, int b) {\n  return a + b;\n}\n',
  'native/src/main.cpp': [
    '#include <vector>',
    '#include <sys/types.h>',
    '#include <boost/asio.hpp>',
    '#include "util.h"',
    'namespace app {',
    'class Server {',
    ' public:',
    '  void run() {',
    '    const char* url = "http://x/{";',
    '  }',
    '};',
    '}',
    'int main() {',
    '  return add(1, 2);',
    '}',
  ].join('\n'),
  'dotnet/Models/User.cs': 'namespace Shop.Models;\n\npublic class User\n{\n    public string Name { get; set; }\n}\n',
  'dotnet/Services/Helper.cs': 'namespace Shop.Services\n{\n    internal static class Helper\n    {\n        public static void Log() {}\n    }\n}\n',
  'dotnet/Services/UserService.cs': [
    'using System;',
    'using Newtonsoft.Json;',
    'using Shop.Models;',
    '',
    'namespace Shop.Services',
    '{',
    '    public class UserService',
    '    {',
    '        public User Load(string id)',
    '        {',
    '            Helper.Log();',
    '            return new User();',
    '        }',
    '    }',
    '}',
  ].join('\n'),
  'kt/src/main/kotlin/com/acme/App.kt': 'package com.acme\n\nimport com.acme.data.Repo\nimport com.acme.util.slug\nimport kotlinx.coroutines.launch\n\nfun main() {\n    Repo().save(slug("x"))\n    Config.load()\n}\n',
  'kt/src/main/kotlin/com/acme/data/Repo.kt': 'package com.acme.data\n\nclass Repo {\n    fun save(value: String) {}\n}\n',
  'kt/src/main/kotlin/com/acme/util/Strings.kt': 'package com.acme.util\n\nfun slug(text: String): String = text.lowercase()\n',
  'kt/src/main/kotlin/com/acme/Config.kt': 'package com.acme\n\nobject Config {\n    fun load() {}\n}\n',
  'sc/src/main/scala/shop/Main.scala': 'package shop\n\nimport shop.model.{Order, Item => It}\nimport scala.collection.mutable\n\nobject Main {\n  def run(): Unit = println(Order(1))\n}\n',
  'sc/src/main/scala/shop/model/Order.scala': 'package shop.model\n\ncase class Order(id: Int)\n\ncase class Item(name: String)\n',
  'php/src/Models/User.php': '<?php\nnamespace App\\Models;\n\nclass User\n{\n    public function name(): string { return ""; }\n}\n',
  'php/src/Http/Controller.php': [
    '<?php',
    'namespace App\\Http;',
    '',
    'use App\\Models\\User;',
    'use Illuminate\\Support\\Str;',
    "require_once __DIR__ . '/../helpers.php';",
    '# use App\\Models\\Ghost;',
    '',
    'class Controller',
    '{',
    '    use Helpers;',
    '    public function show(): User',
    '    {',
    '        return new User();',
    '    }',
    '}',
  ].join('\n'),
  'php/src/helpers.php': '<?php\nfunction helper() {}\n',
  'rb/lib/shop/cart.rb': "require 'json'\nrequire_relative 'item'\n\nmodule Shop\n  class Cart\n    def total\n      0\n    end\n\n    def self.empty\n      new\n    end\n  end\nend\n",
  'rb/lib/shop/item.rb': 'module Shop\n  class Item\n  end\nend\n',
  'rb/bin/run.rb': "require 'shop/cart'\nrequire 'rails'\n",
  'ios/Sources/Core/Store.swift': 'import Foundation\n\npublic struct Store {\n    public func load() {}\n}\n',
  'ios/Sources/App/main.swift': 'import Core\nimport SwiftUI\nimport Alamofire\n\nlet store = Store()\nstore.load()\nHelper.run()\n',
  'ios/Sources/App/Helper.swift': 'enum Helper {\n    static func run() {}\n}\n',
  'flutter/pubspec.yaml': 'name: shop\n',
  'flutter/lib/main.dart': "import 'package:flutter/material.dart';\nimport 'package:shop/models/user.dart';\nimport 'src/util.dart';\nimport 'dart:async';\n\nvoid main() {\n  runApp(App());\n}\n\nclass App {\n  String title() {\n    return 'x';\n  }\n}\n",
  'flutter/lib/models/user.dart': 'class User {}\n',
  'flutter/lib/src/util.dart': 'int twice(int x) => x * 2;\n',
  'web/App.svelte': '<script lang="ts">\n  import Button from "./Button.svelte"\n</script>\n<Button />\n',
  'web/Button.svelte': '<script>\n  export let label = "x"\n</script>\n',
}

let root: string
let analysis: ArchitectureAnalysis
let cache: ParseCache

const fileOf = (path: string) => analysis.files.find((file) => file.path === path)!
const index = (path: string) => analysis.files.findIndex((file) => file.path === path)
const depends = (from: string, to: string) => analysis.edges.some((edge) => edge.from === index(from) && edge.to === index(to))
const external = (ecosystem: string, name: string) => analysis.externals.find((item) => item.ecosystem === ecosystem && item.name === name)
const symbols = (path: string) => fileOf(path).symbols.map((symbol) => `${symbol.kind} ${symbol.parent ? `${symbol.parent}.` : ''}${symbol.name} ${symbol.line}-${symbol.endLine}`)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'diffra-langs-'))
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await analyzeProject({ projectId: 'langs', root, rgPath: await findRipgrep(), cache: null, signal: new AbortController().signal, onProgress: () => {} })
  analysis = result.analysis
  cache = result.cache
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('更多语言的依赖', () => {
  test('C/C++：引号的先找同目录、再按路径后缀找 include 目录；尖括号的系统头文件算自带，库按第一段归', () => {
    expect(depends('native/src/util.c', 'native/include/util.h')).toBe(true)
    expect(depends('native/src/main.cpp', 'native/include/util.h')).toBe(true)
    expect(external('native', 'vector')?.builtin).toBe(true)
    expect(external('native', 'sys/types.h')?.builtin).toBe(true)
    expect(external('native', 'stdio.h')?.builtin).toBe(true)
    expect(external('native', 'boost')?.builtin).toBe(false)
    // 注释里的 include 不算
    expect(analysis.unresolved.map((item) => item.specifier)).not.toContain('commented.h')
    expect(symbols('native/src/main.cpp')).toEqual(['module app 5-12', 'class app.Server 6-11', 'method Server.run 8-10', 'function main 13-15'])
  })

  test('C#：using 的命名空间只连真用到的类型所在的文件；同一个命名空间不用 using；System 是自带的', () => {
    expect(depends('dotnet/Services/UserService.cs', 'dotnet/Models/User.cs')).toBe(true)
    expect(depends('dotnet/Services/UserService.cs', 'dotnet/Services/Helper.cs')).toBe(true)
    expect(depends('dotnet/Models/User.cs', 'dotnet/Services/UserService.cs')).toBe(false)
    expect(external('nuget', 'System')?.builtin).toBe(true)
    expect(external('nuget', 'Newtonsoft.Json')?.builtin).toBe(false)
    expect(fileOf('dotnet/Services/UserService.cs').namespace).toBe('Shop.Services')
    expect(symbols('dotnet/Services/UserService.cs')).toEqual(['class UserService 7-14', 'method UserService.Load 9-13'])
  })

  test('Kotlin、Scala：按包名和文件里定义的类、顶层函数对 import；同包的类型不 import 也算', () => {
    expect(depends('kt/src/main/kotlin/com/acme/App.kt', 'kt/src/main/kotlin/com/acme/data/Repo.kt')).toBe(true)
    expect(depends('kt/src/main/kotlin/com/acme/App.kt', 'kt/src/main/kotlin/com/acme/util/Strings.kt')).toBe(true)
    expect(depends('kt/src/main/kotlin/com/acme/App.kt', 'kt/src/main/kotlin/com/acme/Config.kt')).toBe(true)
    expect(external('java', 'kotlinx.coroutines')?.builtin).toBe(false)
    expect(symbols('kt/src/main/kotlin/com/acme/data/Repo.kt')).toEqual(['class Repo 3-5', 'method Repo.save 4-4'])
    expect(depends('sc/src/main/scala/shop/Main.scala', 'sc/src/main/scala/shop/model/Order.scala')).toBe(true)
    expect(external('java', 'scala.collection')?.builtin).toBe(true)
    expect(symbols('sc/src/main/scala/shop/model/Order.scala')).toEqual(['class Order 3-3', 'class Item 5-5'])
  })

  test('PHP：use 按命名空间加类名对，require 按路径；类里的 use 是 trait 不算；# 注释不算', () => {
    expect(depends('php/src/Http/Controller.php', 'php/src/Models/User.php')).toBe(true)
    expect(depends('php/src/Http/Controller.php', 'php/src/helpers.php')).toBe(true)
    expect(external('composer', 'Illuminate\\Support')?.builtin).toBe(false)
    const specifiers = analysis.unresolved.map((item) => item.specifier)
    expect(specifiers).not.toContain('App\\Models\\Ghost')
    expect(specifiers).not.toContain('Helpers')
    expect(symbols('php/src/Http/Controller.php')).toEqual(['class Controller 9-16', 'method Controller.show 12-15'])
  })

  test('Ruby：require_relative 按路径，require 按 lib 下的路径；标准库和 gem 分开；范围到同样缩进的 end', () => {
    expect(depends('rb/lib/shop/cart.rb', 'rb/lib/shop/item.rb')).toBe(true)
    expect(depends('rb/bin/run.rb', 'rb/lib/shop/cart.rb')).toBe(true)
    expect(external('gem', 'json')?.builtin).toBe(true)
    expect(external('gem', 'rails')?.builtin).toBe(false)
    expect(symbols('rb/lib/shop/cart.rb')).toEqual(['module Shop 4-14', 'class Shop.Cart 5-13', 'method Cart.total 6-8', 'method Cart.empty 10-12'])
  })

  test('Swift：import 本项目的模块只连用到的类型；同一个模块的文件互相直接用；系统框架算自带', () => {
    expect(depends('ios/Sources/App/main.swift', 'ios/Sources/Core/Store.swift')).toBe(true)
    expect(depends('ios/Sources/App/main.swift', 'ios/Sources/App/Helper.swift')).toBe(true)
    expect(external('swift', 'SwiftUI')?.builtin).toBe(true)
    expect(external('swift', 'Alamofire')?.builtin).toBe(false)
    expect(symbols('ios/Sources/Core/Store.swift')).toEqual(['struct Store 3-5', 'method Store.load 4-4'])
  })

  test('Dart：package:本项目 对到 lib/ 下，相对路径按目录；dart: 是自带的', () => {
    expect(depends('flutter/lib/main.dart', 'flutter/lib/models/user.dart')).toBe(true)
    expect(depends('flutter/lib/main.dart', 'flutter/lib/src/util.dart')).toBe(true)
    expect(external('pub', 'flutter')?.builtin).toBe(false)
    expect(external('pub', 'dart:async')?.builtin).toBe(true)
    expect(symbols('flutter/lib/main.dart')).toEqual(['function main 6-8', 'class App 10-14', 'method App.title 11-13'])
    expect(symbols('flutter/lib/src/util.dart')).toEqual(['function twice 1-1'])
  })

  test('Svelte 按 script 块解析，和 TS/JS 一样对路径', () => {
    expect(depends('web/App.svelte', 'web/Button.svelte')).toBe(true)
    expect(fileOf('web/App.svelte').language).toBe('svelte')
  })

  test('都算深度解析的文件；再分析一次全用缓存', async () => {
    expect(analysis.files.every((file) => file.parsed)).toBe(true)
    const again = await analyzeProject({ projectId: 'langs', root, rgPath: await findRipgrep(), cache, signal: new AbortController().signal, onProgress: () => {} })
    expect(again.analysis.stats.reparsed).toBe(0)
  })
})
