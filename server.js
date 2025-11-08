// --- server.js: ФИНАЛЬНАЯ СТАБИЛЬНАЯ ВЕРСИЯ СО ВСЕМИ ФУНКЦИЯМИ ---
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const { Pool } = require('pg'); 
const path = require('path');
const bcrypt = require('bcryptjs'); 
const fs = require('fs'); 

const port = process.env.PORT || 3000;
const SALT_ROUNDS = 10; 

// Директория для загрузки файлов
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)){
    fs.mkdirSync(UPLOADS_DIR);
}

// --- КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ---
// ИСПРАВЛЕНО: Удалили локальный пароль 'postgres:123456', чтобы сервер всегда
// использовал только безопасную переменную DATABASE_URL от Railway.
const DATABASE_URL = process.env.DATABASE_URL; 

// Проверка, использовать ли SSL. Теперь она основана на наличии переменной.
const useSSL = !!DATABASE_URL; // Если DATABASE_URL существует (а он существует на Railway), используем SSL.

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false 
});

// --- УЧЕТНЫЕ ДАННЫЕ ПОЛЬЗОВАТЕЛЕЙ (ВРЕМЕННОЕ ХРАНИЛИЩЕ) ---
const rawUsers = [
    { username: 'Yahyo', password: '1095508Yasd', avatar: '/avatars/yahyo.jpg' },
    { username: 'Fedya', password: 'Fedya123', avatar: '/avatars/fedya.jpg' },
    { username: 'Boyka', password: 'Boyka123', avatar: '/avatars/boyka.jpg' }
];

let usersCredentials = []; 
const connectedUsers = {}; 
let allUsernames = rawUsers.map(u => u.username); 


// --- ФУНКЦИИ ИНИЦИАЛИЗАЦИИ И БЕЗОПАСНОСТИ ---

async function initializeUsers() {
    console.log('*** Хеширование паролей пользователей... ***');
    
    usersCredentials = await Promise.all(rawUsers.map(async (user) => {
        const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
        return {
            ...user,
            password: hashedPassword 
        };
    }));
    console.log('Пароли успешно хешированы.');
}

async function findUser(username, password) {
    const user = usersCredentials.find(u => u.username === username);
    if (user) {
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            return user;
        }
    }
    return null;
}

// --- ФУНКЦИИ БД И ЧАТА ---

async function initializeDB() {
    console.log('*** Инициализация базы данных... ***');
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(50) NOT NULL,
                recipient VARCHAR(50) NOT NULL,
                room VARCHAR(100) NOT NULL,
                text TEXT,
                url TEXT,
                type VARCHAR(50) DEFAULT 'text',
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                edited BOOLEAN DEFAULT FALSE,
                deleted BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('Таблица "messages" проверена/создана успешно.');
        
        // НОВАЯ ТАБЛИЦА: для статусов прочтения
        await client.query(`
            CREATE TABLE IF NOT EXISTS read_receipts (
                room VARCHAR(100) PRIMARY KEY,
                last_read_message_id INTEGER DEFAULT 0,
                last_read_by_user VARCHAR(50) NOT NULL 
            );
        `);
        console.log('Таблица "read_receipts" проверена/создана успешно.');

    } catch (err) {
        console.error('Ошибка при инициализации БД:', err);
        throw err; 
    } finally {
        client.release();
    }
}

