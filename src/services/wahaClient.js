import axios from 'axios';
import logger from '../utils/logger.js';

const SESSION_NAME = 'default';
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

function client(baseUrl) {
  return axios.create({ baseURL: baseUrl, timeout: 30000 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

/**
 * WAHA's sendImage/sendVideo/sendFile/sendVoice accept a file by remote URL,
 * but without an explicit mimetype/filename the NOWEB engine has nothing to
 * go on to know how to package the media - it can accept the request (2xx)
 * without the media actually reaching WhatsApp. Derive both from the URL.
 */
function fileFromUrl(mediaUrl) {
  const filename = mediaUrl.split('/').pop().split('?')[0] || 'file';
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimetype = MIME_BY_EXT[ext] || 'application/octet-stream';
  return { url: mediaUrl, filename, mimetype };
}

class WahaClient {
  /**
   * The container is running as soon as `docker start` returns, but the WAHA
   * process inside it takes a few seconds to actually bind port 3000 -
   * calling the API immediately after start() fails with ECONNREFUSED.
   * Retries connection-level failures only (not real API errors) for up to
   * ~60s, which comfortably covers normal boot time.
   */
  async waitUntilReachable(baseUrl, { timeoutMs = 60000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
      try {
        await client(baseUrl).get('/api/server/version');
        return;
      } catch (error) {
        if (!CONNECTION_ERROR_CODES.has(error.code)) {
          // Container is reachable and answering (even a 404) - good enough.
          return;
        }
        lastError = error;
        await sleep(intervalMs);
      }
    }

    throw lastError || new Error(`WAHA container at ${baseUrl} never became reachable`);
  }

  async startSession(baseUrl) {
    await this.waitUntilReachable(baseUrl);

    try {
      await client(baseUrl).post('/api/sessions', {
        name: SESSION_NAME,
        start: true,
      });
    } catch (error) {
      // Session may already exist (container restart) - that's fine.
      if (error.response?.status !== 422) {
        throw error;
      }
      logger.debug(`[WAHA] Session already exists at ${baseUrl}, ignoring`);
    }
  }

  async getStatus(baseUrl) {
    const res = await client(baseUrl).get(`/api/sessions/${SESSION_NAME}`);
    return res.data.status;
  }

  async getQrBase64(baseUrl) {
    const res = await client(baseUrl).get(`/api/${SESSION_NAME}/auth/qr`, {
      params: { format: 'image' },
      headers: { Accept: 'application/json' },
    });
    return `data:${res.data.mimetype};base64,${res.data.data}`;
  }

  async sendText(baseUrl, { chatId, text }) {
    const res = await client(baseUrl).post('/api/sendText', {
      session: SESSION_NAME,
      chatId,
      text,
    });
    return res.data;
  }

  async sendMedia(baseUrl, endpoint, { chatId, mediaUrl, caption }) {
    const res = await client(baseUrl).post(endpoint, {
      session: SESSION_NAME,
      chatId,
      file: fileFromUrl(mediaUrl),
      caption,
    });
    return res.data;
  }

  sendImage(baseUrl, params) {
    return this.sendMedia(baseUrl, '/api/sendImage', params);
  }

  sendVideo(baseUrl, params) {
    return this.sendMedia(baseUrl, '/api/sendVideo', params);
  }

  sendFile(baseUrl, params) {
    return this.sendMedia(baseUrl, '/api/sendFile', params);
  }

  sendVoice(baseUrl, params) {
    return this.sendMedia(baseUrl, '/api/sendVoice', params);
  }

  async stopSession(baseUrl) {
    try {
      await client(baseUrl).post(`/api/sessions/${SESSION_NAME}/stop`);
    } catch (error) {
      logger.debug(`[WAHA] stopSession error at ${baseUrl}: ${error.message}`);
    }
  }

  async logoutSession(baseUrl) {
    try {
      await client(baseUrl).post(`/api/sessions/${SESSION_NAME}/logout`);
    } catch (error) {
      logger.debug(`[WAHA] logoutSession error at ${baseUrl}: ${error.message}`);
    }
  }
}

export default new WahaClient();
