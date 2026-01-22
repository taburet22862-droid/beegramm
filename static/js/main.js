// BeeGramm - Клиентская часть 🐝

let socket;
let currentUser = null;
let currentChat = null;
let typingTimeout = null;

// ============= ИНИЦИАЛИЗАЦИЯ =============

document.addEventListener('DOMContentLoaded', () => {
    // Переключение вкладок авторизации
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(`${tabName}-form`).classList.add('active');
        });
    });
    
    // Проверяем сохранённую сессию
    const savedUser = localStorage.getItem('beegram_user');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        initApp();
    }
    
    // Применяем сохранённую тему
    const savedTheme = localStorage.getItem('beegram_theme') || 'light';
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        document.getElementById('theme-toggle').textContent = '☀️';
    }
});

// ============= АВТОРИЗАЦИЯ =============

async function register() {
    const username = document.getElementById('register-username').value.trim();
    const nickname = document.getElementById('register-nickname').value.trim();
    const password = document.getElementById('register-password').value;
    const errorDiv = document.getElementById('register-error');
    
    errorDiv.textContent = '';
    
    if (!username || !password) {
        errorDiv.textContent = 'Заполните все обязательные поля!';
        return;
    }
    
    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, nickname: nickname || username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Автоматически входим
            await login();
        } else {
            errorDiv.textContent = data.error || 'Ошибка регистрации';
        }
    } catch (error) {
        errorDiv.textContent = 'Ошибка соединения с сервером';
        console.error(error);
    }
}

async function login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');
    
    errorDiv.textContent = '';
    
    if (!username || !password) {
        errorDiv.textContent = 'Заполните все поля!';
        return;
    }
    
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('beegram_user', JSON.stringify(currentUser));
            initApp();
        } else {
            errorDiv.textContent = data.error || 'Ошибка входа';
        }
    } catch (error) {
        errorDiv.textContent = 'Ошибка соединения с сервером';
        console.error(error);
    }
}

// ============= ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ =============

function initApp() {
    // Скрываем экран авторизации
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    
    // Обновляем информацию о пользователе
    updateUserInfo();
    
    // Подключаемся к Socket.IO
    connectSocket();
    
    // Загружаем чаты
    loadChats();
    
    // Загружаем стикеры
    loadStickers();
}

function updateUserInfo() {
    const displayName = currentUser.nickname || currentUser.username;
    document.getElementById('sidebar-name').textContent = displayName + (currentUser.is_premium ? ' ⭐' : '');
    document.getElementById('sidebar-stars').textContent = `${currentUser.bee_stars} 🐝`;
    
    const avatarUrl = currentUser.avatar !== 'default.png' 
        ? `/uploads/${currentUser.avatar}` 
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    document.getElementById('sidebar-avatar').src = avatarUrl;
    
    // Показываем кнопку админа, если пользователь админ
    if (currentUser.is_admin) {
        document.getElementById('admin-btn').style.display = 'block';
    }
    
    // Скрываем кнопку Premium, если уже есть Premium
    if (currentUser.is_premium) {
        document.getElementById('premium-btn').style.display = 'none';
    }
}

// ============= SOCKET.IO =============

function connectSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('🐝 Подключено к серверу!');
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Отключено от сервера');
    });
    
    socket.on('new_message', (message) => {
        if (currentChat && message.chat_id === currentChat.id) {
            appendMessage(message);
            scrollToBottom();
        }
        
        // Обновляем список чатов
        loadChats();
        
        // Воспроизводим звук (можно добавить)
        playMessageSound();
    });
    
    socket.on('reactions_updated', (data) => {
        updateMessageReactions(data.message_id, data.reactions);
    });
    
    socket.on('user_typing', (data) => {
        if (currentChat && data.user_id !== currentUser.id) {
            showTypingIndicator(data.username, data.is_typing);
        }
    });
    
    socket.on('bee_stars_updated', (data) => {
        if (data.user_id === currentUser.id) {
            currentUser.bee_stars = data.bee_stars;
            updateUserInfo();
        }
    });
}

// ============= ЧАТЫ =============

async function loadChats() {
    try {
        const response = await fetch('/chats/list');
        const data = await response.json();
        
        if (data.chats) {
            renderChats(data.chats);
        }
    } catch (error) {
        console.error('Ошибка загрузки чатов:', error);
    }
}

