import re

EMAIL_PATTERN = re.compile(r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')
EMAIL_MAX = 254
PHONE_PATTERN = re.compile(r'^1[3-9]\d{9}$')
NICKNAME_MIN = 2
NICKNAME_MAX = 20


def validate_email(value):
    email = (value or '').strip()
    if not email:
        return '邮箱不能为空'
    if len(email) > EMAIL_MAX or not EMAIL_PATTERN.match(email):
        return '邮箱格式不对'
    return None


def validate_phone(value):
    """手机号选填：空值不算错。"""
    phone = (value or '').strip()
    if phone and not PHONE_PATTERN.match(phone):
        return '手机号格式不对'
    return None


def validate_nickname(value):
    nickname = (value or '').strip()
    if len(nickname) < NICKNAME_MIN or len(nickname) > NICKNAME_MAX:
        return f'昵称长度要在 {NICKNAME_MIN} 到 {NICKNAME_MAX} 个字之间'
    return None
