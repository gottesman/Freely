import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

console.log('Signaling server started on ws://localhost:8080');

wss.on('connection', ws => {
  console.log('Client connected');

  ws.on('message', message => {
    // Reenviar el mensaje a todos los demás clientes
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});