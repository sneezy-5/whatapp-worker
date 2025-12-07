# 🔄 Auto-Régénération du QR Code

## ✅ FONCTIONNALITÉ AJOUTÉE

Le système régénère maintenant **automatiquement** le QR code quand il expire, avec un maximum de **3 tentatives**.

**NOUVEAU :** L'admin peut aussi **forcer manuellement** la régénération du QR code à tout moment.

---

## 🎯 DEUX MODES DE RÉGÉNÉRATION

### 1️⃣ Régénération Automatique (Expiration)

Quand le QR expire sans être scanné, le worker régénère automatiquement un nouveau QR.

### 2️⃣ Régénération Manuelle (Action Admin)

L'admin peut cliquer sur "Régénérer QR Code" dans le dashboard pour forcer la création d'un nouveau QR.

---

## 🎯 COMPORTEMENT

### Scénario 1: QR Scanné Avant Expiration ✅

1. QR code généré → envoyé au backend
2. Utilisateur scanne le QR dans les 20 secondes
3. Session connectée
4. ✅ **Succès !**

### Scénario 2: QR Expire (Tentative 1/3) 🔄

1. QR code généré → envoyé au backend
2. Après ~20 secondes sans scan → QR expire
3. **Auto-régénération** : Nouveau QR généré automatiquement
4. Nouveau QR envoyé au backend
5. Message au backend : `qr_regenerating` (tentative 1/3)

### Scénario 3: QR Expire (Tentative 2/3) 🔄

1. Nouveau QR généré
2. Après ~20 secondes sans scan → QR expire à nouveau
3. **Auto-régénération** : Nouveau QR généré automatiquement
4. Nouveau QR envoyé au backend
5. Message au backend : `qr_regenerating` (tentative 2/3)

### Scénario 4: QR Expire (Tentative 3/3) 🔄

1. Nouveau QR généré
2. Après ~20 secondes sans scan → QR expire à nouveau
3. **Auto-régénération** : Nouveau QR généré automatiquement
4. Nouveau QR envoyé au backend
5. Message au backend : `qr_regenerating` (tentative 3/3)

### Scénario 5: Échec Après 3 Tentatives ❌

1. QR expire une 4ème fois
2. **Abandon** : Plus de régénération
3. Session supprimée
4. Message au backend : `error` - "QR code generation failed after 3 attempts"
5. L'utilisateur doit **redemander une validation**

---

## 📊 MESSAGES ENVOYÉS AU BACKEND

### 1. QR Généré (Première Fois)

```json
{
  "action": "qr_generated",
  "numberId": 6,
  "sessionId": "session_6_+221...",
  "qrCode": "data:image/png;base64,...",
  "timestamp": 1765029000000
}
```

### 2. QR En Cours de Régénération

```json
{
  "action": "qr_regenerating",
  "numberId": 6,
  "sessionId": "session_6_+221...",
  "attempt": 1,
  "maxAttempts": 3,
  "message": "QR code expired. Generating new QR code (attempt 1/3)",
  "timestamp": 1765029020000
}
```

### 3. Nouveau QR Généré

```json
{
  "action": "qr_generated",
  "numberId": 6,
  "sessionId": "session_6_+221...",
  "qrCode": "data:image/png;base64,...",
  "timestamp": 1765029021000
}
```

### 4. Échec Après 3 Tentatives

```json
{
  "action": "error",
  "numberId": 6,
  "sessionId": "session_6_+221...",
  "error": "QR code generation failed after 3 attempts. Please request a new validation.",
  "timestamp": 1765029080000
}
```

### 5. Connexion Réussie

```json
{
  "action": "connected",
  "numberId": 6,
  "sessionId": "session_6_+221...",
  "timestamp": 1765029015000
}
```

---

## ⚙️ CONFIGURATION

### Nombre Maximum de Tentatives

Dans `sessionManager.js` :

```javascript
this.maxQrRetries = 3; // Maximum number of QR regeneration attempts
```

**Pour modifier :**
- Changez la valeur de `this.maxQrRetries`
- Redéployez le worker

**Recommandations :**
- **3 tentatives** = ~60 secondes au total (recommandé)
- **5 tentatives** = ~100 secondes au total (si réseau lent)
- **1 tentative** = ~20 secondes (pas de régénération)

---

## 🔍 LOGS WORKER

### QR Expire (Tentative 1)

```
QR code expired for session_6_+221771234567. Attempt 1/3
Regenerating QR code for session_6_+221771234567 (attempt 1/3)...
Creating new WhatsApp session: session_6_+221771234567
QR Code generated for session_6_+221771234567
QR Code sent to backend for number 6
```

### QR Expire (Tentative 2)

```
QR code expired for session_6_+221771234567. Attempt 2/3
Regenerating QR code for session_6_+221771234567 (attempt 2/3)...
Creating new WhatsApp session: session_6_+221771234567
QR Code generated for session_6_+221771234567
QR Code sent to backend for number 6
```

### Échec Final

```
QR code expired for session_6_+221771234567. Attempt 3/3
Max QR retry attempts (3) reached for session_6_+221771234567. Giving up.
```

### Connexion Réussie

```
Session session_6_+221771234567 connected successfully
```

---

## 💡 AVANTAGES

