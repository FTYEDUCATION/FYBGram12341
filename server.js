// --- server.js: ПОЛНЫЙ, СТРУКТУРИРОВАННЫЙ И УСТОЙЧИВЫЙ КОД ---

// --- 1. ИМПОРТЫ МОДУЛЕЙ ---
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const { Pool } = require('pg'); 
const path = require('path');
const bcrypt = require('bcryptjs'); 
const fs = require('fs'); 

// --- 2. КОНСТАНТЫ И НАСТРОЙКИ ---
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10; 
const BASE_DIR = __dirname;
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const AVATARS_DIR = path.join(BASE_DIR, 'avatars');

// --- 3. ИНИЦИАЛИЗАЦИЯ ПАПОК ---
if (!fs.existsSync(UPLOADS_DIR)){
    try {
        // Создание папки uploads, если она не существует
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        console.log(`Директория загрузок создана: ${UPLOADS_DIR}`);
    } catch (e) {
        console.error('КРИТИЧЕСКАЯ ОШИБКА: Не удалось создать папку uploads:', e.message);
    }
}

// --- 4. КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ---
const DATABASE_URL = process.env.DATABASE_URL; 
const useSSL = !!DATABASE_URL;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false 
});

// --- 5. ДАННЫЕ ПОЛЬЗОВАТЕЛЕЙ (ЖЕСТКО ЗАДАННЫЕ) ---
const rawUsers = [
    { username: 'Yahyo', password: '1095508Yasd', avatar: '/avatars/yahyo.jpg' },
    { username: 'Fedya', password: 'Fedya123', avatar: '/avatars/fedya.jpg' },
    { username: 'Boyka', password: 'Boyka123', avatar: '/avatars/boyka.jpg' }
];

let usersCredentials = []; 
const connectedUsers = {}; 
let allUsernames = rawUsers.map(u => u.username); 


// --- 6. ФУНКЦИИ БАЗЫ ДАННЫХ И БЕЗОПАСНОСТИ ---

/** Инициализирует и хеширует пароли пользователей. */
async function initializeUsers() {
    console.log('Инициализация пользователей...');
    usersCredentials = await Promise.all(rawUsers.map(async (user) => {
        const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
        return { ...user, password: hashedPassword };
    }));
    console.log('Пользователи готовы.');
}

/** Проверяет учетные данные. */
async function findUser(username, password) {
    const user = usersCredentials.find(u => u.username === username);
    if (user && await bcrypt.compare(password, user.password)) { 
        return user; 
    }
    return null;
}

/** Создает таблицы БД, если они не существуют. */
async function initializeDB() {
    console.log('Инициализация БД...');
    const client = await pool.connect();
    try {
        // Таблица для сообщений
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, sender VARCHAR(50) NOT NULL, recipient VARCHAR(50) NOT NULL,
                room VARCHAR(100) NOT NULL, text TEXT, url TEXT, type VARCHAR(50) DEFAULT 'text',
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, edited BOOLEAN DEFAULT FALSE,
                deleted BOOLEAN DEFAULT FALSE
            );
        `);
        // Таблица для чеков прочтения
        await client.query(`
            CREATE TABLE IF NOT EXISTS read_receipts (
                room VARCHAR(100) PRIMARY KEY, last_read_message_id INTEGER DEFAULT 0,
                last_read_by_user VARCHAR(50) NOT NULL 
            );
        `);
        console.log('Таблицы БД успешно проверены/созданы.');
    } catch (err) {
        console.error('КРИТИЧЕСКАЯ ОШИБКА при инициализации БД:', err);
        throw err; 
    } finally { 
        client.release(); 
    }
}

/** Сохраняет сообщение или файл в БД. */
async function saveMessage(msg) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO messages (sender, recipient, room, text, url, type) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, timestamp`,
            [msg.sender, msg.recipient, msg.room, msg.text, msg.url, msg.type || 'text']
        );
        return { id: result.rows[0].id, timestamp: result.rows[0].timestamp };
    } catch (err) {
        console.error('Ошибка при сохранении сообщения:', err.message);
        return { id: 0, timestamp: new Date() };
    } finally { client.release(); }
}

