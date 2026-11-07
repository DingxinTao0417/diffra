import logging

logger = logging.getLogger(__name__)


def push_to_crm(records):
    logger.info('同步到 CRM：%d 条', len(records))
    # 真实环境这里调用 CRM 的接口；本地开发只返回条数
    return len(records)
