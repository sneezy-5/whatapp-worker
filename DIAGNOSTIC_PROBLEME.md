# 🔍 Diagnostic - Problème de Réception des Messages

## 🚨 PROBLÈME IDENTIFIÉ

**Symptôme:** Le backend envoie des messages mais le worker ne les reçoit pas.

**Logs Backend:**
```
QR Code not yet generated. Please wait...
Worker worker-1 status: 0 total sessions, 0 connected
```

**Cause:** Le worker ne reçoit pas le message `action: create` du backend.

---

## ✅ SOLUTION APPLIQUÉE

### 1. Fichier .env Corrompu - CORRIGÉ ✅

Le fichier `.env` était complètement vide/corrompu. Il a été recréé avec la bonne configuration.

**Vérification:**
```bash
Get-Content .env | Select-String "WORKER_ID"
# Résultat: WORKER_ID=worker-1 ✅
```

---

## 🔧 ÉTAPES DE REDÉMARRAGE

### 1. Arrêter le Worker Actuel

Dans le terminal où tourne le worker:
```
Ctrl+C
```

### 2. Redémarrer le Worker

```bash
cd c:\Users\HP\whatsapp-worker
npm start
```

### 3. Vérifier les Logs de Démarrage

Vous devriez voir:
```
Starting WhatsApp Worker: WhatsApp Worker 1 (worker-1)
Environment: production
Connecting to RabbitMQ...
✓ Connected to AMQP
✓ Channel created
✓ Prefetch set
Connected to RabbitMQ successfully
All message consumers set up successfully
Worker started successfully and ready to process messages
```

---

## 🧪 TEST COMPLET

### Étape 1: Vérifier que le Worker Écoute

**Dans les logs du worker, chercher:**
```
Starting to consume queue: whatsapp.session.update
Consumer set up successfully for queue: whatsapp.session.update
```

### Étape 2: Valider un Client depuis le Backend

```bash
curl -X POST "http://localhost:8080/api/admin/dashboard/clients/6/validate?workerId=worker-1"
```

### Étape 3: Vérifier les Logs du Worker

**Vous devriez voir:**
```
📨 Received message from whatsapp.session.update: { action: 'create', ... }
Session update: create for number 6
Creating new WhatsApp session: session_6_+221...
```

### Étape 4: Attendre le QR Code

**Dans les logs du worker:**
```
QR Code generated for session_6_+221...
QR Code sent to backend for number 6
```

### Étape 5: Récupérer le QR depuis le Backend

```bash
curl "http://localhost:8080/api/admin/dashboard/clients/6/qr-code"
```

**Résultat attendu:**
```json
{
  "success": true,
  "qrCode": "data:image/png;base64,...",
  "clientId": 6,
  "phoneNumber": "+221771234567"
}
```

---

## 🔍 POINTS DE VÉRIFICATION

### 1. Configuration RabbitMQ

**Vérifier dans .env:**
```
RABBITMQ_URL=amqp://guest:guest@213.199.54.136:5672
QUEUE_SESSION_UPDATE=whatsapp.session.update
```

**Vérifier dans le backend (application.yml):**
```yaml
whatsapp:
  queue:
    session-update: whatsapp.session.update
```

✅ Les deux doivent correspondre exactement !

### 2. Worker ID

**Dans .env:**
```
WORKER_ID=worker-1
```

**Dans la requête de validation:**
```
POST /api/admin/dashboard/clients/6/validate?workerId=worker-1
```

⚠️ **IMPORTANT:** Le `workerId` dans la requête doit correspondre au `WORKER_ID` du worker !

### 3. RabbitMQ Accessible

**Tester la connexion:**
```bash
# Interface web RabbitMQ
curl http://213.199.54.136:15672
# Login: guest / guest
```

**Vérifier la queue:**
- Aller sur http://213.199.54.136:15672
- Onglet "Queues"
- Chercher `whatsapp.session.update`
- Vérifier qu'il y a des consumers (doit être >= 1)

---

## 🐛 DEBUGGING

