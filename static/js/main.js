// BeeGramm - Клиентская часть 🐝

let socket;
let currentUser = null;
let currentChat = null;
let typingTimeout = null;
let voiceRecorder = null;
let voiceChunks = [];
let isRecording = false;
let lastNotifiedAt = 0;

let rtcPc = null;
let rtcLocalStream = null;
let rtcPeerUserId = null;
let rtcIncomingOffer = null;
let rtcMuted = false;

const RTC_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function getMaxMessageLength() {
    return currentUser?.is_premium ? 1000 : 500;
}

async function ensurePeerConnection(toUserId) {
    if (rtcPc) return;

    rtcPeerUserId = toUserId;
    rtcPc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });

    rtcPc.onicecandidate = (event) => {
        if (!event.candidate || !socket || !rtcPeerUserId || !currentChat) return;
        socket.emit('call_ice', { to_user_id: rtcPeerUserId, chat_id: currentChat.id, candidate: event.candidate });
    };

    rtcPc.ontrack = (event) => {
        const audio = document.getElementById('remote-audio');
        if (audio && event.streams && event.streams[0]) {
            audio.srcObject = event.streams[0];
        }
    };

    rtcPc.onconnectionstatechange = () => {
        if (!rtcPc) return;
        const st = rtcPc.connectionState;
        if (st === 'connected') {
            setCallStatus('✅ На связи');
            const muteBtn = document.getElementById('call-mute');
            if (muteBtn) muteBtn.style.display = 'inline-block';
        }
        if (st === 'failed' || st === 'disconnected' || st === 'closed') {
            // cleanup happens on hangup
        }
    };
}

async function getLocalAudioStream() {
    if (rtcLocalStream) return rtcLocalStream;
    rtcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return rtcLocalStream;
}

function openCallModal(text, incoming) {
    const modal = document.getElementById('call-modal');
    if (!modal) return;
    modal.classList.add('open');
    const accept = document.getElementById('call-accept');
    if (accept) accept.style.display = incoming ? 'inline-block' : 'none';
    const muteBtn = document.getElementById('call-mute');
    if (muteBtn) muteBtn.style.display = 'none';
    setCallStatus(text || '...');
}

function setCallStatus(text) {
    const el = document.getElementById('call-status');
    if (el) el.textContent = text;
}

function closeCallModalSoon() {
    const modal = document.getElementById('call-modal');
    if (!modal) return;
    setTimeout(() => {
        modal.classList.remove('open');
    }, 800);
}

function cleanupCall() {
    rtcIncomingOffer = null;
    rtcPeerUserId = null;
    rtcMuted = false;
    const muteBtn = document.getElementById('call-mute');
    if (muteBtn) muteBtn.textContent = 'Микрофон';

    try {
        if (rtcPc) {
            rtcPc.ontrack = null;
            rtcPc.onicecandidate = null;
            rtcPc.close();
        }
    } catch (e) {}
    rtcPc = null;

    try {
        if (rtcLocalStream) {
            rtcLocalStream.getTracks().forEach(t => t.stop());
        }
    } catch (e) {}
    rtcLocalStream = null;

    const audio = document.getElementById('remote-audio');
    if (audio) audio.srcObject = null;
}

async function startVoiceCall() {
    if (!socket || !currentChat || !currentChat.other_user) return;
    if (!isPrivateChat(currentChat)) return;
    if (rtcPc) {
        alert('Звонок уже активен');
        return;
    }

    openCallModal('📞 Звоним...', false);
    try {
        await ensurePeerConnection(currentChat.other_user.id);
        const stream = await getLocalAudioStream();
        stream.getTracks().forEach(track => rtcPc.addTrack(track, stream));

        const offer = await rtcPc.createOffer();
        await rtcPc.setLocalDescription(offer);

        socket.emit('call_offer', {
            to_user_id: currentChat.other_user.id,
            chat_id: currentChat.id,
            sdp: offer
        });
        setCallStatus('Ожидаем ответа...');
    } catch (e) {
        console.error('Call start error:', e);
        alert('Не удалось начать звонок (нет доступа к микрофону?)');
        cleanupCall();
        const modal = document.getElementById('call-modal');
        if (modal) modal.classList.remove('open');
    }
}

