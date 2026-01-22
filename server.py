# -*- coding: utf-8 -*-
"""
BeeGramm - Мессенджер с пчелиной тематикой 🐝
Backend: Flask + Flask-SocketIO + SQLite
"""

from flask import Flask, render_template, request, jsonify, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room, leave_room
import sqlite3
import bcrypt
import os
import uuid
from datetime import datetime
from werkzeug.utils import secure_filename
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'beegram_secret_honey_key_2024'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB для премиум

socketio = SocketIO(app, cors_allowed_origins="*")

# Создаём папку для загрузок
os.makedirs('uploads/avatars', exist_ok=True)
os.makedirs('uploads/files', exist_ok=True)

# ============= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============

def hash_password(password):
    """Хэшировать пароль"""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

# ============= БАЗА ДАННЫХ =============

def init_db():
    """Инициализация базы данных"""
    conn = sqlite3.connect('beegram.db')
    c = conn.cursor()
    
    # Проверяем, существует ли таблица users
    table_exists = c.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).fetchone()
    
    if table_exists:
        # Проверяем наличие новых полей и добавляем их
        columns = [row[1] for row in c.execute('PRAGMA table_info(users)').fetchall()]
        
        if 'is_admin' not in columns:
            print('🔧 Добавляем поле is_admin...')
            c.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0')
            conn.commit()
        
        if 'theme' not in columns:
            print('🔧 Добавляем поле theme...')
            c.execute('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT "light"')
            conn.commit()
    
    # Проверяем и обновляем таблицу chats
    chats_exists = c.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chats'"
    ).fetchone()
    
    if chats_exists:
        chat_columns = [row[1] for row in c.execute('PRAGMA table_info(chats)').fetchall()]
        
        if 'is_channel' not in chat_columns:
            print('🔧 Добавляем поле is_channel в chats...')
            c.execute('ALTER TABLE chats ADD COLUMN is_channel INTEGER DEFAULT 0')
            conn.commit()
        
        if 'description' not in chat_columns:
            print('🔧 Добавляем поле description в chats...')
            c.execute('ALTER TABLE chats ADD COLUMN description TEXT')
            conn.commit()
        
        if 'creator_id' not in chat_columns:
            print('🔧 Добавляем поле creator_id в chats...')
            c.execute('ALTER TABLE chats ADD COLUMN creator_id INTEGER')
            conn.commit()
        
        if 'subscribers_count' not in chat_columns:
            print('🔧 Добавляем поле subscribers_count в chats...')
            c.execute('ALTER TABLE chats ADD COLUMN subscribers_count INTEGER DEFAULT 0')
            conn.commit()
    
    # Таблица пользователей
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nickname TEXT,
        bio TEXT,
        status TEXT DEFAULT 'Жужжу в BeeGramm 🐝',
        avatar TEXT DEFAULT 'default.png',
        is_premium INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        bee_stars INTEGER DEFAULT 100,
        theme TEXT DEFAULT 'light',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # Таблица чатов
    c.execute('''CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        is_channel INTEGER DEFAULT 0,
        description TEXT,
        avatar TEXT,
        creator_id INTEGER,
        subscribers_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id)
    )''')
    
    # Таблица участников чатов
    c.execute('''CREATE TABLE IF NOT EXISTS chat_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    
    # Таблица сообщений
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        content TEXT,
        message_type TEXT DEFAULT 'text',
        file_url TEXT,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    
    # Таблица реакций
    c.execute('''CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        user_id INTEGER,
        emoji TEXT,
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    
    # Таблица стикерпаков
    c.execute('''CREATE TABLE IF NOT EXISTS sticker_packs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        is_premium INTEGER DEFAULT 0
    )''')
    
    # Таблица стикеров
    c.execute('''CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id INTEGER,
        emoji TEXT,
        url TEXT,
        FOREIGN KEY (pack_id) REFERENCES sticker_packs(id)
    )''')
    
    # Таблица ключей активации Premium
    c.execute('''CREATE TABLE IF NOT EXISTS premium_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_code TEXT UNIQUE NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        FOREIGN KEY (used_by) REFERENCES users(id)
    )''')
    
    # Добавляем стандартные стикерпаки
    c.execute("SELECT COUNT(*) FROM sticker_packs")
    if c.fetchone()[0] == 0:
        # Пак 1: Базовые пчёлки
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Весёлые пчёлки 🐝', 0))
        pack1_id = c.lastrowid
        stickers1 = [
            ('🐝', '🐝'),
            ('🍯', '🍯'),
            ('🌻', '🌻'),
            ('🌼', '🌼'),
            ('🌺', '🌺'),
        ]
        for emoji, url in stickers1:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack1_id, emoji, url))
        
        # Пак 2: Мёд и соты
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Мёд и соты 🍯', 0))
        pack2_id = c.lastrowid
        stickers2 = [
            ('🍯', '🍯'),
            ('🥄', '🥄'),
            ('🧈', '🧈'),
            ('🎂', '🎂'),
            ('🧁', '🧁'),
        ]
        for emoji, url in stickers2:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack2_id, emoji, url))
        
        # Пак 3: Премиум пчёлки
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Золотые пчёлки ✨', 1))
        pack3_id = c.lastrowid
        stickers3 = [
            ('👑', '👑'),
            ('✨', '✨'),
            ('💎', '💎'),
            ('🏆', '🏆'),
            ('⭐', '⭐'),
        ]
        for emoji, url in stickers3:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack3_id, emoji, url))
        
        # Пак 4: Эмоции
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Эмоции 😊', 0))
        pack4_id = c.lastrowid
        stickers4 = [
            ('😊', '😊'), ('😂', '😂'), ('😍', '😍'), ('🥰', '🥰'),
            ('😎', '😎'), ('🤔', '🤔'), ('😱', '😱'), ('😭', '😭'),
            ('🤗', '🤗'), ('😴', '😴'), ('🤩', '🤩'), ('😇', '😇'),
        ]
        for emoji, url in stickers4:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack4_id, emoji, url))
        
        # Пак 5: Животные
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Животные 🐾', 0))
        pack5_id = c.lastrowid
        stickers5 = [
            ('🐶', '🐶'), ('🐱', '🐱'), ('🐭', '🐭'), ('🐹', '🐹'),
            ('🐰', '🐰'), ('🦊', '🦊'), ('🐻', '🐻'), ('🐼', '🐼'),
            ('🐨', '🐨'), ('🐯', '🐯'), ('🦁', '🦁'), ('🐮', '🐮'),
        ]
        for emoji, url in stickers5:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack5_id, emoji, url))
        
        # Пак 6: Еда
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('Еда 🍕', 0))
        pack6_id = c.lastrowid
        stickers6 = [
            ('🍕', '🍕'), ('🍔', '🍔'), ('🍟', '🍟'), ('🌭', '🌭'),
            ('🍿', '🍿'), ('🍩', '🍩'), ('🍪', '🍪'), ('🎂', '🎂'),
            ('🍰', '🍰'), ('🧁', '🧁'), ('🍫', '🍫'), ('🍬', '🍬'),
        ]
        for emoji, url in stickers6:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack6_id, emoji, url))
        
        # Пак 7: Премиум эмоции
        c.execute("INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)", 
                  ('VIP Эмоции 💫', 1))
        pack7_id = c.lastrowid
        stickers7 = [
            ('🔥', '🔥'), ('💯', '💯'), ('💪', '💪'), ('🙌', '🙌'),
            ('👏', '👏'), ('🎉', '🎉'), ('🎊', '🎊'), ('🎈', '🎈'),
            ('💝', '💝'), ('💖', '💖'), ('💗', '💗'), ('💓', '💓'),
        ]
        for emoji, url in stickers7:
            c.execute("INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)",
                      (pack7_id, emoji, url))
    
    # Создаём админ-пользователя, если его нет
    admin = c.execute("SELECT id, is_admin FROM users WHERE username = 'admin'").fetchone()
    if not admin:
        admin_password = hash_password('admin123')
        c.execute('''INSERT INTO users (username, password, nickname, is_admin, is_premium, bee_stars)
                     VALUES (?, ?, ?, ?, ?, ?)''',
                  ('admin', admin_password, '👑 Администратор', 1, 1, 999999))
        print('✅ Создан админ-пользователь: admin / admin123')
    elif admin and (len(admin) < 2 or not admin[1]):
        # Обновляем существующего админа
        print('🔧 Обновляем права админа...')
        c.execute('UPDATE users SET is_admin = 1, is_premium = 1, nickname = ? WHERE username = ?',
                  ('👑 Администратор', 'admin'))
        conn.commit()
    
    # Генерируем 10 ключей Premium, если их нет
    keys_count = c.execute("SELECT COUNT(*) FROM premium_keys").fetchone()[0]
    if keys_count == 0:
        import secrets
        print('\n🔑 Генерация Premium ключей...')
        for i in range(10):
            key = f"BEE-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
            c.execute('INSERT INTO premium_keys (key_code) VALUES (?)', (key,))
            print(f'   {i+1}. {key}')
        print('✅ Создано 10 Premium ключей\n')
    
    # Проверяем и создаём пользователя admin, если его нет
    admin = c.execute('SELECT * FROM users WHERE username = ?', ('admin',)).fetchone()
    if not admin:
        print('🔧 Создаём пользователя admin...')
        hashed_password = hash_password('admin123')
        c.execute('''
            INSERT INTO users (username, password, nickname, is_premium, is_admin, bee_stars)
            VALUES (?, ?, ?, 1, 1, 1000)
        ''', ('admin', hashed_password, '👑 Администратор'))
        print('✅ Пользователь admin создан с паролем admin123')
    
    conn.commit()
    conn.close()

