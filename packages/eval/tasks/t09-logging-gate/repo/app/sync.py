def push_to_crm(records):
    print('同步到 CRM：', len(records))
    # 真实环境这里调用 CRM 的接口；本地开发只返回条数
    return len(records)
