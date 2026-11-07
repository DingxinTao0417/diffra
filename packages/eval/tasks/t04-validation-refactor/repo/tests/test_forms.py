import unittest

from app.profile import validate_profile_update
from app.signup import validate_signup


class SignupTest(unittest.TestCase):
    def test_valid(self):
        data = {'email': 'li.lei@example.com', 'phone': '13812345678', 'nickname': '李雷', 'password': 'secret-123'}
        self.assertEqual(validate_signup(data), {})

    def test_bad_email(self):
        data = {'email': 'li.lei', 'nickname': '李雷', 'password': 'secret-123'}
        self.assertEqual(validate_signup(data), {'email': '邮箱格式不对'})


class ProfileTest(unittest.TestCase):
    def test_only_checks_given_fields(self):
        self.assertEqual(validate_profile_update({'nickname': '韩梅梅'}), {})

    def test_bad_phone(self):
        self.assertEqual(validate_profile_update({'phone': '123'}), {'phone': '手机号格式不对'})