# Инициализируем БД при запуске
init_db()

def get_db():
    """Получить соединение с БД"""
    conn = sqlite3.connect('beegram.db')
    conn.row_factory = sqlite3.Row
    return conn

def check_password(password, hashed):
    """Проверить пароль"""
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def get_user_by_id(user_id):
    """Получить пользователя по ID"""
    conn = get_db()
    user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    conn.close()
    return dict(user) if user else None

def get_user_by_username(username):
    """Получить пользователя по username"""
    conn = get_db()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    return dict(user) if user else None

# ============= МАРШРУТЫ =============

@app.route('/')
def index():
    """Главная страница"""
    return render_template('index.html')

@app.route('/admin')
def admin_panel():
    """Админ-панель"""
    if 'user_id' not in session:
        return redirect('/login?next=/admin')
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return "Доступ запрещён. Только для администраторов.", 403
        
    return render_template('admin.html')

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    """Отдача загруженных файлов"""
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/register', methods=['POST'])
def register():
    """Регистрация нового пользователя"""
    data = request.json
    username = data.get('username')
    password = data.get('password')
    nickname = data.get('nickname', username)
    
    if not username or not password:
        return jsonify({'success': False, 'error': 'Заполните все поля'}), 400
    
    # Проверяем, существует ли пользователь
    if get_user_by_username(username):
        return jsonify({'success': False, 'error': 'Пользователь уже существует'}), 400
    
    # Создаём пользователя
    hashed_pw = hash_password(password)
    conn = get_db()
    c = conn.cursor()
    c.execute('''INSERT INTO users (username, password, nickname) 
                 VALUES (?, ?, ?)''', (username, hashed_pw, nickname))
    user_id = c.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'user_id': user_id})

