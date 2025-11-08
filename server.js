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
const DATABASE_URL = process.env.DATABASE_URL; 
const useSSL = !!DATABASE_URL;

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
        const messagesResult = await client.query(
            `SELECT id, sender, recipient, text, url, type, timestamp, edited, deleted 
             FROM messages 
             WHERE room = $1 AND deleted = FALSE 
             ORDER BY timestamp ASC`,
            [roomName]
        );
        
        const readStatusResult = await client.query(
            `SELECT last_read_message_id FROM read_receipts WHERE room = $1`,
            [roomName]
        );
        const lastReadId = readStatusResult.rows[0] ? readStatusResult.rows[0].last_read_message_id : 0;

        const history = messagesResult.rows.map(msg => ({
            ...msg,
            is_read: msg.sender === currentUsername && msg.id <= lastReadId,
        }));
        
        return history;
    } finally {
        client.release();
    }
}

async function updateReadReceipt(roomName, messageId) {
    const client = await pool.connect();
    try {
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

async function saveFile(fileMsg) {
    const filename = `${Date.now()}_${fileMsg.filename}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    try {
        const base64Data = fileMsg.data.split(';base64,').pop(); 
        fs.writeFileSync(filePath, base64Data, {encoding: 'base64'});
        console.log(`Файл сохранен: ${filePath} (${fileMsg.type})`);

        return { 
            url: `/uploads/${filename}`, 
            type: fileMsg.type 
        }; 
    } catch (e) {
        console.error("Ошибка при сохранении файла:", e);
        return null;
    }
}

// НОВАЯ ФУНКЦИЯ: Обновление аватара на сервере
async function updateAvatar(username, fileData) {
    try {
        const extension = fileData.split('/')[1].split(';')[0]; // jpeg, png и т.д.
        const filename = `${username}_avatar_${Date.now()}.${extension}`;
        const filePath = path.join(UPLOADS_DIR, filename);

        const base64Data = fileData.split(';base64,').pop(); 
        fs.writeFileSync(filePath, base64Data, {encoding: 'base64'});

        const newAvatarUrl = `/uploads/${filename}`;
        
        // Обновляем временное хранилище usersCredentials
        const userIndex = usersCredentials.findIndex(u => u.username === username);
        if (userIndex !== -1) {
            usersCredentials[userIndex].avatar = newAvatarUrl;
            console.log(`Аватар пользователя ${username} обновлен на ${newAvatarUrl}`);
            return newAvatarUrl;
        }
        return null;

    } catch (e) {
        console.error(`Ошибка при обновлении аватара для ${username}:`, e);
        return null;
    }
}


// --- НАСТРОЙКА EXPRESS ---

app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/avatars', express.static(path.join(__dirname, 'avatars'))); // Для дефолтных аватаров

// ... (Остальной Express код) ...

// --- НАСТРОЙКА SOCKET.IO ---
const io = new Server(server);

function broadcastStatuses() {
    // ... (Функция осталась прежней) ...
    const statuses = {};
    allUsernames.forEach(name => {
        statuses[name] = !!connectedUsers[name]; 
    });
    io.emit('update statuses', statuses);
    return statuses; 
}

function getAllAvatars() {
    return usersCredentials.reduce((acc, u) => {
        acc[u.username] = u.avatar;
        return acc;
    }, {});
}


io.on('connection', (socket) => {
    let currentUsername = null;
    let currentRoom = null;
    
    // ... (Login, Join Room, Private Message, Typing - остались прежними) ...

    // 4. ОТПРАВКА ФАЙЛА (МЕДИА И ГОЛОС)
    socket.on('file upload', async (fileMsg) => {
        if (!currentUsername || !fileMsg.recipient || !currentRoom || !fileMsg.data) return;
        
        const savedFile = await saveFile(fileMsg); 
        
        if (!savedFile) {
            console.log('Ошибка: файл не был сохранен.');
            return;
        }

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
    
    // ... (Handlers: message read, search, edit, delete - остались прежними) ...

    // 9. ОБНОВЛЕНИЕ ПРОФИЛЯ (ИСПРАВЛЕНО)
    socket.on('update profile', async ({ newAvatarData }, callback) => {
        if (!currentUsername || !newAvatarData) {
            return callback(false, 'Нет данных для обновления.');
        }

        const newAvatarUrl = await updateAvatar(currentUsername, newAvatarData);

        if (newAvatarUrl) {
            currentUserAvatar = newAvatarUrl;
            const newAvatars = getAllAvatars();
            
            // Отправляем всем, чтобы обновить их списки
            io.emit('avatar updated', newAvatars);
            
            callback(true, { 
                newAvatarUrl: newAvatarUrl, 
                allAvatars: newAvatars 
            });
        } else {
            callback(false, 'Ошибка сохранения аватара.');
        }
    });

    // ... (Disconnect - остался прежним) ...
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