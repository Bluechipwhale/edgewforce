// ==============================================================================
// EDGEWFORCE - SUPABASE AUTHENTICATION SERVICE MANAGER
// Authoritative Identity Provisioning, Authentication, and Password Lifecycle
// ==============================================================================

import { supabase, supabaseAdmin, createSupabaseAuthClient } from '../config/database.js';
import { logger } from '../utils/logger.js';

const isTestMode = process.env.NODE_ENV === 'test' || Boolean(process.env.TEST_MODE);
const CLIENT_URL = process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',')[0].trim() : 'http://localhost:5173';

export const supabaseAuthService = {
  /**
   * Provisions a real user in Supabase Auth (auth.users).
   * Supports both Admin API (service role key) and Client API (publishable key).
   */
  async provisionUser({ email, password, fullName, roleCode }) {
    if (isTestMode || !email) return null;
    const cleanEmail = email.toLowerCase().trim();
    const passwordToUse = (password && password.trim().length >= 6) ? password.trim() : 'ChangeMe123!';

    // Pathway A: Privileged Admin API (Service Role Key)
    if (supabaseAdmin?.auth?.admin) {
      try {
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: cleanEmail,
          password: passwordToUse,
          email_confirm: true,
          user_metadata: {
            full_name: fullName || 'Staff Member',
            role_code: roleCode || 'EMPLOYEE'
          }
        });

        if (!error && data?.user) {
          logger.info(`Supabase Auth: Admin provisioned user ${cleanEmail} (ID: ${data.user.id})`);
          return { authUserId: data.user.id, user: data.user };
        }

        if (error && (error.message?.includes('already registered') || error.code === 'email_exists')) {
          // Attempt to retrieve existing user ID via signIn or list
          try {
            const loginRes = await createSupabaseAuthClient().auth.signInWithPassword({ email: cleanEmail, password: passwordToUse });
            if (loginRes.data?.user) {
              return { authUserId: loginRes.data.user.id, user: loginRes.data.user };
            }
          } catch {}
        }

        if (error) {
          logger.warn(`Supabase Auth Admin provisioning notice for ${cleanEmail}: ${error.message}`);
        }
      } catch (err) {
        logger.warn(`Supabase Auth Admin provisioning error: ${err.message}`);
      }
    }

    // Pathway B: Standard Client API (Anon / Publishable Key)
    if (supabase?.auth && typeof supabase.auth.signUp === 'function') {
      try {
        const { data, error } = await createSupabaseAuthClient().auth.signUp({
          email: cleanEmail,
          password: passwordToUse,
          options: {
            data: {
              full_name: fullName || 'Staff Member',
              role_code: roleCode || 'EMPLOYEE'
            }
          }
        });

        if (!error && data?.user) {
          logger.info(`Supabase Auth: Client signed up user ${cleanEmail} (ID: ${data.user.id})`);
          return { authUserId: data.user.id, user: data.user, session: data.session };
        }

        if (error && (error.message?.includes('already registered') || error.code === 'user_already_exists')) {
          try {
            const loginRes = await createSupabaseAuthClient().auth.signInWithPassword({ email: cleanEmail, password: passwordToUse });
            if (loginRes.data?.user) {
              return { authUserId: loginRes.data.user.id, user: loginRes.data.user, session: loginRes.data.session };
            }
          } catch {}
        }

        if (error) {
          logger.warn(`Supabase Auth Client signUp notice for ${cleanEmail}: ${error.message}`);
        }
      } catch (err) {
        logger.warn(`Supabase Auth Client signUp error: ${err.message}`);
      }
    }

    return null;
  },

  /**
   * Authenticates user against Supabase Auth using email and password.
   */
  async signIn({ email, password }) {
    if (isTestMode || !supabase?.auth || !email || !password) return null;
    try {
      const cleanEmail = email.toLowerCase().trim();
      const res = await createSupabaseAuthClient().auth.signInWithPassword({
        email: cleanEmail,
        password
      });
      return res;
    } catch (err) {
      return { data: null, error: err };
    }
  },

  /**
   * Sends an official Supabase password reset email.
   */
  async requestPasswordReset(email) {
    if (isTestMode || !supabase?.auth || !email) return { error: new Error('Supabase not configured') };
    try {
      const cleanEmail = email.toLowerCase().trim();
      const redirectTo = `${CLIENT_URL}/#reset-password`;
      const res = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo });
      return res;
    } catch (err) {
      return { error: err };
    }
  },

  /**
   * Updates user password in Supabase Auth.
   */
  async updatePassword(authUserId, newPassword) {
    if (isTestMode || !newPassword) return false;
    if (supabaseAdmin?.auth?.admin && authUserId) {
      try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
          password: newPassword
        });
        if (!error) return true;
      } catch (err) {
        logger.warn(`Supabase Admin password update notice: ${err.message}`);
      }
    }
    return false;
  },

  /**
   * Validates access token with Supabase Auth.
   */
  async getUserFromToken(token) {
    if (isTestMode || !supabase?.auth || !token) return null;
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        return data.user;
      }
    } catch {}
    return null;
  }
};
