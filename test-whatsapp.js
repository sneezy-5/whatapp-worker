#!/usr/bin/env node

/**
 * Test script to verify whatsapp-web.js migration
 * This script tests basic functionality without RabbitMQ
 */

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

console.log('🧪 Testing whatsapp-web.js integration...\n');

// Create a test client
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'test-session',
        dataPath: './test-session'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

console.log('✅ Client created successfully');

// QR Code event
client.on('qr', async (qr) => {
    console.log('\n📱 QR Code generated:');
    qrcode.generate(qr, { small: true });

    try {
        const qrCodeBase64 = await QRCode.toDataURL(qr);
        console.log('\n✅ QR Code converted to base64 successfully');
        console.log('Base64 length:', qrCodeBase64.length);
    } catch (error) {
        console.error('❌ Error converting QR code:', error);
    }
});

// Ready event
client.on('ready', async () => {
    console.log('\n✅ Client is ready!');
    console.log('📞 Client info:', client.info);

    // Test getting state
    try {
        const state = await client.getState();
        console.log('📊 Client state:', state);
    } catch (error) {
        console.error('❌ Error getting state:', error);
    }

    console.log('\n🎉 All tests passed! You can now close this test.');
    console.log('Press Ctrl+C to exit');
});

// Authenticated event
client.on('authenticated', () => {
    console.log('✅ Client authenticated');
});

// Auth failure event
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    process.exit(1);
});

// Disconnected event
client.on('disconnected', (reason) => {
    console.log('⚠️ Client disconnected:', reason);
});

// Loading screen event
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

// Initialize the client
console.log('🚀 Initializing client...\n');
client.initialize().catch((error) => {
    console.error('❌ Failed to initialize client:', error);
    process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down test...');
    await client.destroy();
    console.log('✅ Test completed');
    process.exit(0);
});