@app.route('/login', methods=['POST'])
def login():
    """Вход пользователя"""
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    user = get_user_by_username(username)
    
    if not user or not check_password(password, user['password']):
        return jsonify({'success': False, 'error': 'Неверный логин или пароль'}), 401
    
    session['user_id'] = user['id']
    
    return jsonify({
        'success': True,
        'user': {
            'id': user['id'],
            'username': user['username'],
            'nickname': user['nickname'],
            'bio': user['bio'],
            'status': user['status'],
            'avatar': user['avatar'],
            'is_premium': user['is_premium'],
            'is_admin': user['is_admin'],
            'bee_stars': user['bee_stars']
        }
    })

@app.route('/profile/update', methods=['POST'])
def update_profile():
    """Обновление профиля пользователя"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    data = request.json
    user_id = session['user_id']
    
    conn = get_db()
    c = conn.cursor()
    
    # Обновляем поля
    if 'nickname' in data:
        c.execute('UPDATE users SET nickname = ? WHERE id = ?', (data['nickname'], user_id))
    if 'bio' in data:
        c.execute('UPDATE users SET bio = ? WHERE id = ?', (data['bio'], user_id))
    if 'status' in data:
        c.execute('UPDATE users SET status = ? WHERE id = ?', (data['status'], user_id))
    if 'theme' in data:
        c.execute('UPDATE users SET theme = ? WHERE id = ?', (data['theme'], user_id))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/admin/users', methods=['GET'])
def admin_get_users():
    """Получить всех пользователей (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    users = conn.execute('''SELECT id, username, nickname, is_premium, is_admin, bee_stars, created_at
                            FROM users ORDER BY created_at DESC''').fetchall()
    conn.close()
    
    return jsonify({'users': [dict(u) for u in users]})

@app.route('/admin/user/<int:user_id>/update', methods=['POST'])
def admin_update_user(user_id):
    """Обновить пользователя (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    data = request.json
    conn = get_db()
    c = conn.cursor()
    
    if 'is_premium' in data:
        c.execute('UPDATE users SET is_premium = ? WHERE id = ?', (data['is_premium'], user_id))
    if 'bee_stars' in data:
        c.execute('UPDATE users SET bee_stars = ? WHERE id = ?', (data['bee_stars'], user_id))
    if 'is_admin' in data:
        c.execute('UPDATE users SET is_admin = ? WHERE id = ?', (data['is_admin'], user_id))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/admin/user/<int:user_id>/delete', methods=['DELETE'])
def admin_delete_user(user_id):
    """Удалить пользователя (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    if user_id == session['user_id']:
        return jsonify({'success': False, 'error': 'Нельзя удалить себя'}), 400
    
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM users WHERE id = ?', (user_id,))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/admin/keys', methods=['GET'])
def admin_get_keys():
    """Получить все ключи (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    keys = conn.execute('''SELECT k.*, u.username 
                           FROM premium_keys k
                           LEFT JOIN users u ON k.used_by = u.id
                           ORDER BY k.created_at DESC''').fetchall()
    conn.close()
    
    return jsonify({'keys': [dict(k) for k in keys]})

@app.route('/admin/keys/generate', methods=['POST'])
def admin_generate_keys():
    """Сгенерировать новые ключи (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    data = request.json
    count = data.get('count', 1)
    
    import secrets
    conn = get_db()
    c = conn.cursor()
    
    new_keys = []
    for _ in range(count):
        key = f"BEE-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
        c.execute('INSERT INTO premium_keys (key_code) VALUES (?)', (key,))
        new_keys.append(key)
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'keys': new_keys})

