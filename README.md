<div align="center">

<img src="bridge/icon.png" alt="bambufarm-backend" width="120" />

# bambufarm-backend

### El servidor que mantiene viva una granja de impresoras Bambu Lab

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) ![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white) ![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white) ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) ![Mongoose](https://img.shields.io/badge/Mongoose-880000?style=for-the-badge&logo=mongodb&logoColor=white) ![Claude](https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white) ![JWT](https://img.shields.io/badge/JWT-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white) ![MQTT](https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=mqtt&logoColor=white) ![Jest](https://img.shields.io/badge/Jest-C21325?style=for-the-badge&logo=jest&logoColor=white) ![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)

[**📦 Repositorio**](https://github.com/Harkor421/bambufarm-backend)

</div>

---

## 📖 Sobre el proyecto

Backend Node.js de la app iOS [BambuFarm](https://github.com/Harkor421/BambuFarm). Se suscribe al MQTT de Bambu Cloud para el estado en tiempo real de las impresoras, despacha push notifications y actualizaciones de Live Activity vía APNs, y retransmite las cámaras a través de un bridge por usuario.

## ✨ Qué hace

- Suscripción MQTT a Bambu Cloud para estado en vivo de cada impresora
- Push notifications y Live Activities por APNs
- Bridge de escritorio (Electron) que descubre impresoras y cámaras en la LAN (ONVIF/RTSP)
- Análisis de impresión con Claude sobre snapshots de la cámara
- Auth con JWT, MongoDB, rate limiting, CI en GitHub Actions y tests con cobertura

## 🧰 Stack

| | |
|---|---|
| **Lenguajes y runtime** | ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) |
| **Móvil y escritorio** | ![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white) |
| **Backend** | ![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white) ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) ![JWT](https://img.shields.io/badge/JWT-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white) |
| **Datos** | ![Mongoose](https://img.shields.io/badge/Mongoose-880000?style=for-the-badge&logo=mongodb&logoColor=white) |
| **IA** | ![Claude](https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white) |
| **Servicios e integraciones** | ![MQTT](https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=mqtt&logoColor=white) |
| **Calidad** | ![Jest](https://img.shields.io/badge/Jest-C21325?style=for-the-badge&logo=jest&logoColor=white) |
| **Infraestructura** | ![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white) |

## 📂 Estructura

```
src/__tests__                  # Tests
src/db                         # Acceso a base de datos
src/middleware                 # Middleware
src/routes                     # Definición de rutas
src/services                   # Servicios e integraciones
src/utils                      # Funciones auxiliares
bridge/.DS_Store
bridge/.gitignore
bridge/__tests__
ios/bambufarmserver            # Proyecto nativo de iOS
ios/bambufarmserver.xcodeproj  # Proyecto nativo de iOS
```

## 🚀 Empezar

```bash
git clone https://github.com/Harkor421/bambufarm-backend.git
cd bambufarm-backend
npm install
npm run dev
```

## ⚙️ Variables de entorno

Copia `.env.example` a `.env` y completa los valores:

| Variable | Ejemplo / valor por defecto |
|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/bambufarm` |
| `API_KEY` | `replace_me` |
| `ADMIN_PASSWORD` | `replace_me` |
| `APNS_KEY_ID` | `XXXXXXXXXX` |
| `APNS_TEAM_ID` | `XXXXXXXXXX` |
| `APNS_KEY_PATH` | `./data/AuthKey_XXXXXXXXXX.p8` |
| `APNS_HOST` | `api.push.apple.com            # prod` |
| `PORT` | `3000` |
| `POLL_INTERVAL_MS` | `30000` |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | `development` |

## 📜 Scripts

| Comando | Qué hace |
|---|---|
| `npm run start` | Arranca la aplicación |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |
| `npm run lint` | Revisa el estilo del código |
| `npm run lint:fix` | Corrige automáticamente lo que puede |
| `npm run format` | Formatea el código |
| `npm run format:check` | Verifica el formato sin escribir |
| `npm run test` | Ejecuta la suite de tests |
| `npm run test:watch` | Tests en modo watch |
| `npm run test:cov` | Tests con reporte de cobertura |

## ☁️ Despliegue

- **Railway** (`railway.json` / `nixpacks.toml`)
- **Procfile** (Heroku / Railway)
- **EAS Build** (Expo)

---

<div align="center">

Hecho por [**Samir González**](https://github.com/Harkor421)

</div>
