import { WebSocketServer } from 'ws';
import { logInfo } from './src/core/FrontendLogger';

const wss = new WebSocketServer({ port: 8080 });

logInfo('Signaling server started on ws://localhost:8080');

wss.on('connection', ws => {
  logInfo('Client connected');

  ws.on('message', message => {
    // Reenviar el mensaje a todos los demás clientes
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    logInfo('Client disconnected');
  });
});