@app.route('/premium/activate', methods=['POST'])
def activate_premium():
    """Активировать Premium ключ"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    data = request.json
    key_code = data.get('key_code', '').strip().upper()
    
    if not key_code:
        return jsonify({'success': False, 'error': 'Введите ключ'}), 400
    
    conn = get_db()
    c = conn.cursor()
    
    # Проверяем ключ
    key = c.execute('SELECT * FROM premium_keys WHERE key_code = ?', (key_code,)).fetchone()
    
    if not key:
        conn.close()
        return jsonify({'success': False, 'error': 'Неверный ключ'}), 400
    
    if key['is_used']:
        conn.close()
        return jsonify({'success': False, 'error': 'Ключ уже использован'}), 400
    
    # Активируем Premium
    user_id = session['user_id']
    c.execute('UPDATE users SET is_premium = 1 WHERE id = ?', (user_id,))
    c.execute('''UPDATE premium_keys SET is_used = 1, used_by = ?, used_at = CURRENT_TIMESTAMP 
                 WHERE key_code = ?''', (user_id, key_code))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'message': 'BeeGramm Premium активирован! 🎉'})

@app.route('/profile/avatar', methods=['POST'])
def upload_avatar():
    """Загрузка аватара"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    if 'avatar' not in request.files:
        return jsonify({'success': False, 'error': 'Файл не найден'}), 400
    
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Файл не выбран'}), 400
    
    # Сохраняем файл
    filename = f"{uuid.uuid4()}_{secure_filename(file.filename)}"
    filepath = os.path.join('uploads/avatars', filename)
    file.save(filepath)
    
    # Обновляем в БД
    user_id = session['user_id']
    conn = get_db()
    c = conn.cursor()
    c.execute('UPDATE users SET avatar = ? WHERE id = ?', (f'avatars/{filename}', user_id))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'avatar': f'avatars/{filename}'})

