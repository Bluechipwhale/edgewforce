-- Adds the attendance fields sent by the workplace/shift services.
-- Existing employee UUID references and attendance records are preserved.
-- Apply to the numbered schema, including installations with migrations 011-016.
BEGIN;

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES public.companies(id),
  ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES public.employees(uuid),
  ADD COLUMN IF NOT EXISTS store_id BIGINT REFERENCES public.stores(id),
  ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES public.work_locations(id),
  ADD COLUMN IF NOT EXISTS location_name TEXT,
  ADD COLUMN IF NOT EXISTS market TEXT,
  ADD COLUMN IF NOT EXISTS assigned_market TEXT,
  ADD COLUMN IF NOT EXISTS assigned_region TEXT,
  ADD COLUMN IF NOT EXISTS assigned_state TEXT,
  ADD COLUMN IF NOT EXISTS attendance_type TEXT,
  ADD COLUMN IF NOT EXISTS activity TEXT,
  ADD COLUMN IF NOT EXISTS clock_in_address TEXT,
  ADD COLUMN IF NOT EXISTS clock_out_address TEXT,
  ADD COLUMN IF NOT EXISTS clock_in_distance_from_store NUMERIC,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS distance_meters NUMERIC,
  ADD COLUMN IF NOT EXISTS formatted_distance TEXT,
  ADD COLUMN IF NOT EXISTS geofence_radius NUMERIC,
  ADD COLUMN IF NOT EXISTS is_geofence_verified BOOLEAN,
  ADD COLUMN IF NOT EXISTS geofence_status TEXT,
  ADD COLUMN IF NOT EXISTS is_override BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS override_by TEXT,
  ADD COLUMN IF NOT EXISTS working_duration_text TEXT,
  ADD COLUMN IF NOT EXISTS server_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS local_time_lagos TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS morning_clock_in TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS morning_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS morning_lng NUMERIC,
  ADD COLUMN IF NOT EXISTS morning_distance NUMERIC,
  ADD COLUMN IF NOT EXISTS morning_geofence_status TEXT,
  ADD COLUMN IF NOT EXISTS midday_clock_in TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS midday_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS midday_lng NUMERIC,
  ADD COLUMN IF NOT EXISTS midday_distance NUMERIC,
  ADD COLUMN IF NOT EXISTS midday_geofence_status TEXT,
  ADD COLUMN IF NOT EXISTS evening_clock_out TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evening_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS evening_lng NUMERIC,
  ADD COLUMN IF NOT EXISTS evening_distance NUMERIC,
  ADD COLUMN IF NOT EXISTS evening_geofence_status TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_workplace_date
  ON public.attendance(company_id, date);

NOTIFY pgrst, 'reload schema';
COMMIT;