async function acceptCall() {
    if (!socket || !currentChat || !rtcPeerUserId || !rtcIncomingOffer) return;
    if (rtcPc) {
        // если почему-то уже есть
        return;
    }

    try {
        await ensurePeerConnection(rtcPeerUserId);
        const stream = await getLocalAudioStream();
        stream.getTracks().forEach(track => rtcPc.addTrack(track, stream));

        await rtcPc.setRemoteDescription(new RTCSessionDescription(rtcIncomingOffer));
        const answer = await rtcPc.createAnswer();
        await rtcPc.setLocalDescription(answer);

        socket.emit('call_answer', {
            to_user_id: rtcPeerUserId,
            chat_id: currentChat.id,
            sdp: answer
        });

        rtcIncomingOffer = null;
        setCallStatus('Соединяемся...');
        const accept = document.getElementById('call-accept');
        if (accept) accept.style.display = 'none';
    } catch (e) {
        console.error('Accept call error:', e);
        alert('Не удалось принять звонок');
        hangupCall();
    }
}

function hangupCall() {
    try {
        if (socket && currentChat && rtcPeerUserId) {
            socket.emit('call_hangup', { to_user_id: rtcPeerUserId, chat_id: currentChat.id });
        }
    } catch (e) {}
    cleanupCall();
    const modal = document.getElementById('call-modal');
    if (modal) modal.classList.remove('open');
}

function toggleMute() {
    if (!rtcLocalStream) return;
    rtcMuted = !rtcMuted;
    rtcLocalStream.getAudioTracks().forEach(t => (t.enabled = !rtcMuted));
    const btn = document.getElementById('call-mute');
    if (btn) btn.textContent = rtcMuted ? '🔇 Микрофон выкл' : '🎤 Микрофон вкл';
}

async function reportMessage(messageId) {
    if (!currentChat) return;
    const reason = (prompt('Причина жалобы (можно оставить пусто):') || '').trim();
    try {
        const res = await fetch('/reports/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_id: messageId, chat_id: currentChat.id, reason })
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.error || 'Ошибка отправки жалобы');
            return;
        }
        showToast('Жалоба отправлена');
    } catch (e) {
        console.error('Report failed:', e);
        alert('Ошибка отправки жалобы');
    }
}

async function logout() {
    try {
        await fetch('/logout', { method: 'POST' });
    } catch (e) {
        // игнор
    }

    try {
        localStorage.removeItem('beegram_user');
    } catch (e) {
        // игнор
    }
    window.location.reload();
}

function notifyIncoming(message) {
    const now = Date.now();
    if (now - lastNotifiedAt < 1200) return;
    lastNotifiedAt = now;

    playMessageSound();
    showToast('📨 Новое сообщение');
}

function showToast(text) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.style.position = 'fixed';
        toast.style.right = '20px';
        toast.style.bottom = '20px';
        toast.style.background = 'rgba(0,0,0,0.8)';
        toast.style.color = '#fff';
        toast.style.padding = '12px 14px';
        toast.style.borderRadius = '12px';
        toast.style.zIndex = '20000';
        toast.style.fontSize = '14px';
        toast.style.maxWidth = '260px';
        toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._hideT);
    toast._hideT = setTimeout(() => {
        toast.style.opacity = '0';
    }, 2200);
}

async function toggleVoiceRecord() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
        alert('Голосовые сообщения не поддерживаются в этом браузере');
        return;
    }

    if (isRecording) {
        try {
            voiceRecorder.stop();
        } catch (e) {}
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        voiceChunks = [];
        voiceRecorder = new MediaRecorder(stream);
        voiceRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) voiceChunks.push(e.data);
        };
        voiceRecorder.onstop = async () => {
            try {
                stream.getTracks().forEach(t => t.stop());
            } catch (e) {}
            isRecording = false;
            updateVoiceButton();

            const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
            if (blob.size === 0) return;
            await uploadAndSendVoice(blob);
        };
        isRecording = true;
        updateVoiceButton();
        voiceRecorder.start();
    } catch (error) {
        console.error('Ошибка записи:', error);
        alert('Не удалось включить микрофон');
    }
}

function updateVoiceButton() {
    const btn = document.getElementById('voice-btn');
    if (!btn) return;
    btn.textContent = isRecording ? '⏹️' : '🎤';
}

