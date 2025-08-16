# Freely (P2P music player)

Este repositorio es un **prototipo** web-first que demuestra:
- Reproducción P2P local entre pestañas usando WebRTC (libp2p).
- Base de datos local (SQLite via sql.js) con tablas para usuarios, historial, favoritos, playlists, plugins y settings.
- Gestión básica de plugins por manifest en `/public/plugins`.
- Import/export de todo el estado local en JSON.

## Cómo ejecutar en desarrollo (PC)
1. Instala dependencias:

```bash
npm install
```

2. Ejecuta en modo desarrollo:

```bash
npm run dev
```

## (Android)
Este proyecto está pensado para empaquetarse con **Capacitor** para Android. Resumen:

1. Genera build de producción:
```bash
npm run build
```
2. Añade Capacitor a tu proyecto (desde la carpeta del frontend):
```bash
npm install @capacitor/core @capacitor/cli --save
npx cap init MyPlayer com.example.myplayer
npx cap add android
npx cap copy android
npx cap open android
```
3. En Android Studio ejecuta el proyecto en emulador o dispositivo.

> Nota: WebRTC en WebView puede tener diferencias respecto a navegadores. Para pruebas Android nativas y mejor P2P (sockets/QUIC) deberás integrar un adaptador nativo o usar Tauri + Rust native core. Este repo es punto de partida.

## Limitaciones del prototipo
- El flujo de reproducir chunks aquí es **intencionalmente simple** (blob por chunk). Para producción debes implementar buffering, MSE o WebAudio con decoders, verificación de integridad (hash por chunk), reintentos, peers multiplexing y almacenamiento persistente de chunks en disco.
- Plugins en `public/plugins` son ejemplos estáticos. Implementa un gestor de plugins en el core para ejecutar WASM plugins o conectarse a servicios remotos.

---
