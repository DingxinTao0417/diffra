from app.users import load_users


def main():
    users = load_users()
    print(f'共 {len(users)} 个用户')
    for user in users:
        print(f"{user['id']}\t{user['name']}\t{user['email']}")


if __name__ == '__main__':
    main()