async function uploadAndSendVoice(blob) {
    if (!currentChat) return;
    try {
        const formData = new FormData();
        const ext = (blob.type || '').includes('ogg') ? 'ogg' : 'webm';
        formData.append('file', blob, `voice.${ext}`);
        const response = await fetch('/upload/voice', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!data.success) {
            alert(data.error || 'Ошибка загрузки голосового');
            return;
        }

        socket.emit('send_message', {
            chat_id: currentChat.id,
            user_id: currentUser.id,
            content: '',
            message_type: 'voice',
            file_url: data.file_url
        });
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка загрузки голосового');
    }
}

function sendImageSticker(fileUrl) {
    if (!currentChat || !socket) return;

    socket.emit('send_message', {
        chat_id: currentChat.id,
        user_id: currentUser.id,
        content: '',
        message_type: 'image',
        file_url: fileUrl
    });

    closeStickersModal();
}

function updateMessageCounter() {
    const input = document.getElementById('message-input');
    const counter = document.getElementById('message-counter');
    if (!input || !counter) return;
    
    const maxLen = getMaxMessageLength();
    const len = input.value.length;
    counter.textContent = `${len}/${maxLen}`;
    
    const isOver = len > maxLen;
    counter.classList.toggle('over', isOver);
    input.classList.toggle('too-long', isOver);
}

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

    // Применяем сохранённые обои (Premium)
    applyPremiumWallpaperFromStorage();
});

function applyPremiumWallpaperFromStorage() {
    // Обои — косметика, храним локально. Но применять разрешаем только Premium.
    const wallpaper = localStorage.getItem('beegram_wallpaper') || 'default';
    const allowed = new Set(['default', 'honey', 'lavender', 'night']);
    const normalized = allowed.has(wallpaper) ? wallpaper : 'default';

    document.body.classList.remove('wallpaper-honey', 'wallpaper-lavender', 'wallpaper-night');
    if (currentUser?.is_premium) {
        if (normalized === 'honey') document.body.classList.add('wallpaper-honey');
        if (normalized === 'lavender') document.body.classList.add('wallpaper-lavender');
        if (normalized === 'night') document.body.classList.add('wallpaper-night');
    }
}

function setPremiumWallpaper(value) {
    const allowed = new Set(['default', 'honey', 'lavender', 'night']);
    const normalized = allowed.has(value) ? value : 'default';

    if (!currentUser?.is_premium) {
        alert('Эта функция доступна только для Premium 👑');
        const select = document.getElementById('premium-wallpaper');
        if (select) select.value = 'default';
        localStorage.removeItem('beegram_wallpaper');
        applyPremiumWallpaperFromStorage();
        return;
    }

    localStorage.setItem('beegram_wallpaper', normalized);
    applyPremiumWallpaperFromStorage();
}

// ============= АВТОРИЗАЦИЯ =============

function sanitizeUsernameInput(inputEl) {
    if (!inputEl) return;
    const cleaned = String(inputEl.value || '').replace(/[^A-Za-z0-9]/g, '');
    if (inputEl.value !== cleaned) {
        inputEl.value = cleaned;
    }
}

