import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClients } from '../config/supabaseClients.js';

test('staff sign-ins cannot replace the database credential or another staff session', async () => {
  const tokens = new Map();
  const userHeaders = [];
  let databaseHeader;
  const clients = createSupabaseClients({
    url: 'https://example.supabase.co',
    publicKey: 'test-public-key',
    serviceKey: 'test-server-key',
    fetch: async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init.headers).get('authorization');
      if (url.includes('/auth/v1/token')) {
        const { email } = JSON.parse(init.body);
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        const token = `${header}.${payload}.test-signature`;
        tokens.set(email, token);
        return Response.json({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user: { id: email, email } });
      }
      if (url.includes('/auth/v1/user')) {
        userHeaders.push(authorization);
        return Response.json({ id: 'test-user' });
      }
      assert.ok(url.includes('/rest/v1/users'));
      databaseHeader = authorization;
      return Response.json([{ id: 1 }]);
    }
  });
  const first = clients.createAuthClient();
  const second = clients.createAuthClient();
  assert.equal((await first.auth.signInWithPassword({ email: 'first@example.com', password: 'test-password' })).error, null);
  assert.equal((await second.auth.signInWithPassword({ email: 'second@example.com', password: 'test-password' })).error, null);
  await first.auth.getUser();
  await second.auth.getUser();
  assert.equal((await clients.database.from('users').select('id')).error, null);
  assert.equal(databaseHeader, 'Bearer test-server-key');
  assert.deepEqual(userHeaders, ['Bearer ' + tokens.get('first@example.com'), 'Bearer ' + tokens.get('second@example.com')]);
  assert.equal((await clients.database.auth.getSession()).data.session, null);
  assert.equal((await clients.admin.auth.getSession()).data.session, null);
});