@app.route('/users/search', methods=['GET'])
def search_users():
    """Поиск пользователей"""
    query = request.args.get('q', '')
    
    conn = get_db()
    users = conn.execute('''SELECT id, username, nickname, avatar, is_premium, bee_stars 
                            FROM users 
                            WHERE username LIKE ? OR nickname LIKE ?
                            LIMIT 20''', 
                         (f'%{query}%', f'%{query}%')).fetchall()
    conn.close()
    
    return jsonify({'users': [dict(u) for u in users]})

@app.route('/chats/create', methods=['POST'])
def create_chat():
    """Создание чата (личного, группового или канала)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    data = request.json
    user_id = session['user_id']
    is_group = data.get('is_group', False)
    is_channel = data.get('is_channel', False)
    members = data.get('members', [])
    
    conn = get_db()
    c = conn.cursor()
    
    if is_channel:
        # Канал
        name = data.get('name', 'Новый канал')
        description = data.get('description', '')
        c.execute('''INSERT INTO chats (name, is_channel, description, creator_id, subscribers_count) 
                     VALUES (?, ?, ?, ?, ?)''', (name, 1, description, user_id, 1))
        chat_id = c.lastrowid
        
        # Добавляем создателя как подписчика
        c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
                  (chat_id, user_id))
    elif is_group:
        # Групповой чат
        name = data.get('name', 'Новая группа')
        description = data.get('description', '')
        c.execute('''INSERT INTO chats (name, is_group, description, creator_id) 
                     VALUES (?, ?, ?, ?)''', (name, 1, description, user_id))
        chat_id = c.lastrowid
        
        # Добавляем создателя
        c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
                  (chat_id, user_id))
        
        # Добавляем участников
        for member_id in members:
            c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
                      (chat_id, member_id))
    else:
        # Личный чат
        other_user_id = members[0] if members else None
        if not other_user_id:
            return jsonify({'success': False, 'error': 'Укажите собеседника'}), 400
        
        # Проверяем, есть ли уже чат с этим пользователем
        existing = c.execute('''SELECT c.id FROM chats c
                                JOIN chat_members cm1 ON c.id = cm1.chat_id
                                JOIN chat_members cm2 ON c.id = cm2.chat_id
                                WHERE c.is_group = 0 
                                AND cm1.user_id = ? AND cm2.user_id = ?''',
                             (user_id, other_user_id)).fetchone()
        
        if existing:
            chat_id = existing[0]
        else:
            c.execute('INSERT INTO chats (is_group) VALUES (?)', (0,))
            chat_id = c.lastrowid
            c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
                      (chat_id, user_id))
            c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
                      (chat_id, other_user_id))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'chat_id': chat_id})

@app.route('/chats/list', methods=['GET'])
def list_chats():
    """Список чатов пользователя"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user_id = session['user_id']
    
    conn = get_db()
    chats = conn.execute('''SELECT DISTINCT c.id, c.name, c.is_group, c.avatar
                            FROM chats c
                            JOIN chat_members cm ON c.id = cm.chat_id
                            WHERE cm.user_id = ?
                            ORDER BY c.id DESC''', (user_id,)).fetchall()
    
    result = []
    for chat in chats:
        chat_dict = dict(chat)
        
        # Для личных чатов получаем имя собеседника
        if not chat['is_group']:
            other_user = conn.execute('''SELECT u.id, u.nickname, u.username, u.avatar, u.status, u.is_premium
                                         FROM users u
                                         JOIN chat_members cm ON u.id = cm.user_id
                                         WHERE cm.chat_id = ? AND u.id != ?''',
                                      (chat['id'], user_id)).fetchone()
            if other_user:
                chat_dict['name'] = other_user['nickname'] or other_user['username']
                chat_dict['avatar'] = other_user['avatar']
                chat_dict['other_user'] = dict(other_user)
        
        # Получаем последнее сообщение
        last_msg = conn.execute('''SELECT m.*, u.nickname, u.username
                                   FROM messages m
                                   JOIN users u ON m.user_id = u.id
                                   WHERE m.chat_id = ?
                                   ORDER BY m.created_at DESC
                                   LIMIT 1''', (chat['id'],)).fetchone()
        
        if last_msg:
            chat_dict['last_message'] = dict(last_msg)
        
        # Количество непрочитанных
        unread = conn.execute('''SELECT COUNT(*) FROM messages 
                                 WHERE chat_id = ? AND user_id != ? AND is_read = 0''',
                              (chat['id'], user_id)).fetchone()[0]
        chat_dict['unread_count'] = unread
        
        result.append(chat_dict)
    
    conn.close()
    
    return jsonify({'chats': result})

