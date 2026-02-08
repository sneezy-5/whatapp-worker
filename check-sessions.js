#!/usr/bin/env node

/**
 * Script pour afficher l'état des sessions actives
 * Utile pour le debugging
 */

import sessionManager from './src/services/sessionManager.js';

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║                                                                  ║');
console.log('║   📊 ÉTAT DES SESSIONS ACTIVES                                  ║');
console.log('║                                                                  ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

const sessions = sessionManager.getActiveSessions();

if (sessions.length === 0) {
    console.log('❌ Aucune session active\n');
    console.log('💡 Pour créer une session, envoyez un message via RabbitMQ:');
    console.log(JSON.stringify({
        action: 'create',
        data: {
            numberId: 6,
            phoneNumber: '2250709865432',
            workerId: 1
        }
    }, null, 2));
    console.log('');
} else {
    console.log(`✅ ${sessions.length} session(s) active(s):\n`);

    sessions.forEach((session, index) => {
        console.log(`Session ${index + 1}:`);
        console.log(`  SessionId    : ${session.sessionId}`);
        console.log(`  NumberId     : ${session.numberId}`);
        console.log(`  Phone        : ${session.phoneNumber}`);
        console.log(`  Connected    : ${session.connected ? '✅ Oui' : '❌ Non'}`);
        console.log(`  Ready        : ${session.isReady ? '✅ Oui' : '❌ Non'}`);
        console.log('');
    });
}

console.log('─'.repeat(70));
console.log('');

process.exit(0);
