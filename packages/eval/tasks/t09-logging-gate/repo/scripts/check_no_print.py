"""正式代码不留 print：app/ 下有 print( 调用就失败。"""
import ast
import pathlib
import sys

problems = []
for path in sorted(pathlib.Path('app').rglob('*.py')):
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'print':
            problems.append(f'{path.as_posix()}:{node.lineno} 用了 print，改用 logging')
if problems:
    print('\n'.join(problems))
    sys.exit(1)
print('没有 print')
