# WhatsApp Worker - Baileys

Worker Node.js avec Baileys pour gérer les connexions WhatsApp et l'envoi de messages.

## 🚀 Fonctionnalités

- ✅ Connexion WhatsApp via Baileys (multi-device)
- ✅ Support QR Code pour authentification
- ✅ Envoi de messages (texte, image, vidéo, document, audio)
- ✅ Réception de messages en temps réel
- ✅ Gestion multi-sessions (plusieurs numéros)
- ✅ Health checks automatiques
- ✅ Reconnexion automatique
- ✅ Communication RabbitMQ avec le backend
- ✅ Logs structurés avec Pino

## 📋 Prérequis

- Node.js 18+
- RabbitMQ
- Backend Java (pour recevoir les commandes)

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
WORKER_ID=worker-1
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
```

## 📁 Structure du Projet

```
whatsapp-worker/
├── src/
│   ├── config/
│   │   └── config.js              # Configuration centralisée
│   ├── services/
│   │   ├── rabbitmq.js            # Service RabbitMQ
│   │   └── sessionManager.js     # Gestion des sessions Baileys
│   ├── handlers/
│   │   ├── messageHandler.js     # Handler messages
│   │   └── healthHandler.js      # Handler health checks
│   ├── utils/
│   │   └── logger.js              # Logger Pino
│   └── worker.js                  # Point d'entrée
├── sessions/                      # Sessions WhatsApp (auth data)
├── .env.example                   # Template variables env
├── package.json
├── Dockerfile
└── README.md
```

## 🔌 Communication RabbitMQ

### Queues Consommées

**1. `whatsapp.message.send`** - Envoi de messages
```json
{
  "messageId": 123,
  "whatsappNumberId": 1,
  "recipientNumber": "+225XXXXXXXXX",
  "content": "Hello!",
  "type": "TEXT",
  "mediaUrl": null
}
```

**2. `whatsapp.number.health`** - Health checks
```json
{
  "action": "health_check",
  "numberId": 1,
  "workerId": "worker-1"
}
```

**3. `whatsapp.session.update`** - Gestion sessions
```json
{
  "action": "create",
  "numberId": 1,
  "phoneNumber": "+225XXXXXXXXX"
}
```

### Queues Publiées

**1. `whatsapp.message.receive`** - Statuts messages
```json
{
  "messageId": 123,
  "status": "SENT",
  "whatsappMessageId": "3EB0XXXXX",
  "timestamp": 1234567890
}
```

**2. `whatsapp.number.health`** - Statuts numéros
```json
{
  "numberId": 1,
  "status": "HEALTHY",
  "workerId": "worker-1"
}
```

**3. `whatsapp.session.update`** - Updates sessions
```json
{
  "sessionId": "session_1_+225XXXXX",
  "numberId": 1,
  "action": "connected"
}
```

## 📱 Connexion WhatsApp

### Première Connexion

1. Démarrer le worker
2. Un QR Code sera affiché dans le terminal
3. Scanner le QR Code avec WhatsApp sur votre téléphone
4. La session sera sauvegardée dans `sessions/`

### Sessions Multiples

Chaque numéro WhatsApp a sa propre session :

```
sessions/
├── session_1_+225XXXXX/
│   ├── creds.json
│   └── app-state-sync-*.json
├── session_2_+225YYYYY/
│   ├── creds.json
│   └── app-state-sync-*.json
```

## 💬 Types de Messages Supportés

### Texte
```javascript
{
  "type": "TEXT",
  "content": "Bonjour!",
  "mediaUrl": null
}
```

### Image
```javascript
{
  "type": "IMAGE",
  "content": "Légende de l'image",
  "mediaUrl": "https://example.com/image.jpg"
}
```

### Vidéo
```javascript
{
  "type": "VIDEO",
  "content": "Légende de la vidéo",
  "mediaUrl": "https://example.com/video.mp4"
}
```

### Document
```javascript
{
  "type": "DOCUMENT",
  "content": "document.pdf",
  "mediaUrl": "https://example.com/doc.pdf"
}
```

### Audio
```javascript
{
  "type": "AUDIO",
  "content": "",
  "mediaUrl": "https://example.com/audio.mp3"
}
```

## 🔍 Health Checks

Le worker effectue des health checks automatiques toutes les minutes :

- Vérifie que les sessions sont connectées
- Teste la connexion WebSocket
- Rapporte l'état au backend
- Tente la reconnexion si nécessaire

## 🐳 Docker

### Construire l'Image

```bash
docker build -t whatsapp-worker .
```

### Lancer avec Docker Compose

```bash
# Démarrer tous les workers
docker-compose up -d

# Voir les logs
docker-compose logs -f worker-1

# Arrêter
docker-compose down
```

### Lancer Manuellement

```bash
docker run -d \
  --name whatsapp-worker-1 \
  -e WORKER_ID=worker-1 \
  -e RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672 \
  -v $(pwd)/sessions:/app/sessions \
  whatsapp-worker
```

## 📊 Logs

Les logs sont structurés avec Pino :

```json
{
  "level": "info",
  "time": 1234567890,
  "msg": "Message sent successfully to +225XXXXX"
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

### Numéro Banni

Si un numéro est banni par WhatsApp :
1. Le worker détecte la déconnexion
2. Notifie le backend via `whatsapp.number.health`
3. Le backend remplace automatiquement le numéro

## 🔧 Dépannage

### QR Code ne s'affiche pas

```bash
# Vérifier les logs
npm start

# Vérifier la connexion RabbitMQ
curl http://localhost:15672
```

### Session ne se connecte pas

```bash
# Supprimer la session et réessayer
rm -rf sessions/session_*
npm start
```

### Messages ne s'envoient pas

```bash
# Vérifier RabbitMQ
docker logs whatsapp-rabbitmq

# Vérifier le worker
docker logs whatsapp-worker-1
```

## 📈 Performance

### Scalabilité

- Un worker peut gérer 10-20 numéros simultanément
- Pour plus de numéros, lancer plusieurs workers
- Chaque worker est indépendant

### Ressources

- RAM : ~200MB par worker
- CPU : Minimal (pics lors d'envoi de médias)
- Stockage : ~50MB par session

## 🔐 Sécurité

### Sessions
- Les sessions sont stockées localement
- Ne jamais commiter les sessions dans Git
- Sauvegarder régulièrement les sessions

### Variables d'Environnement
- Ne jamais commiter `.env`
- Utiliser des secrets pour la production
- Changer les credentials par défaut

## 📚 Baileys

Ce worker utilise [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) :

- Multi-device natif
- Sans API officielle WhatsApp
- Open source et gratuit
- Support complet des fonctionnalités

## 🚀 Production

### Recommandations

1. **Utiliser PM2** pour la gestion des processus
```bash
npm install -g pm2
pm2 start src/worker.js --name worker-1
```

2. **Configurer les backups** des sessions
```bash
# Backup automatique toutes les heures
0 * * * * tar -czf sessions-backup-$(date +\%Y\%m\%d-\%H).tar.gz sessions/
```

3. **Monitoring** avec Prometheus/Grafana

4. **Load balancing** avec plusieurs workers

## 📞 Support

Pour toute question :
- Consulter les logs du worker
- Vérifier la connexion RabbitMQ
- Tester avec un seul worker d'abord

## 📄 Licence

MIT License