async function saveMessage(msg) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO messages (sender, recipient, room, text, url, type) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, timestamp`,
            [msg.sender, msg.recipient, msg.room, msg.text, msg.url, msg.type || 'text']
        );
        return {
            id: result.rows[0].id,
            timestamp: result.rows[0].timestamp
        };
    } finally {
        client.release();
    }
}

async function loadHistory(roomName, currentUsername) {
    const client = await pool.connect();
    try {
        // 1. Загрузка сообщений
        const messagesResult = await client.query(
            `SELECT id, sender, recipient, text, url, type, timestamp, edited, deleted 
             FROM messages 
             WHERE room = $1 AND deleted = FALSE 
             ORDER BY timestamp ASC`,
            [roomName]
        );
        
        // 2. Загрузка статуса прочтения
        const readStatusResult = await client.query(
            `SELECT last_read_message_id FROM read_receipts WHERE room = $1`,
            [roomName]
        );
        const lastReadId = readStatusResult.rows[0] ? readStatusResult.rows[0].last_read_message_id : 0;

        // 3. Добавление статуса прочтения к сообщениям
        const history = messagesResult.rows.map(msg => ({
            ...msg,
            // Сообщение прочитано, если оно отправлено текущим пользователем И 
            // его ID меньше или равен ID последнего прочитанного сообщения в этой комнате
            is_read: msg.sender === currentUsername && msg.id <= lastReadId,
        }));
        
        return history;
    } finally {
        client.release();
    }
}

// НОВАЯ ФУНКЦИЯ: Обновление статуса прочтения
async function updateReadReceipt(roomName, messageId) {
    const client = await pool.connect();
    try {
        // Вставляем или обновляем ID последнего прочитанного сообщения для этой комнаты
        await client.query(
            `INSERT INTO read_receipts (room, last_read_message_id, last_read_by_user)
             VALUES ($1, $2, 'dummy')
             ON CONFLICT (room) 
             DO UPDATE SET last_read_message_id = $2
             WHERE read_receipts.last_read_message_id < $2`,
            [roomName, messageId]
        );
    } finally {
        client.release();
    }
}

// ФУНКЦИЯ ПОИСКА
async function searchHistory(roomName, query) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT id, sender, recipient, text, url, type, timestamp, edited, deleted 
             FROM messages 
             WHERE room = $1 
               AND deleted = FALSE 
               AND text ILIKE $2
             ORDER BY timestamp DESC`,
            [roomName, `%${query}%`]
        );
        return result.rows;
    } finally {
        client.release();
    }
}

async function editSavedMessage(id, newText) { 
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE messages SET text = $1, edited = TRUE WHERE id = $2`,
            [newText, id]
        );
    } finally {
        client.release();
    }
}

async function deleteSavedMessage(id) { 
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE messages SET deleted = TRUE WHERE id = $1`,
            [id]
        );
    } finally {
        client.release();
    }
}

