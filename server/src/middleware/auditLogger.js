// ==============================================================================
// EDGEWFORCE - AUDIT LOGGER MIDDLEWARE
// ==============================================================================

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { userRef } from '../utils/id.js';

/**
 * Creates an immutable audit trail record for significant business operations.
 */
export async function recordAudit(actor, action, entity, entityId, metadata = {}, req = null) {
  try {
    const ipAddress = req?.headers['x-forwarded-for'] || req?.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req?.headers['user-agent'] || 'internal';

    const logEntry = {
      actor_id: userRef(req?.user || actor) || null,
      actor_email: actor?.email || 'system',
      action,
      entity,
      entity_id: String(entityId || ''),
      metadata: typeof metadata === 'object' ? metadata : { info: metadata },
      ip_address: String(ipAddress),
      user_agent: String(userAgent),
      created_at: new Date().toISOString()
    };

    await db.insert('audit_logs', logEntry);
    logger.audit(actor?.email || 'system', action, entity, entityId, metadata);
  } catch (err) {
    logger.error('Failed to write audit log entry', err);
  }
}
