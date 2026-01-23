# -*- coding: utf-8 -*-
"""
BeeGramm - Мессенджер с пчелиной тематикой 🐝
Backend: Flask + Flask-SocketIO + SQLite
"""

from flask import Flask, render_template, request, jsonify, send_from_directory, session, redirect
from flask_socketio import SocketIO, emit, join_room, leave_room
import sqlite3
import os
import uuid
import re
import time
import bcrypt
from datetime import datetime
from werkzeug.utils import secure_filename
import json
from collections import defaultdict, deque
import secrets

app = Flask(__name__)
app.config['SECRET_KEY'] = 'beegram_secret_honey_key_2024'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB для премиум

socketio = SocketIO(app, cors_allowed_origins="*")

# ============= ПРОСТАЯ ЗАЩИТА ОТ ABUSE / DoS (in-memory) =============

_rate_http = defaultdict(deque)  # (ip, bucket) -> deque[timestamps]
_rate_socket = defaultdict(deque)  # (ip, event) -> deque[timestamps]

def _get_client_ip():
    xf = request.headers.get('X-Forwarded-For')
    if xf:
        return xf.split(',')[0].strip()
    return request.remote_addr or 'unknown'

def _rate_check(store, key, limit, per_seconds):
    now = time.time()
    q = store[key]
    cutoff = now - per_seconds
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True

def _is_ip_blocked(ip):
    conn = get_db()
    row = conn.execute('SELECT id FROM ip_blocklist WHERE ip = ? LIMIT 1', (ip,)).fetchone()
    conn.close()
    return bool(row)

def _log_suspicious_ip(ip, kind, endpoint, meta=None):
    try:
        conn = get_db()
        conn.execute(
            'INSERT INTO ip_events (ip, kind, endpoint, meta) VALUES (?, ?, ?, ?)',
            (ip, str(kind), str(endpoint)[:200] if endpoint else None, json.dumps(meta, ensure_ascii=False) if meta else None)
        )
        conn.commit()
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass

