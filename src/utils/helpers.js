/**
 * Utility helper functions
 */

/**
 * Format phone number for WhatsApp
 */
export function formatPhoneNumber(phoneNumber) {
  // Remove all non-numeric characters
  let formatted = phoneNumber.replace(/[^0-9]/g, '');
  
  // Add country code if not present
  if (!formatted.startsWith('+')) {
    formatted = '+' + formatted;
  }
  
  // Add @s.whatsapp.net for WhatsApp ID
  return formatted.replace('+', '') + '@s.whatsapp.net';
}

/**
 * Sleep utility
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    onRetry = null,
  } = options;

  let lastError;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        if (onRetry) {
          onRetry(error, attempt);
        }

        await sleep(delay);
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }
  }

  throw lastError;
}

/**
 * Generate unique ID
 */
export function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 9);
  return prefix ? `${prefix}_${timestamp}_${randomStr}` : `${timestamp}_${randomStr}`;
}

/**
 * Validate message content
 */
export function validateMessage(message) {
  const errors = [];

  if (!message.recipientNumber) {
    errors.push('Recipient number is required');
  }

  if (!message.content && !message.mediaUrl) {
    errors.push('Message content or media URL is required');
  }

  if (message.type && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'LOCATION'].includes(message.type)) {
    errors.push('Invalid message type');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize error for logging
 */
export function sanitizeError(error) {
  return {
    message: error.message,
    code: error.code,
    stack: error.stack?.split('\n').slice(0, 5).join('\n'), // Only first 5 lines
  };
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format uptime to human readable
 */
export function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Check if error is temporary (network, timeout, etc.)
 */
export function isTemporaryError(error) {
  const temporaryErrors = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ];

  return temporaryErrors.some(code => 
    error.code === code || error.message?.includes(code)
  );
}

/**
 * Truncate string
 */
export function truncate(str, maxLength = 100) {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Deep clone object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Get memory usage in MB
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
    heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
    rss: (usage.rss / 1024 / 1024).toFixed(2) + ' MB',
    external: (usage.external / 1024 / 1024).toFixed(2) + ' MB',
  };
}