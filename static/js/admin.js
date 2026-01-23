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

    initAdminCmd();
});

function initAdminCmd() {
    const input = document.getElementById('admin-cmd-input');
    const output = document.getElementById('admin-cmd-output');
    if (!input || !output) return;

    const appendLine = (text, cls = '') => {
        const div = document.createElement('div');
        div.className = 'admin-cmd-line' + (cls ? ` ${cls}` : '');
        div.textContent = text;
        output.appendChild(div);
        output.scrollTop = output.scrollHeight;
    };

    const run = async (command) => {
        const cmd = (command || '').trim();
        if (!cmd) return;
        appendLine(`C:\\BeeGramm> ${cmd}`);

        try {
            const res = await fetch('/admin/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
            });
            const data = await res.json();
            if (!data.success) {
                appendLine(data.error || 'Ошибка', 'error');
                return;
            }
            if (data.output) {
                String(data.output).split('\n').forEach(line => appendLine(line));
            }
        } catch (e) {
            appendLine('Ошибка соединения', 'error');
        }
    };

    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = input.value;
            input.value = '';
            await run(cmd);
        }
    });

    if (!output.dataset.booted) {
        output.dataset.booted = '1';
        run('/help');
    }
}

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
        case 'reports':
            loadReports('open');
            break;
        case 'audit':
            loadAudit();
            break;
        case 'security':
            loadSecurity();
            break;
        case 'support':
            loadSupportChats();
            break;
        case 'settings':
            loadSettings();
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
        const [usersRes, keysRes, statsRes] = await Promise.all([
            fetch('/admin/users'),
            fetch('/admin/keys'),
            fetch('/admin/stats')
        ]);
        
        const usersData = await usersRes.json();
        const keysData = await keysRes.json();
        const statsData = await statsRes.json();
        
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

        if (statsData && statsData.success) {
            document.getElementById('stat-chats').textContent = statsData.chats;
            document.getElementById('stat-messages').textContent = statsData.messages;
            const spamEl = document.getElementById('stat-spam-blocked');
            if (spamEl) spamEl.textContent = statsData.spam_blocked;
        } else {
            document.getElementById('stat-chats').textContent = '—';
            document.getElementById('stat-messages').textContent = '—';
            const spamEl = document.getElementById('stat-spam-blocked');
            if (spamEl) spamEl.textContent = '—';
        }
        
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
                        ${user.is_moderator && !user.is_admin ? '<span class="badge badge-admin">🛡️ Модер</span>' : ''}
                        ${user.spam_blocked ? '<span class="badge badge-regular">🚫 Спам-блок</span>' : ''}
                        ${user.early_access ? '<span class="badge badge-regular">🗝️ EA</span>' : ''}
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
                                <button class="btn-warning" onclick="toggleModerator(${user.id}, ${user.is_moderator})" title="${user.is_moderator ? 'Снять модератора' : 'Выдать модератора'}">
                                    🛡️
                                </button>
                            ` : ''}
                            ${user.id !== currentUser.id ? `
                                <button class="btn-warning" onclick="toggleSpamBlocked(${user.id}, ${user.spam_blocked || 0})" title="${user.spam_blocked ? 'Снять спам-блок' : 'Выдать спам-блок'}">
                                    🚫
                                </button>
                            ` : ''}
                            ${user.id !== currentUser.id ? `
                                <button class="btn-success" onclick="toggleEarlyAccess(${user.id}, ${user.early_access || 0})" title="${user.early_access ? 'Забрать Early Access' : 'Выдать Early Access'}">
                                    🗝️
                                </button>
                            ` : ''}
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

async function toggleSpamBlocked(userId, currentStatus) {
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({spam_blocked: currentStatus ? 0 : 1})
        });

        const data = await response.json();
        if (data.success) {
            loadUsers();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function toggleEarlyAccess(userId, currentStatus) {
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({early_access: currentStatus ? 0 : 1})
        });

        const data = await response.json();
        if (data.success) {
            loadUsers();
        } else {
            alert(data.error || 'Ошибка');
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}


// ============= ПОДДЕРЖКА =============

async function loadSupportChats() {
    try {
        const response = await fetch('/admin/support/chats');
        const data = await response.json();

        const container = document.getElementById('support-chats-list');
        if (!container) return;

        if (!data.success) {
            container.innerHTML = `<div style="padding: 16px;">${data.error || 'Ошибка загрузки поддержки'}</div>`;
            return;
        }

        const chats = data.chats || [];
        if (chats.length === 0) {
            container.innerHTML = '<div style="padding: 16px;">Диалогов поддержки пока нет</div>';
            return;
        }

        container.innerHTML = chats.map(item => {
            const user = item.user || {};
            const title = user.nickname || user.username || 'Пользователь';
            const last = item.last_message?.content ? item.last_message.content : '—';
            return `
                <div class="message-item">
                    <div class="message-header">
                        <div><strong>${title}</strong> ${user.username ? '@' + user.username : ''}</div>
                        <div style="opacity:0.7; font-size:12px;">chat_id: ${item.chat_id}</div>
                    </div>
                    <div class="message-content">${last}</div>
                    <div style="display:flex; gap:10px; margin-top:10px;">
                        <input id="support-reply-${item.chat_id}" type="text" placeholder="Ответ от @support..." style="flex:1; padding:10px; border-radius:10px; border:1px solid #ddd;">
                        <button class="btn-success" onclick="sendSupportReply(${item.chat_id})">Отправить</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Ошибка поддержки:', error);
    }
}

