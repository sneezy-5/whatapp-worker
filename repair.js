#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sessionsDir = path.join(__dirname, 'sessions');

console.log('🛠️  WhatsApp Worker - Repair Session');
console.log('====================================');

const args = process.argv.slice(2);
const numberId = args[0];

if (!numberId) {
    console.log('Usage: node repair.js <numberId>');
    console.log('Example: node repair.js 14');
    process.exit(1);
}

// 1. Identify folders to delete
if (!fs.existsSync(sessionsDir)) {
    console.error('❌ Sessions directory not found.');
    process.exit(1);
}

const folders = fs.readdirSync(sessionsDir)
    .filter(f => f.startsWith(`session_${numberId}_`));

if (folders.length === 0) {
    console.log(`ℹ️  No session folders found for number ID ${numberId}.`);
} else {
    console.log(`🗑️  Found ${folders.length} folders to delete:`);
    folders.forEach(f => {
        const fullPath = path.join(sessionsDir, f);
        console.log(`   - ${f}`);
        fs.rmSync(fullPath, { recursive: true, force: true });
    });
    console.log('✅ Folders deleted.');
}

// 2. Suggest restarting PM2
console.log('\n🚀 Next Steps:');
console.log(`1. Restart the worker: pm2 restart whatsapp-worker`);
console.log(`2. The worker will automatically generate a NEW QR Code for number ${numberId}.`);
console.log(`3. Scan the QR code to re-link your device.`);
console.log('====================================');