/** Загружает историю сообщений для комнаты. */
async function loadHistory(roomName, currentUsername) {
    const client = await pool.connect();
    try {
        const messagesResult = await client.query(
            `SELECT id, sender, recipient, text, url, type, timestamp, edited, deleted 
             FROM messages WHERE room = $1 AND deleted = FALSE ORDER BY timestamp ASC`,
            [roomName]
        );
        const readStatusResult = await client.query(
            `SELECT last_read_message_id FROM read_receipts WHERE room = $1`,
            [roomName]
        );
        const lastReadId = readStatusResult.rows[0] ? readStatusResult.rows[0].last_read_message_id : 0;
        
        // Добавление статуса прочтения к каждому сообщению
        return messagesResult.rows.map(msg => ({
            ...msg, 
            is_read: msg.sender === currentUsername && msg.id <= lastReadId,
        }));
    } catch (err) {
        console.error('Ошибка при загрузке истории:', err.message);
        return [];
    } finally { client.release(); }
}

/** Обновляет чек прочтения для комнаты. */
async function updateReadReceipt(roomName, messageId) {
    const client = await pool.connect();
    try {
        await client.query(
            `INSERT INTO read_receipts (room, last_read_message_id, last_read_by_user)
             VALUES ($1, $2, 'dummy') ON CONFLICT (room) 
             DO UPDATE SET last_read_message_id = $2 WHERE read_receipts.last_read_message_id < $2`,
            [roomName, messageId]
        );
    } catch (err) {
        console.error('Ошибка при обновлении чека прочтения:', err.message);
    } finally { client.release(); }
}


// --- 7. ФУНКЦИИ РАБОТЫ С ФАЙЛАМИ ---

/** Сохраняет файл (изображение/аудио/видео) на сервере. */
async function saveFile(fileMsg) {
    const extension = (fileMsg.type.split('/')[1] || 'dat').replace('jpeg', 'jpg');
    const filename = `${Date.now()}_${fileMsg.filename}.${extension}`;
    const filePath = path.join(UPLOADS_DIR, filename); 

    try {
        const base64Data = fileMsg.data.split(';base64,').pop(); 
        fs.writeFileSync(filePath, base64Data, {encoding: 'base64'});

        return { 
            url: `/uploads/${filename}`, // Публичный URL для браузера
            type: fileMsg.type.startsWith('audio') ? 'voice' : fileMsg.type.split('/')[0] 
        }; 
    } catch (e) {
        console.error("Ошибка при сохранении файла:", e);
        return null;
    }
}

/** Обновляет и сохраняет файл аватара. */
async function updateAvatar(username, fileData) {
    try {
        const extension = (fileData.match(/^data:image\/([^;]+);/)?.[1] || 'jpg').replace('jpeg', 'jpg');
        const filename = `${username}_avatar_${Date.now()}.${extension}`;
        const filePath = path.join(UPLOADS_DIR, filename); 

        const base64Data = fileData.split(';base64,').pop(); 
        fs.writeFileSync(filePath, base64Data, {encoding: 'base64'});

        const newAvatarUrl = `/uploads/${filename}`;
        
        const userIndex = usersCredentials.findIndex(u => u.username === username);
        if (userIndex !== -1) {
            usersCredentials[userIndex].avatar = newAvatarUrl;
            return newAvatarUrl;
        }
        return null;
    } catch (e) {
        console.error(`Ошибка при обновлении аватара для ${username}:`, e);
        return null;
    }
}


// --- 8. НАСТРОЙКА EXPRESS ДЛЯ СТАТИЧЕСКИХ ФАЙЛОВ (КРИТИЧЕСКИЙ БЛОК) ---
// Обслуживание файлов из корня (__dirname), включая index.html
app.use(express.static(BASE_DIR)); 
// Обслуживание папки uploads по публичному префиксу /uploads
app.use('/uploads', express.static(UPLOADS_DIR)); 
// Обслуживание дефолтных аватаров
app.use('/avatars', express.static(AVATARS_DIR)); 


// --- 9. НАСТРОЙКА SOCKET.IO ---
const io = new Server(server);

function createRoomName(user1, user2) {
    return [user1, user2].sort().join('-');
}

function broadcastStatuses() {
    const statuses = {};
    allUsernames.forEach(name => { statuses[name] = !!connectedUsers[name]; });
    io.emit('update statuses', statuses);
    return statuses; 
}

function getAllAvatars() {
    return usersCredentials.reduce((acc, u) => { acc[u.username] = u.avatar; return acc; }, {});
}