function renderChats(chats) {
    const chatsList = document.getElementById('chats-list');
    chatsList.innerHTML = '';
    
    if (chats.length === 0) {
        chatsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Нет чатов. Создайте новый! 🐝</div>';
        return;
    }
    
    chats.forEach(chat => {
        const chatItem = document.createElement('div');
        chatItem.className = 'chat-item';
        if (currentChat && currentChat.id === chat.id) {
            chatItem.classList.add('active');
        }
        
        const avatarUrl = chat.avatar && chat.avatar !== 'default.png'
            ? `/uploads/${chat.avatar}`
            : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👥</text></svg>';
        
        const premiumBadge = chat.other_user && chat.other_user.is_premium ? '👑' : '';
        
        let lastMessageText = '';
        if (chat.last_message) {
            const prefix = chat.last_message.user_id === currentUser.id ? 'Вы: ' : '';
            lastMessageText = prefix + (chat.last_message.content || '📎 Файл');
        }
        
        chatItem.innerHTML = `
            <img src="${avatarUrl}" alt="Avatar" class="avatar-medium">
            <div class="chat-item-info">
                <div class="chat-item-name">
                    ${chat.name || 'Чат'}
                    ${premiumBadge}
                </div>
                <div class="chat-item-last-message">${lastMessageText || 'Нет сообщений'}</div>
            </div>
            <div class="chat-item-meta">
                ${chat.last_message ? `<div class="chat-item-time">${formatTime(chat.last_message.created_at)}</div>` : ''}
                ${chat.unread_count > 0 ? `<div class="unread-badge">${chat.unread_count}</div>` : ''}
            </div>
        `;
        
        chatItem.addEventListener('click', () => openChat(chat));
        chatsList.appendChild(chatItem);
    });
}

async function openChat(chat) {
    currentChat = chat;
    
    // Обновляем активный чат в списке
    document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
    event.currentTarget?.classList.add('active');
    
    // Показываем контейнер чата
    document.getElementById('no-chat-selected').style.display = 'none';
    document.getElementById('chat-container').style.display = 'flex';
    
    // Обновляем шапку чата
    const avatarUrl = chat.avatar && chat.avatar !== 'default.png'
        ? `/uploads/${chat.avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👥</text></svg>';
    
    document.getElementById('chat-avatar').src = avatarUrl;
    document.getElementById('chat-name').textContent = chat.name || 'Чат';
    document.getElementById('chat-status').textContent = chat.other_user ? chat.other_user.status : '';
    
    // Присоединяемся к комнате
    if (socket) {
        socket.emit('join_chat', { chat_id: chat.id });
    }
    
    // Загружаем сообщения
    await loadMessages(chat.id);
}

async function loadMessages(chatId) {
    try {
        const response = await fetch(`/chats/${chatId}/messages`);
        const data = await response.json();
        
        if (data.messages) {
            renderMessages(data.messages);
            scrollToBottom();
        }
    } catch (error) {
        console.error('Ошибка загрузки сообщений:', error);
    }
}

function renderMessages(messages) {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    
    messages.forEach(message => {
        appendMessage(message);
    });
}

function appendMessage(message) {
    const container = document.getElementById('messages-container');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.dataset.messageId = message.id;
    
    const isOwn = message.user_id === currentUser.id;
    if (isOwn) {
        messageDiv.classList.add('own');
    }
    
    const avatarUrl = message.avatar && message.avatar !== 'default.png'
        ? `/uploads/${message.avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    const premiumBadge = message.is_premium ? '👑' : '';
    const senderName = message.nickname || message.username;
    
    let contentHTML = '';
    
    if (message.message_type === 'text' || message.message_type === 'system') {
        contentHTML = `<div class="message-bubble ${message.message_type === 'system' ? 'system' : ''}">${escapeHtml(message.content)}</div>`;
    } else if (message.message_type === 'image') {
        contentHTML = `
            <div class="message-bubble">
                ${message.content ? escapeHtml(message.content) : ''}
                <img src="/uploads/${message.file_url}" alt="Image" class="message-image">
            </div>
        `;
    } else if (message.message_type === 'file') {
        const fileName = message.file_url.split('/').pop();
        contentHTML = `
            <div class="message-bubble">
                ${message.content ? escapeHtml(message.content) : ''}
                <div class="message-file">
                    <span>📎 ${fileName}</span>
                    <a href="/uploads/${message.file_url}" download>⬇️</a>
                </div>
            </div>
        `;
    } else if (message.message_type === 'sticker') {
        contentHTML = `<div class="message-bubble" style="background: transparent; font-size: 64px;">${message.content}</div>`;
    }
    
    // Реакции
    let reactionsHTML = '';
    if (message.reactions && message.reactions.length > 0) {
        const reactionGroups = {};
        message.reactions.forEach(r => {
            if (!reactionGroups[r.emoji]) {
                reactionGroups[r.emoji] = [];
            }
            reactionGroups[r.emoji].push(r.username);
        });
        
        reactionsHTML = '<div class="message-reactions">';
        for (const [emoji, users] of Object.entries(reactionGroups)) {
            reactionsHTML += `
                <div class="reaction" onclick="toggleReaction(${message.id}, '${emoji}')" title="${users.join(', ')}">
                    ${emoji} <span class="reaction-count">${users.length}</span>
                </div>
            `;
        }
        reactionsHTML += '</div>';
    }
    
    messageDiv.innerHTML = `
        ${!isOwn ? `<img src="${avatarUrl}" alt="Avatar" class="message-avatar">` : ''}
        <div class="message-content">
            ${!isOwn && message.message_type !== 'system' ? `<div class="message-sender">${senderName} ${premiumBadge}</div>` : ''}
            ${contentHTML}
            ${reactionsHTML}
            <div class="message-time">${formatTime(message.created_at)}</div>
        </div>
        ${isOwn ? `<img src="${avatarUrl}" alt="Avatar" class="message-avatar">` : ''}
    `;
    
    // Добавляем контекстное меню для реакций
    if (message.message_type !== 'system') {
        const bubble = messageDiv.querySelector('.message-bubble');
        bubble.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showReactionMenu(e, message.id);
        });
    }
    
    container.appendChild(messageDiv);
}

