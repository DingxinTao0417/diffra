import { describe, expect, test } from 'vitest'
import { extractFacts, sourceLanguageOf } from '../src/architecture/extract.js'
import type { FileFacts, ImportFact, ImportKind, SymbolFact, SymbolKind } from '../src/architecture/model.js'

const imp = (line: number, specifier: string, names: string[], kind: ImportKind, local?: string): ImportFact => ({ specifier, line, names, kind, ...(local ? { local } : {}) })

const sym = (name: string, kind: SymbolKind, line: number, endLine: number, exported: boolean, parent: string | null = null): SymbolFact => ({
  name,
  kind,
  line,
  endLine,
  exported,
  parent,
})

function facts(path: string, lines: string[]): FileFacts {
  const result = extractFacts(path, lines.join('\n'))
  if (!result) throw new Error(`${path} 没有解析`)
  return result
}

describe('架构分析：按扩展名认语言', () => {
  test('按扩展名识别语言（v2 起多了按行提取的几种和 Svelte），其他返回 null', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'A.TS'].map(sourceLanguageOf)).toEqual(Array(5).fill('typescript'))
    expect(['a.js', 'a.jsx', 'a.mjs', 'a.cjs'].map(sourceLanguageOf)).toEqual(Array(4).fill('javascript'))
    expect(['a.vue', 'a.py', 'a.go', 'a.rs', 'A.java'].map(sourceLanguageOf)).toEqual(['vue', 'python', 'go', 'rust', 'java'])
    expect(['a.c', 'a.h', 'a.cpp', 'a.hpp', 'a.cs', 'a.kt', 'a.scala', 'a.php', 'a.rb', 'a.swift', 'a.dart', 'a.svelte'].map(sourceLanguageOf)).toEqual([
      'c', 'c', 'cpp', 'cpp', 'csharp', 'kotlin', 'scala', 'php', 'ruby', 'swift', 'dart', 'svelte',
    ])
    expect(sourceLanguageOf('README.md')).toBeNull()
    expect(sourceLanguageOf('a.sql')).toBeNull()
    expect(extractFacts('a.kt', 'fun main() {}')?.symbols).toEqual([{ name: 'main', kind: 'function', line: 1, endLine: 1, exported: true, parent: null }])
  })

  test('语法错误的文件不抛错，取出认得出的部分', () => {
    for (const [path, source] of [
      ['a.ts', "import { a from './a'\nexport class {\n  method( {"],
      ['a.py', 'from . import\ndef broken(:\n  pass'],
      ['a.go', 'package p\nimport (\n"fmt"\nfunc ('],
      ['a.rs', 'use a::{b, ;\nimpl for {\nmod x'],
      ['A.java', 'package a.b\nimport x.;\nclass {'],
    ] as const) {
      expect(() => extractFacts(path, source)).not.toThrow()
    }
    expect(extractFacts('a.ts', "import x from './ok'\nconst = ;")?.imports).toEqual([imp(1, './ok', ['default'], 'import')])
  })
})

