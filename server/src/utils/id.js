const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function toDbId(value) {
  if (value === undefined || value === null || value === '') return value;
  if (isUuid(String(value))) return String(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

export function sameId(left, right) {
  return String(left ?? '') === String(right ?? '');
}

export function employeeRef(employee) {
  return employee?.uuid || employee?.id || employee?.auth_user_id;
}

export function userRef(user) {
  return user?.uuid || user?.id || user?.auth_user_id;
}

export async function findEmployeeByAnyId(db, employeeId, companyId = null) {
  const target = String(employeeId ?? '');
  if (!target) return null;

  const direct = await db.findById('employees', toDbId(employeeId));
  if (direct && (companyId === null || Number(direct.company_id) === Number(companyId))) {
    return direct;
  }

  const filter = companyId === null ? {} : { company_id: Number(companyId) };
  const employees = await db.find('employees', filter);
  return employees.find(emp => [
    emp.id,
    emp.uuid,
    emp.auth_user_id,
    emp.user_id,
    emp.employee_code,
    emp.staff_id
  ].some(value => sameId(value, target))) || null;
}

export async function findUserByAnyId(db, userId) {
  const target = String(userId ?? '');
  if (!target) return null;

  const direct = await db.findById('users', toDbId(userId));
  if (direct) return direct;

  const users = await db.find('users');
  return users.find(user => [
    user.id,
    user.uuid,
    user.auth_user_id,
    user.email,
    user.phone
  ].some(value => sameId(value, target))) || null;
}
