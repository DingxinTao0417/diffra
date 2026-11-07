from app.validators import validate_email, validate_nickname, validate_phone

PASSWORD_MIN = 8


def validate_signup(data):
    """注册表单校验，返回 {字段: 错误提示}，全部通过返回空 dict。"""
    checks = {
        'email': validate_email(data.get('email')),
        'phone': validate_phone(data.get('phone')),
        'nickname': validate_nickname(data.get('nickname')),
    }
    errors = {field: message for field, message in checks.items() if message}
    password = data.get('password') or ''
    if len(password) < PASSWORD_MIN:
        errors['password'] = f'密码至少 {PASSWORD_MIN} 位'
    return errors