describe('架构分析：TS / JS / Vue', () => {
  test('各种 import、export from、import()、require()', () => {
    const result = facts('src/a.ts', [
      "import x from './a'",
      "import { b as c, d } from 'pkg'",
      "import * as n from './n'",
      "import './side'",
      "import type { A } from './types'",
      "import { type B, type C } from './types2'",
      "import y, { type Z } from './mixed'",
      "export * from './all'",
      "export { e, f as g } from './some'",
      "export { default as h } from './def'",
      "const lazy = () => import('./lazy')",
      "const fs = require('node:fs')",
      'import(`./template`)',
      'require(name)',
      "import('./a' + suffix)",
      "import def, * as ns from './both'",
      "export * as space from './space'",
      "import legacy = require('./legacy')",
      "function load() { return import(/* webpackChunkName: \"x\" */ './chunk') }",
    ])
    expect(result.language).toBe('typescript')
    expect(result.imports).toEqual([
      imp(1, './a', ['default'], 'import'),
      imp(2, 'pkg', ['b', 'd'], 'import'),
      imp(3, './n', [], 'import', 'n'),
      imp(4, './side', [], 'import'),
      imp(5, './types', ['A'], 'type'),
      imp(6, './types2', ['B', 'C'], 'type'),
      imp(7, './mixed', ['default', 'Z'], 'import'),
      imp(8, './all', [], 'reexport'),
      imp(9, './some', ['e', 'f'], 'reexport'),
      imp(10, './def', ['default'], 'reexport'),
      imp(11, './lazy', [], 'dynamic'),
      imp(12, 'node:fs', [], 'require', 'fs'),
      imp(16, './both', ['default'], 'import', 'ns'),
      imp(17, './space', [], 'reexport'),
      imp(18, './legacy', [], 'require'),
      imp(19, './chunk', [], 'dynamic'),
    ])
    expect(result.namespace).toBeNull()
    expect(result.typeRefs).toEqual([])
  })

  test('顶层符号、类的方法，export 和本地 export 列表都算导出', () => {
    const result = facts('src/a.ts', [
      'export function run() {}',
      'export async function* stream() {}',
      'export abstract class Base<T> {',
      '  abstract load(): void',
      '  save() {}',
      '}',
      'class Local {',
      '  method() {}',
      '}',
      'export interface Options {}',
      'export type Id = string',
      'export enum Mode { A }',
      'export const handler = () => 1, LIMIT = 2',
      'let counter = 0',
      'function helper() {}',
      'export { helper, Local as Renamed }',
      'export function over(a: string): void',
      'export function over(a: unknown) {',
      '}',
      'const { a, b } = obj',
      'var legacy = function () {}',
      'export default function () {}',
    ])
    expect(result.symbols).toEqual([
      sym('run', 'function', 1, 1, true),
      sym('stream', 'function', 2, 2, true),
      sym('Base', 'class', 3, 6, true),
      sym('load', 'method', 4, 4, true, 'Base'),
      sym('save', 'method', 5, 5, true, 'Base'),
      sym('Local', 'class', 7, 9, true),
      sym('method', 'method', 8, 8, true, 'Local'),
      sym('Options', 'interface', 10, 10, true),
      sym('Id', 'type', 11, 11, true),
      sym('Mode', 'enum', 12, 12, true),
      sym('handler', 'function', 13, 13, true),
      sym('LIMIT', 'variable', 13, 13, true),
      sym('counter', 'variable', 14, 14, false),
      sym('helper', 'function', 15, 15, true),
      sym('over', 'function', 17, 19, true),
      sym('legacy', 'function', 21, 21, false),
      sym('default', 'function', 22, 22, true),
    ])
  })

  test('export default 一个本地名字算导出；匿名默认导出的类记作 default', () => {
    const result = facts('src/a.js', ['class Store {', '  get() {}', '}', 'export default Store'])
    expect(result.language).toBe('javascript')
    expect(result.symbols).toEqual([sym('Store', 'class', 1, 3, true), sym('get', 'method', 2, 2, true, 'Store')])
    expect(facts('src/b.ts', ['export default class {', '  run() {}', '}']).symbols).toEqual([
      sym('default', 'class', 1, 3, true),
      sym('run', 'method', 2, 2, true, 'default'),
    ])
  })

  test('.tsx、.jsx 能解析 JSX', () => {
    const tsx = facts('src/App.tsx', ["import { Button } from './Button'", 'export function App(): JSX.Element {', '  return <Button label="x" />', '}'])
    expect(tsx.imports).toEqual([imp(1, './Button', ['Button'], 'import')])
    expect(tsx.symbols).toEqual([sym('App', 'function', 2, 4, true)])
    const jsx = facts('src/App.jsx', ["const React = require('react')", 'export const App = () => <div />'])
    expect(jsx.imports).toEqual([imp(1, 'react', [], 'require', 'React')])
    expect(jsx.symbols).toEqual([sym('React', 'variable', 1, 1, false), sym('App', 'function', 2, 2, true)])
  })

  test('Vue 只看 <script>，行号对应整个文件', () => {
    const result = facts('src/Page.vue', [
      '<template>',
      '  <Child :msg="msg" />',
      '</template>',
      '<script lang="ts">',
      "export { shared } from './shared'",
      '</script>',
      '<script setup lang="ts">',
      "import { ref } from 'vue'",
      "import Child from './Child.vue'",
      "const msg = ref('hi')",
      '</script>',
    ])
    expect(result.language).toBe('vue')
    expect(result.imports).toEqual([imp(5, './shared', ['shared'], 'reexport'), imp(8, 'vue', ['ref'], 'import'), imp(9, './Child.vue', ['default'], 'import')])
    expect(result.symbols).toEqual([sym('msg', 'variable', 10, 10, false)])
  })
})