# Создаём папку для загрузок
os.makedirs('uploads/avatars', exist_ok=True)
os.makedirs('uploads/files', exist_ok=True)
os.makedirs('uploads/stickers', exist_ok=True)
os.makedirs('uploads/voices', exist_ok=True)

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

        if 'is_moderator' not in columns:
            print('🔧 Добавляем поле is_moderator...')
            c.execute('ALTER TABLE users ADD COLUMN is_moderator INTEGER DEFAULT 0')
            conn.commit()
        
        if 'theme' not in columns:
            print('🔧 Добавляем поле theme...')
            c.execute('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT "light"')
            conn.commit()

        if 'spam_blocked' not in columns:
            print('🔧 Добавляем поле spam_blocked...')
            c.execute('ALTER TABLE users ADD COLUMN spam_blocked INTEGER DEFAULT 0')
            conn.commit()

        if 'banned_until' not in columns:
            print('🔧 Добавляем поле banned_until...')
            c.execute('ALTER TABLE users ADD COLUMN banned_until INTEGER DEFAULT 0')
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

        if 'is_support' not in chat_columns:
            print('🔧 Добавляем поле is_support в chats...')
            c.execute('ALTER TABLE chats ADD COLUMN is_support INTEGER DEFAULT 0')
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
        early_access INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        is_moderator INTEGER DEFAULT 0,
        spam_blocked INTEGER DEFAULT 0,
        banned_until INTEGER DEFAULT 0,
        bee_stars INTEGER DEFAULT 100,
        theme TEXT DEFAULT 'light',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # Миграция: early_access
    user_columns = [row[1] for row in c.execute('PRAGMA table_info(users)').fetchall()]
    if 'early_access' not in user_columns:
        print('🔧 Добавляем поле early_access...')
        c.execute('ALTER TABLE users ADD COLUMN early_access INTEGER DEFAULT 0')
        conn.commit()
    
    # Таблица чатов
    c.execute('''CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        is_channel INTEGER DEFAULT 0,
        is_support INTEGER DEFAULT 0,
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
        is_deleted INTEGER DEFAULT 0,
        deleted_at TIMESTAMP,
        deleted_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')

    # Миграция: мягкое удаление сообщений
    msg_columns = [row[1] for row in c.execute('PRAGMA table_info(messages)').fetchall()]
    if 'is_deleted' not in msg_columns:
        print('🔧 Добавляем поле is_deleted в messages...')
        c.execute('ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0')
        conn.commit()
    if 'deleted_at' not in msg_columns:
        print('🔧 Добавляем поле deleted_at в messages...')
        c.execute('ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP')
        conn.commit()
    if 'deleted_by' not in msg_columns:
        print('🔧 Добавляем поле deleted_by в messages...')
        c.execute('ALTER TABLE messages ADD COLUMN deleted_by INTEGER')
        conn.commit()
    
    # Таблица реакций
    c.execute('''CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        user_id INTEGER,
        emoji TEXT,
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')

    # Жалобы на сообщения (очередь модерации)
    c.execute('''CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        reporter_id INTEGER NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'open',
        resolved_by INTEGER,
        resolved_action TEXT,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (chat_id) REFERENCES chats(id),
        FOREIGN KEY (reporter_id) REFERENCES users(id)
    )''')

    # Лог действий админа/модератора
    c.execute('''CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        ip TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (actor_id) REFERENCES users(id)
    )''')

    # IP blocklist + события безопасности
    c.execute('''CREATE TABLE IF NOT EXISTS ip_blocklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT UNIQUE NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS ip_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        kind TEXT NOT NULL,
        endpoint TEXT,
        meta TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        is_image INTEGER DEFAULT 0,
        FOREIGN KEY (pack_id) REFERENCES sticker_packs(id)
    )''')

    sticker_columns = [row[1] for row in c.execute('PRAGMA table_info(stickers)').fetchall()]
    if 'is_image' not in sticker_columns:
        print('🔧 Добавляем поле is_image в stickers...')
        c.execute('ALTER TABLE stickers ADD COLUMN is_image INTEGER DEFAULT 0')
        conn.commit()
    
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

    # Таблица ключей Early Access
    c.execute('''CREATE TABLE IF NOT EXISTS early_access_keys (
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
        admin_password = hash_password('posnos123!')
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
        print('\n🔑 Генерация Premium ключей...')
        for i in range(10):
            key = f"BEE-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
            c.execute('INSERT INTO premium_keys (key_code) VALUES (?)', (key,))
            print(f'   {i+1}. {key}')
        print('✅ Создано 10 Premium ключей\n')

    # Генерируем 10 ключей Early Access, если их нет
    ea_count = c.execute("SELECT COUNT(*) FROM early_access_keys").fetchone()[0]
    if ea_count == 0:
        print('\n🗝️ Генерация Early Access ключей...')
        for i in range(10):
            key = f"EA-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
            c.execute('INSERT INTO early_access_keys (key_code) VALUES (?)', (key,))
            print(f'   {i+1}. {key}')
        print('✅ Создано 10 Early Access ключей\n')
    
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

    # Создаём пользователя поддержки
    support = c.execute('SELECT id FROM users WHERE username = ?', ('support',)).fetchone()
    if not support:
        support_password = hash_password('support123')
        c.execute('''INSERT INTO users (username, password, nickname, is_moderator, is_premium, bee_stars)
                     VALUES (?, ?, ?, ?, ?, ?)''',
                  ('support', support_password, '🛟 Поддержка', 1, 1, 999999))
        print('✅ Создан пользователь поддержки: support / support123')

    # Канал BeeGramm
    admin_user = c.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
    admin_id = admin_user[0] if admin_user else 1
    beegramm = c.execute('SELECT id FROM chats WHERE is_channel = 1 AND name = ?', ('BeeGramm',)).fetchone()
    if not beegramm:
        c.execute('''INSERT INTO chats (name, is_channel, description, creator_id, subscribers_count)
                     VALUES (?, ?, ?, ?, ?)''',
                  ('BeeGramm', 1, 'Официальный канал BeeGramm 🐝', admin_id, 0))
        beegramm_id = c.lastrowid
        c.execute('''INSERT INTO messages (chat_id, user_id, content, message_type)
                     VALUES (?, ?, ?, ?)''',
                  (beegramm_id, admin_id, 'Добро пожаловать в BeeGramm! 🐝\n\nЗдесь будут новости и обновления.', 'system'))
        print('✅ Создан канал BeeGramm')
    else:
        beegramm_id = beegramm[0]

    # Чат поддержки (служебный канал для списка/поиска)
    support_chat = c.execute('SELECT id FROM chats WHERE is_support = 1').fetchone()
    if not support_chat:
        c.execute('''INSERT INTO chats (name, is_support, description, creator_id)
                     VALUES (?, ?, ?, ?)''',
                  ('@support', 1, 'Чат поддержки BeeGramm', admin_id))
        print('✅ Создан служебный чат поддержки')
    
    conn.commit()
    conn.close()

# Инициализируем БД при запуске
init_db()


@app.before_request
def _http_rate_limit_and_block():
    # Не ограничиваем статику и uploads
    p = request.path or ''
    if p.startswith('/static/') or p.startswith('/uploads/'):
        return None

    ip = _get_client_ip()
    if _is_ip_blocked(ip):
        return jsonify({'success': False, 'error': 'IP заблокирован'}), 403

    # Глобальный лимит на HTTP
    if not _rate_check(_rate_http, (ip, 'http'), limit=120, per_seconds=60):
        _log_suspicious_ip(ip, 'http_rate', p, {'method': request.method})
        return jsonify({'success': False, 'error': 'Слишком много запросов'}), 429

    # Чуть строже на логин/регистрацию
    if p in ('/login', '/register'):
        if not _rate_check(_rate_http, (ip, p), limit=15, per_seconds=60):
            _log_suspicious_ip(ip, 'auth_rate', p, {'method': request.method})
            return jsonify({'success': False, 'error': 'Слишком много попыток. Подождите минуту.'}), 429

    return None


@app.before_request
def _early_access_guard():
    p = request.path or ''
    if not p:
        return None

    # разрешённые пути без EA
    if p.startswith('/static/') or p.startswith('/uploads/'):
        return None

    if p in ('/', '/login', '/register', '/logout', '/early_access/activate', '/premium/activate'):
        return None

    if 'user_id' not in session:
        return None

    user = get_user_by_id(session['user_id'])
    if _has_early_access_user(user):
        return None

    # блокируем основной функционал
    if (
        p.startswith('/chats') or
        p.startswith('/channels') or
        p.startswith('/support') or
        p.startswith('/profile') or
        p.startswith('/reports')
    ):
        return _early_access_blocked_json()

    return None

def get_db():
    """Получить соединение с БД"""
    conn = sqlite3.connect('beegram.db')
    conn.row_factory = sqlite3.Row
    return conn


def log_action(actor_id, action, details=None):
    """Запись действия в audit_log (best-effort, не ломает основной поток)"""
    try:
        conn = get_db()
        conn.execute(
            'INSERT INTO audit_log (actor_id, action, details, ip) VALUES (?, ?, ?, ?)',
            (actor_id, str(action), json.dumps(details, ensure_ascii=False) if details is not None else None,
             request.headers.get('X-Forwarded-For', request.remote_addr) if request else None)
        )
        conn.commit()
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass


def _require_admin():
    if 'user_id' not in session:
        return None, (jsonify({'success': False, 'error': 'Не авторизован'}), 401)
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin.get('is_admin'):
        return None, (jsonify({'success': False, 'error': 'Доступ запрещён'}), 403)
    return admin, None


def _has_early_access_user(user):
    if not user:
        return False
    if user.get('is_admin') or user.get('is_moderator'):
        return True
    return bool(user.get('early_access'))


def _early_access_blocked_json():
    return jsonify({'success': False, 'error': 'Нужен Early Access ключ'}), 403

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


@app.route('/logout', methods=['POST'])
def logout():
    """Выход из аккаунта"""
    session.pop('user_id', None)
    return jsonify({'success': True})


@app.route('/reports/create', methods=['POST'])
def create_report():
    """Создать жалобу на сообщение (любой авторизованный пользователь)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    data = request.get_json(silent=True) or {}
    message_id = data.get('message_id')
    chat_id = data.get('chat_id')
    reason = (data.get('reason') or '').strip()[:500]
    reporter_id = session['user_id']

    ip = _get_client_ip()
    if not _rate_check(_rate_http, (ip, 'report_create'), limit=20, per_seconds=60):
        _log_suspicious_ip(ip, 'report_rate', '/reports/create')
        return jsonify({'success': False, 'error': 'Слишком часто. Подождите.'}), 429

    if not message_id or not chat_id:
        return jsonify({'success': False, 'error': 'Некорректные данные'}), 400

    conn = get_db()
    try:
        # Проверяем, что сообщение существует и принадлежит чату
        msg = conn.execute('SELECT id, user_id, is_deleted FROM messages WHERE id = ? AND chat_id = ?', (message_id, chat_id)).fetchone()
        if not msg:
            return jsonify({'success': False, 'error': 'Сообщение не найдено'}), 404
        if msg['is_deleted']:
            return jsonify({'success': False, 'error': 'Сообщение уже удалено'}), 400

        # Не даём спамить жалобами на одно и то же сообщение от одного пользователя
        exists = conn.execute(
            "SELECT id FROM reports WHERE message_id = ? AND reporter_id = ? AND status = 'open' LIMIT 1",
            (message_id, reporter_id)
        ).fetchone()
        if exists:
            return jsonify({'success': True, 'report_id': exists['id']})

        c = conn.cursor()
        c.execute('''INSERT INTO reports (message_id, chat_id, reporter_id, reason)
                     VALUES (?, ?, ?, ?)''', (message_id, chat_id, reporter_id, reason))
        report_id = c.lastrowid
        conn.commit()
    finally:
        conn.close()

    log_action(reporter_id, 'report_create', {
        'report_id': report_id,
        'message_id': message_id,
        'chat_id': chat_id
    })

    return jsonify({'success': True, 'report_id': report_id})


def _actor_is_mod_or_admin(actor):
    return actor and (actor.get('is_admin') or actor.get('is_moderator'))


@app.route('/moderator/reports', methods=['GET'])
def moderator_get_reports():
    """Очередь жалоб (модер/админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    actor = get_user_by_id(session['user_id'])
    if not _actor_is_mod_or_admin(actor):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    status = (request.args.get('status') or 'open').strip()
    if status not in ('open', 'resolved'):
        status = 'open'

    conn = get_db()
    rows = conn.execute('''
        SELECT r.id, r.message_id, r.chat_id, r.reason, r.status, r.created_at,
               m.content AS message_content, m.message_type, m.is_deleted,
               u.username AS reporter_username,
               su.username AS sender_username
        FROM reports r
        JOIN messages m ON m.id = r.message_id
        JOIN users u ON u.id = r.reporter_id
        JOIN users su ON su.id = m.user_id
        WHERE r.status = ?
        ORDER BY r.created_at DESC
        LIMIT 200
    ''', (status,)).fetchall()
    conn.close()

    return jsonify({'success': True, 'reports': [dict(x) for x in rows]})


@app.route('/moderator/report/<int:report_id>/resolve', methods=['POST'])
def moderator_resolve_report(report_id):
    """Закрыть жалобу (действие опционально) (модер/админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    actor = get_user_by_id(session['user_id'])
    if not _actor_is_mod_or_admin(actor):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True) or {}
    action = (data.get('action') or 'resolve').strip()
    ban_minutes = int(data.get('ban_minutes') or 0)
    spam_block = bool(data.get('spam_block'))

    conn = get_db()
    c = conn.cursor()
    rpt = c.execute('SELECT id, message_id, chat_id, status FROM reports WHERE id = ?', (report_id,)).fetchone()
    if not rpt:
        conn.close()
        return jsonify({'success': False, 'error': 'Жалоба не найдена'}), 404
    if rpt['status'] != 'open':
        conn.close()
        return jsonify({'success': True})

    msg = c.execute('SELECT id, user_id, is_deleted FROM messages WHERE id = ?', (rpt['message_id'],)).fetchone()
    if not msg:
        conn.close()
        return jsonify({'success': False, 'error': 'Сообщение не найдено'}), 404

    target_user_id = msg['user_id']

    # Действия
    if action == 'delete_message' and not msg['is_deleted']:
        c.execute('''UPDATE messages
                     SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
                     WHERE id = ?''', (actor['id'], msg['id']))
        socketio.emit('message_deleted', {
            'message_id': msg['id'],
            'chat_id': rpt['chat_id']
        }, room=f"chat_{rpt['chat_id']}")

    if spam_block:
        # Нельзя спам-блокать админа
        target = c.execute('SELECT id, is_admin FROM users WHERE id = ?', (target_user_id,)).fetchone()
        if target and not target['is_admin']:
            c.execute('UPDATE users SET spam_blocked = 1 WHERE id = ?', (target_user_id,))

    if ban_minutes > 0:
        target = c.execute('SELECT id, is_admin FROM users WHERE id = ?', (target_user_id,)).fetchone()
        if target and not target['is_admin']:
            until = int(time.time()) + (ban_minutes * 60)
            c.execute('UPDATE users SET banned_until = ? WHERE id = ?', (until, target_user_id))

    c.execute('''UPDATE reports
                 SET status = 'resolved', resolved_by = ?, resolved_action = ?, resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?''', (actor['id'], action, report_id))
    conn.commit()
    conn.close()

    log_action(actor.get('id'), 'report_resolve', {
        'report_id': report_id,
        'action': action,
        'spam_block': spam_block,
        'ban_minutes': ban_minutes
    })

    return jsonify({'success': True})


@app.route('/admin/audit', methods=['GET'])
def admin_get_audit():
    """Лог действий (только админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    conn = get_db()
    rows = conn.execute('''
        SELECT a.id, a.actor_id, a.action, a.details, a.ip, a.created_at,
               u.username AS actor_username
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC
        LIMIT 300
    ''').fetchall()
    conn.close()

    result = []
    for r in rows:
        item = dict(r)
        try:
            item['details'] = json.loads(item['details']) if item.get('details') else None
        except Exception:
            pass
        result.append(item)

    return jsonify({'success': True, 'items': result})


@app.route('/admin/security/ips', methods=['GET'])
def admin_security_ips():
    admin, err = _require_admin()
    if err:
        return err

    conn = get_db()
    blocked = conn.execute('SELECT ip, reason, created_at FROM ip_blocklist ORDER BY created_at DESC LIMIT 500').fetchall()
    recent = conn.execute('''
        SELECT ip, kind, endpoint, created_at
        FROM ip_events
        ORDER BY created_at DESC
        LIMIT 300
    ''').fetchall()
    conn.close()

    return jsonify({
        'success': True,
        'blocked': [dict(x) for x in blocked],
        'events': [dict(x) for x in recent]
    })


@app.route('/admin/security/ip/block', methods=['POST'])
def admin_security_ip_block():
    admin, err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    ip = (data.get('ip') or '').strip()[:64]
    reason = (data.get('reason') or '').strip()[:200]
    if not ip:
        return jsonify({'success': False, 'error': 'IP обязателен'}), 400

    conn = get_db()
    try:
        conn.execute('INSERT OR IGNORE INTO ip_blocklist (ip, reason) VALUES (?, ?)', (ip, reason))
        conn.commit()
    finally:
        conn.close()

    log_action(admin.get('id'), 'ip_block', {'ip': ip, 'reason': reason})
    return jsonify({'success': True})


@app.route('/admin/security/ip/unblock', methods=['POST'])
def admin_security_ip_unblock():
    admin, err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    ip = (data.get('ip') or '').strip()[:64]
    if not ip:
        return jsonify({'success': False, 'error': 'IP обязателен'}), 400

    conn = get_db()
    try:
        conn.execute('DELETE FROM ip_blocklist WHERE ip = ?', (ip,))
        conn.commit()
    finally:
        conn.close()

    log_action(admin.get('id'), 'ip_unblock', {'ip': ip})
    return jsonify({'success': True})


@app.route('/moderator')
def moderator_panel():
    """Панель модератора (ограниченные действия)"""
    if 'user_id' not in session:
        return redirect('/login?next=/moderator')

    user = get_user_by_id(session['user_id'])
    if not user or (not user.get('is_moderator') and not user.get('is_admin')):
        return "Доступ запрещён. Только для модераторов.", 403

    # Админ тоже может зайти, если нужно
    return render_template('moderator.html')


@app.route('/moderator/support/chats', methods=['GET'])
def moderator_support_chats():
    """Список диалогов поддержки (модер/админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin') and not actor.get('is_moderator')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    return _support_chats_impl()


@app.route('/moderator/support/send', methods=['POST'])
def moderator_support_send():
    """Ответить в поддержку от имени @support (модер/админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin') and not actor.get('is_moderator')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True) or {}
    chat_id = data.get('chat_id')
    content = (data.get('content') or '').strip()
    return _support_send_impl(chat_id, content)


@app.route('/moderator/users/search', methods=['GET'])
def moderator_search_users():
    """Модератор: поиск пользователей (для спам-блока)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin') and not actor.get('is_moderator')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    query = (request.args.get('q', '') or '').strip()
    if len(query) < 2:
        return jsonify({'success': True, 'users': []})

    conn = get_db()
    users = conn.execute('''SELECT id, username, nickname, spam_blocked
                            FROM users
                            WHERE username LIKE ? OR nickname LIKE ?
                            ORDER BY created_at DESC
                            LIMIT 30''',
                         (f'%{query}%', f'%{query}%')).fetchall()
    conn.close()
    return jsonify({'success': True, 'users': [dict(u) for u in users]})


@app.route('/moderator/user/<int:user_id>/spam_block', methods=['POST'])
def moderator_set_spam_block(user_id):
    """Модератор: поставить/снять спам-блок пользователю"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin') and not actor.get('is_moderator')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True) or {}
    value = 1 if data.get('spam_blocked') else 0

    # Нельзя спам-блокать админа
    conn = get_db()
    try:
        target = conn.execute('SELECT id, is_admin FROM users WHERE id = ?', (user_id,)).fetchone()
        if not target:
            return jsonify({'success': False, 'error': 'Пользователь не найден'}), 404
        if target['is_admin']:
            return jsonify({'success': False, 'error': 'Нельзя применять к администратору'}), 400

        conn.execute('UPDATE users SET spam_blocked = ? WHERE id = ?', (value, user_id))
        conn.commit()
    finally:
        conn.close()

    log_action(actor.get('id'), 'spam_block_set', {
        'target_user_id': user_id,
        'spam_blocked': bool(value)
    })

    return jsonify({'success': True})

@app.route('/register', methods=['POST'])
def register():
    """Регистрация нового пользователя"""
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    password = data.get('password')
    nickname = data.get('nickname', username)
    
    if not username or not password:
        return jsonify({'success': False, 'error': 'Заполните все поля'}), 400

    username = str(username).strip()
    # Username: только английские буквы и цифры (без пробелов и символов)
    if not re.fullmatch(r'[A-Za-z0-9]+', username):
        return jsonify({
            'success': False,
            'error': 'Username может содержать только английские буквы и цифры (без пробелов и символов)'
        }), 400
    
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

    # Автоподписка на канал BeeGramm
    beegramm = c.execute('SELECT id FROM chats WHERE is_channel = 1 AND name = ?', ('BeeGramm',)).fetchone()
    if beegramm:
        beegramm_id = beegramm[0]
        exists = c.execute('SELECT id FROM chat_members WHERE chat_id = ? AND user_id = ?',
                           (beegramm_id, user_id)).fetchone()
        if not exists:
            c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', (beegramm_id, user_id))
            c.execute('UPDATE chats SET subscribers_count = subscribers_count + 1 WHERE id = ?', (beegramm_id,))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'user_id': user_id})

@app.route('/login', methods=['POST'])
def login():
    """Вход пользователя"""
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    password = data.get('password')
    
    user = get_user_by_username(username)
    
    if not user or not check_password(password, user['password']):
        return jsonify({'success': False, 'error': 'Неверный логин или пароль'}), 401

    # Бан по времени
    try:
        banned_until = int(user.get('banned_until') or 0)
    except Exception:
        banned_until = 0
    now_ts = int(time.time())
    if banned_until and banned_until > now_ts:
        mins_left = max(1, int((banned_until - now_ts + 59) / 60))
        return jsonify({'success': False, 'error': f'Вы забанены. Осталось ~{mins_left} мин.'}), 403
    
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
            'early_access': user.get('early_access', 0),
            'is_admin': user['is_admin'],
            'is_moderator': user.get('is_moderator', 0),
            'spam_blocked': user.get('spam_blocked', 0),
            'bee_stars': user['bee_stars']
        }
    })


@app.route('/early_access/activate', methods=['POST'])
def activate_early_access():
    """Активировать Early Access ключ"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    data = request.get_json(silent=True) or {}
    key_code = (data.get('key_code') or '').strip().upper()
    if not key_code:
        return jsonify({'success': False, 'error': 'Введите ключ'}), 400

    conn = get_db()
    c = conn.cursor()
    try:
        key = c.execute('SELECT * FROM early_access_keys WHERE key_code = ?', (key_code,)).fetchone()
        if not key:
            return jsonify({'success': False, 'error': 'Неверный ключ'}), 400
        if key['is_used']:
            return jsonify({'success': False, 'error': 'Ключ уже использован'}), 400

        user_id = session['user_id']
        c.execute('UPDATE users SET early_access = 1 WHERE id = ?', (user_id,))
        c.execute('''UPDATE early_access_keys
                     SET is_used = 1, used_by = ?, used_at = CURRENT_TIMESTAMP
                     WHERE key_code = ?''', (user_id, key_code))
        conn.commit()
    finally:
        conn.close()

    return jsonify({'success': True, 'message': 'Early Access активирован! 🗝️'})


@app.route('/admin/command', methods=['POST'])
def admin_command():
    """CMD-команды для админ-консоли (только админ)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    admin = get_user_by_id(session['user_id'])
    if not admin or not admin.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True) or {}
    raw = (data.get('command') or '').strip()
    if not raw:
        return jsonify({'success': True, 'output': ''})

    parts = raw.split()
    cmd = parts[0].lower()

    def help_text():
        return "\n".join([
            "BeeGramm Admin CMD — команды:",
            "/help — список команд",
            "/ban @username minutes — бан пользователя на N минут",
            "/unban @username — снять бан",
            "/ea list — показать 10 неиспользованных EA ключей",
            "/ea gen N — сгенерировать N EA ключей (макс 100 всего)",
            "/ea give @username — выдать EA пользователю (возьмёт свободный ключ)",
            "/ea revoke @username — забрать EA у пользователя (ключ не возвращаем)",
        ])

    if cmd == '/help':
        return jsonify({'success': True, 'output': help_text()})

    if cmd == '/ea':
        if len(parts) < 2:
            return jsonify({'success': False, 'error': 'Использование: /ea list | /ea gen N | /ea give @username | /ea revoke @username'}), 400

        sub = parts[1].lower()
        conn = get_db()
        try:
            if sub == 'list':
                rows = conn.execute('''SELECT key_code FROM early_access_keys
                                       WHERE is_used = 0
                                       ORDER BY created_at ASC
                                       LIMIT 10''').fetchall()
                keys = [r['key_code'] for r in rows]
                if not keys:
                    return jsonify({'success': True, 'output': 'Нет доступных EA ключей'})
                return jsonify({'success': True, 'output': "EA keys (free):\n" + "\n".join(keys)})

            if sub == 'gen':
                if len(parts) < 3:
                    return jsonify({'success': False, 'error': 'Нужно указать количество: /ea gen N'}), 400
                try:
                    n = int(parts[2])
                except Exception:
                    return jsonify({'success': False, 'error': 'N должно быть числом'}), 400
                if n <= 0 or n > 100:
                    return jsonify({'success': False, 'error': 'N должно быть от 1 до 100'}), 400

                total = conn.execute('SELECT COUNT(*) as c FROM early_access_keys').fetchone()['c']
                if total >= 100:
                    return jsonify({'success': False, 'error': 'Лимит 100 EA ключей уже достигнут'}), 400
                can = min(n, 100 - total)

                new_keys = []
                for _ in range(can):
                    k = f"EA-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
                    conn.execute('INSERT INTO early_access_keys (key_code) VALUES (?)', (k,))
                    new_keys.append(k)
                conn.commit()

                log_action(admin.get('id'), 'ea_keys_generate', {'count': can})
                return jsonify({'success': True, 'output': "OK: generated EA keys:\n" + "\n".join(new_keys)})

            if sub in ('give', 'revoke'):
                if len(parts) < 3:
                    return jsonify({'success': False, 'error': 'Нужно указать пользователя: @username'}), 400
                target_username = parts[2].lstrip('@').strip()
                if not re.fullmatch(r'[A-Za-z0-9]+', target_username):
                    return jsonify({'success': False, 'error': 'Некорректный username'}), 400

                target = conn.execute('SELECT id, is_admin, early_access FROM users WHERE username = ?', (target_username,)).fetchone()
                if not target:
                    return jsonify({'success': False, 'error': 'Пользователь не найден'}), 404
                if target['is_admin']:
                    return jsonify({'success': False, 'error': 'Админу не нужно EA'}), 400

                if sub == 'revoke':
                    conn.execute('UPDATE users SET early_access = 0 WHERE id = ?', (target['id'],))
                    conn.commit()
                    log_action(admin.get('id'), 'ea_revoke', {'username': target_username, 'user_id': target['id']})
                    return jsonify({'success': True, 'output': f'OK: EA revoked for @{target_username}'})

                if target['early_access']:
                    return jsonify({'success': False, 'error': 'У пользователя уже есть EA'}), 400

                free = conn.execute('''SELECT key_code FROM early_access_keys
                                       WHERE is_used = 0
                                       ORDER BY created_at ASC
                                       LIMIT 1''').fetchone()
                if not free:
                    return jsonify({'success': False, 'error': 'Нет свободных EA ключей'}), 400

                conn.execute('UPDATE users SET early_access = 1 WHERE id = ?', (target['id'],))
                conn.execute('''UPDATE early_access_keys
                                SET is_used = 1, used_by = ?, used_at = CURRENT_TIMESTAMP
                                WHERE key_code = ?''', (target['id'], free['key_code']))
                conn.commit()
                log_action(admin.get('id'), 'ea_give', {'username': target_username, 'user_id': target['id'], 'key_code': free['key_code']})
                return jsonify({'success': True, 'output': f'OK: EA granted to @{target_username} (key {free["key_code"]})'})

            return jsonify({'success': False, 'error': 'Неизвестная подкоманда /ea'}), 400
        finally:
            conn.close()

    if cmd in ('/ban', '/unban'):
        if len(parts) < 2:
            return jsonify({'success': False, 'error': 'Нужно указать пользователя: @username'}), 400

        target_username = parts[1].lstrip('@').strip()
        if not re.fullmatch(r'[A-Za-z0-9]+', target_username):
            return jsonify({'success': False, 'error': 'Некорректный username'}), 400

        conn = get_db()
        try:
            target = conn.execute('SELECT id, is_admin, banned_until FROM users WHERE username = ?', (target_username,)).fetchone()
            if not target:
                return jsonify({'success': False, 'error': 'Пользователь не найден'}), 404
            if target['is_admin']:
                return jsonify({'success': False, 'error': 'Нельзя банить администратора'}), 400

            if cmd == '/unban':
                conn.execute('UPDATE users SET banned_until = 0 WHERE id = ?', (target['id'],))
                conn.commit()
                return jsonify({'success': True, 'output': f'OK: unban @{target_username}'})

            # /ban
            if len(parts) < 3:
                return jsonify({'success': False, 'error': 'Нужно указать время в минутах'}), 400
            try:
                minutes = int(parts[2])
            except Exception:
                return jsonify({'success': False, 'error': 'minutes должно быть числом'}), 400
            if minutes <= 0 or minutes > 60 * 24 * 30:
                return jsonify({'success': False, 'error': 'minutes должно быть от 1 до 43200'}), 400

            until = int(time.time()) + minutes * 60
            conn.execute('UPDATE users SET banned_until = ? WHERE id = ?', (until, target['id']))
            conn.commit()
            return jsonify({'success': True, 'output': f'OK: ban @{target_username} for {minutes} min' })
        finally:
            conn.close()

    return jsonify({'success': False, 'error': 'Неизвестная команда. Введите /help'}), 400


@app.route('/support/open', methods=['POST'])
def open_support_chat():
    """Открыть чат поддержки (создать личный чат с пользователем support)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    user_id = session['user_id']
    support = get_user_by_username('support')
    if not support:
        return jsonify({'success': False, 'error': 'Поддержка недоступна'}), 500

    conn = get_db()
    c = conn.cursor()

    existing = c.execute('''SELECT c.id FROM chats c
                            JOIN chat_members cm1 ON c.id = cm1.chat_id
                            JOIN chat_members cm2 ON c.id = cm2.chat_id
                            WHERE c.is_group = 0 AND IFNULL(c.is_channel, 0) = 0
                            AND cm1.user_id = ? AND cm2.user_id = ?''',
                         (user_id, support['id'])).fetchone()
    if existing:
        chat_id = existing[0]
        conn.close()
        return jsonify({'success': True, 'chat_id': chat_id})

    c.execute('INSERT INTO chats (is_group, creator_id) VALUES (?, ?)', (0, user_id))
    chat_id = c.lastrowid
    c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', (chat_id, user_id))
    c.execute('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)', (chat_id, support['id']))
    c.execute('''INSERT INTO messages (chat_id, user_id, content, message_type)
                 VALUES (?, ?, ?, ?)''',
              (chat_id, support['id'], 'Здравствуйте! Опишите проблему — мы поможем 🐝', 'system'))
    conn.commit()
    conn.close()

    return jsonify({'success': True, 'chat_id': chat_id})


@app.route('/admin/support/chats', methods=['GET'])
def admin_support_chats():
    """Список всех диалогов с поддержкой (админ/модер)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    return _support_chats_impl()


@app.route('/admin/support/send', methods=['POST'])
def admin_support_send():
    """Отправить сообщение в диалог поддержки от имени @support (админ/модер)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    actor = get_user_by_id(session['user_id'])
    if not actor or (not actor.get('is_admin')):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True) or {}
    chat_id = data.get('chat_id')
    content = (data.get('content') or '').strip()
    return _support_send_impl(chat_id, content)


def _support_chats_impl():
    """Внутренняя реализация списка чатов поддержки (права проверяются снаружи)."""
    support = get_user_by_username('support')
    if not support:
        return jsonify({'success': False, 'error': 'Поддержка недоступна'}), 500

    conn = get_db()
    try:
        chats = conn.execute('''SELECT DISTINCT c.id
                                FROM chats c
                                JOIN chat_members cm ON c.id = cm.chat_id
                                WHERE c.is_group = 0 AND IFNULL(c.is_channel, 0) = 0
                                AND c.id IN (
                                    SELECT chat_id FROM chat_members WHERE user_id = ?
                                )''', (support['id'],)).fetchall()

        result = []
        for row in chats:
            chat_id = row['id']
            other_user = conn.execute('''SELECT u.id, u.username, u.nickname, u.avatar
                                         FROM users u
                                         JOIN chat_members cm ON u.id = cm.user_id
                                         WHERE cm.chat_id = ? AND u.id != ?
                                         LIMIT 1''', (chat_id, support['id'])).fetchone()
            last_msg = conn.execute('''SELECT m.id, m.content, m.created_at, m.message_type
                                       FROM messages m
                                       WHERE m.chat_id = ?
                                       ORDER BY m.created_at DESC
                                       LIMIT 1''', (chat_id,)).fetchone()
            result.append({
                'chat_id': chat_id,
                'user': dict(other_user) if other_user else None,
                'last_message': dict(last_msg) if last_msg else None
            })
    finally:
        conn.close()

    return jsonify({'success': True, 'chats': result})


def _support_send_impl(chat_id, content):
    """Внутренняя реализация отправки сообщения поддержки (права проверяются снаружи)."""
    if not chat_id or not content:
        return jsonify({'success': False, 'error': 'Некорректные данные'}), 400

    support = get_user_by_username('support')
    if not support:
        return jsonify({'success': False, 'error': 'Поддержка недоступна'}), 500

    conn = get_db()
    try:
        c = conn.cursor()
        is_support_chat = c.execute('''SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?''',
                                    (chat_id, support['id'])).fetchone()
        if not is_support_chat:
            return jsonify({'success': False, 'error': 'Это не чат поддержки'}), 400

        c.execute('''INSERT INTO messages (chat_id, user_id, content, message_type)
                     VALUES (?, ?, ?, ?)''', (chat_id, support['id'], content, 'text'))
        msg_id = c.lastrowid
        conn.commit()

        msg = c.execute('''SELECT m.*, u.nickname, u.username, u.avatar, u.is_premium
                           FROM messages m
                           JOIN users u ON m.user_id = u.id
                           WHERE m.id = ?''', (msg_id,)).fetchone()
    finally:
        conn.close()

    socketio.emit('new_message', dict(msg), room=f'chat_{chat_id}')
    return jsonify({'success': True})

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

@app.route('/admin/messages', methods=['GET'])
def admin_get_messages():
    """Получить последние сообщения (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    messages = conn.execute('''
        SELECT m.id, m.chat_id, m.user_id, m.content, m.message_type, m.file_url,
               m.is_deleted, m.deleted_at, m.deleted_by, m.created_at,
               u.username, u.nickname
        FROM messages m
        JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at DESC
        LIMIT 200
    ''').fetchall()
    conn.close()
    
    return jsonify({'messages': [dict(m) for m in messages]})

@app.route('/admin/message/<int:message_id>/delete', methods=['POST'])
def admin_delete_message(message_id):
    """Удалить сообщение (мягко) (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    c = conn.cursor()
    msg = c.execute('SELECT chat_id, is_deleted FROM messages WHERE id = ?', (message_id,)).fetchone()
    if not msg:
        conn.close()
        return jsonify({'success': False, 'error': 'Сообщение не найдено'}), 404
    
    if msg['is_deleted']:
        conn.close()
        return jsonify({'success': True})
    
    c.execute('''UPDATE messages
                 SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
                 WHERE id = ?''', (user['id'], message_id))
    conn.commit()
    conn.close()

    log_action(user.get('id'), 'message_delete', {
        'message_id': message_id,
        'chat_id': msg['chat_id'],
        'via': 'admin_http'
    })
    
    socketio.emit('message_deleted', {
        'message_id': message_id,
        'chat_id': msg['chat_id']
    }, room=f"chat_{msg['chat_id']}")
    
    return jsonify({'success': True})

@app.route('/admin/stickers/packs', methods=['GET'])
def admin_get_sticker_packs():
    """Список стикерпаков (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    packs = conn.execute('SELECT * FROM sticker_packs ORDER BY id DESC').fetchall()
    result = []
    for pack in packs:
        pack_dict = dict(pack)
        stickers = conn.execute('SELECT * FROM stickers WHERE pack_id = ? ORDER BY id ASC', (pack['id'],)).fetchall()
        pack_dict['stickers'] = [dict(s) for s in stickers]
        result.append(pack_dict)
    conn.close()
    return jsonify({'packs': result})

@app.route('/admin/stickers/packs', methods=['POST'])
def admin_create_sticker_pack():
    """Создать стикерпак (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    data = request.json or {}
    name = (data.get('name') or '').strip()
    is_premium = 1 if data.get('is_premium') else 0
    if not name:
        return jsonify({'success': False, 'error': 'Название обязательно'}), 400
    
    conn = get_db()
    c = conn.cursor()
    c.execute('INSERT INTO sticker_packs (name, is_premium) VALUES (?, ?)', (name, is_premium))
    pack_id = c.lastrowid
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'pack_id': pack_id})

@app.route('/admin/stickers/packs/<int:pack_id>/stickers', methods=['POST'])
def admin_add_sticker(pack_id):
    """Добавить стикер в пак (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    data = request.json or {}
    emoji = (data.get('emoji') or '').strip()
    url = (data.get('url') or emoji).strip()
    if not emoji:
        return jsonify({'success': False, 'error': 'Emoji обязателен'}), 400
    
    conn = get_db()
    c = conn.cursor()
    pack = c.execute('SELECT id FROM sticker_packs WHERE id = ?', (pack_id,)).fetchone()
    if not pack:
        conn.close()
        return jsonify({'success': False, 'error': 'Пак не найден'}), 404
    
    c.execute('INSERT INTO stickers (pack_id, emoji, url) VALUES (?, ?, ?)', (pack_id, emoji, url))
    sticker_id = c.lastrowid
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'sticker_id': sticker_id})

@app.route('/admin/chats/<int:chat_id>/delete', methods=['DELETE'])
def admin_delete_chat(chat_id):
    """Удалить чат/канал/группу (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    c = conn.cursor()
    c.execute('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', (chat_id,))
    c.execute('DELETE FROM messages WHERE chat_id = ?', (chat_id,))
    c.execute('DELETE FROM chat_members WHERE chat_id = ?', (chat_id,))
    c.execute('DELETE FROM chats WHERE id = ?', (chat_id,))
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
    users = conn.execute('''SELECT id, username, nickname, avatar, is_premium, is_admin, is_moderator, spam_blocked, bee_stars, created_at
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
    
    data = request.get_json(silent=True) or {}
    conn = get_db()
    c = conn.cursor()
    
    if 'is_premium' in data:
        c.execute('UPDATE users SET is_premium = ? WHERE id = ?', (data['is_premium'], user_id))
    if 'bee_stars' in data:
        c.execute('UPDATE users SET bee_stars = ? WHERE id = ?', (data['bee_stars'], user_id))
    if 'is_admin' in data:
        c.execute('UPDATE users SET is_admin = ? WHERE id = ?', (data['is_admin'], user_id))
    if 'is_moderator' in data:
        c.execute('UPDATE users SET is_moderator = ? WHERE id = ?', (data['is_moderator'], user_id))
    if 'spam_blocked' in data:
        c.execute('UPDATE users SET spam_blocked = ? WHERE id = ?', (data['spam_blocked'], user_id))
    if 'early_access' in data:
        c.execute('UPDATE users SET early_access = ? WHERE id = ?', (data['early_access'], user_id))
    
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

@app.route('/admin/early_access/keys', methods=['GET'])
def admin_get_early_access_keys():
    """Получить все ключи раннего доступа (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    conn = get_db()
    keys = conn.execute('''SELECT k.*, u.username 
                           FROM early_access_keys k
                           LEFT JOIN users u ON k.used_by = u.id
                           ORDER BY k.created_at DESC''').fetchall()
    conn.close()
    
    return jsonify({'keys': [dict(k) for k in keys]})

@app.route('/admin/early_access/keys/generate', methods=['POST'])
def admin_generate_early_access_keys():
    """Сгенерировать новые ключи раннего доступа (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401
    
    admin = get_user_by_id(session['user_id'])
    if not admin or not admin['is_admin']:
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403
    
    data = request.get_json(silent=True) or {}
    try:
        count = int(data.get('count', 1))
    except Exception:
        return jsonify({'success': False, 'error': 'count должно быть числом'}), 400
    if count <= 0 or count > 100:
        return jsonify({'success': False, 'error': 'count должно быть от 1 до 100'}), 400

    conn = get_db()
    c = conn.cursor()

    try:
        total = c.execute('SELECT COUNT(*) as c FROM early_access_keys').fetchone()['c']
        if total >= 100:
            return jsonify({'success': False, 'error': 'Лимит 100 ключей уже достигнут'}), 400
        can = min(count, 100 - total)
        new_keys = []
        for _ in range(can):
            key = f"EA-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
            c.execute('INSERT INTO early_access_keys (key_code) VALUES (?)', (key,))
            new_keys.append(key)
        conn.commit()
    finally:
        conn.close()

    log_action(admin.get('id'), 'ea_keys_generate', {'count': len(new_keys)})
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
    
    return jsonify({'success': True, 'message': 'BeeGramm Premium активирован! '})

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
    
    data = request.get_json(silent=True) or {}
    user_id = session['user_id']
    is_group = data.get('is_group', False)
    is_channel = data.get('is_channel', False)
    members = data.get('members', []) or []
    
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
            conn.close()
            return jsonify({'success': False, 'error': 'Укажите собеседника'}), 400

        if int(other_user_id) == int(user_id):
            conn.close()
            return jsonify({'success': False, 'error': 'Нельзя создать чат с самим собой'}), 400
        
        # Проверяем, есть ли уже чат с этим пользователем
        existing = c.execute('''SELECT c.id FROM chats c
                                JOIN chat_members cm1 ON c.id = cm1.chat_id
                                JOIN chat_members cm2 ON c.id = cm2.chat_id
                                WHERE c.is_group = 0 
                                AND IFNULL(c.is_channel, 0) = 0
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
    chats = conn.execute('''SELECT DISTINCT c.id, c.name, c.is_group, c.is_channel, c.description,
                                   c.avatar, c.creator_id, c.subscribers_count
                            FROM chats c
                            JOIN chat_members cm ON c.id = cm.chat_id
                            WHERE cm.user_id = ?
                            ORDER BY c.id DESC''', (user_id,)).fetchall()
    
    result = []
    for chat in chats:
        chat_dict = dict(chat)
        
        # Для личных чатов получаем имя собеседника
        is_group = int(chat['is_group'] or 0)
        is_channel = int(chat['is_channel'] or 0)

        if not is_group and not is_channel:
            other_user = conn.execute('''SELECT u.id, u.nickname, u.username, u.avatar, u.status, u.is_premium
                                         FROM users u
                                         JOIN chat_members cm ON u.id = cm.user_id
                                         WHERE cm.chat_id = ? AND u.id != ?''',
                                      (chat['id'], user_id)).fetchone()
            if other_user:
                chat_dict['name'] = other_user['nickname'] or other_user['username']
                chat_dict['avatar'] = other_user['avatar']
                chat_dict['other_user'] = dict(other_user)

        if is_channel:
            chat_dict['type'] = 'channel'
        elif is_group:
            chat_dict['type'] = 'group'
        else:
            chat_dict['type'] = 'private'
        
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


@app.route('/upload/voice', methods=['POST'])
def upload_voice():
    """Загрузка голосового сообщения"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Файл не найден'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Файл не выбран'}), 400

    # Ограничение: голосовые как обычные файлы
    user = get_user_by_id(session['user_id'])
    file.seek(0, 2)
    file_size = file.tell()
    file.seek(0)
    max_size = 100 * 1024 * 1024 if user and user.get('is_premium') else 10 * 1024 * 1024
    if file_size > max_size:
        return jsonify({'success': False, 'error': 'Файл слишком большой'}), 400

    filename = f"{uuid.uuid4()}_{secure_filename(file.filename)}"
    filepath = os.path.join('uploads/voices', filename)
    file.save(filepath)

    return jsonify({'success': True, 'file_url': f'voices/{filename}', 'filename': file.filename})


@app.route('/admin/stickers/packs/<int:pack_id>/upload', methods=['POST'])
def admin_upload_sticker_image(pack_id):
    """Загрузить стикер-картинку в пак (только для админа)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'error': 'Не авторизован'}), 401

    user = get_user_by_id(session['user_id'])
    if not user or not user.get('is_admin'):
        return jsonify({'success': False, 'error': 'Доступ запрещён'}), 403

    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Файл не найден'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Файл не выбран'}), 400

    filename = f"{uuid.uuid4()}_{secure_filename(file.filename)}"
    filepath = os.path.join('uploads/stickers', filename)
    file.save(filepath)

    conn = get_db()
    c = conn.cursor()
    exists = c.execute('SELECT id FROM sticker_packs WHERE id = ?', (pack_id,)).fetchone()
    if not exists:
        conn.close()
        return jsonify({'success': False, 'error': 'Пак не найден'}), 404

    c.execute('INSERT INTO stickers (pack_id, emoji, url, is_image) VALUES (?, ?, ?, ?)',
              (pack_id, '', f'stickers/{filename}', 1))
    conn.commit()
    conn.close()

    return jsonify({'success': True})

# ============= SOCKET.IO СОБЫТИЯ =============

@socketio.on('connect')
def handle_connect():
    """Подключение клиента"""
    ip = _get_client_ip()
    if _is_ip_blocked(ip):
        try:
            _log_suspicious_ip(ip, 'socket_blocked', 'connect')
        except Exception:
            pass
        return False

    # Лимит на подключения
    if not _rate_check(_rate_socket, (ip, 'connect'), limit=30, per_seconds=60):
        _log_suspicious_ip(ip, 'socket_connect_rate', 'connect')
        return False

    if 'user_id' in session:
        join_room(f"user_{session['user_id']}")

    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    """Отключение клиента"""
    print('Client disconnected')

@socketio.on('join_chat')
def handle_join_chat(data):
    """Присоединение к чату"""
    if 'user_id' in session:
        user = get_user_by_id(session['user_id'])
        if not _has_early_access_user(user):
            emit('message_error', {'error': 'Нужен Early Access ключ'})
            return
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

    if 'user_id' in session:
        user = get_user_by_id(session['user_id'])
        if not _has_early_access_user(user):
            emit('message_error', {'error': 'Нужен Early Access ключ'})
            return

    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'send_message'), limit=45, per_seconds=10):
        _log_suspicious_ip(ip, 'socket_rate', 'send_message')
        emit('message_error', {'error': 'Слишком часто. Подождите немного.'})
        return

    # Бан: запрещаем отправку любых сообщений
    try:
        conn = get_db()
        row = conn.execute('SELECT banned_until, is_admin FROM users WHERE id = ?', (user_id,)).fetchone()
        if row and (not row['is_admin']):
            banned_until = int(row['banned_until'] or 0)
            now_ts = int(time.time())
            if banned_until and banned_until > now_ts:
                mins_left = max(1, int((banned_until - now_ts + 59) / 60))
                conn.close()
                emit('message_error', {'error': f'Вы забанены. Осталось ~{mins_left} мин.'})
                return
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass

    # Спам-блок: запрещаем инициировать личные сообщения тем, кто ещё не писал тебе
    try:
        conn = get_db()
        sender = conn.execute('SELECT spam_blocked, is_admin, is_moderator FROM users WHERE id = ?', (user_id,)).fetchone()
        if sender and sender['spam_blocked'] and not sender['is_admin'] and not sender['is_moderator']:
            chat = conn.execute('SELECT id, is_group, is_channel FROM chats WHERE id = ?', (chat_id,)).fetchone()
            if chat and (not chat['is_group']) and (not chat.get('is_channel')):
                other = conn.execute('''SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? LIMIT 1''',
                                    (chat_id, user_id)).fetchone()
                if other:
                    other_has_replied = conn.execute('''SELECT 1 FROM messages WHERE chat_id = ? AND user_id = ? LIMIT 1''',
                                                   (chat_id, other['user_id'])).fetchone()
                    if not other_has_replied:
                        conn.close()
                        emit('message_error', {'error': 'Спам-блок: нельзя писать пользователю, пока он сам не напишет вам'})
                        return
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
    
    # Лимит длины текстовых сообщений
    if message_type == 'text' and content is not None:
        try:
            conn = get_db()
            sender = conn.execute('SELECT is_premium FROM users WHERE id = ?', (user_id,)).fetchone()
            conn.close()
            max_len = 1000 if (sender and sender['is_premium']) else 500
            if len(content) > max_len:
                emit('message_error', {
                    'error': f'Слишком длинное сообщение (макс. {max_len} символов)'
                })
                return
        except Exception:
            emit('message_error', {
                'error': 'Ошибка проверки длины сообщения'
            })
            return
    
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
                               f" Отправил(а) {amount} пчёлок пользователю @{target_username}!",
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

    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'typing'), limit=60, per_seconds=10):
        return

    if 'user_id' in session:
        user = get_user_by_id(session['user_id'])
        if not _has_early_access_user(user):
            return
    
    user = get_user_by_id(user_id)
    
    emit('user_typing', {
        'user_id': user_id,
        'username': user['nickname'] or user['username'],
        'is_typing': is_typing
    }, room=f'chat_{chat_id}', include_self=False)


@socketio.on('delete_message')
def handle_delete_message(data):
    message_id = data.get('message_id')
    user_id = data.get('user_id')
    chat_id = data.get('chat_id')

    if not message_id or not user_id or not chat_id:
        emit('message_error', {'error': 'Некорректные данные'})
        return

    actor = get_user_by_id(user_id)
    if not actor:
        emit('message_error', {'error': 'Пользователь не найден'})
        return

    conn = get_db()
    c = conn.cursor()
    msg = c.execute('SELECT id, chat_id, user_id, is_deleted FROM messages WHERE id = ?', (message_id,)).fetchone()
    if not msg or msg['chat_id'] != chat_id:
        conn.close()
        emit('message_error', {'error': 'Сообщение не найдено'})
        return

    if msg['is_deleted']:
        conn.close()
        return

    can_delete = (msg['user_id'] == user_id) or actor.get('is_admin') or actor.get('is_moderator')
    if not can_delete:
        conn.close()
        emit('message_error', {'error': 'Нет прав на удаление'})
        return

    c.execute('''UPDATE messages
                 SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
                 WHERE id = ?''', (user_id, message_id))
    conn.commit()
    conn.close()

    emit('message_deleted', {
        'message_id': message_id,
        'chat_id': chat_id
    }, room=f'chat_{chat_id}')


@socketio.on('call_offer')
def handle_call_offer(data):
    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'call_offer'), limit=6, per_seconds=60):
        _log_suspicious_ip(ip, 'socket_rate', 'call_offer')
        return

    if 'user_id' not in session:
        return

    user = get_user_by_id(session['user_id'])
    if not _has_early_access_user(user):
        return

    to_user_id = data.get('to_user_id')
    chat_id = data.get('chat_id')
    sdp = data.get('sdp')
    if not to_user_id or not chat_id or not sdp:
        return

    emit('call_offer', {
        'from_user_id': session['user_id'],
        'chat_id': chat_id,
        'sdp': sdp
    }, room=f"user_{to_user_id}")

@socketio.on('call_answer')
def handle_call_answer(data):
    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'call_answer'), limit=10, per_seconds=60):
        return

    if 'user_id' not in session:
        return

    user = get_user_by_id(session['user_id'])
    if not _has_early_access_user(user):
        return

    to_user_id = data.get('to_user_id')
    chat_id = data.get('chat_id')
    sdp = data.get('sdp')
    if not to_user_id or not chat_id or not sdp:
        return

    emit('call_answer', {
        'from_user_id': session['user_id'],
        'chat_id': chat_id,
        'sdp': sdp
    }, room=f"user_{to_user_id}")


@socketio.on('call_ice')
def handle_call_ice(data):
    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'call_ice'), limit=120, per_seconds=60):
        return

    if 'user_id' not in session:
        return

    user = get_user_by_id(session['user_id'])
    if not _has_early_access_user(user):
        return

    to_user_id = data.get('to_user_id')
    chat_id = data.get('chat_id')
    candidate = data.get('candidate')
    if not to_user_id or not chat_id or not candidate:
        return

    emit('call_ice', {
        'from_user_id': session['user_id'],
        'chat_id': chat_id,
        'candidate': candidate
    }, room=f"user_{to_user_id}")


@socketio.on('call_hangup')
def handle_call_hangup(data):
    ip = _get_client_ip()
    if not _rate_check(_rate_socket, (ip, 'call_hangup'), limit=30, per_seconds=60):
        return

    if 'user_id' not in session:
        return

    user = get_user_by_id(session['user_id'])
    if not _has_early_access_user(user):
        return

    to_user_id = data.get('to_user_id')
    chat_id = data.get('chat_id')
    if not to_user_id or not chat_id:
        return

    emit('call_hangup', {
        'from_user_id': session['user_id'],
        'chat_id': chat_id
    }, room=f"user_{to_user_id}")

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
