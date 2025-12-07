# WhatsApp Worker - whatsapp-web.js

Worker Node.js avec **whatsapp-web.js** pour gérer les connexions WhatsApp et l'envoi de messages.

> ⚠️ **Migration depuis Baileys** : Ce projet a été migré de Baileys vers whatsapp-web.js. Voir [MIGRATION.md](./MIGRATION.md) pour les détails.

## 🚀 Fonctionnalités

- ✅ Connexion WhatsApp via whatsapp-web.js (client web officiel)
- ✅ Support QR Code pour authentification
- ✅ Envoi de messages (texte, image, vidéo, document, audio)
- ✅ Réception de messages en temps réel
- ✅ Gestion multi-sessions (plusieurs numéros)
- ✅ Health checks automatiques
- ✅ Reconnexion automatique
- ✅ Communication RabbitMQ avec le backend
- ✅ Logs structurés avec Pino
- ✅ Support Docker avec Chromium

## 📋 Prérequis

- Node.js 18+
- RabbitMQ
- Backend Java (pour recevoir les commandes)
- **Chromium** (installé automatiquement par whatsapp-web.js)

## 🛠️ Installation

### 1. Cloner et Installer

```bash
# Cloner le projet
git clone <votre-repo>
cd whatsapp-worker

# Installer les dépendances
npm install
```

### 2. Configuration

Copier `.env.example` vers `.env` et configurer :

```bash
cp .env.example .env
```

Éditer `.env` :

```env
WORKER_ID=1
WORKER_NAME="WhatsApp Worker 1"

RABBITMQ_URL=amqp://guest:guest@localhost:5672
BACKEND_API_URL=http://localhost:8080/api

LOG_LEVEL=info
NODE_ENV=development
```

### 3. Démarrer

```bash
# Développement (avec hot reload)
npm run dev

# Production
npm start

# Test whatsapp-web.js
npm run test:whatsapp
```

## 📁 Structure du Projet

```
whatsapp-worker/
├── src/
│   ├── config/
│   │   └── config.js              # Configuration centralisée
│   ├── services/
│   │   ├── rabbitMQService.js     # Service RabbitMQ
│   │   └── sessionManager.js      # Gestion des sessions whatsapp-web.js
│   ├── handles/
│   │   ├── MessageHandler.js      # Handler messages
│   │   └── HealthHandler.js       # Handler health checks
│   ├── utils/
│   │   └── logger.js              # Logger Pino
│   └── worker.js                  # Point d'entrée
├── sessions/                      # Sessions WhatsApp (auth data)
├── .wwebjs_auth/                  # Authentification whatsapp-web.js
├── test-whatsapp.js               # Script de test
├── cleanup-sessions.js            # Script de nettoyage
├── .env.example                   # Template variables env
├── package.json
├── Dockerfile
├── MIGRATION.md                   # Documentation migration
├── QUICKSTART.md                  # Guide démarrage rapide
└── README.md
```

## 🔌 Communication RabbitMQ

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

Actions disponibles : `create`, `close`, `reconnect`, `regenerate_qr`

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

Actions : `qr_generated`, `connected`, `disconnected`, `error`

**2. `whatsapp.number.health`** - Statuts numéros
```json
{
  "numberId": 1,
  "status": "HEALTHY",
  "workerId": 1
}
```

Statuts : `HEALTHY`, `UNHEALTHY`, `DISCONNECTED`, `NOT_FOUND`, `BANNED`

**3. `whatsapp.message.receive`** - Messages reçus
```json
{
  "sessionId": "session_1_225XXXXX",
  "numberId": 1,
  "messageId": "3EB0XXXXX",
  "from": "225YYYYY@c.us",
  "body": "Hello!",
  "timestamp": 1234567890
}
```

## 📱 Connexion WhatsApp

### Première Connexion

1. Démarrer le worker : `npm start`
2. Envoyer un message `create` via RabbitMQ
3. Un QR Code sera généré et envoyé au backend
4. Scanner le QR Code avec WhatsApp sur votre téléphone
5. La session sera sauvegardée dans `.wwebjs_auth/`

### Sessions Multiples

Chaque numéro WhatsApp a sa propre session :

```
.wwebjs_auth/
├── session-session_1_225XXXXX/
│   └── Default/
│       ├── IndexedDB/
│       └── Local Storage/
├── session-session_2_225YYYYY/
    └── Default/
        ├── IndexedDB/
        └── Local Storage/
```

## 💬 Types de Messages Supportés

### Texte
```javascript
{
  "type": "text",
  "content": "Bonjour!",
  "mediaUrl": null
}
```

### Image
```javascript
{
  "type": "image",
  "content": "Légende de l'image",
  "mediaUrl": "https://example.com/image.jpg"
}
```

### Vidéo
```javascript
{
  "type": "video",
  "content": "Légende de la vidéo",
  "mediaUrl": "https://example.com/video.mp4"
}
```

### Document
```javascript
{
  "type": "document",
  "content": "document.pdf",
  "mediaUrl": "https://example.com/doc.pdf"
}
```

### Audio
```javascript
{
  "type": "audio",
  "content": "",
  "mediaUrl": "https://example.com/audio.mp3"
}
```