describe('架构分析：Python', () => {
  test('import 和 from import，函数里、try 里的也算', () => {
    const result = facts('pkg/a.py', [
      'import os, a.b.c',
      'import a.b as x',
      'from a.b import c, d as e',
      'from . import y',
      'from ..pkg.mod import (z,)',
      'from x import *',
      'def f():',
      '    import json',
      '    try:',
      '        from q import r',
      '    except ImportError:',
      '        pass',
    ])
    expect(result.imports).toEqual([
      imp(1, 'os', [], 'import'),
      imp(1, 'a.b.c', [], 'import'),
      imp(2, 'a.b', [], 'import', 'x'),
      imp(3, 'a.b', ['c', 'd'], 'import'),
      imp(4, '.', ['y'], 'import'),
      imp(5, '..pkg.mod', ['z'], 'import'),
      imp(6, 'x', [], 'import'),
      imp(8, 'json', [], 'import'),
      imp(10, 'q', ['r'], 'import'),
    ])
  })

  test('顶层函数、类和方法（含装饰过的）、模块级变量；下划线开头的不导出', () => {
    const result = facts('pkg/a.py', [
      'MAX_SIZE: int = 3',
      '_private = 1',
      'a, b = 1, 2',
      'obj.attr = 3',
      'value = 4',
      '@dec',
      'class Foo(Base):',
      '    X = 1',
      '    def m(self):',
      '        pass',
      '    @property',
      '    def _p(self):',
      '        return 1',
      'async def g():',
      '    pass',
      '@dec',
      'def _h():',
      '    pass',
    ])
    expect(result.symbols).toEqual([
      sym('MAX_SIZE', 'constant', 1, 1, true),
      sym('_private', 'variable', 2, 2, false),
      sym('value', 'variable', 5, 5, true),
      sym('Foo', 'class', 7, 13, true),
      sym('m', 'method', 9, 10, true, 'Foo'),
      sym('_p', 'method', 12, 13, false, 'Foo'),
      sym('g', 'function', 14, 15, true),
      sym('_h', 'function', 17, 18, false),
    ])
  })
})

describe('架构分析：Go', () => {
  test('import、package 名、函数、方法（接收者去掉指针和泛型参数）、类型、常量和变量', () => {
    const result = facts('cmd/main.go', [
      'package main',
      '',
      'import "fmt"',
      'import (',
      '\t"os"',
      '\tf "path/filepath"',
      '\t_ "github.com/a/b/c"',
      '\t`raw/path`',
      ')',
      '',
      'type Point struct{ X int }',
      'type shape interface{ Area() float64 }',
      'type ID = string',
      'type (',
      '\tList[T any] struct{ items []T }',
      '\tCount int',
      ')',
      'const A, b = 1, 2',
      'var (',
      '\tx int',
      '\tY = 2',
      ')',
      'func (p *Point) Move() {}',
      'func (l List[T]) len() int {',
      '\treturn 0',
      '}',
      'func main() { fmt.Println("x") }',
    ])
    expect(result.namespace).toBe('main')
    expect(result.imports).toEqual([
      imp(3, 'fmt', [], 'import'),
      imp(5, 'os', [], 'import'),
      imp(6, 'path/filepath', [], 'import', 'f'),
      imp(7, 'github.com/a/b/c', [], 'import'),
      imp(8, 'raw/path', [], 'import'),
    ])
    expect(result.symbols).toEqual([
      sym('Point', 'struct', 11, 11, true),
      sym('shape', 'interface', 12, 12, false),
      sym('ID', 'type', 13, 13, true),
      sym('List', 'struct', 15, 15, true),
      sym('Count', 'type', 16, 16, true),
      sym('A', 'constant', 18, 18, true),
      sym('b', 'constant', 18, 18, false),
      sym('x', 'variable', 20, 20, false),
      sym('Y', 'variable', 21, 21, true),
      sym('Move', 'method', 23, 23, true, 'Point'),
      sym('len', 'method', 24, 26, false, 'List'),
      sym('main', 'function', 27, 27, false),
    ])
  })
})

