import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_MANAGER_PATH = path.join(__dirname, '../services/sessionManager.js');

/**
 * UpdateChecker: Monitors for new WhatsApp Web versions and library updates
 */
export async function checkUpdates() {
    console.log('\n🔍 [UPDATE CHECKER] Checking for updates...');

    const results = {
        webVersion: { current: null, latest: null, updateAvailable: false },
        library: { updateAvailable: false }
    };

    try {
        // 1. Check if hardcoded version exists in sessionManager.js
        const content = fs.readFileSync(SESSION_MANAGER_PATH, 'utf8');
        const versionMatch = content.match(/webVersion:\s*'([^']+)'/);

        if (versionMatch) {
            results.webVersion.current = versionMatch[1];
            console.log(`📡 Current hardcoded WhatsApp Web version: ${results.webVersion.current}`);
        } else {
            console.log(`📡 No hardcoded version found (using library default).`);
            results.webVersion.current = 'default';
        }

        // 2. Fetch latest version from WPPConnect WA Version repo
        try {
            // We use the file list API to find the highest version
            const response = await axios.get('https://api.github.com/repos/wppconnect-team/wa-version/contents/html', {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            if (response.data && Array.isArray(response.data)) {
                const versions = response.data
                    .map(file => file.name.replace('.html', ''))
                    .filter(v => v.includes('.'))
                    .sort((a, b) => {
                        // Very basic semver-ish sort for strings like 2.3000.1033110843-alpha
                        const getParts = (str) => str.split(/[\.-]/).map(p => isNaN(p) ? p : parseInt(p));
                        const partsA = getParts(a);
                        const partsB = getParts(b);

                        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
                            if (partsA[i] === undefined) return -1;
                            if (partsB[i] === undefined) return 1;
                            if (partsA[i] < partsB[i]) return 1;
                            if (partsA[i] > partsB[i]) return -1;
                        }
                        return 0;
                    });

                if (versions.length > 0) {
                    results.webVersion.latest = versions[0];
                    console.log(`🌍 Latest WhatsApp Web version found: ${results.webVersion.latest}`);

                    if (results.webVersion.latest !== results.webVersion.current) {
                        results.webVersion.updateAvailable = true;
                        process.env.UPDATE_READY = 'true'; // Set flag
                    }
                }
            }
        } catch (error) {
            console.error('❌ Failed to fetch latest web version from GitHub API:', error.message);
        }

        // 3. Output Summary
        if (results.webVersion.updateAvailable) {
            console.log('\n⚠️  [UPDATE] A NEW WHATSAPP WEB VERSION IS AVAILABLE!');
            console.log(`   From: ${results.webVersion.current}`);
            console.log(`   To:   ${results.webVersion.latest}`);
            console.log('\n👉 Recommendation: Update the webVersion in src/services/sessionManager.js');
            console.log(`   URL: https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${results.webVersion.latest}.html`);
        } else {
            console.log('\n✅ WhatsApp Web version is up to date.');
        }

        return results;
    } catch (error) {
        console.error('❌ Error in UpdateChecker:', error);
        return null;
    }
}

export default checkUpdates;
