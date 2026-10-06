// ==============================================================================
// EDGEWFORCE - SUPABASE AUTH & JWT AUTHENTICATION MIDDLEWARE
// Supports real Supabase Auth sessions, token verification & identity linking
// ==============================================================================

import jwt from 'jsonwebtoken';
import { db, supabase } from '../config/database.js';
import { isUuid, userRef } from '../utils/id.js';

const JWT_SECRET = process.env.JWT_SECRET || '3458929f44e69c199398c77212600d9f760aabb9b1dda42680556892307277ea';

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required. Please provide a valid Bearer token.' }
      });
    }

    const token = authHeader.split(' ')[1];
    let user = null;
    let authUserId = null;
    let authEmail = null;

    // 1. Attempt Supabase Auth Token Verification
    if (supabase && typeof supabase.auth?.getUser === 'function') {
      try {
        const { data: sbData, error: sbErr } = await supabase.auth.getUser(token);
        if (!sbErr && sbData?.user) {
          authUserId = sbData.user.id;
          authEmail = sbData.user.email?.toLowerCase();
        }
      } catch {
        // Fall through to JWT decoding
      }
    }

    // 2. Fallback / JWT Token Decoding
    if (!authUserId) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        authUserId = decoded.auth_user_id || decoded.uuid || decoded.userId || decoded.id || decoded.sub;
        authEmail = decoded.email?.toLowerCase();
      } catch {
        return res.status(401).json({ success: false, error: {
          code: 'INVALID_TOKEN', message: 'Invalid or expired authentication token.'
        } });
      }
    }

    if (!authUserId && !authEmail) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired authentication token.' }
      });
    }

    // 3. Resolve Linked EdgeWForce Staff Profile
    if (authUserId) {
      user = (isUuid(String(authUserId)) ? await db.findOne('users', { auth_user_id: authUserId }) ||
             await db.findOne('users', { uuid: authUserId }) : null) ||
             await db.findById('users', authUserId);
    }

    if (!user && authEmail) {
      user = await db.findOne('users', { email: authEmail });
      // If user matched by email and auth_user_id is not yet set, link it now!
      if (user && isUuid(String(authUserId)) && !user.auth_user_id) {
        db.update('users', user.id, { auth_user_id: authUserId }).catch(() => {});
      }
    }

    // Check by employee work email / personal email
    if (!user && authEmail) {
      const employees = await db.find('employees');
      const emp = employees.find(e =>
        (e.work_email && e.work_email.toLowerCase() === authEmail) ||
        (e.personal_email && e.personal_email.toLowerCase() === authEmail) ||
        (e.email && e.email.toLowerCase() === authEmail)
      );
      if (emp?.user_id) {
        user = await db.findById('users', emp.user_id);
        if (user && authUserId) {
          db.update('users', user.id, { auth_user_id: authUserId }).catch(() => {});
        }
      }
    }

    if (!user || user.status === 'inactive' || user.status === 'suspended') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_INACTIVE',
          message: user ? 'This account has been deactivated. Please contact your administrator.' : 'No EdgeWForce staff profile is linked to this authenticated user.'
        }
      });
    }

    const employee = await db.findOne('employees', { user_id: userRef(user) }) ||
                     (userRef(user) !== user.id ? await db.findOne('employees', { user_id: user.id }) : null) ||
                     (user.auth_user_id ? await db.findOne('employees', { auth_user_id: user.auth_user_id }) : null);
    
    const [rank, department] = await Promise.all([
      employee?.rank_code ? db.findOne('ranks', { code: employee.rank_code }) : null,
      employee?.department_id ? db.findById('departments', employee.department_id) : (employee?.department ? { name: employee.department } : null)
    ]);

    // Attach complete security context to request
    req.user = {
      ...user,
      employee,
      rank,
      department
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: { code: 'TOKEN_EXPIRED', message: 'Session token has expired. Please sign in again.' }
      });
    }
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid authentication token.' }
    });
  }
}

export function signUserToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      auth_user_id: user.auth_user_id || user.uuid || null,
      email: user.email,
      role: user.role_code
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

