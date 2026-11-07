import logging

from app.sync import push_to_crm

logger = logging.getLogger(__name__)


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
        logger.debug('处理第 %d 行', index)
        try:
            imported.append(parse_row(row))
        except (KeyError, ValueError):
            logger.error('第 %d 行导入失败', index, exc_info=True)
    logger.info('导入完成：成功 %d 条，共 %d 行', len(imported), len(rows))
    push_to_crm(imported)
    return imported
