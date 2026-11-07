from app.validators import validate_email, validate_nickname, validate_phone

VALIDATORS = {'email': validate_email, 'phone': validate_phone, 'nickname': validate_nickname}


def validate_profile_update(data):
    """资料修改校验：只校验传了的字段，返回 {字段: 错误提示}。"""
    errors = {}
    for field, validate in VALIDATORS.items():
        if field in data:
            message = validate(data.get(field))
            if message:
                errors[field] = message
    return errors
