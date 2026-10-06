// ==============================================================================
// EDGEWFORCE - UNIFIED DATABASE DATA ACCESS LAYER
// Supports Supabase PostgreSQL and Transactional In-Memory / File Persistent Store
// ==============================================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import tls from 'node:tls';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger.js';
import { isTestMode } from '../utils/runtime.js';
import { isUuid } from '../utils/id.js';
import { retryLegacyRuntimeActorWrite } from './runtimeActorCompat.js';
import { createSupabaseClients } from './supabaseClients.js';
import { resolveSchemaVariant } from './schemaVariant.js';
import { attendanceWrite } from './attendanceSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const dataDir = isServerless ? path.join(os.tmpdir(), 'edgewforce-data') : path.resolve(__dirname, '../../data');
const storePath = path.join(dataDir, 'store.json');

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // Gracefully ignore filesystem errors in read-only serverless runtimes
}

export let supabase = null;
export let supabaseAdmin = null;
export let createSupabaseAuthClient = null;

const isProduction = (isServerless || process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'supabase') && !isTestMode;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const databaseKey = serviceRoleKey || anonKey;
const usesNumberedSchema = resolveSchemaVariant(process.env.SUPABASE_SCHEMA_VARIANT) === 'numbered';

if (isProduction && (!supabaseUrl || !serviceRoleKey)) {
  throw new Error('Live database mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Local database fallback is disabled.');
}

if (process.env.SUPABASE_USE_SYSTEM_CA === 'true') {
  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error('SUPABASE_USE_SYSTEM_CA requires Node 22.19+ or Node 24+.');
  }
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

// Dynamically initialize Supabase if credentials are provided and not in test runner
if (!isTestMode && supabaseUrl && databaseKey) {
  try {
    const clients = createSupabaseClients({ url: supabaseUrl, publicKey: anonKey, serviceKey: serviceRoleKey });
    supabase = clients.database;
    supabaseAdmin = clients.admin;
    createSupabaseAuthClient = clients.createAuthClient;
    if (supabaseAdmin) {
      logger.info('Supabase Admin Client initialized with Service Role.');
    }
    logger.info('Supabase client configured. Database availability is checked by /api/health.');
  } catch (err) {
    if (isProduction) throw new Error(`Unable to initialize the production Supabase client: ${err.message}`);
    logger.warn(`Supabase connection failed: ${err.message}. Operating in local transactional mode.`);
  }
} else {
  logger.info('Supabase credentials not set or in test mode; utilizing high-fidelity local transactional store with persistence.');
}

const defaultPasswordHash = bcrypt.hashSync('ChangeMe123!', 10);

