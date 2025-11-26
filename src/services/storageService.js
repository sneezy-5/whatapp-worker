import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Service for managing session storage
 */
class StorageService {
  constructor() {
    this.sessionDir = config.sessions.dir;
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      logger.info(`Session directory created: ${this.sessionDir}`);
    }
  }

  getSessionPath(sessionId) {
    return path.join(this.sessionDir, sessionId);
  }

  sessionExists(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    return fs.existsSync(sessionPath);
  }

  createSessionDirectory(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
      logger.info(`Session directory created: ${sessionPath}`);
    }
    
    return sessionPath;
  }

  deleteSession(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      logger.info(`Session directory deleted: ${sessionPath}`);
      return true;
    }
    
    return false;
  }

  listSessions() {
    if (!fs.existsSync(this.sessionDir)) {
      return [];
    }

    return fs.readdirSync(this.sessionDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  }

  getSessionSize(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (!fs.existsSync(sessionPath)) {
      return 0;
    }

    let totalSize = 0;
    const files = fs.readdirSync(sessionPath);

    for (const file of files) {
      const filePath = path.join(sessionPath, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }

    return totalSize;
  }

  cleanupOldSessions(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days default
    const sessions = this.listSessions();
    const now = Date.now();
    let cleaned = 0;

    for (const sessionId of sessions) {
      const sessionPath = this.getSessionPath(sessionId);
      const stats = fs.statSync(sessionPath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        this.deleteSession(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old sessions`);
    }

    return cleaned;
  }

  backupSession(sessionId, backupDir) {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${sessionId}_${timestamp}`);

    fs.cpSync(sessionPath, backupPath, { recursive: true });
    logger.info(`Session ${sessionId} backed up to ${backupPath}`);

    return backupPath;
  }

  restoreSession(sessionId, backupPath) {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup path ${backupPath} not found`);
    }

    const sessionPath = this.getSessionPath(sessionId);

    // Remove existing session if present
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Restore from backup
    fs.cpSync(backupPath, sessionPath, { recursive: true });
    logger.info(`Session ${sessionId} restored from ${backupPath}`);

    return sessionPath;
  }

  getStorageStats() {
    const sessions = this.listSessions();
    let totalSize = 0;

    for (const sessionId of sessions) {
      totalSize += this.getSessionSize(sessionId);
    }

    return {
      totalSessions: sessions.length,
      totalSize: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      sessionDir: this.sessionDir,
      sessions: sessions.map(sessionId => ({
        id: sessionId,
        size: this.getSessionSize(sessionId),
        sizeMB: (this.getSessionSize(sessionId) / (1024 * 1024)).toFixed(2),
      })),
    };
  }
}

export default new StorageService();