@app.route('/chats/<int:chat_id>/messages', methods=['GET'])
def get_messages(chat_id):
    """Получить сообщения чата"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    conn = get_db()
    messages = conn.execute('''SELECT m.*, u.nickname, u.username, u.avatar, u.is_premium
                               FROM messages m
                               JOIN users u ON m.user_id = u.id
                               WHERE m.chat_id = ?
                               ORDER BY m.created_at ASC''', (chat_id,)).fetchall()
    
    result = []
    for msg in messages:
        msg_dict = dict(msg)
        
        # Получаем реакции
        reactions = conn.execute('''SELECT r.emoji, u.username
                                    FROM reactions r
                                    JOIN users u ON r.user_id = u.id
                                    WHERE r.message_id = ?''', (msg['id'],)).fetchall()
        msg_dict['reactions'] = [dict(r) for r in reactions]
        
        result.append(msg_dict)
    
    # Помечаем сообщения как прочитанные
    user_id = session['user_id']
    conn.execute('''UPDATE messages SET is_read = 1 
                    WHERE chat_id = ? AND user_id != ?''', (chat_id, user_id))
    conn.commit()
    conn.close()
    
    return jsonify({'messages': result})

@app.route('/stickers', methods=['GET'])
def get_stickers():
    """Получить все стикерпаки"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user_id = session['user_id']
    user = get_user_by_id(user_id)
    
    conn = get_db()
    packs = conn.execute('SELECT * FROM sticker_packs').fetchall()
    
    result = []
    for pack in packs:
        # Проверяем доступ к премиум-пакам
        if pack['is_premium'] and not user['is_premium']:
            continue
        
        pack_dict = dict(pack)
        stickers = conn.execute('SELECT * FROM stickers WHERE pack_id = ?', 
                                (pack['id'],)).fetchall()
        pack_dict['stickers'] = [dict(s) for s in stickers]
        result.append(pack_dict)
    
    conn.close()
    
    return jsonify({'packs': result})

