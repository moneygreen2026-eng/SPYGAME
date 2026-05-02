const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const DEFAULT_LOCATIONS = [
  'Аэропорт', 'Пляж', 'Подводная лодка', 'Банк', 'Казино',
  'Цирк', 'Посольство', 'Больница', 'Военная база', 'Музей',
  'Ночной клуб', 'Полицейский участок', 'Ресторан', 'Школа',
  'Космическая станция', 'Корабль', 'Поезд', 'Супермаркет',
  'Университет', 'Кинотеатр', 'Замок', 'Тюрьма',
  'Яхта', 'Отель', 'Театр'
];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: playerName, ready: false }],
      settings: { maxPlayers: 8, spyCount: 1, duration: 8 },
      locations: [...DEFAULT_LOCATIONS],
      state: 'lobby',
      timer: null,
      votes: {}
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName;
    socket.emit('roomCreated', { code, room: sanitizeRoom(rooms[code]) });
    console.log(`Room ${code} created by ${playerName}`);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Комната не найдена');
    if (room.state !== 'lobby') return socket.emit('error', 'Игра уже началась');
    if (room.players.length >= room.settings.maxPlayers)
      return socket.emit('error', 'Комната заполнена');
    if (room.players.find(p => p.name === playerName))
      return socket.emit('error', 'Имя уже занято');

    room.players.push({ id: socket.id, name: playerName, ready: false });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName;
    socket.emit('roomJoined', { code, room: sanitizeRoom(room) });
    socket.to(code).emit('playerJoined', { room: sanitizeRoom(room) });
  });

  socket.on('updateSettings', ({ settings }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    room.settings = { ...room.settings, ...settings };
    io.to(socket.roomCode).emit('settingsUpdated', { settings: room.settings });
  });

  socket.on('updateLocations', ({ locations }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    room.locations = locations;
    io.to(socket.roomCode).emit('locationsUpdated', { locations });
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) return socket.emit('error', 'Нужно минимум 3 игрока');

    const location = room.locations[Math.floor(Math.random() * room.locations.length)];
    const shuffled = shuffle(room.players);
    const spyCount = Math.min(room.settings.spyCount, Math.floor(room.players.length / 2));
    const spyIds = shuffled.slice(0, spyCount).map(p => p.id);

    room.state = 'playing';
    room.location = location;
    room.spyIds = spyIds;
    room.startTime = Date.now();
    room.votes = {};

    // Send individual roles
    room.players.forEach(player => {
      const isSpy = spyIds.includes(player.id);
      io.to(player.id).emit('gameStarted', {
        role: isSpy ? 'spy' : 'civilian',
        location: isSpy ? null : location,
        spyCount,
        players: room.players.map(p => p.name),
        duration: room.settings.duration,
        locations: isSpy ? room.locations : null
      });
    });

    // Timer countdown
    let timeLeft = room.settings.duration * 60;
    room.timer = setInterval(() => {
      timeLeft--;
      io.to(socket.roomCode).emit('timerTick', { timeLeft });
      if (timeLeft <= 0) {
        clearInterval(room.timer);
        room.state = 'ended';
        io.to(socket.roomCode).emit('timeUp', {
          location: room.location,
          spies: room.players.filter(p => room.spyIds.includes(p.id)).map(p => p.name)
        });
      }
    }, 1000);
  });

  socket.on('callVote', ({ targetName }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'playing') return;
    io.to(socket.roomCode).emit('voteStarted', {
      callerName: socket.playerName,
      targetName,
      players: room.players.map(p => p.name)
    });
    room.votes = {};
  });

  socket.on('castVote', ({ targetName, vote }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.votes[socket.id] = { targetName, vote };
    const totalVotes = Object.keys(room.votes).length;
    if (totalVotes >= room.players.length) {
      const guilty = Object.values(room.votes).filter(v => v.vote === 'guilty').length;
      const innocent = Object.values(room.votes).filter(v => v.vote === 'innocent').length;
      io.to(socket.roomCode).emit('voteResult', { targetName, guilty, innocent, total: totalVotes });
    } else {
      io.to(socket.roomCode).emit('voteProgress', { voted: totalVotes, total: room.players.length });
    }
  });

  socket.on('endGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    endGame(room, socket.roomCode);
  });

  socket.on('restartGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.host !== socket.id) return;
    clearInterval(room.timer);
    room.state = 'lobby';
    room.location = null;
    room.spyIds = [];
    room.votes = {};
    io.to(socket.roomCode).emit('gameRestarted', { room: sanitizeRoom(room) });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      clearInterval(room.timer);
      delete rooms[code];
      return;
    }

    if (room.host === socket.id) {
      room.host = room.players[0].id;
      io.to(room.players[0].id).emit('youAreHost');
    }

    io.to(code).emit('playerLeft', { playerName: socket.playerName, room: sanitizeRoom(room) });
  });
});

function endGame(room, code) {
  clearInterval(room.timer);
  room.state = 'ended';
  io.to(code).emit('timeUp', {
    location: room.location,
    spies: room.players.filter(p => room.spyIds.includes(p.id)).map(p => p.name)
  });
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    players: room.players,
    settings: room.settings,
    locations: room.locations,
    state: room.state,
    host: room.host
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🕵️ Spy Game server running on http://localhost:${PORT}`));
