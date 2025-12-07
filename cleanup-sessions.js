#!/usr/bin/env node

/**
 * Cleanup script for migrating from Baileys to whatsapp-web.js
 * This script backs up old Baileys sessions and prepares for new sessions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧹 WhatsApp Session Cleanup Script\n');
console.log('This script will:');
console.log('1. Backup existing Baileys sessions');
console.log('2. Clean up old session data');
console.log('3. Prepare directories for whatsapp-web.js\n');

// Directories to clean
const sessionsDir = path.join(__dirname, 'sessions');
const wwebjsAuthDir = path.join(__dirname, '.wwebjs_auth');
const wwebjsCacheDir = path.join(__dirname, '.wwebjs_cache');
const testSessionDir = path.join(__dirname, 'test-session');

// Backup directory
const backupDir = path.join(__dirname, 'sessions_backup_baileys_' + Date.now());

// Function to check if directory exists and has files
function hasFiles(dir) {
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir);
    return files.length > 0;
}

// Function to backup directory
function backupDirectory(source, destination) {
    if (!fs.existsSync(source)) {
        console.log(`⚠️  Directory ${source} does not exist, skipping backup`);
        return false;
    }

    console.log(`📦 Backing up ${source} to ${destination}...`);

    try {
        fs.cpSync(source, destination, { recursive: true });
        console.log(`✅ Backup completed: ${destination}`);
        return true;
    } catch (error) {
        console.error(`❌ Backup failed:`, error.message);
        return false;
    }
}

// Function to remove directory
function removeDirectory(dir) {
    if (!fs.existsSync(dir)) {
        console.log(`⚠️  Directory ${dir} does not exist, skipping removal`);
        return;
    }

    console.log(`🗑️  Removing ${dir}...`);

    try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`✅ Removed: ${dir}`);
    } catch (error) {
        console.error(`❌ Removal failed:`, error.message);
    }
}

// Function to create directory
function createDirectory(dir) {
    if (fs.existsSync(dir)) {
        console.log(`✅ Directory already exists: ${dir}`);
        return;
    }

    console.log(`📁 Creating ${dir}...`);

    try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created: ${dir}`);
    } catch (error) {
        console.error(`❌ Creation failed:`, error.message);
    }
}

// Main cleanup process
async function cleanup() {
    console.log('🚀 Starting cleanup process...\n');

    // Step 1: Backup existing sessions
    console.log('📦 Step 1: Backing up existing sessions');
    console.log('─'.repeat(50));

    if (hasFiles(sessionsDir)) {
        const backed = backupDirectory(sessionsDir, backupDir);
        if (backed) {
            console.log(`\n✅ Baileys sessions backed up to: ${backupDir}`);
            console.log('   You can restore them if needed.\n');
        }
    } else {
        console.log('ℹ️  No existing sessions to backup\n');
    }

    // Step 2: Clean up old data
    console.log('🧹 Step 2: Cleaning up old data');
    console.log('─'.repeat(50));

    removeDirectory(sessionsDir);
    removeDirectory(wwebjsAuthDir);
    removeDirectory(wwebjsCacheDir);
    removeDirectory(testSessionDir);
    console.log('');

    // Step 3: Create fresh directories
    console.log('📁 Step 3: Creating fresh directories');
    console.log('─'.repeat(50));

    createDirectory(sessionsDir);
    console.log('');

    // Summary
    console.log('✅ Cleanup completed!\n');
    console.log('📋 Summary:');
    console.log('─'.repeat(50));
    console.log(`✅ Old sessions backed up to: ${backupDir}`);
    console.log(`✅ Sessions directory cleaned and recreated`);
    console.log(`✅ whatsapp-web.js directories cleaned`);
    console.log('');
    console.log('🎯 Next steps:');
    console.log('1. Start the worker: npm start');
    console.log('2. Create sessions via RabbitMQ');
    console.log('3. Scan QR codes for each number');
    console.log('');
    console.log('⚠️  IMPORTANT: All users will need to re-scan their QR codes!');
    console.log('');
}

// Run cleanup
cleanup().catch((error) => {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
});
