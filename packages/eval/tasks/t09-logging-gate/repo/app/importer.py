from app.sync import push_to_crm


def parse_row(row):
    name = row['name'].strip()
    if not name:
        raise ValueError('名字为空')
    age = int(row['age'])
    if age < 0 or age > 150:
        raise ValueError(f'年龄不合理：{age}')
    return {'name': name, 'age': age}


def import_rows(rows):
    imported = []
    for index, row in enumerate(rows, start=1):
        print('处理第', index, '行')
        try:
            imported.append(parse_row(row))
        except (KeyError, ValueError) as error:
            print('第', index, '行导入失败', error)
    print('导入完成', len(imported), '条')
    push_to_crm(imported)
    return imported