// НОВАЯ ФУНКЦИЯ: Сохранение файла (включая голосовые сообщения)
async function saveFile(fileMsg) {
    const filename = `${Date.now()}_${fileMsg.filename}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    const base64Data = fileMsg.data.split(';base64,').pop(); 
    fs.writeFileSync(filePath, base64Data, {encoding: 'base64'});

    return { 
        url: `/uploads/${filename}`, 
        type: fileMsg.type 
    }; 
}


// --- НАСТРОЙКА EXPRESS ---

app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/avatars', express.static(path.join(__dirname, 'avatars')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- НАСТРОЙКА SOCKET.IO ---
const io = new Server(server);

function broadcastStatuses() {
    const statuses = {};
    allUsernames.forEach(name => {
        statuses[name] = !!connectedUsers[name]; 
    });
    io.emit('update statuses', statuses);
    return statuses; 
}

// Функция для получения всех аватаров
function getAllAvatars() {
    return usersCredentials.reduce((acc, u) => {
        acc[u.username] = u.avatar;
        return acc;
    }, {});
}


io.on('connection', (socket) => {
    let currentUsername = null;
    let currentRoom = null;
    
    // 1. АВТОРИЗАЦИЯ И ВХОД
    socket.on('login', async (username, password, callback) => {
        const user = await findUser(username, password);

        if (user) {
            currentUsername = user.username;
            connectedUsers[currentUsername] = socket.id; 
            
            console.log(`Пользователь ${currentUsername} вошел в систему.`);
            
            const initialStatuses = broadcastStatuses(); 
            
            const allAvatars = getAllAvatars();

            callback(true, { 
                allUsers: allUsernames,
                currentUser: user.username, 
                currentUserAvatar: user.avatar,
                allUsersAvatars: allAvatars,
                initialStatuses: initialStatuses 
            });
        } else {
            callback(false, 'Неверное имя пользователя или пароль');
        }
    });
    
    // 2. СМЕНА КОМНАТЫ
    socket.on('join room', async (roomName) => {
        if (!currentUsername) return; 
        
        if (currentRoom) {
            socket.leave(currentRoom); 
        }
        currentRoom = roomName;
        socket.join(currentRoom); 
        
        const history = await loadHistory(currentRoom, currentUsername);
        
        if (history.length > 0) {
            const lastMessageId = history[history.length - 1].id;
            await updateReadReceipt(currentRoom, lastMessageId);
            
            const recipient = currentRoom.split('-').find(name => name !== currentUsername);
            if (recipient) {
                 io.to(currentRoom).emit('read status updated', {
                     room: currentRoom,
                     lastReadId: lastMessageId
                 });
             }
        }
        
        socket.emit('history loaded', history);
    });

    // 3. ОТПРАВКА ТЕКСТОВОГО СООБЩЕНИЯ
    socket.on('private message', async (msg) => {
        if (!currentUsername || !msg.recipient || !currentRoom) return;
        
        const messageToSave = {
            sender: currentUsername,
            recipient: msg.recipient,
            room: currentRoom,
            text: msg.text,
            url: null,
            type: 'text'
        };

        const savedData = await saveMessage(messageToSave);
        
        const message = {
            ...messageToSave,
            id: savedData.id,
            timestamp: savedData.timestamp,
            is_read: false 
        };
        
        io.to(currentRoom).emit('private message', message);
    });

    // 4. ОТПРАВКА ФАЙЛА (МЕДИА И ГОЛОС)
    socket.on('file upload', async (fileMsg) => {
        if (!currentUsername || !fileMsg.recipient || !currentRoom || !fileMsg.data) return;
        
        const savedFile = await saveFile(fileMsg); 
        
        const messageToSave = {
            sender: currentUsername,
            recipient: fileMsg.recipient,
            room: currentRoom,
            text: fileMsg.filename, 
            url: savedFile.url,
            type: savedFile.type || fileMsg.type 
        };

        const savedData = await saveMessage(messageToSave);
        
        const message = {
            ...messageToSave,
            id: savedData.id,
            timestamp: savedData.timestamp,
            is_read: false
        };

        io.to(currentRoom).emit('private message', message);
    });
    
    // 5. ОБРАБОТЧИК СТАТУСА ПРОЧТЕНИЯ
    socket.on('message read', async ({ roomName, lastMessageId, recipient }) => {
        if (!currentUsername || !roomName || !lastMessageId) return;
        
        await updateReadReceipt(roomName, lastMessageId);
        
        const recipientSocketId = connectedUsers[recipient];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('read status updated', {
                room: roomName,
                lastReadId: lastMessageId
            });
        }
    });

    // 6. ПОИСК ИСТОРИИ
    socket.on('search history', async (query) => {
        if (!currentUsername || !currentRoom || !query) return;

        const results = await searchHistory(currentRoom, query);
        socket.emit('search results', results);
    });
    
    // 7. РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
    socket.on('edit message', async ({ messageId, newText, recipient }) => {
        if (!currentUsername || !messageId || !newText) return;
        
        await editSavedMessage(messageId, newText); 

        const update = { messageId, newText };
        io.to(currentRoom).emit('message edited', update);
    });

    // 8. УДАЛЕНИЕ СООБЩЕНИЯ
    socket.on('delete message', async ({ messageId }) => {
        if (!currentUsername || !messageId) return;

        await deleteSavedMessage(messageId);

        const update = { messageId };
        io.to(currentRoom).emit('message deleted', update);
    });

    // 9. ОБНОВЛЕНИЕ ПРОФИЛЯ
    socket.on('update profile', ({ newUsername, newAvatar, oldUsername }, callback) => {
        const userIndex = usersCredentials.findIndex(u => u.username === oldUsername);
        if (userIndex !== -1) {
            usersCredentials[userIndex].avatar = newAvatar;
            
            const newAvatars = getAllAvatars();
            
            io.emit('avatar updated', newAvatars);
            
            callback(true, { updatedUser: usersCredentials[userIndex], allAvatars: newAvatars });
        } else {
            callback(false, 'Пользователь не найден.');
        }
    });


    // 10. ИНДИКАТОР ПЕЧАТИ
    socket.on('typing', ({ recipient, isTyping }) => {
        const recipientSocketId = connectedUsers[recipient];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('typing', { sender: currentUsername, isTyping: isTyping });
        }
    });

    // 11. ОТКЛЮЧЕНИЕ
    socket.on('disconnect', () => {
        if (currentUsername) {
            if (connectedUsers[currentUsername] === socket.id) {
                delete connectedUsers[currentUsername];
                console.log(`Пользователь ${currentUsername} отключился.`);
                broadcastStatuses(); 
            }
        }
    });
});

// --- ЗАПУСК СЕРВЕРА ---
initializeUsers().then(() => { 
    return initializeDB();
}).then(() => {
    server.listen(port, () => {
        console.log(`Сервер чата запущен на порту ${port}`);
        // Выводим только часть строки, чтобы не показывать секретный пароль в логах
        const displayUrl = DATABASE_URL.indexOf('@') > 0 ? DATABASE_URL.substring(0, DATABASE_URL.indexOf('@') + 1) + '...' : DATABASE_URL;
        console.log(`Подключение к БД: ${displayUrl}`); 
    });
}).catch(err => {
    console.error('Критическая ошибка запуска:', err.message);
    process.exit(1);
});