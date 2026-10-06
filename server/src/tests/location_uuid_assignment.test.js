import test from 'node:test';
import assert from 'node:assert/strict';
import { locationService } from '../services/locationService.js';
import { db } from '../config/database.js';
import { isTestMode } from '../utils/runtime.js';

test('location assignment resolves legacy employee IDs and preserves UUID location IDs', async () => {
  assert.equal(isTestMode, true);
  const employeeUuid = 'f2d4b16a-73a9-4f01-9cf1-7a3e84ef6d28';
  const locationUuid = 'ba57dc34-7ce0-4e5c-95f3-4606a4139e7b';
  const employee = {
    id: 11,
    uuid: employeeUuid,
    company_id: 1,
    first_name: 'Test',
    last_name: 'Employee'
  };
  const location = {
    id: locationUuid,
    company_id: 1,
    name: 'UUID Test Workplace',
    status: 'active'
  };
  const tables = {
    work_locations: [],
    employee_location_assignments: [],
    location_assignment_history: [],
    audit_logs: []
  };
  const originals = {
    find: db.find,
    findOne: db.findOne,
    findById: db.findById,
    insert: db.insert,
    update: db.update
  };

  const matches = (row, filter) => Object.entries(filter).every(([key, value]) =>
    String(row[key] ?? '') === String(value ?? '')
  );

  db.findById = async (table, id) => {
    if (table === 'employees' && String(id) === '11') return employee;
    if (table === 'work_locations' && String(id) === locationUuid) return location;
    return (tables[table] || []).find(row => String(row.id) === String(id)) || null;
  };
  db.find = async (table, filter = {}) => {
    const rows = table === 'employees'
      ? [employee]
      : table === 'work_locations'
        ? [location]
        : (tables[table] || []);
    return rows.filter(row => matches(row, filter));
  };
  db.findOne = async (table, filter = {}) => (await db.find(table, filter))[0] || null;
  db.insert = async (table, record) => {
    const row = { id: `${table}-${tables[table]?.length || 0}`, ...record };
    (tables[table] ||= []).push(row);
    return row;
  };
  db.update = async (table, id, updates) => {
    const row = (tables[table] || []).find(item => String(item.id) === String(id));
    if (!row) return null;
    Object.assign(row, updates);
    return row;
  };

  try {
    const result = await locationService.assignEmployeeLocation({
      company_id: 1,
      employee_id: '11',
      location_id: locationUuid,
      assignment_type: 'primary'
    });

    assert.equal(result.assignment.employee_id, employeeUuid);
    assert.equal(result.assignment.location_id, locationUuid);

    const employeeLocations = await locationService.getEmployeeLocations('11', 1);
    assert.equal(employeeLocations.primary_location.id, locationUuid);

    const created = await locationService.createLocation({
      company_id: 1, name: 'New Workplace', latitude: 6.4, longitude: 3.4
    }, { id: 11, uuid: employeeUuid });
    assert.equal(created.created_by, null, 'An application UUID is not an auth.users ID');
  } finally {
    Object.assign(db, originals);
  }
});