async function sendSupportReply(chatId) {
    const input = document.getElementById(`support-reply-${chatId}`);
    if (!input) return;
    const content = (input.value || '').trim();
    if (!content) return;

    try {
        const response = await fetch('/admin/support/send', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({chat_id: chatId, content})
        });
        const data = await response.json();
        if (data.success) {
            input.value = '';
            loadSupportChats();
        } else {
            alert(data.error || 'Ошибка отправки');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка отправки');
    }
}

async function toggleModerator(userId, currentStatus) {
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({is_moderator: currentStatus ? 0 : 1})
        });
        
        const data = await response.json();
        if (data.success) {
            loadUsers();
        }
    } catch (error) {
        console.error('Ошибка:', error);
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
        const response = await fetch(`/admin/chats/${channelId}/delete`, {
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
        const response = await fetch(`/admin/chats/${groupId}/delete`, {
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
    try {
        const response = await fetch('/admin/stickers/packs');
        const data = await response.json();
        const list = document.getElementById('sticker-packs-list');

        if (!data.packs) {
            list.innerHTML = '<div style="text-align: center; padding: 40px; background: white; border-radius: 15px;">Нет данных</div>';
            return;
        }

        list.innerHTML = data.packs.map(pack => {
            const stickers = (pack.stickers || []).map(s => {
                if (s.is_image) {
                    return `<img src="/uploads/${s.url}" alt="sticker" style="width:34px; height:34px; object-fit:contain; margin-right:6px; vertical-align:middle;">`;
                }
                return `<span style="font-size:28px; margin-right:6px;">${s.emoji}</span>`;
            }).join('') || '—';
            return `
                <div class="message-item">
                    <div class="message-header">
                        <div class="message-user">${pack.name} ${pack.is_premium ? '⭐' : ''}</div>
                        <div>
                            <button class="btn-primary" onclick="addStickerToPack(${pack.id})">➕ Стикер</button>
                            <button class="btn-primary" onclick="uploadStickerImage(${pack.id})">🖼️ Картинка</button>
                        </div>
                    </div>
                    <div class="message-text">${stickers}</div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Ошибка загрузки стикеров:', error);
    }
}

async function uploadStickerImage(packId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        if (!input.files || !input.files[0]) return;
        const formData = new FormData();
        formData.append('file', input.files[0]);

        try {
            const response = await fetch(`/admin/stickers/packs/${packId}/upload`, {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            if (data.success) {
                loadStickers();
            } else {
                alert(data.error || 'Ошибка загрузки');
            }
        } catch (error) {
            console.error('Ошибка:', error);
            alert('Ошибка загрузки');
        }
    };
    input.click();
}

function showAddStickerPackModal() {
    addStickerPack();
}

async function addStickerPack() {
    const name = prompt('Название стикерпака:');
    if (!name) return;

    const premium = confirm('Сделать стикерпак Premium?');

    try {
        const response = await fetch('/admin/stickers/packs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, is_premium: premium ? 1 : 0})
        });

        const data = await response.json();
        if (data.success) {
            loadStickers();
        } else {
            alert(data.error || 'Ошибка');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка');
    }
}

async function addStickerToPack(packId) {
    const emoji = prompt('Emoji (например 😀):');
    if (!emoji) return;
    const url = prompt('URL/значение (можно оставить пустым):', emoji) || emoji;

    try {
        const response = await fetch(`/admin/stickers/packs/${packId}/stickers`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({emoji, url})
        });

        const data = await response.json();
        if (data.success) {
            loadStickers();
        } else {
            alert(data.error || 'Ошибка');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка');
    }
}

// ============= ЖАЛОБЫ + AUDIT =============

async function loadReports(status) {
    try {
        const response = await fetch(`/moderator/reports?status=${encodeURIComponent(status || 'open')}`);
        const data = await response.json();

        const list = document.getElementById('reports-list');
        if (!list) return;

        if (!data.success) {
            list.innerHTML = `<div style="text-align: center; padding: 40px;">${escapeHtml(data.error || 'Ошибка')}</div>`;
            return;
        }

        const reports = data.reports || [];
        if (reports.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 40px;">Нет жалоб</div>';
            return;
        }

        list.innerHTML = reports.map(r => {
            const msg = r.is_deleted ? '<i>Сообщение удалено</i>' : escapeHtml(r.message_content || '—');
            const reason = (r.reason || '').trim();
            const actions = (r.status === 'open') ? `
                <div class="action-buttons" style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
                    <button class="btn-danger" onclick="resolveReport(${r.id}, {action: 'delete_message'})">🗑️ Удалить</button>
                    <button class="btn-primary" onclick="resolveReport(${r.id}, {action: 'resolve', spam_block: true})">🚫 Спам-блок</button>
                    <button class="btn-primary" onclick="resolveReportPromptBan(${r.id})">⏱️ Бан</button>
                    <button class="btn-secondary" onclick="resolveReport(${r.id}, {action: 'resolve'})">✅ Закрыть</button>
                </div>
            ` : '';

            return `
                <div class="message-item">
                    <div class="message-header">
                        <div class="message-user">#${r.id} • @${escapeHtml(r.reporter_username)} → @${escapeHtml(r.sender_username)} • чат #${r.chat_id}</div>
                        <div class="message-time">${new Date(r.created_at).toLocaleString('ru-RU')}</div>
                    </div>
                    ${reason ? `<div class="message-text"><b>Причина:</b> ${escapeHtml(reason)}</div>` : ''}
                    <div class="message-text">${msg}</div>
                    ${actions}
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Ошибка загрузки жалоб:', e);
    }
}

async function resolveReportPromptBan(reportId) {
    const raw = prompt('Бан на сколько минут? (например 60)');
    if (!raw) return;
    const minutes = parseInt(raw, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        alert('Некорректное число минут');
        return;
    }
    await resolveReport(reportId, { action: 'resolve', ban_minutes: minutes });
}

async function resolveReport(reportId, payload) {
    try {
        const res = await fetch(`/moderator/report/${reportId}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || { action: 'resolve' })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка');
            return;
        }
        loadReports('open');
    } catch (e) {
        console.error('Ошибка resolve report:', e);
    }
}

async function loadAudit() {
    try {
        const response = await fetch('/admin/audit');
        const data = await response.json();

        const list = document.getElementById('audit-list');
        if (!list) return;

        if (!data.success) {
            list.innerHTML = `<div style="text-align: center; padding: 40px;">${escapeHtml(data.error || 'Ошибка')}</div>`;
            return;
        }

        const items = data.items || [];
        if (items.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 40px;">Пока пусто</div>';
            return;
        }

        list.innerHTML = items.map(it => {
            const who = it.actor_username ? '@' + it.actor_username : ('ID ' + it.actor_id);
            const when = new Date(it.created_at).toLocaleString('ru-RU');
            const details = it.details ? escapeHtml(JSON.stringify(it.details)) : '—';
            return `
                <div class="message-item">
                    <div class="message-header">
                        <div class="message-user">${escapeHtml(who)} • ${escapeHtml(it.action)}</div>
                        <div class="message-time">${when}</div>
                    </div>
                    <div class="message-text">${details}</div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Ошибка audit:', e);
    }
}

function escapeHtml(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// ============= SECURITY (IP EVENTS + BLOCKLIST) =============

async function loadSecurity() {
    try {
        const res = await fetch('/admin/security/ips');
        const data = await res.json();

        const eventsEl = document.getElementById('security-events');
        const blockedEl = document.getElementById('security-blocked');
        if (!eventsEl || !blockedEl) return;

        if (!data.success) {
            const msg = escapeHtml(data.error || 'Ошибка');
            eventsEl.innerHTML = `<div style="padding: 16px;">${msg}</div>`;
            blockedEl.innerHTML = `<div style="padding: 16px;">${msg}</div>`;
            return;
        }

        const events = data.events || [];
        const blocked = data.blocked || [];

        eventsEl.innerHTML = events.length ? events.map(e => `
            <div class="message-item">
                <div class="message-header">
                    <div class="message-user">${escapeHtml(e.ip)} • ${escapeHtml(e.kind)}</div>
                    <div class="message-time">${new Date(e.created_at).toLocaleString('ru-RU')}</div>
                </div>
                <div class="message-text">${escapeHtml(e.endpoint || '—')}</div>
            </div>
        `).join('') : '<div style="padding: 16px;">Нет событий</div>';

        blockedEl.innerHTML = blocked.length ? blocked.map(b => `
            <div class="message-item">
                <div class="message-header">
                    <div class="message-user">${escapeHtml(b.ip)}</div>
                    <div class="message-time">${new Date(b.created_at).toLocaleString('ru-RU')}</div>
                </div>
                <div class="message-text">${escapeHtml(b.reason || '—')}</div>
                <div class="action-buttons" style="margin-top:12px;">
                    <button class="btn-secondary" onclick="unblockIp('${escapeHtml(b.ip)}')">Разблокировать</button>
                </div>
            </div>
        `).join('') : '<div style="padding: 16px;">Блоклист пуст</div>';
    } catch (e) {
        console.error('Security load error:', e);
    }
}

async function promptBlockIp() {
    const ip = (prompt('IP для блокировки:') || '').trim();
    if (!ip) return;
    const reason = (prompt('Причина (необязательно):') || '').trim();
    await blockIp(ip, reason);
}

async function blockIp(ip, reason) {
    try {
        const res = await fetch('/admin/security/ip/block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, reason })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка');
            return;
        }
        loadSecurity();
    } catch (e) {
        console.error('Block ip error:', e);
    }
}

async function unblockIp(ip) {
    try {
        const res = await fetch('/admin/security/ip/unblock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка');
            return;
        }
        loadSecurity();
    } catch (e) {
        console.error('Unblock ip error:', e);
    }
}

// ============= СООБЩЕНИЯ =============

async function loadMessages() {
    try {
        const response = await fetch('/admin/messages');
        const data = await response.json();
        const list = document.getElementById('messages-list');
        
        if (!data.messages) {
            list.innerHTML = '<div style="text-align: center; padding: 40px; background: white; border-radius: 15px;">Нет данных</div>';
            return;
        }

        list.innerHTML = data.messages.map(m => `
            <div class="message-item">
                <div class="message-header">
                    <div class="message-user">@${m.username} • чат #${m.chat_id}</div>
                    <div class="message-time">${new Date(m.created_at).toLocaleString('ru-RU')}</div>
                </div>
                <div class="message-text">${m.is_deleted ? '<i>Сообщение удалено</i>' : (m.content || '—')}</div>
                <div class="action-buttons" style="margin-top:12px;">
                    <button class="btn-danger" onclick="adminDeleteMessage(${m.id})" ${m.is_deleted ? 'disabled' : ''}>
                        🗑️ Удалить
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Ошибка загрузки сообщений:', error);
    }
}

async function adminDeleteMessage(messageId) {
    if (!confirm('Удалить сообщение?')) return;
    try {
        const response = await fetch(`/admin/message/${messageId}/delete`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            loadMessages();
        } else {
            alert(data.error || 'Ошибка');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка');
    }
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
