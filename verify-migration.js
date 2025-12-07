#!/usr/bin/env node

/**
 * Post-migration verification script
 * Checks if the migration was successful and all files are in place
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║                                                                  ║');
console.log('║   🔍 VÉRIFICATION POST-MIGRATION                                ║');
console.log('║                                                                  ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

let allGood = true;

// Files to check
const filesToCheck = [
    { path: 'package.json', type: 'modified', critical: true },
    { path: 'src/services/sessionManager.js', type: 'modified', critical: true },
    { path: 'src/handles/MessageHandler.js', type: 'modified', critical: true },
    { path: 'src/handles/HealthHandler.js', type: 'modified', critical: true },
    { path: 'Dockerfile', type: 'created', critical: true },
    { path: 'docker-compose.yaml', type: 'modified', critical: true },
    { path: '.gitignore', type: 'modified', critical: false },
    { path: 'MIGRATION.md', type: 'created', critical: false },
    { path: 'QUICKSTART.md', type: 'created', critical: false },
    { path: 'MIGRATION_SUMMARY.md', type: 'created', critical: false },
    { path: 'MIGRATION_COMPLETE.md', type: 'created', critical: false },
    { path: 'CHANGELOG.md', type: 'created', critical: false },
    { path: 'test-whatsapp.js', type: 'created', critical: false },
    { path: 'cleanup-sessions.js', type: 'created', critical: false },
    { path: 'README.md', type: 'modified', critical: false },
];

console.log('📋 Vérification des fichiers...\n');

filesToCheck.forEach((file) => {
    const fullPath = path.join(__dirname, file.path);
    const exists = fs.existsSync(fullPath);

    const icon = exists ? '✅' : '❌';
    const status = exists ? 'OK' : 'MANQUANT';
    const typeLabel = file.type === 'created' ? '(nouveau)' : '(modifié)';

    console.log(`${icon} ${file.path.padEnd(40)} ${typeLabel.padEnd(12)} ${status}`);

    if (!exists && file.critical) {
        allGood = false;
    }
});

console.log('\n' + '─'.repeat(70) + '\n');

// Check package.json content
console.log('📦 Vérification de package.json...\n');

try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

    const checks = [
        {
            name: 'whatsapp-web.js installé',
            check: () => packageJson.dependencies['whatsapp-web.js'],
            critical: true
        },
        {
            name: 'qrcode installé',
            check: () => packageJson.dependencies['qrcode'],
            critical: true
        },
        {
            name: 'Baileys supprimé',
            check: () => !packageJson.dependencies['@whiskeysockets/baileys'],
            critical: true
        },
        {
            name: 'Script test:whatsapp',
            check: () => packageJson.scripts['test:whatsapp'],
            critical: false
        },
        {
            name: 'Script cleanup',
            check: () => packageJson.scripts['cleanup'],
            critical: false
        }
    ];

    checks.forEach((check) => {
        const result = check.check();
        const icon = result ? '✅' : '❌';
        const status = result ? 'OK' : 'MANQUANT';

        console.log(`${icon} ${check.name.padEnd(40)} ${status}`);

        if (!result && check.critical) {
            allGood = false;
        }
    });
} catch (error) {
    console.error('❌ Erreur lors de la lecture de package.json:', error.message);
    allGood = false;
}

console.log('\n' + '─'.repeat(70) + '\n');

// Check node_modules
console.log('📚 Vérification des dépendances...\n');

const nodeModulesPath = path.join(__dirname, 'node_modules');
const wwebjsPath = path.join(nodeModulesPath, 'whatsapp-web.js');
const qrcodePath = path.join(nodeModulesPath, 'qrcode');
const baileysPath = path.join(nodeModulesPath, '@whiskeysockets', 'baileys');

const wwebjsExists = fs.existsSync(wwebjsPath);
const qrcodeExists = fs.existsSync(qrcodePath);
const baileysExists = fs.existsSync(baileysPath);

console.log(`${wwebjsExists ? '✅' : '❌'} whatsapp-web.js dans node_modules`);
console.log(`${qrcodeExists ? '✅' : '❌'} qrcode dans node_modules`);
console.log(`${!baileysExists ? '✅' : '⚠️ '} Baileys ${!baileysExists ? 'supprimé' : 'encore présent'}`);

if (!wwebjsExists || !qrcodeExists) {
    console.log('\n⚠️  Certaines dépendances sont manquantes. Exécutez: npm install');
    allGood = false;
}

console.log('\n' + '─'.repeat(70) + '\n');

// Final summary
if (allGood) {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                  ║');
    console.log('║   ✅ MIGRATION VÉRIFIÉE AVEC SUCCÈS !                           ║');
    console.log('║                                                                  ║');
    console.log('║   Tous les fichiers critiques sont en place.                    ║');
    console.log('║   Les dépendances sont installées correctement.                 ║');
    console.log('║                                                                  ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    console.log('🎯 Prochaines étapes:\n');
    console.log('1. Tester whatsapp-web.js:');
    console.log('   npm run test:whatsapp\n');
    console.log('2. Nettoyer les anciennes sessions:');
    console.log('   npm run cleanup\n');
    console.log('3. Démarrer le worker:');
    console.log('   npm start\n');
    console.log('4. Consulter la documentation:');
    console.log('   - QUICKSTART.md pour démarrer rapidement');
    console.log('   - MIGRATION.md pour les détails complets');
    console.log('   - MIGRATION_COMPLETE.md pour le résumé\n');

    process.exit(0);
} else {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                  ║');
    console.log('║   ⚠️  PROBLÈMES DÉTECTÉS                                        ║');
    console.log('║                                                                  ║');
    console.log('║   Certains fichiers critiques sont manquants ou incorrects.     ║');
    console.log('║                                                                  ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    console.log('🔧 Actions recommandées:\n');
    console.log('1. Vérifier que tous les fichiers ont été créés/modifiés');
    console.log('2. Exécuter: npm install');
    console.log('3. Relancer cette vérification: node verify-migration.js\n');

    process.exit(1);
}