function showReactionMenu(event, messageId) {
    const reactions = ['🐝', '🍯', '🌻', '❤️', '😂', '👍', '🎉'];
    
    // Создаём меню реакций
    const menu = document.createElement('div');
    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    menu.style.background = 'white';
    menu.style.border = '2px solid #FFD700';
    menu.style.borderRadius = '10px';
    menu.style.padding = '5px';
    menu.style.display = 'flex';
    menu.style.gap = '5px';
    menu.style.zIndex = '10000';
    menu.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
    
    reactions.forEach(emoji => {
        const btn = document.createElement('button');
        btn.textContent = emoji;
        btn.style.fontSize = '24px';
        btn.style.border = 'none';
        btn.style.background = 'transparent';
        btn.style.cursor = 'pointer';
        btn.style.padding = '5px';
        btn.style.borderRadius = '5px';
        btn.addEventListener('click', () => {
            toggleReaction(messageId, emoji);
            document.body.removeChild(menu);
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.background = '#FFF8DC';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
        });
        menu.appendChild(btn);
    });
    
    document.body.appendChild(menu);
    
    // Закрываем меню при клике вне его
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            if (document.body.contains(menu)) {
                document.body.removeChild(menu);
            }
            document.removeEventListener('click', closeMenu);
        });
    }, 100);
}

function toggleReaction(messageId, emoji) {
    if (!socket || !currentChat) return;
    
    socket.emit('add_reaction', {
        message_id: messageId,
        user_id: currentUser.id,
        emoji: emoji,
        chat_id: currentChat.id
    });
}

function updateMessageReactions(messageId, reactions) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageDiv) return;
    
    let reactionsContainer = messageDiv.querySelector('.message-reactions');
    
    if (reactions.length === 0) {
        if (reactionsContainer) {
            reactionsContainer.remove();
        }
        return;
    }
    
    const reactionGroups = {};
    reactions.forEach(r => {
        if (!reactionGroups[r.emoji]) {
            reactionGroups[r.emoji] = [];
        }
        reactionGroups[r.emoji].push(r.username);
    });
    
    let reactionsHTML = '';
    for (const [emoji, users] of Object.entries(reactionGroups)) {
        reactionsHTML += `
            <div class="reaction" onclick="toggleReaction(${messageId}, '${emoji}')" title="${users.join(', ')}">
                ${emoji} <span class="reaction-count">${users.length}</span>
            </div>
        `;
    }
    
    if (!reactionsContainer) {
        reactionsContainer = document.createElement('div');
        reactionsContainer.className = 'message-reactions';
        const bubble = messageDiv.querySelector('.message-bubble');
        bubble.after(reactionsContainer);
    }
    
    reactionsContainer.innerHTML = reactionsHTML;
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    
    if (!content || !currentChat || !socket) return;
    
    socket.emit('send_message', {
        chat_id: currentChat.id,
        user_id: currentUser.id,
        content: content,
        message_type: 'text'
    });
    
    input.value = '';
    
    // Сбрасываем высоту textarea
    input.style.height = 'auto';
    
    // Анимация пчёлки
    animateBee();
}

