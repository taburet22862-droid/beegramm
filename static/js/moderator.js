let currentUser = null;
let selectedSupportChatId = null;
let searchTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
    const savedUser = localStorage.getItem('beegram_user');
    if (!savedUser) {
        window.location.href = '/';
        return;
    }

    currentUser = JSON.parse(savedUser);

    // На клиенте фильтруем, но сервер всё равно проверяет
    if (!currentUser.is_moderator && !currentUser.is_admin) {
        alert('Доступ запрещён');
        window.location.href = '/';
        return;
    }

    document.getElementById('mod-name').textContent = currentUser.nickname || currentUser.username;
    const avatarUrl = currentUser.avatar !== 'default.png'
        ? `/uploads/${currentUser.avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    document.getElementById('mod-avatar').src = avatarUrl;

    await loadSupportChats();
});

function backToApp() {
    window.location.href = '/';
}

function showSection(name) {
    document.querySelectorAll('.mod-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById(`section-${name}`).classList.add('active');
    event.target.classList.add('active');

    if (name === 'support') loadSupportChats();
    if (name === 'reports') loadReports('open');
}

async function loadReports(status) {
    try {
        const res = await fetch(`/moderator/reports?status=${encodeURIComponent(status || 'open')}`);
        const data = await res.json();
        if (!data.success) {
            console.error(data.error);
            return;
        }

        const root = document.getElementById('reports-list');
        if (!root) return;
        const reports = data.reports || [];
        if (reports.length === 0) {
            root.innerHTML = '<div style="color:#94a3b8; padding: 10px;">Нет жалоб</div>';
            return;
        }

        root.innerHTML = reports.map(r => {
            const msg = r.is_deleted ? '<i>Сообщение удалено</i>' : (r.message_content || '—');
            const reason = (r.reason || '').trim();
            const reasonHtml = reason ? `<div class="meta">Причина: ${escapeHtml(reason)}</div>` : '';
            const actions = (r.status === 'open') ? `
                <div style="display:flex; gap:8px; flex-wrap: wrap; margin-top:10px;">
                    <button class="btn-danger" onclick="resolveReport(${r.id}, {action: 'delete_message'})">🗑️ Удалить</button>
                    <button class="btn-primary" onclick="resolveReport(${r.id}, {action: 'resolve', spam_block: true})">🚫 Спам-блок</button>
                    <button class="btn-primary" onclick="resolveReportPromptBan(${r.id})">⏱️ Бан</button>
                    <button class="btn-primary" onclick="resolveReport(${r.id}, {action: 'resolve'})">✅ Закрыть</button>
                </div>
            ` : '';

            return `
                <div class="user-card" style="align-items:flex-start;">
                    <div style="flex:1;">
                        <div><strong>#${r.id}</strong> • от <strong>@${r.reporter_username}</strong> на <strong>@${r.sender_username}</strong> • чат #${r.chat_id}</div>
                        <div class="meta">${new Date(r.created_at).toLocaleString('ru-RU')}</div>
                        ${reasonHtml}
                        <div style="margin-top:8px; padding:10px; border-radius:10px; background: rgba(255,255,255,0.04);">${escapeHtml(msg)}</div>
                        ${actions}
                    </div>
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

function escapeHtml(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

async function loadSupportChats() {
    try {
        const res = await fetch('/moderator/support/chats');
        const data = await res.json();
        if (!data.success) {
            console.error(data.error);
            return;
        }

        const list = document.getElementById('support-chats');
        list.innerHTML = '';

        const chats = data.chats || [];
        if (chats.length === 0) {
            list.innerHTML = '<div style="color:#94a3b8; padding: 10px;">Нет диалогов</div>';
            return;
        }

        chats.forEach(item => {
            const user = item.user;
            const last = item.last_message;
            const div = document.createElement('div');
            div.className = 'chat-row' + (selectedSupportChatId === item.chat_id ? ' active' : '');
            div.innerHTML = `
                <div><strong>@${user?.username || 'unknown'}</strong> ${user?.nickname ? '— ' + user.nickname : ''}</div>
                <div class="small">${last ? (last.message_type === 'text' ? (last.content || '') : '[' + last.message_type + ']') : 'Нет сообщений'}</div>
            `;
            div.addEventListener('click', () => {
                selectedSupportChatId = item.chat_id;
                document.querySelectorAll('.chat-row').forEach(x => x.classList.remove('active'));
                div.classList.add('active');
                const sel = document.getElementById('support-selected');
                if (sel) sel.textContent = `Диалог: @${user?.username || 'unknown'}`;
            });
            list.appendChild(div);
        });
    } catch (e) {
        console.error('Ошибка загрузки поддержки:', e);
    }
}

async function sendSupportReply() {
    const text = (document.getElementById('support-reply').value || '').trim();
    if (!selectedSupportChatId) {
        alert('Выберите диалог');
        return;
    }
    if (!text) return;

    try {
        const res = await fetch('/moderator/support/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: selectedSupportChatId, content: text })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка отправки');
            return;
        }
        document.getElementById('support-reply').value = '';
        loadSupportChats();
    } catch (e) {
        console.error('Ошибка отправки:', e);
    }
}

function searchUsers() {
    const q = (document.getElementById('user-search').value || '').trim();
    clearTimeout(searchTimeout);

    if (q.length < 2) {
        document.getElementById('user-results').innerHTML = '';
        return;
    }

    searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`/moderator/users/search?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            if (!data.success) {
                console.error(data.error);
                return;
            }
            renderUsers(data.users || []);
        } catch (e) {
            console.error('Ошибка поиска:', e);
        }
    }, 250);
}

function renderUsers(users) {
    const root = document.getElementById('user-results');
    root.innerHTML = '';

    if (users.length === 0) {
        root.innerHTML = '<div style="color:#94a3b8; padding: 10px;">Ничего не найдено</div>';
        return;
    }

    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-card';
        div.innerHTML = `
            <div>
                <div><strong>@${u.username}</strong> ${u.nickname ? '— ' + u.nickname : ''}</div>
                <div class="meta">ID: ${u.id} • Спам-блок: ${u.spam_blocked ? 'да' : 'нет'}</div>
            </div>
            <div>
                ${u.spam_blocked ? `<button class="btn-primary" onclick="setSpamBlock(${u.id}, 0)">Снять</button>` : `<button class="btn-danger" onclick="setSpamBlock(${u.id}, 1)">Выдать</button>`}
            </div>
        `;
        root.appendChild(div);
    });
}

async function setSpamBlock(userId, value) {
    try {
        const res = await fetch(`/moderator/user/${userId}/spam_block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spam_blocked: value })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка');
            return;
        }
        searchUsers();
    } catch (e) {
        console.error('Ошибка spam-block:', e);
    }
}
