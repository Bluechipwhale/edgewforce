import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const employeeUuid = 'f2d4b16a-73a9-4f01-9cf1-7a3e84ef6d28';
const userUuid = 'd2d4b16a-73a9-4f01-9cf1-7a3e84ef6d28';
const runChild = (code, env) => new Promise((resolve, reject) => {
  const childEnv = {...process.env, ...env};
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.TEST_MODE;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env:childEnv, cwd:fileURLToPath(new URL('../../../',import.meta.url))
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', reject);
  child.on('close', code => resolve({code, output}));
});

test('production UUID assignments, shift attendance and database errors use Supabase without local fallback', {timeout:30000}, async () => {
  const tables = {
    employees:[{id:11, uuid:employeeUuid, company_id:1, first_name:'Test', last_name:'Employee', position:'Sales Agent', role_code:'SALES_AGENT'}],
    users:[{id:1, uuid:userUuid, company_id:1}],
    work_locations:[{id:81, company_id:1, name:'Assigned Workplace', latitude:6.4, longitude:3.4, geofence_radius_meters:150, status:'active'}],
    employee_location_assignments:[], location_assignment_history:[], attendance:[], location_logs:[], location_alerts:[], audit_logs:[], stores:[]
  };
  const baseColumns = ['id','employee_id','date','clock_in_time','clock_out_time','clock_in_lat','clock_in_lng','clock_in_accuracy','clock_in_device','clock_out_lat','clock_out_lng','clock_out_accuracy','clock_out_device','status','verification_mode','working_hours','idempotency_key','created_at','updated_at'];
  const migration = fs.readFileSync(new URL('../../../supabase/migrations/017_workplace_attendance_runtime.sql', import.meta.url),'utf8');
  const attendanceColumns = new Set([...baseColumns, ...Array.from(migration.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g), m=>m[1])]);
  let failWrites = false;
  let slowReads = true;
  let serverError;
  const server = http.createServer(async (req,res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer test-server-key');
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').at(-1);
      const rows = tables[table] || [];
      const matches = row => [...url.searchParams.entries()].filter(([key])=>!['select','limit','order','offset'].includes(key)).every(([key,value])=>String(row[key]) === value.replace(/^eq\./,''));
      if (req.method === 'GET') {
        if (slowReads && table === 'work_locations') await new Promise(resolve => setTimeout(resolve,650));
        const result = rows.filter(matches).slice(0,Number(url.searchParams.get('limit')) || Infinity);
        res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(result)); return;
      }
      let text = ''; for await (const chunk of req) text += chunk;
      const record = JSON.parse(text || '{}');
      if (failWrites) {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:'23503',message:'simulated foreign key failure'}));return;}
      if (record.employee_id !== undefined && ['employee_location_assignments','attendance','location_logs','location_alerts'].includes(table)) assert.equal(record.employee_id,employeeUuid);
      if (table === 'attendance') {
        if (Object.hasOwn(record,'store_id')) assert.equal(record.store_id,null,'A workplace is not a store FK');
        if (Object.hasOwn(record,'location_id')) assert.equal(record.location_id,81);
        for (const key of Object.keys(record)) assert.ok(attendanceColumns.has(key),`Unknown attendance column ${key}`);
        if (record.status) assert.ok(['Present','Late','Absent'].includes(record.status));
      }
      if (table === 'location_logs') {
        assert.equal(record.store_id,null);
        assert.equal(record.location_id,81);
      }
      let result;
      if (req.method === 'PATCH') {
        result = rows.filter(matches); result.forEach(row=>Object.assign(row,record));
      } else { result = [{id:rows.length+1,...record}]; rows.push(...result); }
      tables[table] = rows;
      const single = req.headers.accept?.includes('application/vnd.pgrst.object+json');
      res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(single ? result[0] : result));
    } catch (error) {
      serverError = error;
      res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:'PGRST204',message:error.message}));
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const env = {NODE_ENV:'production',DOTENV_CONFIG_PATH:'NUL',SUPABASE_URL:`http://127.0.0.1:${server.address().port}`,SUPABASE_SERVICE_ROLE_KEY:'test-server-key',SUPABASE_ANON_KEY:'test-public-key',SUPABASE_SCHEMA_VARIANT:'numbered'};
  try {
    const workflow = await runChild(`
      import assert from 'node:assert/strict';
      import {locationService} from './server/src/services/locationService.js';
      import {fieldService} from './server/src/services/fieldService.js';
      const actor={id:1,uuid:'${userUuid}',company_id:1}; const req={user:actor,headers:{}};
      const assigned=await locationService.assignEmployeeLocation({company_id:1,employee_id:'11',location_id:'81',assignment_type:'primary'},actor,req);
      assert.equal(assigned.assignment.employee_id,'${employeeUuid}');
      const locations=await locationService.getEmployeeLocations('11',1);
      assert.equal(locations.primary_location.id,81);
      const morning=await fieldService.checkIn({employeeId:'11',latitude:6.4,longitude:3.4,req,testDate:'2026-10-06T07:00:00Z'});
      assert.equal(morning.employee_id,'${employeeUuid}'); assert.equal(morning.is_geofence_verified,true);
      await assert.rejects(fieldService.checkIn({employeeId:'11',latitude:6.4,longitude:3.4,req,testDate:'2026-10-06T07:30:00Z'}),/Duplicate attendance/);
      await fieldService.checkIn({employeeId:'11',latitude:6.4,longitude:3.4,req,testDate:'2026-10-06T12:00:00Z'});
      const evening=await fieldService.checkOut({employeeId:'11',latitude:6.4,longitude:3.4,req,testDate:'2026-10-06T17:00:00Z'});
      assert.ok(evening.clock_out_time); console.log('production workflow passed');
    `,env);
    if (serverError) throw serverError;
    assert.equal(workflow.code,0,workflow.output);
    assert.equal(tables.attendance.length,1);
    assert.ok(tables.attendance[0].morning_clock_in);
    assert.ok(tables.attendance[0].midday_clock_in);
    assert.ok(tables.attendance[0].evening_clock_out);
    slowReads=false; failWrites=true;
    const errors=await runChild(`
      import assert from 'node:assert/strict'; import {db} from './server/src/config/database.js';
      assert.deepEqual(await db.find('stores'),[]);
      for (const operation of [()=>db.insert('work_locations',{name:'Failure'}),()=>db.update('work_locations',81,{name:'Failure'}),()=>db.delete('work_locations',81)]) {
        await assert.rejects(operation,e=>e.code==='23503');
      }
      console.log('production failure handling passed');
    `,env);
    assert.equal(errors.code,0,errors.output);
    assert.equal(tables.work_locations.length,1);
    assert.equal(tables.work_locations[0].name,'Assigned Workplace');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