async function register() {
    const usernameEl = document.getElementById('register-username');
    sanitizeUsernameInput(usernameEl);
    const username = usernameEl.value.trim();
    const nickname = document.getElementById('register-nickname').value.trim();
    const password = document.getElementById('register-password').value;
    const errorDiv = document.getElementById('register-error');
    
    errorDiv.textContent = '';
    
    if (!username || !password) {
        errorDiv.textContent = 'Заполните все обязательные поля!';
        return;
    }

    if (!/^[A-Za-z0-9]+$/.test(username)) {
        errorDiv.textContent = 'Username может содержать только английские буквы и цифры (без пробелов и символов)';
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

async function openSupport() {
    try {
        const response = await fetch('/support/open', {
            method: 'POST'
        });
        const data = await response.json();

        if (!data.success) {
            alert(data.error || 'Поддержка недоступна');
            return;
        }

        await loadChats();
        const chats = await fetch('/chats/list').then(r => r.json());
        const supportChat = chats.chats?.find(c => c.id === data.chat_id);
        if (supportChat) {
            openChat(supportChat);
        }
    } catch (error) {
        console.error('Ошибка поддержки:', error);
        alert('Ошибка открытия поддержки');
    }
}

// ============= КАНАЛЫ =============

function openChannels() {
    document.getElementById('channels-modal').classList.add('open');
    const input = document.getElementById('channel-search');
    if (input) input.value = '';
    const list = document.getElementById('channels-list');
    if (list) list.innerHTML = '';
}

function closeChannelsModal() {
    document.getElementById('channels-modal').classList.remove('open');
}

let channelSearchTimeout;
async function searchChannels() {
    const query = document.getElementById('channel-search').value.trim();
    const list = document.getElementById('channels-list');
    if (!list) return;

    clearTimeout(channelSearchTimeout);

    if (query.length < 2) {
        list.innerHTML = '';
        return;
    }

    channelSearchTimeout = setTimeout(async () => {
        try {
            const response = await fetch(`/channels/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();
            renderChannelsList(data.channels || []);
        } catch (error) {
            console.error('Ошибка поиска каналов:', error);
        }
    }, 300);
}

function renderChannelsList(channels) {
    const list = document.getElementById('channels-list');
    if (!list) return;

    if (channels.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Каналы не найдены</div>';
        return;
    }

    list.innerHTML = channels.map(ch => `
        <div class="channel-item">
            <div class="channel-info">
                <div class="channel-name">${escapeHtml(ch.name || 'Канал')}</div>
                <div class="channel-meta">${escapeHtml(ch.description || '')} • ${(ch.subscribers_count || 0)} 👥</div>
            </div>
            <button class="btn-primary" style="width:auto; padding:10px 14px;" onclick="subscribeChannel(${ch.id})">Подписаться</button>
        </div>
    `).join('');
}

async function subscribeChannel(channelId) {
    try {
        const response = await fetch(`/channels/${channelId}/subscribe`, {
            method: 'POST'
        });
        const data = await response.json();
        if (!data.success) {
            alert(data.error || 'Ошибка подписки');
            return;
        }

        closeChannelsModal();
        await loadChats();

        const chatsData = await fetch('/chats/list').then(r => r.json());
        const newChat = chatsData.chats?.find(c => c.id === channelId);
        if (newChat) {
            openChat(newChat);
        }
    } catch (error) {
        console.error('Ошибка подписки на канал:', error);
        alert('Ошибка подписки на канал');
    }
}

async function createChannelPrompt() {
    const name = prompt('Название канала:');
    if (!name) return;
    const description = prompt('Описание (не обязательно):', '') || '';

    try {
        const response = await fetch('/chats/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                is_channel: true,
                name,
                description
            })
        });
        const data = await response.json();
        if (!data.success) {
            alert(data.error || 'Ошибка создания канала');
            return;
        }

        closeChannelsModal();
        await loadChats();
        const chatsData = await fetch('/chats/list').then(r => r.json());
        const newChat = chatsData.chats?.find(c => c.id === data.chat_id);
        if (newChat) {
            openChat(newChat);
        }
    } catch (error) {
        console.error('Ошибка создания канала:', error);
        alert('Ошибка создания канала');
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

        const contentType = response.headers.get('content-type') || '';
        let data = null;
        if (contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const text = await response.text();
            throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 200)}`);
        }

        if (data && data.success) {
            currentUser = data.user;
            localStorage.setItem('beegram_user', JSON.stringify(currentUser));
            initApp();
        } else {
            const msg = data?.error || `Ошибка входа (HTTP ${response.status})`;
            errorDiv.textContent = msg;
        }
    } catch (error) {
        errorDiv.textContent = 'Ошибка входа. Открой консоль (F12) — там причина.';
        console.error('Login failed:', error);
    }
}

// ============= ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ =============

function initApp() {
    // Скрываем экран авторизации
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';

    // Обновляем информацию пользователя
    updateUserInfo();

    // Early Access gate
    if (!hasEarlyAccess()) {
        openEarlyAccessModal();
        return;
    }

    // Обои могут зависеть от Premium
    applyPremiumWallpaperFromStorage();
    
    // Подключаем сокет
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

    // Показываем кнопку модератора, если пользователь модер или админ
    if (currentUser.is_admin || currentUser.is_moderator) {
        const modBtn = document.getElementById('moderator-btn');
        if (modBtn) modBtn.style.display = 'block';
    }
    
    // Скрываем кнопку Premium, если уже есть Premium
    if (currentUser.is_premium) {
        document.getElementById('premium-btn').style.display = 'none';
    }
}

function hasEarlyAccess() {
    return !!(currentUser && (currentUser.early_access || currentUser.is_admin || currentUser.is_moderator));
}

function openEarlyAccessModal() {
    const modal = document.getElementById('early-access-modal');
    if (modal) modal.classList.add('open');
    const err = document.getElementById('early-access-error');
    if (err) err.textContent = '';
    const input = document.getElementById('early-access-key-input');
    if (input) input.value = '';
}

function closeEarlyAccessModal() {
    const modal = document.getElementById('early-access-modal');
    if (modal) modal.classList.remove('open');
}

async function activateEarlyAccess() {
    const input = document.getElementById('early-access-key-input');
    const err = document.getElementById('early-access-error');
    if (err) err.textContent = '';
    const key_code = (input?.value || '').trim().toUpperCase();
    if (!key_code) {
        if (err) err.textContent = 'Введите ключ';
        return;
    }

    try {
        const res = await fetch('/early_access/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key_code })
        });
        const data = await res.json();
        if (!data.success) {
            if (err) err.textContent = data.error || 'Ошибка активации';
            return;
        }

        currentUser.early_access = 1;
        localStorage.setItem('beegram_user', JSON.stringify(currentUser));
        closeEarlyAccessModal();
        initApp();
    } catch (e) {
        console.error('EA activate error:', e);
        if (err) err.textContent = 'Ошибка соединения';
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
        const isCurrent = currentChat && message.chat_id === currentChat.id;
        if (isCurrent) {
            appendMessage(message);
            scrollToBottom();
        }
        
        // Обновляем список чатов
        loadChats();
        
        // Уведомление только если это не текущий чат или вкладка не активна
        const shouldNotify = (!isCurrent) || document.hidden;
        if (shouldNotify) {
            notifyIncoming(message);
        }
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

    socket.on('message_deleted', (data) => {
        if (!data?.message_id) return;
        markMessageDeleted(data.message_id);
    });

    socket.on('message_error', (data) => {
        const msg = data?.error || 'Ошибка отправки сообщения';
        alert(msg);
        updateMessageCounter();
    });

    // ============= VOICE CALL SIGNALING =============

    socket.on('call_offer', async (data) => {
        if (!data?.from_user_id || !data?.sdp || !data?.chat_id) return;
        if (!currentChat || currentChat.id !== data.chat_id) {
            // игнорируем офферы не из текущего чата
            return;
        }
        rtcPeerUserId = data.from_user_id;
        rtcIncomingOffer = data.sdp;
        openCallModal('Входящий звонок...', true);
    });

    socket.on('call_answer', async (data) => {
        if (!rtcPc || !data?.sdp || !data?.from_user_id) return;
        if (rtcPeerUserId !== data.from_user_id) return;
        await rtcPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        setCallStatus('Соединяемся...');
    });

    socket.on('call_ice', async (data) => {
        if (!rtcPc || !data?.candidate || !data?.from_user_id) return;
        if (rtcPeerUserId !== data.from_user_id) return;
        try {
            await rtcPc.addIceCandidate(data.candidate);
        } catch (e) {
            // ignore
        }
    });

    socket.on('call_hangup', (data) => {
        if (!data?.from_user_id) return;
        if (rtcPeerUserId && rtcPeerUserId !== data.from_user_id) return;
        setCallStatus('Звонок завершён');
        cleanupCall();
        closeCallModalSoon();
    });
}

function isPrivateChat(chat) {
    return !!(chat && chat.other_user && !chat.is_group && !chat.is_channel);
}

function showCallButtonForChat(chat) {
    const btn = document.getElementById('call-btn');
    if (!btn) return;
    btn.style.display = isPrivateChat(chat) ? 'block' : 'none';
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

    showCallButtonForChat(chat);
    
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
    
    if (message.is_deleted) {
        contentHTML = `<div class="message-bubble system">Сообщение удалено</div>`;
    } else if (message.message_type === 'text' || message.message_type === 'system') {
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
    } else if (message.message_type === 'voice') {
        contentHTML = `
            <div class="message-bubble">
                <audio controls style="width: 260px; max-width: 100%;">
                    <source src="/uploads/${message.file_url}">
                </audio>
            </div>
        `;
    }
    
    // Реакции
    let reactionsHTML = '';
    if (!message.is_deleted && message.reactions && message.reactions.length > 0) {
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
    if (!message.is_deleted && message.message_type !== 'system') {
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

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑️';
    deleteBtn.style.fontSize = '20px';
    deleteBtn.style.border = 'none';
    deleteBtn.style.background = 'transparent';
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.style.padding = '5px';
    deleteBtn.style.borderRadius = '5px';
    deleteBtn.title = 'Удалить сообщение';
    deleteBtn.addEventListener('click', () => {
        deleteMessage(messageId);
        if (document.body.contains(menu)) {
            document.body.removeChild(menu);
        }
    });
    deleteBtn.addEventListener('mouseenter', () => {
        deleteBtn.style.background = '#FFF8DC';
    });
    deleteBtn.addEventListener('mouseleave', () => {
        deleteBtn.style.background = 'transparent';
    });
    menu.appendChild(deleteBtn);

    const reportBtn = document.createElement('button');
    reportBtn.textContent = '🚩';
    reportBtn.style.fontSize = '20px';
    reportBtn.style.border = 'none';
    reportBtn.style.background = 'transparent';
    reportBtn.style.cursor = 'pointer';
    reportBtn.style.padding = '5px';
    reportBtn.style.borderRadius = '5px';
    reportBtn.title = 'Пожаловаться';
    reportBtn.addEventListener('click', async () => {
        await reportMessage(messageId);
        if (document.body.contains(menu)) {
            document.body.removeChild(menu);
        }
    });
    reportBtn.addEventListener('mouseenter', () => {
        reportBtn.style.background = '#FFF8DC';
    });
    reportBtn.addEventListener('mouseleave', () => {
        reportBtn.style.background = 'transparent';
    });
    menu.appendChild(reportBtn);
    
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

function deleteMessage(messageId) {
    if (!socket || !currentChat) return;
    if (!confirm('Удалить сообщение?')) return;
    socket.emit('delete_message', {
        message_id: messageId,
        user_id: currentUser.id,
        chat_id: currentChat.id
    });
}

function markMessageDeleted(messageId) {
    const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageDiv) return;

    const bubble = messageDiv.querySelector('.message-bubble');
    if (bubble) {
        bubble.classList.add('system');
        bubble.innerHTML = 'Сообщение удалено';
    }

    const reactions = messageDiv.querySelector('.message-reactions');
    if (reactions) reactions.remove();
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

    const maxLen = getMaxMessageLength();
    if (content.length > maxLen) {
        alert(`Слишком длинное сообщение (макс. ${maxLen} символов)`);
        updateMessageCounter();
        return;
    }
    
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

    updateMessageCounter();
    
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

    const select = document.getElementById('premium-wallpaper');
    const hint = document.getElementById('premium-wallpaper-hint');
    if (select) {
        const wallpaper = localStorage.getItem('beegram_wallpaper') || 'default';
        select.value = wallpaper;
        select.disabled = !currentUser.is_premium;
    }
    if (hint) {
        hint.style.color = currentUser.is_premium ? '#666' : '#ff6b6b';
        hint.textContent = currentUser.is_premium ? 'Выберите обои — применятся сразу' : 'Доступно только для Premium';
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
            if (sticker.is_image) {
                const img = document.createElement('img');
                img.src = `/uploads/${sticker.url}`;
                img.alt = 'sticker';
                img.style.width = '64px';
                img.style.height = '64px';
                img.style.objectFit = 'contain';
                stickerItem.appendChild(img);
                stickerItem.addEventListener('click', () => sendImageSticker(sticker.url));
            } else {
                stickerItem.textContent = sticker.emoji;
                stickerItem.addEventListener('click', () => sendSticker(sticker.emoji));
            }
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
    
    if (currentChat.is_channel) {
        content.innerHTML = `
            <h3>Канал 📢</h3>
            <p><strong>Название:</strong> ${escapeHtml(currentChat.name || '')}</p>
            <p><strong>Описание:</strong> ${escapeHtml(currentChat.description || '—')}</p>
            <p><strong>Подписчиков:</strong> ${currentChat.subscribers_count || 0}</p>
        `;
    } else if (currentChat.is_group) {
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