describe('架构分析：Rust', () => {
  test('use 树展开成每个叶子一条；mod foo; 和 extern crate', () => {
    const result = facts('src/lib.rs', [
      'use std::collections::HashMap;',
      'use crate::a::b::{c, d::e};',
      'use super::x::{self, y as z};',
      'pub use self::m::*;',
      'use a::B as C;',
      'use crate::{',
      '    p::{q, r::*},',
      '    s,',
      '};',
      'extern crate foo;',
      'mod bar;',
      'pub(crate) mod inner {',
      '    use crate::deep::Thing;',
      '    mod nested;',
      '}',
      'fn top() {',
      '    use std::io;',
      '}',
    ])
    expect(result.imports).toEqual([
      imp(1, 'std::collections::HashMap', ['HashMap'], 'use'),
      imp(2, 'crate::a::b::c', ['c'], 'use'),
      imp(2, 'crate::a::b::d::e', ['e'], 'use'),
      imp(3, 'super::x', ['x'], 'use'),
      imp(3, 'super::x::y', ['y'], 'use'),
      imp(4, 'self::m', [], 'use'),
      imp(5, 'a::B', ['B'], 'use'),
      imp(7, 'crate::p::q', ['q'], 'use'),
      imp(7, 'crate::p::r', [], 'use'),
      imp(8, 'crate::s', ['s'], 'use'),
      imp(10, 'foo', [], 'use'),
      imp(11, 'bar', [], 'mod'),
      imp(13, 'crate::deep::Thing', ['Thing'], 'use'),
      imp(14, 'inner::nested', [], 'mod'),
      imp(17, 'std::io', ['io'], 'use'),
    ])
  })

  test('顶层和行内 mod 里的条目；impl 里的函数记成类型的方法', () => {
    const result = facts('src/lib.rs', [
      'pub struct S<T> { x: T }',
      'enum E { A }',
      'pub trait Tr { fn m(&self); }',
      'type Alias = u32;',
      'pub const K: u32 = 1;',
      'static G: u32 = 2;',
      'impl<T> Tr for S<T> {',
      '    fn m(&self) {}',
      '}',
      "impl<'a> &'a S<u8> {",
      '    pub fn n(&self) {}',
      '}',
      'impl crate::x::Y { pub(crate) fn o() {} }',
      'pub fn top() {}',
      'mod tests {',
      '    fn check() {}',
      '}',
      'mod bar;',
    ])
    expect(result.symbols).toEqual([
      sym('S', 'struct', 1, 1, true),
      sym('E', 'enum', 2, 2, false),
      sym('Tr', 'trait', 3, 3, true),
      sym('Alias', 'type', 4, 4, false),
      sym('K', 'constant', 5, 5, true),
      sym('G', 'constant', 6, 6, false),
      sym('m', 'method', 8, 8, false, 'S'),
      sym('n', 'method', 11, 11, true, 'S'),
      sym('o', 'method', 13, 13, true, 'Y'),
      sym('top', 'function', 14, 14, true),
      sym('tests', 'module', 15, 17, false),
      sym('check', 'function', 16, 16, false),
      sym('bar', 'module', 18, 18, false),
    ])
    expect(result.namespace).toBeNull()
  })
})

describe('架构分析：Java', () => {
  test('package、import、import static、类型引用', () => {
    const result = facts('src/main/java/com/x/y/Foo.java', [
      'package com.x.y;',
      '',
      'import java.util.List;',
      'import java.util.*;',
      'import static org.junit.Assert.assertEquals;',
      'import static org.junit.Assert.*;',
      '',
      'public class Foo extends Bar implements Baz {',
      '    private Map<String, List<Helper>> m;',
      '    void run() { new Other(); }',
      '}',
    ])
    expect(result.namespace).toBe('com.x.y')
    expect(result.imports).toEqual([
      imp(3, 'java.util.List', ['List'], 'import'),
      imp(4, 'java.util.*', [], 'import'),
      imp(5, 'org.junit.Assert.assertEquals', ['assertEquals'], 'static'),
      imp(6, 'org.junit.Assert.*', [], 'static'),
    ])
    expect(result.typeRefs).toEqual(['Bar', 'Baz', 'Helper', 'List', 'Map', 'Other', 'String'])
    expect(facts('Main.java', ['class Main {}']).namespace).toBeNull()
  })

  test('类型声明（含嵌套）、方法和构造函数；public 才算导出', () => {
    const result = facts('Foo.java', [
      '@Deprecated',
      'public class Foo<T> {',
      '    public Foo() {}',
      '    public static void run() {}',
      '    static class Inner { void x() {} }',
      '    public interface I { void y(); }',
      '    enum E { A; void z() {} }',
      '    record R(int a) { R {} }',
      '}',
      'interface Top {}',
      '@interface Ann { String value(); }',
    ])
    expect(result.symbols).toEqual([
      sym('Foo', 'class', 1, 9, true),
      sym('Foo', 'method', 3, 3, true, 'Foo'),
      sym('run', 'method', 4, 4, true, 'Foo'),
      sym('Inner', 'class', 5, 5, false, 'Foo'),
      sym('x', 'method', 5, 5, false, 'Inner'),
      sym('I', 'interface', 6, 6, true, 'Foo'),
      sym('y', 'method', 6, 6, false, 'I'),
      sym('E', 'enum', 7, 7, false, 'Foo'),
      sym('z', 'method', 7, 7, false, 'E'),
      sym('R', 'class', 8, 8, false, 'Foo'),
      sym('R', 'method', 8, 8, false, 'R'),
      sym('Top', 'interface', 10, 10, false),
      sym('Ann', 'interface', 11, 11, false),
    ])
  })
})
