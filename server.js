// Plik: server.js

// Import potrzebnych modułów
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// Inicjalizacja aplikacji Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const games = {};
const clients = {};

// --- DEFINICJE KART (bez zmian) ---
const CARDS = [
    { id: 'atk1', name: 'Soczysty Mem', type: 'Atak', description: 'Cel traci 3 Honoru.', effect: { type: 'lose_honor', value: 3 } },
    { id: 'atk2', name: 'Teoria Spiskowa', type: 'Atak', description: 'Cel traci 2 Honoru i dostaje 1 kartę Skandalu.', effect: { type: 'lose_honor_and_scandal', honor: 2, scandal: 1 } },
    { id: 'atk3', name: 'Publiczne Pranie Brudów', type: 'Atak', description: 'Wszyscy pozostali gracze tracą 2 Honoru.', effect: { type: 'aoe_lose_honor', value: 2 } },
    { id: 'def1', name: 'To Fake News!', type: 'Obrona', description: 'Zablokuj następny Atak skierowany w Ciebie.', effect: { type: 'block_attack' } },
    { id: 'def2', name: 'Tarcza Ignorancji', type: 'Obrona', description: 'Zablokuj następny Sabotaż.', effect: { type: 'block_sabotage' } },
    { id: 'sab1', name: 'Zmień Temat!', type: 'Sabotaż', description: 'Przekieruj następny Atak na innego gracza.', effect: { type: 'redirect_attack' } },
    { id: 'sab2', name: 'Kryzys Wizerunkowy', type: 'Sabotaż', description: 'Wybrany gracz pomija swoją następną turę.', effect: { type: 'skip_turn' } },
    { id: 'sab3', name: 'Kradzież Tożsamości', type: 'Sabotaż', description: 'Ukradnij losową kartę z ręki wybranego gracza.', effect: { type: 'steal_card' } },
    { id: 'bst1', name: 'Wiralowy Taniec', type: 'Boost', description: 'Zyskujesz 3 Honoru.', effect: { type: 'gain_honor', value: 3 } },
    { id: 'bst2', name: 'Kawa i Nadgodziny', type: 'Boost', description: 'Dobierz 1 kartę i wykonaj dodatkową akcję w tej turze.', effect: { type: 'extra_turn_and_card' } },
    { id: 'bst3', name: 'Apel o Wsparciu', type: 'Boost', description: 'Każdy inny gracz musi oddać Ci 1 Honoru (jeśli ma).', effect: { type: 'leech_honor', value: 1 } },
];

wss.on('connection', ws => {
    const clientId = `gracz-${Math.random().toString(36).substr(2, 9)}`;
    clients[clientId] = { ws: ws };
    console.log(`Połączono nowego klienta: ${clientId}`);
    ws.send(JSON.stringify({ type: 'welcome', clientId: clientId }));

    ws.on('message', message => {
        const data = JSON.parse(message);
        const { gameId, payload } = data;
        const game = games[gameId];

        switch (data.type) {
            case 'createGame': handleCreateGame(clientId, gameId, payload.nickname); break;
            case 'joinGame': handleJoinGame(clientId, gameId, payload.nickname); break;
            case 'startGame': if (game && game.players.find(p => p.id === clientId)?.isHost) { handleStartGame(gameId); } break;
            case 'draftCard': if (game && game.currentTurnPlayerId === clientId) { handleDraftCard(clientId, gameId, payload.cardId); } break;
            case 'playCard': if (game && game.currentTurnPlayerId === clientId) { handlePlayCard(clientId, gameId, payload.cardId, payload.targetId); } break;
        }
    });

    ws.on('close', () => {
        console.log(`Klient ${clientId} rozłączony.`);
        const clientInfo = clients[clientId];
        if (clientInfo && clientInfo.gameId) {
            const game = games[clientInfo.gameId];
            if (game) {
                const disconnectedPlayer = game.players.find(p => p.id === clientId);
                game.players = game.players.filter(p => p.id !== clientId);
                game.log.push(`Gracz ${disconnectedPlayer?.nickname || clientId} opuścił grę.`);
                broadcast(clientInfo.gameId);
            }
        }
        delete clients[clientId];
    });
});