function sendSticker(emoji) {
    if (!currentChat || !socket) return;
    
    socket.emit('send_message', {
        chat_id: currentChat.id,
        user_id: currentUser.id,
        content: emoji,
        message_type: 'sticker'
    });
    
    closeStickersModal();
    animateBee();
}

function handleMessageKeyPress(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function handleTyping() {
    // Автоматическое изменение высоты textarea
    const input = document.getElementById('message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    
    if (!socket || !currentChat) return;
    
    socket.emit('typing', {
        chat_id: currentChat.id,
        user_id: currentUser.id,
        is_typing: true
    });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', {
            chat_id: currentChat.id,
            user_id: currentUser.id,
            is_typing: false
        });
    }, 1000);
}

function showTypingIndicator(username, isTyping) {
    const indicator = document.getElementById('typing-indicator');
    const userSpan = document.getElementById('typing-user');
    
    if (isTyping) {
        userSpan.textContent = username;
        indicator.style.display = 'block';
    } else {
        indicator.style.display = 'none';
    }
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

function animateBee() {
    const bee = document.getElementById('bee-fly-animation');
    const input = document.getElementById('message-input');
    const rect = input.getBoundingClientRect();
    
    bee.style.left = rect.left + 'px';
    bee.style.top = rect.top + 'px';
    bee.classList.add('flying');
    
    setTimeout(() => {
        bee.classList.remove('flying');
    }, 1500);
}

function playMessageSound() {
    // Можно добавить звук
    // const audio = new Audio('/static/sounds/bee.mp3');
    // audio.play();
}

// ============= ЗАГРУЗКА ФАЙЛОВ =============

function openFileUpload() {
    document.getElementById('file-input').click();
}

async function uploadFile(input) {
    const file = input.files[0];
    if (!file || !currentChat) return;
    
    const maxSize = currentUser.is_premium ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
    
    if (file.size > maxSize) {
        alert(`Файл слишком большой! Максимум ${currentUser.is_premium ? '100' : '10'}МБ`);
        input.value = '';
        return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        // Показываем индикатор загрузки
        const loadingMsg = { 
            id: Date.now(), 
            user_id: currentUser.id, 
            content: 'Загрузка файла...', 
            message_type: 'text',
            nickname: currentUser.nickname,
            username: currentUser.username,
            avatar: currentUser.avatar,
            is_premium: currentUser.is_premium,
            created_at: new Date().toISOString()
        };
        appendMessage(loadingMsg);
        scrollToBottom();
        
        // Загружаем файл через HTTP
        const response = await fetch('/upload/file', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        // Удаляем сообщение о загрузке
        const loadingDiv = document.querySelector(`[data-message-id="${loadingMsg.id}"]`);
        if (loadingDiv) loadingDiv.remove();
        
        if (data.success) {
            // Отправляем сообщение с файлом
            const messageType = file.type.startsWith('image/') ? 'image' : 'file';
            
            socket.emit('send_message', {
                chat_id: currentChat.id,
                user_id: currentUser.id,
                content: data.filename,
                message_type: messageType,
                file_url: data.file_url
            });
            
            animateBee();
        } else {
            alert(data.error || 'Ошибка загрузки файла');
        }
        
    } catch (error) {
        console.error('Ошибка загрузки файла:', error);
        alert('Ошибка загрузки файла');
        
        // Удаляем сообщение о загрузке в случае ошибки
        const loadingDiv = document.querySelector(`[data-message-id="${Date.now()}"]`);
        if (loadingDiv) loadingDiv.remove();
    }
    
    input.value = '';
}

// ============= ПРОФИЛЬ =============

function openProfile() {
    const panel = document.getElementById('profile-panel');
    panel.classList.add('open');
    
    // Заполняем данные
    document.getElementById('profile-nickname').value = currentUser.nickname || '';
    document.getElementById('profile-username').value = currentUser.username;
    document.getElementById('profile-bio').value = currentUser.bio || '';
    document.getElementById('profile-status').value = currentUser.status || '';
    document.getElementById('profile-stars').textContent = currentUser.bee_stars;
    
    const avatarUrl = currentUser.avatar !== 'default.png'
        ? `/uploads/${currentUser.avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    document.getElementById('profile-avatar').src = avatarUrl;
    
    const premiumBadge = document.getElementById('premium-badge');
    if (currentUser.is_premium) {
        premiumBadge.textContent = '👑 Premium';
        premiumBadge.style.color = '#FFD700';
    } else {
        premiumBadge.textContent = 'Обычный';
        premiumBadge.style.color = '#666';
    }
}

function closeProfile() {
    document.getElementById('profile-panel').classList.remove('open');
}

async function saveProfile() {
    const nickname = document.getElementById('profile-nickname').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();
    const status = document.getElementById('profile-status').value.trim();
    
    try {
        const response = await fetch('/profile/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, bio, status })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser.nickname = nickname;
            currentUser.bio = bio;
            currentUser.status = status;
            localStorage.setItem('beegram_user', JSON.stringify(currentUser));
            updateUserInfo();
            alert('Профиль обновлён! 🐝');
        }
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        alert('Ошибка обновления профиля');
    }
}

function changeAvatar() {
    document.getElementById('avatar-input').click();
}

async function uploadAvatar(input) {
    const file = input.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        alert('Выберите изображение!');
        return;
    }
    
    const formData = new FormData();
    formData.append('avatar', file);
    
    try {
        const response = await fetch('/profile/avatar', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser.avatar = data.avatar;
            localStorage.setItem('beegram_user', JSON.stringify(currentUser));
            updateUserInfo();
            document.getElementById('profile-avatar').src = `/uploads/${data.avatar}`;
            alert('Аватар обновлён! 📸');
        }
    } catch (error) {
        console.error('Ошибка загрузки аватара:', error);
        alert('Ошибка загрузки аватара');
    }
    
    input.value = '';
}

// ============= НОВЫЙ ЧАТ =============

function openNewChat() {
    document.getElementById('new-chat-modal').classList.add('open');
    document.getElementById('user-search').value = '';
    document.getElementById('users-list').innerHTML = '';
}

function closeNewChatModal() {
    document.getElementById('new-chat-modal').classList.remove('open');
}

let searchTimeout;
async function searchUsers() {
    const query = document.getElementById('user-search').value.trim();
    
    clearTimeout(searchTimeout);
    
    if (query.length < 2) {
        document.getElementById('users-list').innerHTML = '';
        return;
    }
    
    searchTimeout = setTimeout(async () => {
        try {
            const response = await fetch(`/users/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();
            
            renderUsersList(data.users || []);
        } catch (error) {
            console.error('Ошибка поиска пользователей:', error);
        }
    }, 300);
}

