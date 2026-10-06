import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { db } from '../config/database.js';
import { requireAuth, signUserToken } from '../middleware/auth.js';

test('the workplace session resolves an employee linked through the application user UUID', async () => {
  db.resetToSeed();
  const uuid = 'd2d4b16a-73a9-4f01-9cf1-7a3e84ef6d28';
  const user = await db.update('users',1,{uuid});
  await db.update('employees',1,{user_id:uuid});
  const req = {headers:{authorization:`Bearer ${signUserToken(user)}`}};
  let continued = false;
  const res = {status:()=>{throw new Error('Valid session was rejected');}};
  await requireAuth(req,res,()=>{continued=true;});
  assert.equal(continued,true);
  assert.equal(req.user.employee.id,1);
});

test('unverified JWT claims cannot select another employee workplace session', async () => {
  const token = jwt.sign({sub:'1',email:'it@edgewforce.com'},'an-untrusted-secret');
  const req = {headers:{authorization:`Bearer ${token}`}};
  let status; let response;
  const res = {status(code){status=code;return this;},json(body){response=body;return this;}};
  await requireAuth(req,res,()=>assert.fail('Unverified session was accepted'));
  assert.equal(status,401);
  assert.equal(response.error.code,'INVALID_TOKEN');
});