function getPlayerName(game, playerId) {
    return game.players.find(p => p.id === playerId)?.nickname || playerId;
}

function broadcast(gameId) {
    const game = games[gameId];
    if (!game) return;
    game.players.forEach(player => {
        const client = clients[player.id];
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'update', gameData: game }));
        }
    });
}

function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

function handleCreateGame(clientId, gameId, nickname) {
    if (games[gameId]) {
        clients[clientId].ws.send(JSON.stringify({ type: 'error', message: 'Gra o tym ID już istnieje.' }));
        return;
    }
    const finalNickname = nickname || clientId;
    const shuffledDeck = shuffle([...CARDS, ...CARDS, ...CARDS]);
    games[gameId] = {
        gameId: gameId,
        players: [{ id: clientId, nickname: finalNickname, honor: 10, hand: [], scandals: 0, isHost: true, isEliminated: false }],
        deck: shuffledDeck,
        discardPile: [],
        round: 1,
        currentTurnPlayerId: null,
        gameState: 'WAITING_FOR_PLAYERS',
        log: [`Gra "${gameId}" została utworzona przez ${finalNickname}.`],
        draftOptions: [],
        actionsLeft: 1
    };
    clients[clientId].gameId = gameId;
    console.log(`Gra ${gameId} stworzona przez ${finalNickname}`);
    broadcast(gameId);
}

function handleJoinGame(clientId, gameId, nickname) {
    const game = games[gameId];
    if (!game) {
        clients[clientId].ws.send(JSON.stringify({ type: 'error', message: 'Gra o tym ID nie istnieje.' }));
        return;
    }
    if (game.players.length >= 4) {
        clients[clientId].ws.send(JSON.stringify({ type: 'error', message: 'Gra jest pełna.' }));
        return;
    }
    if (game.gameState !== 'WAITING_FOR_PLAYERS') {
        clients[clientId].ws.send(JSON.stringify({ type: 'error', message: 'Nie można dołączyć do trwającej gry.' }));
        return;
    }
    const finalNickname = nickname || clientId;
    game.players.push({ id: clientId, nickname: finalNickname, honor: 10, hand: [], scandals: 0, isHost: false, isEliminated: false });
    game.log.push(`Gracz ${finalNickname} dołączył do gry.`);
    clients[clientId].gameId = gameId;
    console.log(`Gracz ${finalNickname} dołączył do gry ${gameId}`);
    broadcast(gameId);
}

function handleStartGame(gameId) {
    const game = games[gameId];
    if (game.players.length < 2) return;
    game.players.forEach(player => { player.hand = game.deck.splice(0, 5); });
    const firstPlayer = game.players[0];
    game.currentTurnPlayerId = firstPlayer.id;
    game.gameState = 'DRAFTING';
    game.draftOptions = game.deck.slice(0, 3);
    game.log.push(`Gra rozpoczęta! Tura gracza ${firstPlayer.nickname}.`);
    broadcast(gameId);
}

function handleDraftCard(clientId, gameId, cardId) {
    const game = games[gameId];
    const player = game.players.find(p => p.id === clientId);
    player.hand.push({ id: cardId });
    game.deck = game.deck.filter(c => !game.draftOptions.some(opt => opt.id === c.id));
    game.draftOptions = [];
    game.gameState = 'ACTION';
    game.actionsLeft = 1;
    game.log.push(`${player.nickname} dobrał kartę.`);
    broadcast(gameId);
}

function handlePlayCard(clientId, gameId, cardId, targetId) {
    const game = games[gameId];
    const player = game.players.find(p => p.id === clientId);
    const card = CARDS.find(c => c.id === cardId);
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex > -1) { player.hand.splice(cardIndex, 1); }
    game.discardPile.push(card);
    const targetName = getPlayerName(game, targetId);
    game.log.push(`${player.nickname} zagrywa "${card.name}"` + (targetId ? ` na ${targetName}.` : '.'));
    game.actionsLeft--;
    applyCardEffect(game, card, clientId, targetId);
    if (game.actionsLeft <= 0 && game.gameState !== 'GAME_OVER') {
        endTurn(gameId);
    } else {
        broadcast(gameId);
    }
}