function renderUsersList(users) {
    const usersList = document.getElementById('users-list');
    usersList.innerHTML = '';
    
    if (users.length === 0) {
        usersList.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Пользователи не найдены</div>';
        return;
    }
    
    users.forEach(user => {
        if (user.id === currentUser.id) return; // Пропускаем себя
        
        const userItem = document.createElement('div');
        userItem.className = 'user-item';
        
        const avatarUrl = user.avatar !== 'default.png'
            ? `/uploads/${user.avatar}`
            : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
        
        const premiumBadge = user.is_premium ? '👑' : '';
        
        userItem.innerHTML = `
            <img src="${avatarUrl}" alt="Avatar" class="avatar-medium">
            <div class="user-item-info">
                <div class="user-item-name">${user.nickname || user.username} ${premiumBadge}</div>
                <div class="user-item-username">@${user.username} • ${user.bee_stars} 🐝</div>
            </div>
        `;
        
        userItem.addEventListener('click', () => createChat(user.id));
        usersList.appendChild(userItem);
    });
}

async function createChat(otherUserId) {
    try {
        const response = await fetch('/chats/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                is_group: false,
                members: [otherUserId]
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            closeNewChatModal();
            await loadChats();
            
            // Открываем созданный чат
            const chats = await fetch('/chats/list').then(r => r.json());
            const newChat = chats.chats.find(c => c.id === data.chat_id);
            if (newChat) {
                openChat(newChat);
            }
        }
    } catch (error) {
        console.error('Ошибка создания чата:', error);
        alert('Ошибка создания чата');
    }
}

// ============= СТИКЕРЫ =============