const initialSeed = {
  companies: [
    {
      id: 1,
      uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      name: 'Experiential Edge Nigeria Limited',
      business_type: 'Commercial Sales & Field Operations',
      industry: 'Field Sales Force Automation & Workforce Operations',
      registration_number: 'RC-1849201',
      email: 'operations@edgewforce.com',
      phone: '+2348000000001',
      address: '15 Atiba Osborne, Mende, Maryland, Lagos',
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      logo_url: null,
      status: 'active',
      created_at: new Date().toISOString()
    }
  ],
  company_settings: [
    {
      id: 1,
      company_id: 1,
      working_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      working_hours_start: '08:00',
      working_hours_end: '17:00',
      geofence_radius: 150,
      attendance_rules: { require_gps: true, require_selfie: false, auto_checkout: true },
      visit_rules: { min_duration_minutes: 15, require_photo: true, require_signature: true },
      sales_targets: { monthly_target_ngn: 10000000, commission_percent: 5 },
      currency: 'NGN',
      timezone: 'Africa/Lagos',
      active_modules: {
        workforce: true,
        attendance: true,
        field: true,
        sales: true,
        crm: true,
        payments: true,
        inventory: true,
        delivery: true,
        reports: true,
        tracking: true
      },
      created_at: new Date().toISOString()
    }
  ],
  regions: [
    { id: 1, company_id: 1, code: 'SW', name: 'South-West Region (Lagos & Ogun)', description: 'Primary commercial hub and retail corridor' },
    { id: 2, company_id: 1, code: 'NC', name: 'North-Central Region (Abuja & Plateau)', description: 'Federal capital territory and northern gateway' },
    { id: 3, company_id: 1, code: 'SS', name: 'South-South / South-East (Rivers & Enugu)', description: 'Oil hub and eastern trade networks' }
  ],
  territories: [
    { id: 1, company_id: 1, region_id: 1, code: 'LAG-MAIN', name: 'Lagos Mainland' },
    { id: 2, company_id: 1, region_id: 1, code: 'LAG-ISL', name: 'Lagos Island & Lekki' },
    { id: 3, company_id: 1, region_id: 1, code: 'LAG-IKJ', name: 'Ikeja & Industrial' },
    { id: 4, company_id: 1, region_id: 2, code: 'ABJ-CEN', name: 'Abuja Central' },
    { id: 5, company_id: 1, region_id: 3, code: 'PH-METRO', name: 'Port Harcourt Metro' },
    { id: 6, company_id: 1, region_id: 2, code: 'KAN-URB', name: 'Kano Urban' }
  ],
  teams: [],
  branches: [],
  warehouses: [],
  departments: [
    { id: 1, name: 'Commercial Sales', code: 'SALES', description: 'Retail distribution & accounts' },
    { id: 2, name: 'Field Operations', code: 'FIELD', description: 'Store audits & route execution' },
    { id: 3, name: 'Human Resources', code: 'HR', description: 'People operations & welfare' },
    { id: 4, name: 'Finance & Accounts', code: 'FINANCE', description: 'Treasury, collections & payroll' },
    { id: 5, name: 'Technology & IT', code: 'TECH', description: 'Portal administration, security & telemetry' },
    { id: 6, name: 'Executive Management', code: 'EXEC', description: 'Strategic leadership' }
  ],
  ranks: [
    { id: 1, code: 'CEO', name: 'Chief Executive Officer', level: 1, active: true },
    { id: 2, code: 'IT_ADMIN', name: 'IT Super Admin / Portal Administrator', level: 1, active: true },
    { id: 3, code: 'CTO', name: 'Chief Technology Officer', level: 2, active: true },
    { id: 4, code: 'HR', name: 'Head of Human Resources', level: 3, active: true },
    { id: 5, code: 'SENIOR_ACCOUNTANT', name: 'Head of Accounting & Payroll', level: 4, active: true },
    { id: 6, code: 'ACCOUNTANT', name: 'Accountant', level: 5, active: true },
    { id: 7, code: 'MANAGER', name: 'Regional Manager', level: 6, active: true },
    { id: 8, code: 'SUPERVISOR', name: 'Field Operations Supervisor', level: 7, active: true },
    { id: 9, code: 'STAFF', name: 'Operations Staff', level: 8, active: true }
  ],
  permissions: [
    { id: 1, code: 'view_dashboard', name: 'View Dashboard', category: 'General' },
    { id: 2, code: 'view_employees', name: 'View Employees', category: 'HR' },
    { id: 3, code: 'create_employee', name: 'Create Employee', category: 'HR' },
    { id: 4, code: 'edit_employee', name: 'Edit Employee', category: 'HR' },
    { id: 5, code: 'assign_tasks', name: 'Assign Tasks', category: 'Tasks' },
    { id: 6, code: 'approve_leave', name: 'Approve Leave', category: 'HR' },
    { id: 7, code: 'view_payroll', name: 'View Payroll', category: 'Finance' },
    { id: 8, code: 'manage_payroll', name: 'Manage Payroll', category: 'Finance' },
    { id: 9, code: 'view_attendance', name: 'View Attendance', category: 'HR' },
    { id: 10, code: 'manage_attendance', name: 'Manage Attendance', category: 'HR' },
    { id: 11, code: 'view_idle_reports', name: 'View Idle Reports', category: 'HR' },
    { id: 12, code: 'manage_ranks', name: 'Manage Ranks', category: 'HR' },
    { id: 13, code: 'view_sales', name: 'View Sales', category: 'Sales' },
    { id: 14, code: 'create_orders', name: 'Create Orders', category: 'Sales' },
    { id: 15, code: 'record_collections', name: 'Record Collections', category: 'Sales' },
    { id: 16, code: 'view_customers', name: 'View Customers', category: 'Sales' },
    { id: 17, code: 'create_customers', name: 'Create Customers', category: 'Sales' },
    { id: 18, code: 'view_field_operations', name: 'View Field Operations', category: 'Field' },
    { id: 19, code: 'manage_routes', name: 'Manage Routes', category: 'Field' },
    { id: 20, code: 'view_sos', name: 'View SOS Alerts', category: 'Emergency' },
    { id: 21, code: 'resolve_sos', name: 'Resolve SOS Alerts', category: 'Emergency' },
    { id: 22, code: 'manage_products', name: 'Manage Products', category: 'Inventory' },
    { id: 23, code: 'view_competitors', name: 'View Competitor Intel', category: 'Marketing' },
    { id: 24, code: 'view_reports', name: 'View Reports', category: 'Executive' },
    { id: 25, code: 'admin_portal', name: 'Super Admin Portal Access', category: 'IT' }
  ],
  users: [
    { id: 1, company_id: 1, full_name: 'IT Super Admin', email: 'it@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348000000001', role_code: 'SUPER_ADMIN', status: 'active', created_at: new Date().toISOString() },
    { id: 2, company_id: 1, full_name: 'Chief Executive Officer', email: 'ceo@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348000000002', role_code: 'CEO', status: 'active', created_at: new Date().toISOString() },
    { id: 3, company_id: 1, full_name: 'Head of Human Resources', email: 'hr@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348000000003', role_code: 'HR_MANAGER', status: 'active', created_at: new Date().toISOString() },
    { id: 4, company_id: 1, full_name: 'Commercial Sales Lead', email: 'sales@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348031234567', role_code: 'SALES_AGENT', status: 'active', created_at: new Date().toISOString() },
    { id: 5, company_id: 1, full_name: 'Field Operations Lead', email: 'field@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348029876543', role_code: 'FIELD_AGENT', status: 'active', created_at: new Date().toISOString() },
    { id: 6, company_id: 1, full_name: 'Finance & Accounting Lead', email: 'accountant@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348000000006', role_code: 'ACCOUNTANT', status: 'active', created_at: new Date().toISOString() },
    { id: 7, company_id: 1, full_name: 'Field Operations Supervisor', email: 'supervisor@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348187654321', role_code: 'SUPERVISOR', status: 'active', created_at: new Date().toISOString() },
    { id: 8, company_id: 1, full_name: 'Corporate Operations Staff', email: 'staff@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348145550192', role_code: 'STAFF_MEMBER', status: 'active', created_at: new Date().toISOString() },
    { id: 9, company_id: 1, full_name: 'Platform Super Administrator', email: 'admin@edgewforce.com', password_hash: defaultPasswordHash, phone: '+2348000000000', role_code: 'SUPER_ADMIN', status: 'active', created_at: new Date().toISOString() }
  ],
  employees: [
    { id: 1, company_id: 1, user_id: 1, employee_code: 'EMP-1001', first_name: 'IT Admin', last_name: 'Service', phone: '+2348000000001', department_id: 5, department: 'Technology & IT', position: 'IT Super Admin / System Engineer', territory: 'Headquarters', rank_code: 'IT_ADMIN', base_salary: 1800000, performance_score: 98.0, status: 'active' },
    { id: 2, company_id: 1, user_id: 2, employee_code: 'EMP-1002', first_name: 'Executive', last_name: 'Management', phone: '+2348000000002', department_id: 6, department: 'Executive Management', position: 'Chief Executive Officer', territory: 'National', rank_code: 'CEO', base_salary: 2500000, performance_score: 99.0, status: 'active' },
    { id: 3, company_id: 1, user_id: 3, employee_code: 'EMP-1003', first_name: 'HR', last_name: 'Manager', phone: '+2348000000003', department_id: 3, department: 'Human Resources', position: 'Head of Human Resources', territory: 'Headquarters', rank_code: 'HR', base_salary: 1200000, performance_score: 95.0, status: 'active' },
    { id: 4, company_id: 1, user_id: 4, employee_code: 'EMP-1004', first_name: 'Thompson', last_name: 'Babatunde', phone: '+2348031234567', department_id: 1, department: 'Commercial Sales', position: 'Senior Commercial Sales Agent', territory: 'Lagos Mainland', supervisor_id: 7, rank_code: 'STAFF', base_salary: 380000, performance_score: 92.5, status: 'active' },
    { id: 5, company_id: 1, user_id: 5, employee_code: 'EMP-1005', first_name: 'Godfrey', last_name: 'Okorie', phone: '+2348029876543', department_id: 2, department: 'Field Operations', position: 'Field Operations Lead Agent', territory: 'Lagos Island & Lekki', supervisor_id: 7, rank_code: 'STAFF', base_salary: 350000, performance_score: 88.0, status: 'active' },
    { id: 6, company_id: 1, user_id: 6, employee_code: 'EMP-1006', first_name: 'Finance', last_name: 'Officer', phone: '+2348000000006', department_id: 4, department: 'Finance & Accounts', position: 'Head of Accounting & Payroll', territory: 'Headquarters', rank_code: 'ACCOUNTANT', base_salary: 1100000, performance_score: 90.0, status: 'active' },
    { id: 7, company_id: 1, user_id: 7, employee_code: 'EMP-1007', first_name: 'Amina', last_name: 'Bello', phone: '+2348187654321', department_id: 2, department: 'Field Operations', position: 'Field Operations Supervisor', territory: 'Lagos Island', rank_code: 'SUPERVISOR', base_salary: 750000, performance_score: 96.0, status: 'active' },
    { id: 8, company_id: 1, user_id: 8, employee_code: 'EMP-1008', first_name: 'Gloria', last_name: 'Iwuh', phone: '+2348145550192', department_id: 3, department: 'Corporate Operations', position: 'Workforce Operations Analyst', territory: 'Headquarters', supervisor_id: 3, rank_code: 'STAFF', base_salary: 420000, performance_score: 85.0, status: 'active' },
    { id: 9, company_id: 1, user_id: 9, employee_code: 'EMP-1009', first_name: 'Platform', last_name: 'Administrator', phone: '+2348000000000', department_id: 6, department: 'Executive Governance', position: 'Super Administrator', territory: 'National', rank_code: 'CEO', base_salary: 1800000, performance_score: 99.0, status: 'active' }
  ],
  customers: [],
  products: [],
  orders: [],
  order_items: [],
  order_approvals: [],
  collections: [],
  deliveries: [],
  inventory_movements: [],
  visits: [],
  visit_reports: [],
  attendance: [],
  location_tracking: [],
  alerts: [],
  performance_scores: [],
  audit_logs: [],
  stores: [],
  store_requests: [],
  work_locations: [],
  employee_location_assignments: [],
  location_assignment_history: [],
  location_logs: [],
  field_activities: [],
  sales_activities: [],
  location_alerts: [],
  daily_summaries: [],
  leave_balances: [],
  leave_requests: [],
  payslips: [],
  okrs: [],
  tasks: [],
  task_comments: [],
  task_reminders: [],
  task_reminder_rules: [],
  reminder_delivery_logs: [],
  employee_idle_sessions: [],
  escalation_rules: [],
  announcements: [],
  holidays: [
    { id: 1, name: "New Year's Day", date: '2026-01-01', description: 'Public Holiday', year: 2026 },
    { id: 2, name: "Workers' Day", date: '2026-05-01', description: 'International Workers Day', year: 2026 },
    { id: 3, name: "Democracy Day", date: '2026-06-12', description: 'Democracy Day', year: 2026 },
    { id: 4, name: "Independence Day", date: '2026-10-01', description: 'National Independence Day', year: 2026 },
    { id: 5, name: "Christmas Day", date: '2026-12-25', description: 'Christmas Day', year: 2026 },
    { id: 6, name: "Boxing Day", date: '2026-12-26', description: 'Boxing Day', year: 2026 }
  ],
  schedules: [
    {
      id: 1,
      company_id: 1,
      employee_id: 4,
      employee_name: 'Thompson Babatunde',
      employee_code: 'EMP-1004',
      department: 'Commercial Sales',
      position: 'Senior Commercial Sales Agent',
      date: '2026-09-02',
      title: 'Commercial Key Account Restock & POS Territory Audits',
      shift_start: '08:00',
      shift_end: '17:00',
      work_location: 'Lagos Mainland / Surulere Retail Zone',
      tasks: [
        {
          id: 'task-1',
          time_start: '08:30',
          time_end: '10:00',
          activity: 'Morning Commercial Briefing & SKU Allocation Check',
          category: 'Admin / Office',
          location: 'Mainland Regional Hub',
          priority: 'NORMAL',
          notes: 'Review promotional SKUs and distributor trade margins.',
          status: 'Completed'
        },
        {
          id: 'task-2',
          time_start: '10:30',
          time_end: '12:30',
          activity: 'Key Account Shelf Restock Audit at Alhaji Bello Supermarket',
          category: 'Client Visit',
          location: 'Surulere Retail Corridor',
          priority: 'HIGH',
          notes: 'Inspect shelf share, verify POS terminal connectivity.',
          status: 'Completed'
        },
        {
          id: 'task-3',
          time_start: '13:30',
          time_end: '15:30',
          activity: 'B2B Merchant Direct Prospecting & Onboarding',
          category: 'Sales Prospecting',
          location: 'Bode Thomas Commercial Strip',
          priority: 'HIGH',
          notes: 'Target 4 new retail storefront accounts for wholesale catalog.',
          status: 'In Progress'
        },
        {
          id: 'task-4',
          time_start: '16:00',
          time_end: '17:00',
          activity: 'Daily Cash Settlement & EOD Reconciliations',
          category: 'Admin / Office',
          location: 'Mainland Regional Hub',
          priority: 'NORMAL',
          notes: 'Reconcile physical stock receipts with ERP sales orders.',
          status: 'Planned'
        }
      ],
      total_planned_hours: 8,
      notes: 'Focus on scaling Q3 volume and closing overdue collections.',
      status: 'SUBMITTED',
      submitted_at: '2026-09-02T07:45:00.000Z',
      supervisor_id: 7,
      supervisor_name: 'Amina Bello',
      supervisor_status: 'PENDING',
      supervisor_reviewed_at: null,
      supervisor_notes: null,
      hr_status: 'PENDING',
      hr_reviewed_at: null,
      hr_notes: null,
      created_at: '2026-09-02T07:45:00.000Z',
      updated_at: '2026-09-02T07:45:00.000Z'
    },
    {
      id: 2,
      company_id: 1,
      employee_id: 5,
      employee_name: 'Godfrey Okorie',
      employee_code: 'EMP-1005',
      department: 'Field Operations',
      position: 'Field Operations Lead Agent',
      date: '2026-09-02',
      title: 'Lagos Island Retail Store Compliance & Geofence Audits',
      shift_start: '08:00',
      shift_end: '17:00',
      work_location: 'Lagos Island & Lekki Phase 1',
      tasks: [
        {
          id: 'task-201',
          time_start: '08:30',
          time_end: '11:00',
          activity: 'Store Geofence Radius Verification & Signage Audit',
          category: 'Field Audit',
          location: 'Victoria Island Mega Outlet',
          priority: 'NORMAL',
          notes: 'Verify 150m GPS geofence compliance and outdoor banner visibility.',
          status: 'Completed'
        },
        {
          id: 'task-202',
          time_start: '11:30',
          time_end: '14:00',
          activity: 'Fast-Moving Goods Inventory Count & Stock Reorder',
          category: 'Field Audit',
          location: 'Lekki Admiralty Mall',
          priority: 'HIGH',
          notes: 'Check expiration dates and scan barcoded packaging.',
          status: 'In Progress'
        },
        {
          id: 'task-203',
          time_start: '14:30',
          time_end: '16:30',
          activity: 'Merchant Satisfaction Review & Dispute Resolution',
          category: 'Client Visit',
          location: 'Oniru Market Trade Center',
          priority: 'NORMAL',
          notes: 'Collect client feedback on logistics turnaround times.',
          status: 'Planned'
        }
      ],
      total_planned_hours: 8,
      notes: 'Territory inspection for Lagos Island operations.',
      status: 'APPROVED',
      submitted_at: '2026-09-02T07:30:00.000Z',
      supervisor_id: 7,
      supervisor_name: 'Amina Bello',
      supervisor_status: 'APPROVED',
      supervisor_reviewed_at: '2026-09-02T08:15:00.000Z',
      supervisor_notes: 'Approved. Ensure high-resolution shelf photos are uploaded for Admiralty Mall.',
      hr_status: 'ACKNOWLEDGED',
      hr_reviewed_at: '2026-09-02T08:30:00.000Z',
      hr_notes: 'Logged into workforce daily roster.',
      created_at: '2026-09-02T07:30:00.000Z',
      updated_at: '2026-09-02T08:15:00.000Z'
    }
  ],
  settlements: [],
  sos: [],
  idle_alerts: [],
  push_subscriptions: [],
  notifications: [],
  face_events: []
};

