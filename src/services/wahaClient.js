import axios from 'axios';
import logger from '../utils/logger.js';

const SESSION_NAME = 'default';

function client(baseUrl) {
  return axios.create({ baseURL: baseUrl, timeout: 30000 });
}

class WahaClient {
  async startSession(baseUrl) {
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
      file: { url: mediaUrl },
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