async function loadStickers() {
    try {
        const response = await fetch('/stickers');
        const data = await response.json();
        
        if (data.packs) {
            window.stickerPacks = data.packs;
        }
    } catch (error) {
        console.error('Ошибка загрузки стикеров:', error);
    }
}

function openStickers() {
    const modal = document.getElementById('stickers-modal');
    modal.classList.add('open');
    
    const container = document.getElementById('stickers-container');
    container.innerHTML = '';
    
    if (!window.stickerPacks || window.stickerPacks.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center;">Стикеры не загружены</div>';
        return;
    }
    
    window.stickerPacks.forEach(pack => {
        const packDiv = document.createElement('div');
        packDiv.className = 'sticker-pack';
        
        const packName = document.createElement('div');
        packName.className = 'sticker-pack-name';
        packName.textContent = pack.name;
        packDiv.appendChild(packName);
        
        const grid = document.createElement('div');
        grid.className = 'sticker-pack-grid';
        
        pack.stickers.forEach(sticker => {
            const stickerItem = document.createElement('div');
            stickerItem.className = 'sticker-item';
            stickerItem.textContent = sticker.emoji;
            stickerItem.addEventListener('click', () => sendSticker(sticker.emoji));
            grid.appendChild(stickerItem);
        });
        
        packDiv.appendChild(grid);
        container.appendChild(packDiv);
    });
}

function closeStickersModal() {
    document.getElementById('stickers-modal').classList.remove('open');
}

// ============= ИНФОРМАЦИЯ О ЧАТЕ =============

function openChatInfo() {
    if (!currentChat) return;
    
    const modal = document.getElementById('chat-info-modal');
    modal.classList.add('open');
    
    const content = document.getElementById('chat-info-content');
    
    if (currentChat.is_group) {
        content.innerHTML = `
            <h3>Групповой чат</h3>
            <p><strong>Название:</strong> ${currentChat.name}</p>
            <p><strong>Участников:</strong> ${currentChat.members?.length || 0}</p>
        `;
    } else if (currentChat.other_user) {
        const user = currentChat.other_user;
        const premiumBadge = user.is_premium ? '👑 Premium' : 'Обычный';
        
        content.innerHTML = `
            <div style="text-align: center; margin-bottom: 20px;">
                <img src="/uploads/${user.avatar}" alt="Avatar" style="width: 100px; height: 100px; border-radius: 50%; border: 3px solid #FFD700;">
            </div>
            <p><strong>Никнейм:</strong> ${user.nickname || user.username}</p>
            <p><strong>Username:</strong> @${user.username}</p>
            <p><strong>Статус:</strong> ${user.status || 'Не указан'}</p>
            <p><strong>Пчёлки:</strong> ${user.bee_stars || 0} 🐝</p>
            <p><strong>Тип аккаунта:</strong> ${premiumBadge}</p>
        `;
    }
}

function closeChatInfoModal() {
    document.getElementById('chat-info-modal').classList.remove('open');
}

// ============= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Закрытие модальных окон по клику вне их
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('open');
    }
});

// ============= ТЁМНАЯ ТЕМА =============

function toggleTheme() {
    const body = document.body;
    const themeToggle = document.getElementById('theme-toggle');
    const isDark = body.classList.toggle('dark-theme');
    
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    
    // Сохраняем в localStorage
    localStorage.setItem('beegram_theme', isDark ? 'dark' : 'light');
    
    // Отправляем на сервер
    if (currentUser) {
        fetch('/profile/update', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({theme: isDark ? 'dark' : 'light'})
        });
    }
}

// ============= PREMIUM =============

function openPremiumModal() {
    document.getElementById('premium-modal').classList.add('open');
}

function closePremiumModal() {
    document.getElementById('premium-modal').classList.remove('open');
}

