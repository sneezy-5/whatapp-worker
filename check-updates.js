#!/usr/bin/env node

import { checkUpdates } from './src/utils/updateChecker.js';

console.log('========================================');
console.log('🚀 WHATSAPP WORKER - UPDATE CHECKER');
console.log('========================================');

async function run() {
    try {
        const results = await checkUpdates();

        console.log('\n========================================');
        if (results && results.webVersion.updateAvailable) {
            console.log('🔴 UPDATES FOUND');
            process.exit(0); // Exit code 0 so it doesn't fail scripts, but logs are clear
        } else {
            console.log('🟢 SYSTEM UP TO DATE');
            process.exit(0);
        }
    } catch (err) {
        console.error('Fatal error during check:', err);
        process.exit(1);
    }
}

run();