// Initialize or load local store
let store = JSON.parse(JSON.stringify(initialSeed));

function loadPersistedStore() {
  if (isTestMode) return;
  try {
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, 'utf8');
      const loaded = JSON.parse(data);
      store = { ...initialSeed, ...loaded };
      store.companies = loaded.companies?.length ? loaded.companies : initialSeed.companies;
      store.company_settings = loaded.company_settings?.length ? loaded.company_settings : initialSeed.company_settings;
      store.regions = loaded.regions?.length ? loaded.regions : initialSeed.regions;
      store.territories = loaded.territories?.length ? loaded.territories : initialSeed.territories;
      store.departments = loaded.departments?.length ? loaded.departments : initialSeed.departments;
      store.ranks = loaded.ranks?.length ? loaded.ranks : initialSeed.ranks;
      store.permissions = loaded.permissions?.length ? loaded.permissions : initialSeed.permissions;
      store.users = loaded.users?.length ? loaded.users : initialSeed.users;
      store.employees = loaded.employees?.length ? loaded.employees : initialSeed.employees;
      store.schedules = loaded.schedules?.length ? loaded.schedules : initialSeed.schedules;
    } else {
      savePersistedStoreSync();
    }
  } catch (err) {
    logger.error('Failed to load local store file, resetting to clean baseline', err);
    store = JSON.parse(JSON.stringify(initialSeed));
  }
}

