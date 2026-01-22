#!/usr/bin/env python3
# Скрипт для исправления прав админа

import sqlite3

print('🔧 Исправление прав админа...\n')

conn = sqlite3.connect('beegram.db')
c = conn.cursor()

# Проверяем структуру таблицы
columns = [row[1] for row in c.execute('PRAGMA table_info(users)').fetchall()]
print(f'📋 Поля в таблице users: {", ".join(columns)}\n')

# Добавляем поля если их нет
if 'is_admin' not in columns:
    print('➕ Добавляем поле is_admin...')
    c.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0')
    conn.commit()
    print('✅ Поле is_admin добавлено\n')

if 'theme' not in columns:
    print('➕ Добавляем поле theme...')
    c.execute('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT "light"')
    conn.commit()
    print('✅ Поле theme добавлено\n')

# Проверяем админа
admin = c.execute('SELECT id, username, is_admin, is_premium FROM users WHERE username = "admin"').fetchone()

if admin:
    print(f'👤 Найден пользователь admin:')
    print(f'   ID: {admin[0]}')
    print(f'   is_admin: {admin[2]}')
    print(f'   is_premium: {admin[3]}\n')
    
    if not admin[2]:
        print('🔧 Обновляем права админа...')
        c.execute('UPDATE users SET is_admin = 1, is_premium = 1, nickname = "👑 Администратор" WHERE username = "admin"')
        conn.commit()
        print('✅ Права админа обновлены!\n')
    else:
        print('✅ Админ уже имеет права!\n')
else:
    print('❌ Пользователь admin не найден!\n')
    print('Создайте его через регистрацию или запустите сервер заново.\n')

# Показываем всех админов
admins = c.execute('SELECT id, username, nickname, is_admin, is_premium FROM users WHERE is_admin = 1').fetchall()
print(f'👑 Администраторы ({len(admins)}):')
for admin in admins:
    print(f'   • {admin[2] or admin[1]} (@{admin[1]}) - Premium: {"Да" if admin[4] else "Нет"}')

conn.close()

print('\n✅ Готово! Теперь запустите сервер и войдите как admin / admin123')
