import Docker from 'dockerode';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

const docker = new Docker();

const MANAGED_LABEL = 'com.pool.whatsapp.numberId';
const PHONE_LABEL = 'com.pool.whatsapp.phoneNumber';

function containerName(numberId) {
  return `waha-${numberId}`;
}

function volumeName(numberId) {
  return `waha_session_${numberId}`;
}

/**
 * Pulls config.waha.image if it isn't already present locally.
 * dockerode's createContainer does NOT auto-pull, so without this the very
 * first session ever created on a fresh host fails with "no such image".
 */
async function ensureImage() {
  const images = await docker.listImages({ filters: { reference: [config.waha.image] } });
  if (images.length > 0) return;

  logger.info(`[DOCKER] Pulling WAHA image ${config.waha.image}...`);
  await new Promise((resolve, reject) => {
    docker.pull(config.waha.image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  });
  logger.info(`[DOCKER] Pulled WAHA image ${config.waha.image}`);
}

class DockerManager {
  /**
   * Ensures a WAHA container is created and running for this number.
   * Idempotent: reuses the existing container if one is already there.
   */
  async ensureContainer(numberId, phoneNumber) {
    const name = containerName(numberId);
    const container = docker.getContainer(name);

    let info;
    try {
      info = await container.inspect();
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      await ensureImage();
      logger.info(`[DOCKER] Creating WAHA container ${name}`);
      const created = await docker.createContainer({
        name,
        Image: config.waha.image,
        Env: [
          'WHATSAPP_DEFAULT_ENGINE=NOWEB',
          `WHATSAPP_HOOK_URL=${config.waha.webhookBaseUrl}/waha-webhook/${numberId}`,
          'WHATSAPP_HOOK_EVENTS=session.status,message',
          'WAHA_PRINT_QR=false',
        ],
        Labels: { [MANAGED_LABEL]: String(numberId), [PHONE_LABEL]: String(phoneNumber) },
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          NetworkMode: config.waha.network,
          Binds: [`${volumeName(numberId)}:/app/.sessions`],
        },
      });
      await created.start();
      return { name, baseUrl: `http://${name}:3000` };
    }

    if (!info.State.Running) {
      logger.info(`[DOCKER] Starting existing WAHA container ${name}`);
      await container.start();
    }

    return { name, baseUrl: `http://${name}:3000` };
  }

  async stopContainer(numberId) {
    const name = containerName(numberId);
    try {
      const container = docker.getContainer(name);
      const info = await container.inspect();
      if (info.State.Running) {
        logger.info(`[DOCKER] Stopping WAHA container ${name}`);
        await container.stop();
      }
    } catch (error) {
      if (error.statusCode !== 404) {
        logger.error(`[DOCKER] Error stopping container ${name}:`, error);
      }
    }
  }

  async removeContainer(numberId, { removeVolume = false } = {}) {
    const name = containerName(numberId);
    try {
      const container = docker.getContainer(name);
      logger.info(`[DOCKER] Removing WAHA container ${name} (removeVolume: ${removeVolume})`);
      await container.remove({ force: true });
    } catch (error) {
      if (error.statusCode !== 404) {
        logger.error(`[DOCKER] Error removing container ${name}:`, error);
      }
    }

    if (removeVolume) {
      try {
        await docker.getVolume(volumeName(numberId)).remove();
      } catch (error) {
        if (error.statusCode !== 404) {
          logger.error(`[DOCKER] Error removing volume ${volumeName(numberId)}:`, error);
        }
      }
    }
  }

  /**
   * Lists containers previously created by this worker (label-based),
   * used on boot to reattach to sessions that survived a worker restart.
   */
  async listManagedContainers() {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [MANAGED_LABEL] },
    });

    return containers.map((c) => {
      const numberId = parseInt(c.Labels[MANAGED_LABEL], 10);
      return {
        numberId,
        phoneNumber: c.Labels[PHONE_LABEL] || null,
        name: containerName(numberId),
        baseUrl: `http://${containerName(numberId)}:3000`,
        running: c.State === 'running',
      };
    });
  }
}

export default new DockerManager();