async function activatePremium() {
    const keyInput = document.getElementById('premium-key-input');
    const keyCode = keyInput.value.trim().toUpperCase();
    
    if (!keyCode) {
        alert('Введите ключ активации');
        return;
    }
    
    try {
        const response = await fetch('/premium/activate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({key_code: keyCode})
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert(data.message);
            currentUser.is_premium = 1;
            localStorage.setItem('beegram_user', JSON.stringify(currentUser));
            updateUserInfo();
            closePremiumModal();
            keyInput.value = '';
        } else {
            alert(data.error || 'Ошибка активации');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка активации Premium');
    }
}

// ============= АДМИН-ПАНЕЛЬ =============

async function openAdminPanel() {
    document.getElementById('admin-panel-modal').classList.add('open');
    await loadAdminUsers();
}

function closeAdminPanel() {
    document.getElementById('admin-panel-modal').classList.remove('open');
}

function showAdminTab(tabName) {
    // Переключаем вкладки
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(content => content.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(`admin-tab-${tabName}`).classList.add('active');
    
    // Загружаем данные
    if (tabName === 'users') {
        loadAdminUsers();
    } else if (tabName === 'keys') {
        loadAdminKeys();
    }
}

async function loadAdminUsers() {
    try {
        const response = await fetch('/admin/users');
        const data = await response.json();
        
        if (data.users) {
            const list = document.getElementById('admin-users-list');
            list.innerHTML = data.users.map(user => `
                <div class="admin-user-item">
                    <div class="admin-user-header">
                        <div class="admin-user-info">
                            <div class="admin-user-name">
                                ${user.nickname || user.username}
                                ${user.is_premium ? '⭐' : ''}
                                ${user.is_admin ? '👑' : ''}
                            </div>
                            <div class="admin-user-meta">
                                @${user.username} • ${user.bee_stars} 🐝
                            </div>
                        </div>
                    </div>
                    <div class="admin-user-actions">
                        <button class="btn-admin-premium" onclick="toggleUserPremium(${user.id}, ${user.is_premium})">
                            ${user.is_premium ? '❌ Забрать Premium' : '⭐ Выдать Premium'}
                        </button>
                        <button class="btn-admin-stars" onclick="changeUserStars(${user.id})">
                            🐝 Изменить пчёлок
                        </button>
                        ${user.id !== currentUser.id ? `
                            <button class="btn-admin-delete" onclick="deleteUser(${user.id})">
                                🗑️ Удалить
                            </button>
                        ` : ''}
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

async function toggleUserPremium(userId, currentStatus) {
    try {
        const response = await fetch(`/admin/user/${userId}/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({is_premium: currentStatus ? 0 : 1})
        });
        
        const data = await response.json();
        if (data.success) {
            loadAdminUsers();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function changeUserStars(userId) {
    const amount = prompt('Введите новое количество пчёлок:');
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
            loadAdminUsers();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function deleteUser(userId) {
    if (!confirm('Удалить пользователя?')) return;
    
    try {
        const response = await fetch(`/admin/user/${userId}/delete`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (data.success) {
            loadAdminUsers();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

async function loadAdminKeys() {
    try {
        const response = await fetch('/admin/keys');
        const data = await response.json();
        
        if (data.keys) {
            const list = document.getElementById('admin-keys-list');
            list.innerHTML = data.keys.map(key => `
                <div class="admin-key-item">
                    <div>
                        <div class="admin-key-code">${key.key_code}</div>
                        ${key.is_used ? `<small>Использован: ${key.username || 'Неизвестно'}</small>` : ''}
                    </div>
                    <span class="admin-key-status ${key.is_used ? 'used' : 'unused'}">
                        ${key.is_used ? '❌ Использован' : '✅ Доступен'}
                    </span>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки ключей:', error);
    }
}

async function generateKeys() {
    const count = prompt('Сколько ключей сгенерировать?', '5');
    if (!count) return;
    
    const num = parseInt(count);
    if (isNaN(num) || num < 1 || num > 100) {
        alert('Введите число от 1 до 100');
        return;
    }
    
    try {
        const response = await fetch('/admin/keys/generate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({count: num})
        });
        
        const data = await response.json();
        if (data.success) {
            alert(`Сгенерировано ${num} ключей:\n\n` + data.keys.join('\n'));
            loadAdminKeys();
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

let currentCall = null;
let callTimer = null;
let callDuration = 0;

function startCall(callType) {
    if (!currentChat || !socket) return;
    
    const receiverId = currentChat.other_user?.id;
    if (!receiverId) {
        alert('Звонки доступны только в личных чатах');
        return;
    }
    
    // Отправляем запрос на звонок
    socket.emit('start_call', {
        chat_id: currentChat.id,
        caller_id: currentUser.id,
        receiver_id: receiverId,
        call_type: callType
    });
}

// Обработчик начала звонка
socket?.on('call_started', (data) => {
    currentCall = data;
    
    // Показываем окно активного звонка
    const modal = document.getElementById('active-call-modal');
    const avatar = document.getElementById('active-call-avatar');
    const name = document.getElementById('active-call-name');
    const statusText = document.getElementById('call-status-text');
    
    const avatarUrl = currentChat.other_user?.avatar !== 'default.png'
        ? `/uploads/${currentChat.other_user.avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    avatar.src = avatarUrl;
    name.textContent = currentChat.other_user?.nickname || currentChat.other_user?.username || 'Пользователь';
    statusText.textContent = 'Вызов...';
    
    modal.classList.add('open');
    
    // Воспроизводим звук вызова (можно добавить)
    playCallSound();
});

// Обработчик входящего звонка
socket?.on('incoming_call', (data) => {
    currentCall = data;
    
    // Показываем окно входящего звонка
    const modal = document.getElementById('incoming-call-modal');
    const avatar = document.getElementById('call-avatar');
    const callerName = document.getElementById('call-caller-name');
    const callTypeText = document.getElementById('call-type-text');
    
    const avatarUrl = data.caller_avatar !== 'default.png'
        ? `/uploads/${data.caller_avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    avatar.src = avatarUrl;
    callerName.textContent = data.caller_name;
    callTypeText.textContent = data.call_type === 'video' ? '📹 Видеозвонок' : '📞 Голосовой звонок';
    
    modal.classList.add('open');
    
    // Воспроизводим звук входящего звонка
    playRingtone();
});

function answerCall() {
    if (!currentCall || !socket) return;
    
    // Отправляем подтверждение
    socket.emit('answer_call', {
        call_id: currentCall.call_id,
        chat_id: currentCall.chat_id
    });
    
    // Закрываем окно входящего звонка
    document.getElementById('incoming-call-modal').classList.remove('open');
    
    // Показываем окно активного звонка
    const modal = document.getElementById('active-call-modal');
    const avatar = document.getElementById('active-call-avatar');
    const name = document.getElementById('active-call-name');
    
    const avatarUrl = currentCall.caller_avatar !== 'default.png'
        ? `/uploads/${currentCall.caller_avatar}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👤</text></svg>';
    
    avatar.src = avatarUrl;
    name.textContent = currentCall.caller_name;
    
    modal.classList.add('open');
    
    stopRingtone();
}

function rejectCall() {
    if (!currentCall || !socket) return;
    
    socket.emit('reject_call', {
        call_id: currentCall.call_id,
        chat_id: currentCall.chat_id
    });
    
    document.getElementById('incoming-call-modal').classList.remove('open');
    currentCall = null;
    
    stopRingtone();
}

function endCall() {
    if (!currentCall || !socket) return;
    
    socket.emit('end_call', {
        call_id: currentCall.call_id,
        chat_id: currentCall.chat_id,
        duration: callDuration
    });
    
    document.getElementById('active-call-modal').classList.remove('open');
    
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    callDuration = 0;
    currentCall = null;
    
    stopCallSound();
}

// Обработчик принятия звонка
socket?.on('call_answered', (data) => {
    const statusText = document.getElementById('call-status-text');
    statusText.textContent = 'Соединено';
    
    stopCallSound();
    
    // Запускаем таймер
    callDuration = 0;
    callTimer = setInterval(() => {
        callDuration++;
        const minutes = Math.floor(callDuration / 60);
        const seconds = callDuration % 60;
        document.getElementById('active-call-duration').textContent = 
            `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }, 1000);
});

// Обработчик отклонения звонка
socket?.on('call_rejected', (data) => {
    document.getElementById('active-call-modal').classList.remove('open');
    currentCall = null;
    
    stopCallSound();
    
    alert('Звонок отклонён');
});

// Обработчик завершения звонка
socket?.on('call_ended', (data) => {
    document.getElementById('active-call-modal').classList.remove('open');
    document.getElementById('incoming-call-modal').classList.remove('open');
    
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    callDuration = 0;
    currentCall = null;
    
    stopCallSound();
    stopRingtone();
    
    if (data.duration > 0) {
        const minutes = Math.floor(data.duration / 60);
        const seconds = data.duration % 60;
        console.log(`Звонок завершён. Длительность: ${minutes}:${String(seconds).padStart(2, '0')}`);
    }
});

// Звуковые эффекты (заглушки)
function playCallSound() {
    // Можно добавить звук вызова
    console.log('🔊 Звук вызова...');
}

function stopCallSound() {
    console.log('🔇 Звук вызова остановлен');
}

function playRingtone() {
    // Можно добавить мелодию звонка
    console.log('🔔 Входящий звонок...');
}

function stopRingtone() {
    console.log('🔇 Мелодия остановлена');
}
