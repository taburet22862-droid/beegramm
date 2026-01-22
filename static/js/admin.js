// Админ-панель BeeGramm

let currentUser = null;

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    // Проверяем авторизацию
    const savedUser = localStorage.getItem('beegram_user');
    if (!savedUser) {
        window.location.href = '/';
        return;
    }
    
    currentUser = JSON.parse(savedUser);
    
    // Проверяем права админа
    if (!currentUser.is_admin) {
        alert('Доступ запрещён');
        window.location.href = '/';
        return;
    }
    
    // Обновляем информацию о пользователе
    document.getElementById('admin-name').textContent = currentUser.nickname || currentUser.username;
    const avatarUrl = currentUser.avatar !== 'default.png' 
        ? `/uploads/${currentUser.avatar}` 
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    document.getElementById('admin-avatar').src = avatarUrl;
    
    // Загружаем данные
    await loadDashboard();
});

// ============= НАВИГАЦИЯ =============

function showSection(sectionName) {
    // Убираем активный класс со всех секций и ссылок
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    // Добавляем активный класс
    document.getElementById(`section-${sectionName}`).classList.add('active');
    event.target.classList.add('active');
    
    // Загружаем данные для секции
    switch(sectionName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'users':
            loadUsers();
            break;
        case 'channels':
            loadChannels();
            break;
        case 'groups':
            loadGroups();
            break;
        case 'keys':
            loadKeys();
            break;
        case 'stickers':
            loadStickers();
            break;
        case 'messages':
            loadMessages();
            break;
    }
}

function backToApp() {
    window.location.href = '/';
}

// ============= ДАШБОРД =============

async function loadDashboard() {
    try {
        // Загружаем статистику
        const [usersRes, keysRes] = await Promise.all([
            fetch('/admin/users'),
            fetch('/admin/keys')
        ]);
        
        const usersData = await usersRes.json();
        const keysData = await keysRes.json();
        
        if (usersData.users) {
            const users = usersData.users;
            const premiumUsers = users.filter(u => u.is_premium).length;
            const totalStars = users.reduce((sum, u) => sum + u.bee_stars, 0);
            
            document.getElementById('stat-users').textContent = users.length;
            document.getElementById('stat-premium').textContent = premiumUsers;
            document.getElementById('stat-total-stars').textContent = totalStars.toLocaleString();
            
            // Последние пользователи
            const recentUsers = users.slice(0, 5);
            const recentList = document.getElementById('recent-users');
            recentList.innerHTML = recentUsers.map(user => `
                <div class="activity-item">
                    <img src="${user.avatar !== 'default.png' ? '/uploads/' + user.avatar : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>'}" 
                         alt="Avatar" class="activity-avatar">
                    <div class="activity-info">
                        <div class="activity-name">
                            ${user.nickname || user.username}
                            ${user.is_premium ? '⭐' : ''}
                            ${user.is_admin ? '👑' : ''}
                        </div>
                        <div class="activity-time">@${user.username} • ${user.bee_stars} 🐝</div>
                    </div>
                </div>
            `).join('');
        }
        
        if (keysData.keys) {
            const availableKeys = keysData.keys.filter(k => !k.is_used).length;
            document.getElementById('stat-keys-available').textContent = availableKeys;
        }
        
        // TODO: Загрузить статистику чатов и сообщений
        document.getElementById('stat-chats').textContent = '—';
        document.getElementById('stat-messages').textContent = '—';
        
    } catch (error) {
        console.error('Ошибка загрузки дашборда:', error);
    }
}

// ============= ПОЛЬЗОВАТЕЛИ =============

