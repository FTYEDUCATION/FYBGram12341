# Использовать официальный образ Node.js
FROM node:18-alpine

# Установить рабочую директорию внутри контейнера
WORKDIR /usr/src/app

# Копировать package.json для установки зависимостей
COPY package*.json ./

# Установить зависимости (express, socket.io, pg)
RUN npm install

# Копировать весь остальной код (server.js, index.html, style.css и т.д.)
COPY . .

# Открыть порт 3000
EXPOSE 3000

# ... (Остальной ваш Dockerfile)

# Заменить финальную команду CMD или ENTRYPOINT на эти две строки
# Эта команда установит утилиту 'bash' и 'wait-for-it' для паузы.
RUN apk add --no-cache bash

# Заменить финальную CMD на эту:
CMD ["sh", "-c", "sleep 15 && node server.js"]