// --- 10. ОБРАБОТЧИКИ SOCKET.IO ---
io.on('connection', (socket) => {
    let currentUsername = null;
    let currentRoom = null;
    let currentRecipient = null;
    
    // --- Логин ---
    socket.on('login', async (username, password, callback) => {
        const user = await findUser(username, password);
        if (user) {
            currentUsername = user.username;
            connectedUsers[currentUsername] = socket.id;
            const initialStatuses = broadcastStatuses();
            const allAvatars = getAllAvatars();
            
            callback(true, { 
                currentUser: currentUsername, currentUserAvatar: user.avatar, allUsers: allUsernames, 
                initialStatuses, allUsersAvatars: allAvatars
            });
        } else {
            callback(false, 'Неверное имя пользователя или пароль.');
        }
    });

    // --- Вход в комнату чата ---
    socket.on('join room', async (recipient) => {
        if (!currentUsername || !recipient) return;
        
        const newRoom = createRoomName(currentUsername, recipient);
        if (currentRoom) { socket.leave(currentRoom); }
        
        currentRoom = newRoom;
        currentRecipient = recipient;
        socket.join(currentRoom);
        
        const history = await loadHistory(currentRoom, currentUsername);
        socket.emit('load history', { history: history, recipient: recipient });
        
        // Отправка чека прочтения, если последнее сообщение не наше
        if (history.length > 0 && history[history.length - 1].sender !== currentUsername) {
            const lastMessage = history[history.length - 1];
            socket.emit('message read', { roomName: currentRoom, lastMessageId: lastMessage.id, recipient: lastMessage.sender });
        }
    });

    // --- Отправка текстового сообщения ---
    socket.on('private message', async (msg) => {
        if (!currentUsername || !currentRoom || !currentRecipient || !msg.text) return;
        
        const messageToSave = {
            sender: currentUsername, recipient: currentRecipient, room: currentRoom,
            text: msg.text, type: 'text'
        };
        const savedData = await saveMessage(messageToSave);
        const message = {
            ...messageToSave, id: savedData.id, timestamp: savedData.timestamp, is_read: false 
        };
        io.to(currentRoom).emit('private message', message);
    });

    // --- Загрузка файла/медиа ---
    socket.on('file upload', async (fileMsg) => {
        if (!currentUsername || !fileMsg.recipient || !currentRoom || !fileMsg.data) return;
        
        const savedFile = await saveFile(fileMsg); 
        if (!savedFile) { return; }

        const messageToSave = {
            sender: currentUsername, recipient: fileMsg.recipient, room: currentRoom,
            text: fileMsg.filename, url: savedFile.url, type: savedFile.type 
        };

        const savedData = await saveMessage(messageToSave);
        const message = {
            ...messageToSave, id: savedData.id, timestamp: savedData.timestamp, is_read: false
        };

        io.to(currentRoom).emit('private message', message);
    });
    
    // --- Чек прочтения ---
    socket.on('message read', async ({ roomName, lastMessageId, recipient }) => {
        await updateReadReceipt(roomName, lastMessageId);
        // Отправка подтверждения всем в комнате, чтобы обновить статусы "прочтено"
        io.to(roomName).emit('message read ack', { roomName: roomName, lastMessageId: lastMessageId });
    });

    // --- Обновление профиля/аватара ---
    socket.on('update profile', async ({ newAvatarData }, callback) => {
        if (!currentUsername || !newAvatarData) { return callback(false, 'Нет данных для обновления.'); }

        const newAvatarUrl = await updateAvatar(currentUsername, newAvatarData);

        if (newAvatarUrl) {
            io.emit('avatar updated', getAllAvatars());
            callback(true, { newAvatarUrl, allAvatars: getAllAvatars() });
        } else {
            callback(false, 'Ошибка сохранения аватара.');
        }
    });

    // --- Отключение ---
    socket.on('disconnect', () => {
        if (currentUsername && connectedUsers[currentUsername]) {
            delete connectedUsers[currentUsername];
            broadcastStatuses();
        }
    });
});


// --- 11. ЗАПУСК СЕРВЕРА ---
initializeUsers()
    .then(() => initializeDB())
    .then(() => {
        server.listen(PORT, () => {
            console.log(`Сервер чата запущен на порту ${PORT}`);
        });
    })
    .catch(err => {
        console.error('КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:', err.message);
        process.exit(1);
    });