@app.route('/upload/file', methods=['POST'])
def upload_file():
    """Загрузка файла в чат"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Файл не найден'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Файл не выбран'}), 400
    
    user_id = session['user_id']
    user = get_user_by_id(user_id)
    
    # Проверяем размер файла
    file.seek(0, 2)  # Переходим в конец файла
    file_size = file.tell()
    file.seek(0)  # Возвращаемся в начало
    
    max_size = 100 * 1024 * 1024 if user['is_premium'] else 10 * 1024 * 1024
    
    if file_size > max_size:
        return jsonify({'success': False, 'error': 'Файл слишком большой'}), 400
    
    # Сохраняем файл
    filename = f"{uuid.uuid4()}_{secure_filename(file.filename)}"
    filepath = os.path.join('uploads/files', filename)
    file.save(filepath)
    
    return jsonify({'success': True, 'file_url': f'files/{filename}', 'filename': file.filename})

# ============= SOCKET.IO СОБЫТИЯ =============

@socketio.on('connect')
def handle_connect():
    """Подключение клиента"""
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    """Отключение клиента"""
    print('Client disconnected')

@socketio.on('join_chat')
def handle_join_chat(data):
    """Присоединение к чату"""
    chat_id = data.get('chat_id')
    join_room(f'chat_{chat_id}')
    emit('joined_chat', {'chat_id': chat_id})

@socketio.on('leave_chat')
def handle_leave_chat(data):
    """Выход из чата"""
    chat_id = data.get('chat_id')
    leave_room(f'chat_{chat_id}')

@socketio.on('send_message')
def handle_send_message(data):
    """Отправка сообщения"""
    chat_id = data.get('chat_id')
    user_id = data.get('user_id')
    content = data.get('content')
    message_type = data.get('message_type', 'text')
    file_url = data.get('file_url')
    
    # Проверяем команды
    if content and content.startswith('/gift'):
        # Команда отправки пчёлок
        parts = content.split()
        if len(parts) >= 3:
            target_username = parts[1].replace('@', '')
            try:
                amount = int(parts[2])
                
                conn = get_db()
                c = conn.cursor()
                
                # Получаем отправителя
                sender = c.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
                
                # Получаем получателя
                receiver = c.execute('SELECT * FROM users WHERE username = ?', 
                                     (target_username,)).fetchone()
                
                if receiver and sender['bee_stars'] >= amount and amount > 0:
                    # Переводим пчёлок
                    c.execute('UPDATE users SET bee_stars = bee_stars - ? WHERE id = ?',
                              (amount, user_id))
                    c.execute('UPDATE users SET bee_stars = bee_stars + ? WHERE id = ?',
                              (amount, receiver['id']))
                    conn.commit()
                    
                    # Отправляем системное сообщение
                    c.execute('''INSERT INTO messages (chat_id, user_id, content, message_type)
                                 VALUES (?, ?, ?, ?)''',
                              (chat_id, user_id, 
                               f"🐝 Отправил(а) {amount} пчёлок пользователю @{target_username}!",
                               'system'))
                    msg_id = c.lastrowid
                    conn.commit()
                    
                    # Отправляем обновление
                    msg = c.execute('''SELECT m.*, u.nickname, u.username, u.avatar, u.is_premium
                                       FROM messages m
                                       JOIN users u ON m.user_id = u.id
                                       WHERE m.id = ?''', (msg_id,)).fetchone()
                    
                    emit('new_message', dict(msg), room=f'chat_{chat_id}')
                    emit('bee_stars_updated', {
                        'user_id': user_id,
                        'bee_stars': sender['bee_stars'] - amount
                    }, room=f'chat_{chat_id}')
                    
                conn.close()
                return
            except:
                pass
    
    # Сохраняем сообщение
    conn = get_db()
    c = conn.cursor()
    c.execute('''INSERT INTO messages (chat_id, user_id, content, message_type, file_url)
                 VALUES (?, ?, ?, ?, ?)''',
              (chat_id, user_id, content, message_type, file_url))
    msg_id = c.lastrowid
    conn.commit()
    
    # Получаем полное сообщение
    msg = c.execute('''SELECT m.*, u.nickname, u.username, u.avatar, u.is_premium
                       FROM messages m
                       JOIN users u ON m.user_id = u.id
                       WHERE m.id = ?''', (msg_id,)).fetchone()
    conn.close()
    
    # Отправляем всем в чате
    emit('new_message', dict(msg), room=f'chat_{chat_id}')

@socketio.on('add_reaction')
def handle_add_reaction(data):
    """Добавление реакции"""
    message_id = data.get('message_id')
    user_id = data.get('user_id')
    emoji = data.get('emoji')
    chat_id = data.get('chat_id')
    
    conn = get_db()
    c = conn.cursor()
    
    # Проверяем, есть ли уже такая реакция
    existing = c.execute('''SELECT id FROM reactions 
                            WHERE message_id = ? AND user_id = ? AND emoji = ?''',
                         (message_id, user_id, emoji)).fetchone()
    
    if existing:
        # Удаляем реакцию
        c.execute('DELETE FROM reactions WHERE id = ?', (existing[0],))
    else:
        # Добавляем реакцию
        c.execute('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
                  (message_id, user_id, emoji))
    
    conn.commit()
    
    # Получаем все реакции на сообщение
    reactions = c.execute('''SELECT r.emoji, u.username
                             FROM reactions r
                             JOIN users u ON r.user_id = u.id
                             WHERE r.message_id = ?''', (message_id,)).fetchall()
    conn.close()
    
    # Отправляем обновление
    emit('reactions_updated', {
        'message_id': message_id,
        'reactions': [dict(r) for r in reactions]
    }, room=f'chat_{chat_id}')


@socketio.on('typing')
def handle_typing(data):
    """Пользователь печатает"""
    chat_id = data.get('chat_id')
    user_id = data.get('user_id')
    is_typing = data.get('is_typing')
    
    user = get_user_by_id(user_id)
    
    emit('user_typing', {
        'user_id': user_id,
        'username': user['nickname'] or user['username'],
        'is_typing': is_typing
    }, room=f'chat_{chat_id}', include_self=False)

@app.route('/channels/search', methods=['GET'])
def search_channels():
    """Поиск публичных каналов"""
    query = request.args.get('q', '')
    
    conn = get_db()
    channels = conn.execute('''SELECT c.id, c.name, c.description, c.subscribers_count, c.avatar,
                                      u.nickname as creator_name
                               FROM chats c
                               LEFT JOIN users u ON c.creator_id = u.id
                               WHERE c.is_channel = 1 
                               AND (c.name LIKE ? OR c.description LIKE ?)
                               ORDER BY c.subscribers_count DESC
                               LIMIT 20''', 
                            (f'%{query}%', f'%{query}%')).fetchall()
    conn.close()
    
    return jsonify({'channels': [dict(ch) for ch in channels]})

@app.route('/channels/<int:channel_id>/subscribe', methods=['POST'])
def subscribe_channel(channel_id):
    """Подписаться на канал"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user_id = session['user_id']
    
    conn = get_db()
    c = conn.cursor()
    
    # Проверяем, не подписан ли уже
    existing = c.execute('SELECT id FROM chat_members WHERE chat_id = ? AND user_id = ?',
                         (channel_id, user_id)).fetchone()
    
    if existing:
        return jsonify({'success': False, 'error': 'Уже подписаны'}), 400
    
    # Добавляем подписку
    c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', 
              (channel_id, user_id))
    
    # Обновляем счётчик подписчиков
    c.execute('UPDATE chats SET subscribers_count = subscribers_count + 1 WHERE id = ?',
              (channel_id,))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/channels/<int:channel_id>/unsubscribe', methods=['POST'])
