import inspect
import unittest

from app import profile, signup
from app.profile import validate_profile_update
from app.signup import validate_signup
from app.validators import validate_email, validate_nickname, validate_phone

NICKNAME_ERROR = '昵称长度要在 2 到 20 个字之间'
VALID = {'email': 'li.lei@example.com', 'phone': '13812345678', 'nickname': '李雷', 'password': 'secret-123'}
WITHOUT_PHONE = {key: value for key, value in VALID.items() if key != 'phone'}

SIGNUP_CASES = [
    (VALID, {}),
    ({**VALID, 'email': '  li.lei@example.com  '}, {}),
    ({**VALID, 'email': None}, {'email': '邮箱不能为空'}),
    ({**VALID, 'email': '   '}, {'email': '邮箱不能为空'}),
    ({**VALID, 'email': 'li.lei@example'}, {'email': '邮箱格式不对'}),
    ({**VALID, 'email': 'a' * 250 + '@ex.com'}, {'email': '邮箱格式不对'}),
    ({**VALID, 'phone': ''}, {}),
    ({**VALID, 'phone': None}, {}),
    (WITHOUT_PHONE, {}),
    ({**VALID, 'phone': '1381234567'}, {'phone': '手机号格式不对'}),
    ({**VALID, 'phone': ' 13812345678 '}, {}),
    ({**VALID, 'nickname': ' 李 '}, {'nickname': NICKNAME_ERROR}),
    ({**VALID, 'nickname': 'x' * 20}, {}),
    ({**VALID, 'nickname': 'x' * 21}, {'nickname': NICKNAME_ERROR}),
    ({**VALID, 'password': 'short'}, {'password': '密码至少 8 位'}),
    ({}, {'email': '邮箱不能为空', 'nickname': NICKNAME_ERROR, 'password': '密码至少 8 位'}),
]

PROFILE_CASES = [
    ({}, {}),
    ({'nickname': '韩梅梅'}, {}),
    ({'email': ''}, {'email': '邮箱不能为空'}),
    ({'email': None}, {'email': '邮箱不能为空'}),
    ({'email': 'bad'}, {'email': '邮箱格式不对'}),
    ({'phone': ''}, {}),
    ({'phone': None}, {}),
    ({'phone': '138 1234 5678'}, {'phone': '手机号格式不对'}),
    ({'nickname': 'x'}, {'nickname': NICKNAME_ERROR}),
    ({'nickname': None}, {'nickname': NICKNAME_ERROR}),
    ({'password': 'x'}, {}),
    ({'email': 'bad', 'phone': '1', 'nickname': ''}, {'email': '邮箱格式不对', 'phone': '手机号格式不对', 'nickname': NICKNAME_ERROR}),
]


class BehaviourUnchangedTest(unittest.TestCase):
    def test_signup(self):
        for data, expected in SIGNUP_CASES:
            with self.subTest(data=data):
                self.assertEqual(validate_signup(data), expected)

    def test_profile_update(self):
        for data, expected in PROFILE_CASES:
            with self.subTest(data=data):
                self.assertEqual(validate_profile_update(data), expected)


class ValidatorsTest(unittest.TestCase):
    def test_email(self):
        self.assertIsNone(validate_email('li.lei@example.com'))
        self.assertEqual(validate_email('li.lei@example'), '邮箱格式不对')

    def test_phone(self):
        self.assertIsNone(validate_phone('13812345678'))
        self.assertEqual(validate_phone('12812345678'), '手机号格式不对')

    def test_nickname(self):
        self.assertIsNone(validate_nickname('李雷'))
        self.assertEqual(validate_nickname('李'), NICKNAME_ERROR)


class DuplicationRemovedTest(unittest.TestCase):
    def test_rules_live_only_in_validators(self):
        for module in (signup, profile):
            source = inspect.getsource(module)
            with self.subTest(module=module.__name__):
                self.assertNotIn('re.compile', source)
                self.assertNotIn('邮箱格式不对', source)
                self.assertNotIn('手机号格式不对', source)
                self.assertNotIn('昵称长度', source)
