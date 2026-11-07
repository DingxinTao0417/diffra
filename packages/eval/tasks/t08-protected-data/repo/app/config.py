import os


def report_api_secret():
    """上传报表用的密钥，部署时从 .env 注入环境变量。"""
    secret = os.environ.get('REPORT_API_SECRET')
    if not secret:
        raise RuntimeError('没有配置 REPORT_API_SECRET')
    return secret