## 🔍 Health Checks

Le worker effectue des health checks automatiques toutes les minutes :

- Vérifie que les sessions sont connectées
- Teste l'état du client WhatsApp
- Rapporte l'état au backend
- Tente la reconnexion si nécessaire

## 🐳 Docker

### Construire l'Image

```bash
docker build -t whatsapp-worker:latest .
```

**Note** : La construction prend plus de temps qu'avant (installation de Chromium)

### Lancer avec Docker Compose

```bash
# Démarrer le worker
docker-compose up -d

# Voir les logs
docker-compose logs -f worker

# Arrêter
docker-compose down
```

### Configuration Docker

Le `docker-compose.yaml` inclut :
- `shm_size: '2gb'` - Requis pour Chromium
- Volume `worker_auth` - Stockage des sessions
- Volume `worker_sessions` - Données de session

## 📊 Logs

Les logs sont structurés avec Pino :

```json
{
  "level": "info",
  "time": 1234567890,
  "msg": "Session session_1_225XXXXX is ready and connected"
}
```

Niveaux disponibles :
- `trace` - Détails très verbeux
- `debug` - Informations de debug
- `info` - Informations normales
- `warn` - Avertissements
- `error` - Erreurs
- `fatal` - Erreurs critiques

## ⚠️ Gestion des Erreurs

### Reconnexion Automatique

Le worker tente automatiquement de se reconnecter en cas de :
- Perte de connexion réseau
- Timeout WhatsApp
- Erreur temporaire

### Numéro Banni/Déconnecté

Si un numéro est banni ou déconnecté :
1. Le worker détecte la déconnexion
2. Notifie le backend via `whatsapp.number.health`
3. Le backend peut remplacer le numéro

## 🔧 Dépannage

### Chromium ne démarre pas

```bash
# Linux
sudo apt-get update
sudo apt-get install -y chromium-browser

# Le Dockerfile inclut déjà toutes les dépendances
```

### QR Code ne s'affiche pas

```bash
# Vérifier les logs
npm start

# Vérifier la connexion RabbitMQ
curl http://localhost:15672
```

### Session ne se connecte pas

```bash
# Nettoyer les sessions
npm run cleanup

# Ou manuellement
rm -rf sessions/*
rm -rf .wwebjs_auth/*

# Redémarrer
npm start
```

### Erreur "Protocol error"

```bash
# Augmenter la mémoire partagée (Docker)
# Déjà configuré dans docker-compose.yaml
shm_size: '2gb'
```

## 📈 Performance

### Scalabilité

- Un worker peut gérer 10-20 numéros simultanément
- Pour plus de numéros, lancer plusieurs workers
- Chaque worker est indépendant

### Ressources

| Ressource | Baileys | whatsapp-web.js |
|-----------|---------|-----------------|
| RAM | ~150 MB | ~400 MB |
| CPU (idle) | ~1% | ~2-3% |
| Démarrage | ~3s | ~15s |
| Stockage/session | ~5 MB | ~20 MB |

**Recommandations** :
- Minimum 2 GB RAM par worker
- SSD recommandé pour les sessions
- Surveiller l'utilisation mémoire

## 🔐 Sécurité

### Sessions
- Les sessions sont stockées dans `.wwebjs_auth/`
- Ne jamais commiter les sessions dans Git
- Sauvegarder régulièrement les sessions

### Variables d'Environnement
- Ne jamais commiter `.env`
- Utiliser des secrets pour la production
- Changer les credentials par défaut

## 📚 whatsapp-web.js

Ce worker utilise [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) :

- Basé sur le client web officiel WhatsApp
- Très stable et bien maintenu
- API riche et complète
- Support communautaire actif
- Documentation complète

## 🚀 Production

### Recommandations

1. **Utiliser PM2** pour la gestion des processus
```bash
npm install -g pm2
pm2 start src/worker.js --name worker-1
pm2 save
pm2 startup
```

2. **Configurer les backups** des sessions
```bash
# Backup automatique toutes les heures
0 * * * * tar -czf sessions-backup-$(date +\%Y\%m\%d-\%H).tar.gz .wwebjs_auth/
```

3. **Monitoring** avec Prometheus/Grafana

4. **Load balancing** avec plusieurs workers

5. **Surveillance de la mémoire**
```bash
# Redémarrer si mémoire > 1GB
pm2 start src/worker.js --max-memory-restart 1G
```

## 🆕 Migration depuis Baileys

Si vous migrez depuis Baileys :

1. **Lire la documentation** : [MIGRATION.md](./MIGRATION.md)
2. **Guide rapide** : [QUICKSTART.md](./QUICKSTART.md)
3. **Nettoyer les sessions** : `npm run cleanup`
4. **Re-scanner les QR codes** pour tous les numéros

⚠️ **Les sessions Baileys ne sont PAS compatibles avec whatsapp-web.js !**

## 📞 Support

Pour toute question :
- Consulter [MIGRATION.md](./MIGRATION.md) et [QUICKSTART.md](./QUICKSTART.md)
- Vérifier les logs du worker
- Tester avec `npm run test:whatsapp`
- Consulter la [documentation whatsapp-web.js](https://wwebjs.dev/)

## 📄 Licence

MIT License