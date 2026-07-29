# WhatsApp Worker - WAHA orchestrator

Worker Node.js qui orchestre un conteneur **[WAHA](https://waha.devlike.pro/)** (WhatsApp HTTP API) par numéro WhatsApp, et fait le pont entre RabbitMQ (backend Java) et l'API REST/webhooks de ces conteneurs.

> 🆕 **Migration depuis whatsapp-web.js** : ce worker pilotait auparavant WhatsApp directement via whatsapp-web.js + Puppeteer/Chromium (sujet aux freezes d'onglet). Il délègue maintenant tout le pilotage WhatsApp à WAHA (moteur `NOWEB`, sans navigateur), ce qui rend le worker lui-même très léger.

## 🚀 Fonctionnalités

- ✅ Un conteneur WAHA par numéro WhatsApp, créé/géré dynamiquement (Docker Engine API)
- ✅ Support QR Code pour authentification
- ✅ Envoi de messages (texte, image, vidéo, document, audio)
- ✅ Réception de messages en temps réel (webhooks WAHA)
- ✅ Gestion multi-sessions (plusieurs numéros)
- ✅ Health checks automatiques
- ✅ Reconnexion automatique
- ✅ Communication RabbitMQ avec le backend (contrat de queues inchangé)
- ✅ Logs structurés avec Pino

## 📋 Prérequis

- Node.js 18+
- Docker (le worker a besoin d'accéder au socket Docker de l'hôte pour créer les conteneurs WAHA)
- RabbitMQ
- Backend Java (pour recevoir les commandes)

## 🛠️ Installation

### 1. Cloner et Installer

```bash
git clone <votre-repo>
cd whatsapp-worker
npm install
```

### 2. Configuration

```bash
cp .env.example .env
```

Éditer `.env` :

```env
WORKER_ID=1
WORKER_NAME="WhatsApp Worker 1"

RABBITMQ_URL=amqp://guest:guest@localhost:5672

WAHA_IMAGE=devlikeapro/waha:latest
DOCKER_NETWORK=whatsapp-network
WEBHOOK_PORT=3001
WORKER_PUBLIC_URL=http://worker:3001

LOG_LEVEL=info
NODE_ENV=development
```

### 3. Démarrer

En local (hors Docker), le worker a quand même besoin d'un Docker daemon accessible (Docker Desktop) pour créer les conteneurs WAHA, et le réseau `whatsapp-network` doit exister :

```bash
docker network create whatsapp-network

# Développement (avec hot reload)
npm run dev

# Production
npm start
```

## 📁 Structure du Projet

```
whatsapp-worker/
├── src/
│   ├── config/
│   │   └── config.js              # Configuration centralisée
│   ├── services/
│   │   ├── rabbitMQService.js     # Service RabbitMQ
│   │   ├── dockerManager.js       # Crée/gère les conteneurs WAHA (un par numéro)
│   │   ├── wahaClient.js          # Client REST vers l'API WAHA d'un conteneur
│   │   └── sessionManager.js      # Etat des sessions + orchestration WAHA
│   ├── handles/
│   │   ├── MessageHandler.js      # Handler messages
│   │   └── HealthHandler.js       # Handler health checks
│   ├── utils/
│   │   └── logger.js              # Logger Pino
│   ├── webhookServer.js           # Reçoit les webhooks des conteneurs WAHA
│   └── worker.js                  # Point d'entrée
├── .env.example                   # Template variables env
├── package.json
├── DockerFile
├── docker-compose.yaml
└── README.md
```

## 🔌 Communication RabbitMQ

Le contrat de queues est identique à l'ancienne version whatsapp-web.js — **aucun changement côté backend Java**.

### Queues Consommées

**1. `whatsapp.message.send`** - Envoi de messages
```json
{
  "messageId": 123,
  "whatsappNumberId": 1,
  "recipientNumber": "225XXXXXXXXX",
  "content": "Hello!",
  "type": "text",
  "mediaUrl": null
}
```

**2. `whatsapp.number.health`** - Health checks
```json
{
  "action": "health_check",
  "numberId": 1,
  "workerId": 1
}
```

**3. `whatsapp.session.update`** - Gestion sessions
```json
{
  "action": "create",
  "data": {
    "numberId": 1,
    "phoneNumber": "225XXXXXXXXX",
    "workerId": 1
  }
}
```

Actions disponibles : `create`, `close`, `delete`, `reconnect`, `regenerate_qr`

### Queues Publiées

**1. `whatsapp.worker.events`** - Événements worker
```json
{
  "action": "qr_generated",
  "numberId": 1,
  "sessionId": "session_1_225XXXXX",
  "qrCode": "data:image/png;base64,...",
  "timestamp": 1234567890
}
```

Actions : `qr_generated`, `connected`, `disconnected`, `error`, `deleted_inactivity`, `worker_status`

**2. `whatsapp.number.health`** - Statuts numéros
```json
{
  "numberId": 1,
  "status": "HEALTHY",
  "workerId": 1
}
```

Statuts : `HEALTHY`, `UNHEALTHY`, `DISCONNECTED`, `NOT_FOUND`, `BANNED`

**3. `whatsapp.message.receive`** - Messages reçus (et statuts d'envoi)
```json
{
  "sessionId": "session_1_225XXXXX",
  "numberId": 1,
  "from": "225YYYYY@c.us",
  "body": "Hello!",
  "timestamp": 1234567890
}
```

## 📱 Connexion WhatsApp

### Comment ça marche

1. Le backend publie un `session.update` (`create`) pour un `numberId`/`phoneNumber`.
2. Le worker crée (ou redémarre) un conteneur `waha-{numberId}` sur le réseau Docker `whatsapp-network`, avec un volume persistant `waha_session_{numberId}`.
3. Le conteneur WAHA notifie le worker par webhook (`http://worker:3001/waha-webhook/{numberId}`) de son état (`SCAN_QR_CODE`, `WORKING`, `FAILED`, `STOPPED`).
4. Sur `SCAN_QR_CODE`, le worker récupère le QR via l'API WAHA et le publie sur `whatsapp.worker.events` (`qr_generated`) — le backend l'affiche pour scan.
5. Sur `WORKING`, le worker publie `connected` + `HEALTHY`.
6. La session persiste dans le volume Docker : un redémarrage du worker ou du conteneur WAHA ne nécessite pas de re-scanner le QR (voir `restoreSessions()`).

## 💬 Types de Messages Supportés

Identique à l'ancienne version : `text`, `image`, `video`, `document`, `audio` avec `content`/`mediaUrl`.

## 🔍 Health Checks

Le worker effectue des health checks automatiques toutes les minutes. L'état `connected`/`isReady` de chaque session est maintenu par les webhooks WAHA (pas de polling actif du conteneur nécessaire, contrairement à l'ancien `client.getState()` whatsapp-web.js qui pouvait bloquer indéfiniment sur un onglet Chromium figé).

## 🐳 Docker

### Construire l'Image

```bash
docker build -t whatsapp-worker:latest -f DockerFile .
```

### Lancer avec Docker Compose

```bash
docker network create whatsapp-network   # si pas déjà créé
docker-compose up -d
docker-compose logs -f worker
docker-compose down
```

### Configuration Docker

Le `docker-compose.yaml` :
- Monte `/var/run/docker.sock` dans le worker pour qu'il puisse créer/gérer les conteneurs WAHA (équivalent à un accès root sur l'hôte — nécessaire pour l'architecture "un conteneur par numéro").
- `group_add` doit correspondre au GID du socket Docker de l'hôte (`stat -c '%g' /var/run/docker.sock`).
- Les conteneurs WAHA eux-mêmes ne sont **pas** déclarés dans ce fichier : ils sont créés dynamiquement par `dockerManager.js`, visibles via `docker ps` (préfixe `waha-`).

## ⚠️ Gestion des Erreurs

### Numéro Déconnecté/Échec

Si un conteneur WAHA passe en `FAILED` ou `STOPPED` :
1. Le webhook notifie le worker.
2. Le worker publie `whatsapp.worker.events` (`error`/`disconnected`) et `whatsapp.number.health` (`DISCONNECTED`).
3. Le health check périodique tente une reconnexion automatique (`createSession`).

## 🔧 Dépannage

### Le conteneur WAHA ne démarre pas

```bash
docker ps -a --filter "name=waha-"
docker logs waha-<numberId>
```

### QR Code ne s'affiche pas

```bash
# Vérifier que le webhook du worker est bien joignable depuis le conteneur WAHA
docker exec waha-<numberId> wget -qO- http://worker:3001/waha-webhook/<numberId> || true

# Vérifier la connexion RabbitMQ
curl http://localhost:15672
```

### Session ne se reconnecte pas

```bash
# Supprimer complètement le conteneur et son volume pour forcer un nouveau QR
docker rm -f waha-<numberId>
docker volume rm waha_session_<numberId>
```

## 📈 Performance

Le moteur WAHA `NOWEB` ne lance pas de navigateur, ce qui allège fortement le worker par rapport à l'ancienne intégration whatsapp-web.js/Puppeteer. Chaque numéro tourne dans son propre conteneur WAHA, donc la consommation mémoire évolue avec le nombre de conteneurs plutôt qu'avec le process worker lui-même.

## 🔐 Sécurité

- Le worker a un accès équivalent root sur l'hôte via `/var/run/docker.sock` — à isoler sur une machine/VM dédiée à cet usage.
- Les sessions WAHA sont persistées dans des volumes Docker nommés (`waha_session_{numberId}`) — à sauvegarder régulièrement.
- Ne jamais commiter `.env`.

## 🚀 Production

1. **PM2** (hors Docker) reste utilisable pour le process worker, mais le worker doit toujours avoir accès à un daemon Docker.
```bash
npm install -g pm2
pm2 start src/worker.js --name worker-1
pm2 save
pm2 startup
```

2. **Sauvegarder les volumes de sessions** (`waha_session_*`) régulièrement.

3. **Monitoring** avec Prometheus/Grafana, `docker ps` pour l'état des conteneurs WAHA.

## 📚 WAHA

Ce worker orchestre [WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API) :

- Moteur `NOWEB` : pas de navigateur, empreinte mémoire réduite
- API REST simple pour l'envoi et la gestion des sessions
- Webhooks pour les événements (statut de session, messages entrants)

## 📞 Support

- Consulter les logs du worker (`docker-compose logs -f worker`) et des conteneurs WAHA (`docker logs waha-<numberId>`)
- [Documentation WAHA](https://waha.devlike.pro/docs/overview/quick-start/)

## 📄 Licence

MIT License