function applyCardEffect(game, card, casterId, targetId) {
    const casterName = getPlayerName(game, casterId);
    const targetName = getPlayerName(game, targetId);
    const caster = game.players.find(p => p.id === casterId);
    const target = game.players.find(p => p.id === targetId);
    switch (card.effect.type) {
        case 'lose_honor': if (target) { target.honor = Math.max(0, target.honor - card.effect.value); game.log.push(`${targetName} traci ${card.effect.value} Honoru.`); } break;
        case 'lose_honor_and_scandal': if (target) { target.honor = Math.max(0, target.honor - card.effect.honor); target.scandals += card.effect.scandal; game.log.push(`${targetName} traci ${card.effect.honor} Honoru i dostaje ${card.effect.scandal} Skandal.`); } break;
        case 'aoe_lose_honor': game.players.forEach(p => { if (p.id !== casterId && !p.isEliminated) { p.honor = Math.max(0, p.honor - card.effect.value); game.log.push(`${p.nickname} traci ${card.effect.value} Honoru.`); } }); break;
        case 'gain_honor': caster.honor += card.effect.value; game.log.push(`${casterName} zyskuje ${card.effect.value} Honoru.`); break;
        case 'extra_turn_and_card': if (game.deck.length > 0) { caster.hand.push(game.deck.shift()); } game.actionsLeft += 2; game.log.push(`${casterName} dobiera kartę i ma dodatkową akcję.`); break;
        case 'leech_honor': let honorGained = 0; game.players.forEach(p => { if (p.id !== casterId && !p.isEliminated && p.honor > 0) { p.honor--; honorGained++; } }); caster.honor += honorGained; game.log.push(`${casterName} kradnie ${honorGained} Honoru od innych graczy.`); break;
    }
}

function endTurn(gameId) {
    const game = games[gameId];
    game.players.forEach(p => { if ((p.honor <= 0 || p.scandals >= 5) && !p.isEliminated) { p.isEliminated = true; game.log.push(`Gracz ${p.nickname} odpada z gry!`); } });
    const activePlayers = game.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1) { const winner = activePlayers.length === 1 ? activePlayers[0] : null; game.log.push(winner ? `Wygrywa ${winner.nickname} jako ostatni na placu boju!` : "Wszyscy odpadli! Brak zwycięzcy."); game.gameState = 'GAME_OVER'; broadcast(gameId); return; }
    const honorWinner = game.players.find(p => p.honor >= 20);
    if (honorWinner) { game.log.push(`${honorWinner.nickname} osiąga 20 Honoru i wygrywa grę!`); game.gameState = 'GAME_OVER'; broadcast(gameId); return; }
    const currentIndex = game.players.findIndex(p => p.id === game.currentTurnPlayerId);
    let nextIndex = (currentIndex + 1) % game.players.length;
    while (game.players[nextIndex].isEliminated) { nextIndex = (nextIndex + 1) % game.players.length; }
    if (nextIndex <= currentIndex) { game.round++; }
    if (game.round > 10) { const sortedByScandal = [...activePlayers].sort((a, b) => a.scandals - b.scandals); const winner = sortedByScandal[0]; game.log.push(`Koniec rund! Wygrywa ${winner.nickname} z najmniejszą liczbą Skandali (${winner.scandals})!`); game.gameState = 'GAME_OVER'; broadcast(gameId); return; }
    if (game.deck.length < 3) { game.deck.push(...shuffle(game.discardPile)); game.discardPile = []; game.log.push("Talia przetasowana z odrzuconych kart."); }
    const nextPlayer = game.players[nextIndex];
    game.currentTurnPlayerId = nextPlayer.id;
    game.gameState = 'DRAFTING';
    game.draftOptions = game.deck.slice(0, 3);
    game.log.push(`Koniec tury. Teraz ruch gracza ${nextPlayer.nickname}.`);
    broadcast(gameId);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Serwer nasłuchuje na porcie ${PORT}`);
});