function savePersistedStoreSync() {
  if (isProduction || isTestMode) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to persist store synchronously', err);
  }
}

function savePersistedStore() {
  if (isProduction || isTestMode) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to persist store', err);
  }
}

if (!isProduction) loadPersistedStore();

// Helper to race promise against a timeout (generous 8s for cloud/serverless latency)
function fetchWithTimeout(promise, ms = 8000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('SUPABASE_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Canonical Table Name Mapper
function resolveCanonicalTable(table) {
  if (usesNumberedSchema) return table;
  const map = {
    visits: 'field_visits',
    orders: 'sales',
    order_items: 'sale_items',
    alerts: 'idle_alerts'
  };
  return map[table] || table;
}

export const db = {
  resetToSeed() {
    if (isProduction) throw new Error('The local seed store is disabled in production.');
    store = JSON.parse(JSON.stringify(initialSeed));
    savePersistedStore();
    return true;
  },

  async find(table, filter = {}, options = {}) {
    const canonicalTable = resolveCanonicalTable(table);
    if (!isTestMode && usesNumberedSchema && table === 'employees' && filter.user_id != null && !isUuid(String(filter.user_id))) {
      return [];
    }

    if (supabase && !isTestMode) {
      try {
        let q = supabase.from(canonicalTable).select(options.select || '*');
        for (const [k, v] of Object.entries(filter)) {
          if (v !== undefined && v !== null) {
            // Alias resolution for attendance filters
            const mappedKey = (!usesNumberedSchema && canonicalTable === 'attendance' && k === 'date') ? 'attendance_date' : k;
            q = q.eq(mappedKey, v);
          }
        }
        if (options.order) q = q.order(options.order.column, { ascending: options.order.ascending !== false });
        if (options.offset !== undefined) q = q.range(options.offset, options.offset + (options.limit || 500) - 1);
        else if (options.limit) q = q.limit(options.limit);
        
        const { data, error } = await fetchWithTimeout(q, 8000);
        if (!error && Array.isArray(data)) {
          return data.map(item => {
            // Normalize attendance fields for backwards compatibility
            if (canonicalTable === 'attendance') {
              return {
                ...item,
                date: item.attendance_date || item.date,
                clock_in_time: item.clock_in || item.clock_in_time,
                clock_out_time: item.clock_out || item.clock_out_time,
                clock_in_lat: item.clock_in_latitude ?? item.clock_in_lat,
                clock_in_lng: item.clock_in_longitude ?? item.clock_in_lng,
                clock_out_lat: item.clock_out_latitude ?? item.clock_out_lat,
                clock_out_lng: item.clock_out_longitude ?? item.clock_out_lng
              };
            }
            return item;
          });
        }
        if (isProduction) throw new Error(`Supabase query for ${canonicalTable} failed: ${error?.message || 'empty response'}`);
        if (options.strict) throw new Error(`Unable to load ${canonicalTable} from the database.`);
        if (error && (error.code === '42P01' || error.message?.includes('does not exist') || error.message?.includes('schema cache'))) {
          logger.warn(`Supabase table ${canonicalTable} not found in database, using local fallback.`);
        } else if (error) {
          logger.error(`Supabase query for ${canonicalTable} failed: ${error.message}`);
        }
      } catch (err) {
        if (isProduction || options.strict) throw err;
        logger.warn(`Supabase find for ${canonicalTable} notice: ${err.message}`);
      }
    }

    if (isProduction) throw new Error('Supabase is unavailable. Production database fallback is disabled.');
    const targetList = store[canonicalTable] || store[table] || [];
    let items = targetList.filter(item => {
      return Object.entries(filter).every(([k, v]) => {
        if (v === undefined || v === null) return true;
        const itemVal = item[k] !== undefined ? item[k] : (k === 'date' ? item.attendance_date : (k === 'attendance_date' ? item.date : undefined));
        return String(itemVal) === String(v);
      });
    });

    if (options.order) {
      const col = options.order.column;
      const asc = options.order.ascending !== false;
      items.sort((a, b) => {
        const valA = a[col] ?? '';
        const valB = b[col] ?? '';
        if (typeof valA === 'number' && typeof valB === 'number') {
          return asc ? valA - valB : valB - valA;
        }
        return asc ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
      });
    }

    if (options.offset) items = items.slice(options.offset);
    if (options.strict && !Object.hasOwn(store, canonicalTable) && !Object.hasOwn(store, table)) {
      throw new Error(`Table ${canonicalTable} is unavailable in the local store.`);
    }
    if (options.limit) {
      items = items.slice(0, options.limit);
    }

    return JSON.parse(JSON.stringify(items));
  },

  async findOne(table, filter = {}) {
    const list = await this.find(table, filter, { limit: 1 });
    return list[0] || null;
  },

  async findById(table, id) {
    if (!isTestMode && usesNumberedSchema && ['users', 'employees'].includes(table)) {
      if (isUuid(String(id))) return this.findOne(table, { uuid: id });
      if (!/^\d+$/.test(String(id))) return null;
    }
    return this.findOne(table, { id });
  },

  async insert(table, record) {
    const canonicalTable = resolveCanonicalTable(table);

    // Normalize canonical attendance columns
    const normalized = canonicalTable === 'attendance' && !isTestMode
      ? attendanceWrite(record, usesNumberedSchema ? 'numbered' : 'legacy')
      : { ...record };

    if (supabase && !isTestMode) {
      try {
        let { data, error } = await supabase.from(canonicalTable).insert(normalized).select().single();
        if (error && usesNumberedSchema) {
          const retried = await retryLegacyRuntimeActorWrite(canonicalTable, normalized, error, supabase,
            legacy => supabase.from(canonicalTable).insert(legacy).select().single());
          if (retried) ({ data, error } = retried);
        }
        if (error) {
          logger.error(`Supabase insert for ${canonicalTable} failed: ${error.message}`);
          throw error;
        }
        if (data) {
          return JSON.parse(JSON.stringify(data));
        }
      } catch (err) {
        if (isProduction) throw err;
        if (err.code !== '42P01' && !err.message?.includes('does not exist') && !err.message?.includes('schema cache')) {
          throw err;
        }
        logger.warn(`Supabase table ${canonicalTable} not present, writing to local store: ${err.message}`);
      }
    }

    if (isProduction) throw new Error(`Supabase insert for ${canonicalTable} returned no record.`);

    if (!store[canonicalTable]) store[canonicalTable] = [];
    const maxId = store[canonicalTable].reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
    const newRecord = {
      id: record.id || (typeof record.id === 'string' ? record.id : maxId + 1),
      created_at: new Date().toISOString(),
      ...normalized
    };

    store[canonicalTable].push(newRecord);
    savePersistedStore();
    return JSON.parse(JSON.stringify(newRecord));
  },

  async update(table, id, updates) {
    const canonicalTable = resolveCanonicalTable(table);

    // Normalize canonical attendance columns
    const normalized = canonicalTable === 'attendance' && !isTestMode
      ? attendanceWrite(updates, usesNumberedSchema ? 'numbered' : 'legacy')
      : { ...updates };

    if (supabase && !isTestMode) {
      try {
        let { data, error } = await supabase.from(canonicalTable).update(normalized).eq('id', id).select().single();
        if (error && usesNumberedSchema) {
          const retried = await retryLegacyRuntimeActorWrite(canonicalTable, normalized, error, supabase,
            legacy => supabase.from(canonicalTable).update(legacy).eq('id', id).select().single());
          if (retried) ({ data, error } = retried);
        }
        if (error) {
          logger.error(`Supabase update for ${canonicalTable} failed: ${error.message}`);
          throw error;
        }
        if (data) return JSON.parse(JSON.stringify(data));
        return null;
      } catch (err) {
        if (isProduction) throw err;
        if (err.code !== '42P01' && !err.message?.includes('does not exist') && !err.message?.includes('schema cache')) {
          throw err;
        }
        logger.warn(`Supabase update for ${canonicalTable} failed, updating local store: ${err.message}`);
      }
    }

    const targetTable = store[canonicalTable] ? canonicalTable : table;
    if (!store[targetTable]) store[targetTable] = [];
    const index = store[targetTable].findIndex(r => String(r.id) === String(id));
    if (index !== -1) {
      store[targetTable][index] = {
        ...store[targetTable][index],
        ...normalized,
        updated_at: new Date().toISOString()
      };
      savePersistedStore();
      return JSON.parse(JSON.stringify(store[targetTable][index]));
    }

    return null;
  },

  async delete(table, id) {
    const canonicalTable = resolveCanonicalTable(table);

    if (supabase && !isTestMode) {
      try {
        const { error } = await supabase.from(canonicalTable).delete().eq('id', id);
        if (error) {
          logger.error(`Supabase delete for ${canonicalTable} failed: ${error.message}`);
          throw error;
        }
        return true;
      } catch (err) {
        if (isProduction) throw err;
        if (err.code !== '42P01' && !err.message?.includes('does not exist') && !err.message?.includes('schema cache')) {
          throw err;
        }
        logger.warn(`Supabase delete for ${canonicalTable} failed: ${err.message}`);
      }
    }

    const targetTable = store[canonicalTable] ? canonicalTable : table;
    if (!store[targetTable]) return false;
    const initialLen = store[targetTable].length;
    store[targetTable] = store[targetTable].filter(r => String(r.id) !== String(id));
    const deleted = store[targetTable].length < initialLen;
    if (deleted) savePersistedStore();
    return deleted;
  },

  /**
   * Executes an atomic transaction callback with safe rollback capability.
   */
  async transaction(callback) {
    const snapshot = JSON.stringify(store);
    try {
      const result = await callback(this);
      savePersistedStore();
      return result;
    } catch (error) {
      store = JSON.parse(snapshot);
      savePersistedStore();
      throw error;
    }
  }
};
