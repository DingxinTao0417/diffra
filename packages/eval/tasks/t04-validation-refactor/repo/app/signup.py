import re

EMAIL_PATTERN = re.compile(r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')
PHONE_PATTERN = re.compile(r'^1[3-9]\d{9}$')
NICKNAME_MIN = 2
NICKNAME_MAX = 20
PASSWORD_MIN = 8


def validate_signup(data):
    """注册表单校验，返回 {字段: 错误提示}，全部通过返回空 dict。"""
    errors = {}
    email = (data.get('email') or '').strip()
    if not email:
        errors['email'] = '邮箱不能为空'
    elif len(email) > 254 or not EMAIL_PATTERN.match(email):
        errors['email'] = '邮箱格式不对'
    phone = (data.get('phone') or '').strip()
    if phone and not PHONE_PATTERN.match(phone):
        errors['phone'] = '手机号格式不对'
    nickname = (data.get('nickname') or '').strip()
    if len(nickname) < NICKNAME_MIN or len(nickname) > NICKNAME_MAX:
        errors['nickname'] = f'昵称长度要在 {NICKNAME_MIN} 到 {NICKNAME_MAX} 个字之间'
    password = data.get('password') or ''
    if len(password) < PASSWORD_MIN:
        errors['password'] = f'密码至少 {PASSWORD_MIN} 位'
    return errors