async function loadUsers() {
    try {
        const response = await fetch('/admin/users');
        const data = await response.json();
        
        if (data.users) {
            const tbody = document.getElementById('users-table-body');
            tbody.innerHTML = data.users.map(user => `
                <tr>
                    <td>${user.id}</td>
                    <td>
                        <div class="user-cell">
                            <img src="${user.avatar !== 'default.png' ? '/uploads/' + user.avatar : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>'}" 
                                 alt="Avatar" class="user-avatar">
                            <div>
                                <div class="user-name">${user.nickname || user.username}</div>
                                <div class="user-username">@${user.username}</div>
                            </div>
                        </div>
                    </td>
                    <td>
                        ${user.is_admin ? '<span class="badge badge-admin">👑 Админ</span>' : ''}
                        ${user.is_premium ? '<span class="badge badge-premium">⭐ Premium</span>' : '<span class="badge badge-regular">Обычный</span>'}
                    </td>
                    <td>${user.bee_stars} 🐝</td>
                    <td>${new Date(user.created_at).toLocaleDateString('ru-RU')}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-success" onclick="togglePremium(${user.id}, ${user.is_premium})" title="${user.is_premium ? 'Забрать Premium' : 'Выдать Premium'}">
                                ${user.is_premium ? '❌' : '⭐'}
                            </button>
                            <button class="btn-warning" onclick="editStars(${user.id}, ${user.bee_stars})" title="Изменить пчёлок">
                                🐝
                            </button>
                            ${user.id !== currentUser.id ? `
                                <button class="btn-danger" onclick="deleteUser(${user.id})" title="Удалить">
                                    🗑️
                                </button>
                            ` : ''}
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

async function togglePremium(userId, currentStatus) {
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({is_premium: currentStatus ? 0 : 1})
        });
        
        const data = await response.json();
        if (data.success) {
            loadUsers();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function editStars(userId, currentStars) {
    const amount = prompt(`Введите новое количество пчёлок (текущее: ${currentStars}):`, currentStars);
    if (amount === null) return;
    
    const stars = parseInt(amount);
    if (isNaN(stars) || stars < 0) {
        alert('Неверное количество');
        return;
    }
    
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({bee_stars: stars})
        });
        
        const data = await response.json();
        if (data.success) {
            loadUsers();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function deleteUser(userId) {
    if (!confirm('Вы уверены, что хотите удалить этого пользователя?')) return;
    
    try {
        const response = await fetch(`/admin/user/${userId}/delete`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (data.success) {
            loadUsers();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

// ============= КЛЮЧИ =============

async function loadKeys() {
    try {
        const response = await fetch('/admin/keys');
        const data = await response.json();
        
        if (data.keys) {
            const grid = document.getElementById('keys-grid');
            grid.innerHTML = data.keys.map(key => `
                <div class="key-card ${key.is_used ? 'used' : ''}">
                    <div class="key-code">${key.key_code}</div>
                    <span class="key-status ${key.is_used ? 'used' : 'available'}">
                        ${key.is_used ? '❌ Использован' : '✅ Доступен'}
                    </span>
                    ${key.is_used ? `
                        <div class="key-info">
                            Использован: <strong>${key.username || 'Неизвестно'}</strong><br>
                            Дата: ${new Date(key.used_at).toLocaleString('ru-RU')}
                        </div>
                    ` : `
                        <div class="key-info">
                            Создан: ${new Date(key.created_at).toLocaleString('ru-RU')}
                        </div>
                    `}
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки ключей:', error);
    }
}

function showGenerateKeysModal() {
    document.getElementById('generate-keys-modal').classList.add('open');
}

function closeGenerateKeysModal() {
    document.getElementById('generate-keys-modal').classList.remove('open');
}

async function generateKeys() {
    const count = parseInt(document.getElementById('keys-count').value);
    
    if (isNaN(count) || count < 1 || count > 100) {
        alert('Введите число от 1 до 100');
        return;
    }
    
    try {
        const response = await fetch('/admin/keys/generate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({count})
        });
        
        const data = await response.json();
        if (data.success) {
            alert(`✅ Сгенерировано ${count} ключей:\n\n${data.keys.join('\n')}`);
            closeGenerateKeysModal();
            loadKeys();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка генерации ключей');
    }
}

// ============= КАНАЛЫ =============

async function loadChannels() {
    try {
        const response = await fetch('/admin/channels');
        const data = await response.json();
        
        if (data.channels) {
            const tbody = document.getElementById('channels-table-body');
            tbody.innerHTML = data.channels.map(channel => `
                <tr>
                    <td>${channel.id}</td>
                    <td><strong>${channel.name}</strong></td>
                    <td>${channel.description || '—'}</td>
                    <td>${channel.subscribers_count || 0} 👥</td>
                    <td>@${channel.creator_username || 'Неизвестно'}</td>
                    <td>${new Date(channel.created_at).toLocaleDateString('ru-RU')}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-warning" onclick="editChannel(${channel.id})" title="Редактировать">
                                ✏️
                            </button>
                            <button class="btn-danger" onclick="deleteChannel(${channel.id})" title="Удалить">
                                🗑️
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки каналов:', error);
    }
}

async function deleteChannel(channelId) {
    if (!confirm('Удалить канал?')) return;
    
    try {
        const response = await fetch(`/admin/user/${channelId}/delete`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (data.success) {
            loadChannels();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

function editChannel(channelId) {
    alert('Функция редактирования в разработке');
}

// ============= ГРУППЫ =============

async function loadGroups() {
    try {
        const response = await fetch('/admin/groups');
        const data = await response.json();
        
        if (data.groups) {
            const tbody = document.getElementById('groups-table-body');
            tbody.innerHTML = data.groups.map(group => `
                <tr>
                    <td>${group.id}</td>
                    <td><strong>${group.name}</strong></td>
                    <td>${group.description || '—'}</td>
                    <td>${group.members_count || 0} 👥</td>
                    <td>@${group.creator_username || 'Неизвестно'}</td>
                    <td>${new Date(group.created_at).toLocaleDateString('ru-RU')}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-warning" onclick="editGroup(${group.id})" title="Редактировать">
                                ✏️
                            </button>
                            <button class="btn-danger" onclick="deleteGroup(${group.id})" title="Удалить">
                                🗑️
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки групп:', error);
    }
}

async function deleteGroup(groupId) {
    if (!confirm('Удалить группу?')) return;
    
    try {
        const response = await fetch(`/admin/user/${groupId}/delete`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (data.success) {
            loadGroups();
            loadDashboard();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

function editGroup(groupId) {
    alert('Функция редактирования в разработке');
}

// ============= СТИКЕРЫ =============

async function loadStickers() {
    const list = document.getElementById('sticker-packs-list');
    list.innerHTML = '<div style="text-align: center; padding: 40px; background: white; border-radius: 15px;">Функция в разработке</div>';
}

function showAddStickerPackModal() {
    alert('Функция добавления стикерпака в разработке');
}

// ============= СООБЩЕНИЯ =============

async function loadMessages() {
    // TODO: Добавить endpoint для получения всех сообщений
    const list = document.getElementById('messages-list');
    list.innerHTML = '<div style="text-align: center; padding: 40px; background: white; border-radius: 15px;">Функция в разработке</div>';
}

// Закрытие модальных окон по клику вне их
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('open');
    }
});

// Поиск пользователей
document.getElementById('user-search')?.addEventListener('input', (e) => {
    const search = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#users-table-body tr');
    
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(search) ? '' : 'none';
    });
});