### Si le Worker ne Reçoit Toujours Pas les Messages

**1. Vérifier les logs RabbitMQ dans le worker:**
```
=== RABBITMQ CONNECTION DEBUG ===
URL: amqp://guest:guest@213.199.54.136:5672
Queues config: { sessionUpdate: 'whatsapp.session.update', ... }
✓ Connected to AMQP
✓ Channel created
```

**2. Vérifier que le consumer est actif:**
```
Starting to consume queue: whatsapp.session.update
Consumer set up successfully for queue: whatsapp.session.update
```

**3. Envoyer un message de test directement via RabbitMQ:**

Aller sur http://213.199.54.136:15672
- Queues → `whatsapp.session.update`
- Publish message:
```json
{
  "action": "create",
  "numberId": 999,
  "phoneNumber": "+221771234567",
  "workerId": "worker-1"
}
```

**4. Vérifier les logs du worker:**
Si le message de test n'apparaît pas, le problème est la connexion RabbitMQ.

---

## 📊 CHECKLIST DE DIAGNOSTIC

- [ ] Fichier `.env` correct et lisible
- [ ] Worker démarre sans erreur
- [ ] Worker se connecte à RabbitMQ
- [ ] Consumer `whatsapp.session.update` actif
- [ ] RabbitMQ accessible (http://213.199.54.136:15672)
- [ ] Queue `whatsapp.session.update` existe
- [ ] Queue a au moins 1 consumer
- [ ] Worker ID correspond dans .env et requête backend
- [ ] Backend envoie bien sur la queue `whatsapp.session.update`

---

## 🚀 ACTIONS IMMÉDIATES

### 1. Redémarrer le Worker

```bash
# Dans le terminal du worker
Ctrl+C

# Redémarrer
cd c:\Users\HP\whatsapp-worker
npm start
```

### 2. Tester la Validation

```bash
# Depuis un autre terminal
curl -X POST "http://localhost:8080/api/admin/dashboard/clients/6/validate?workerId=worker-1"
```

### 3. Surveiller les Logs

**Terminal Worker:**
```
Session update: create for number 6
Creating new WhatsApp session: session_6_+221...
QR Code generated for session_6_+221...
```

**Logs Backend:**
```
Session update sent for session: 6 - action: create
QR Code received for number: 6
```

---

## 📞 SI LE PROBLÈME PERSISTE

### Vérifier le Code Backend

**Dans `SessionService.java`:**
```java
// Ligne ~60
rabbitMQService.sendSessionUpdate(
    numberId,
    "create",
    Map.of(
        "numberId", numberId,
        "phoneNumber", number.getPhoneNumber(),
        "sessionId", saved.getSessionId(),
        "workerId", workerId  // ← Doit être présent
    )
);
```

### Vérifier le Code Worker

**Dans `worker.js` ligne 243:**
```javascript
async handleSessionUpdate(data) {
  const { action, numberId, phoneNumber } = data;
  
  // ⚠️ Ajouter ce log pour debug
  logger.info('📨 Received session update:', JSON.stringify(data));
  
  logger.info(`Session update: ${action} for number ${numberId}`);
  
  switch (action) {
    case 'create':
      await sessionManager.createSession(numberId, phoneNumber);
      break;
  }
}
```

---

## 🎯 RÉSULTAT ATTENDU

Après redémarrage du worker avec le nouveau `.env`:

1. ✅ Worker démarre correctement
2. ✅ Worker se connecte à RabbitMQ
3. ✅ Worker écoute la queue `whatsapp.session.update`
4. ✅ Backend envoie le message de création
5. ✅ Worker reçoit le message
6. ✅ Worker crée la session Baileys
7. ✅ Worker génère le QR code
8. ✅ Worker envoie le QR au backend
9. ✅ Backend sauvegarde le QR
10. ✅ Admin récupère le QR

---

**Document créé le:** 2025-12-05  
**Statut:** Fichier .env corrigé ✅  
**Prochaine étape:** Redémarrer le worker