def unsubscribe_channel(channel_id):
    """Отписаться от канала"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user_id = session['user_id']
    
    conn = get_db()
    c = conn.cursor()
    
    # Удаляем подписку
    c.execute('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?',
              (channel_id, user_id))
    
    # Обновляем счётчик подписчиков
    c.execute('UPDATE chats SET subscribers_count = subscribers_count - 1 WHERE id = ?',
              (channel_id,))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/admin/channels', methods=['GET'])
def admin_get_channels():
    """Получить все каналы (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    channels = conn.execute('''SELECT c.*, u.username as creator_username
                               FROM chats c
                               LEFT JOIN users u ON c.creator_id = u.id
                               WHERE c.is_channel = 1
                               ORDER BY c.created_at DESC''').fetchall()
    conn.close()
    
    return jsonify({'channels': [dict(ch) for ch in channels]})

@app.route('/admin/groups', methods=['GET'])
def admin_get_groups():
    """Получить все группы (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    groups = conn.execute('''SELECT c.*, u.username as creator_username,
                                    COUNT(cm.id) as members_count
                             FROM chats c
                             LEFT JOIN users u ON c.creator_id = u.id
                             LEFT JOIN chat_members cm ON c.id = cm.chat_id
                             WHERE c.is_group = 1 AND c.is_channel = 0
                             GROUP BY c.id
                             ORDER BY c.created_at DESC''').fetchall()
    conn.close()
    
    return jsonify({'groups': [dict(g) for g in groups]})

# ============= ЗАПУСК СЕРВЕРА =============

if __name__ == '__main__':
    print('🐝 BeeGramm запущен на http://localhost:5000')
    print('🍯 Жужжим и работаем!')
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