### ✅ Pour l'Utilisateur

- **Pas besoin de redemander une validation** si le QR expire
- **Plus de temps** pour scanner le QR (~60 secondes au lieu de ~20)
- **Meilleure expérience** utilisateur

### ✅ Pour le Backend

- **Moins de requêtes** de validation
- **Notifications claires** sur l'état de la génération du QR
- **Gestion automatique** des expirations

### ✅ Pour le Worker

- **Robustesse** : Gère automatiquement les expirations
- **Limite** : Évite les boucles infinies (max 3 tentatives)
- **Traçabilité** : Logs clairs de chaque tentative

---

## 🎯 UTILISATION CÔTÉ BACKEND

### Écouter les Événements

Le backend doit écouter la queue `whatsapp.worker.events` pour recevoir :

1. **`qr_generated`** : Nouveau QR disponible → Mettre à jour en base
2. **`qr_regenerating`** : QR en cours de régénération → Informer l'utilisateur
3. **`connected`** : Session connectée → Marquer comme validé
4. **`error`** : Échec après 3 tentatives → Demander nouvelle validation

### Exemple de Listener Backend

```java
@RabbitListener(queues = "whatsapp.worker.events")
public void handleWorkerEvents(Map<String, Object> message) {
    String action = (String) message.get("action");
    Long numberId = (Long) message.get("numberId");
    
    switch (action) {
        case "qr_generated":
            String qrCode = (String) message.get("qrCode");
            updateQRCodeInDatabase(numberId, qrCode);
            break;
            
        case "qr_regenerating":
            Integer attempt = (Integer) message.get("attempt");
            notifyUser("Generating new QR code (attempt " + attempt + "/3)");
            break;
            
        case "connected":
            markNumberAsValidated(numberId);
            break;
            
        case "error":
            String error = (String) message.get("error");
            notifyUser("Validation failed: " + error);
            break;
    }
}
```

---

## 📝 TIMELINE EXEMPLE

```
00:00 - Validation demandée
00:01 - QR #1 généré et envoyé
00:21 - QR #1 expire → Régénération automatique (1/3)
00:22 - QR #2 généré et envoyé
00:42 - QR #2 expire → Régénération automatique (2/3)
00:43 - QR #3 généré et envoyé
01:03 - QR #3 expire → Régénération automatique (3/3)
01:04 - QR #4 généré et envoyé
01:24 - QR #4 expire → ÉCHEC (max tentatives atteint)
```

**Total : ~84 secondes** pour scanner le QR avant échec définitif.

---

## ✅ CHECKLIST

- [x] Auto-régénération du QR activée
- [x] Maximum 3 tentatives
- [x] Notifications au backend à chaque étape
- [x] Réinitialisation du compteur après connexion réussie
- [x] Logs détaillés pour le debugging
- [x] Gestion de l'échec après 3 tentatives
- [x] **Régénération manuelle via action `regenerate_qr`**

---

## 🔧 RÉGÉNÉRATION MANUELLE DU QR

### Message Backend → Worker

Quand l'admin clique sur "Régénérer QR Code", le backend envoie:

```json
{
  "action": "regenerate_qr",
  "data": {
    "numberId": 6,
    "phoneNumber": "+221771234567",
    "workerId": "worker-1"
  },
  "timestamp": 1765029100000
}
```

### Comportement du Worker

1. **Vérifier si session existe**
   - Si session connectée → Envoyer `connected` (pas besoin de QR)
   - Si session non connectée → Continuer

2. **Fermer l'ancienne session** (si existe)

3. **Réinitialiser le compteur de tentatives** (fresh start)

4. **Créer une nouvelle session** → Génère un nouveau QR

5. **Envoyer le nouveau QR au backend**

### Cas d'Usage

#### Cas 1: Session Déjà Connectée

**Worker → Backend:**
```json
{
  "action": "connected",
  "numberId": 6,
  "sessionId": "session_6_+221771234567",
  "message": "Session already connected. No QR needed.",
  "timestamp": 1765029101000
}
```

#### Cas 2: Session Non Connectée

**Worker logs:**
```
🔄 Régénération manuelle du QR demandée pour numéro 6...
🔄 Fermeture de la session existante pour régénération du QR...
✅ Ancienne session fermée
🔄 Compteur de tentatives QR réinitialisé pour numéro 6
🔄 Création d'une nouvelle session pour générer un nouveau QR...
✅ Nouvelle session créée - Nouveau QR en cours de génération pour numéro 6
```

**Worker → Backend:**
```json
{
  "action": "qr_generated",
  "numberId": 6,
  "sessionId": "session_6_+221771234567",
  "qrCode": "data:image/png;base64,...",
  "timestamp": 1765029102000
}
```

### Avantages

✅ **Contrôle total** : L'admin peut régénérer le QR à tout moment  
✅ **Compteur réinitialisé** : Repart de 0/3 tentatives  
✅ **Pas de limite** : L'admin peut régénérer autant de fois que nécessaire  
✅ **Feedback immédiat** : Nouveau QR disponible en quelques secondes

---

**Document créé le:** 2025-12-06  
**Fonctionnalité:** Auto-régénération QR + Régénération Manuelle  
**Statut:** ✅ IMPLÉMENTÉ

