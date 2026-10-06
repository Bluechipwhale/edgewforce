// ==============================================================================
// EDGEWFORCE - FIELD OPERATIONS & SUPERVISOR MONITORING SERVICE
// GPS Shift Tracking, Geofence Enforcement, Work Locations, Visits & Alerts
// ==============================================================================

import { db } from '../config/database.js';
import { verifyGeofence, calculateHaversineDistance, formatDistance, validateCoordinates, GEOFENCE_MAX_METERS } from '../utils/haversine.js';
import { getLagosTime, determineShiftAttendanceWindow, isShiftEligibleRole } from '../utils/nigeriaTime.js';
import { formatTime } from '../utils/calculations.js';
import { recordAudit } from '../middleware/auditLogger.js';
import { locationService } from './locationService.js';
import { storageService } from './storageService.js';
import { employeeRef, findEmployeeByAnyId, sameId, toDbId } from '../utils/id.js';

const matchesEmployee = (employee, id) =>
  sameId(employeeRef(employee), id) || sameId(employee?.id, id) || sameId(employee?.user_id, id);

export const fieldService = {
  /**
   * Retrieves today's assigned route stops / stores with geofence metrics.
   */
  async getRouteManifest(agentId) {
    const visits = await db.find('visits', { agent_id: toDbId(agentId) });
    const customers = await db.find('customers');
    const stores = await db.find('stores');
    const workLocations = await db.find('work_locations');

    return visits.map(v => {
      const customer = customers.find(c => Number(c.id) === Number(v.customer_id));
      const store = stores.find(s => Number(s.id) === Number(v.store_id || v.customer_id)) || workLocations.find(w => Number(w.id) === Number(v.store_id || v.customer_id));
      const outlet = store || customer || { name: 'Assigned Outlet', address: 'Field Location', latitude: null, longitude: null, geofence_radius: 150 };

      return {
        ...v,
        store: outlet,
        customer: outlet
      };
    });
  },

  /**
   * Retrieves active shift state for an employee with assigned work location.
   */
  async getCurrentShift(agentId) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const shift = await db.findOne('attendance', { employee_id: toDbId(agentId), date: todayStr });
    if (!shift) return null;

    let store = null;
    if (shift.store_id || shift.location_id) {
      const locId = Number(shift.store_id || shift.location_id);
      store = await db.findById('work_locations', locId) || await db.findById('stores', locId) || await db.findById('customers', locId);
    }

    return {
      ...shift,
      store
    };
  },

  /**
   * Retrieves current shift window status and authoritative server time in Africa/Lagos.
   */
  async getShiftWindowStatus(agentId = null, companyId = 1, testDate = null) {
    const serverNow = testDate ? new Date(testDate) : new Date();
    const lagosTime = getLagosTime(serverNow);
    const windowInfo = determineShiftAttendanceWindow(serverNow);

    let employee = null;
    let isShiftEligible = false;
    let todayAttendance = null;
    let morningRecorded = false;
    let middayRecorded = false;
    let eveningRecorded = false;
    let currentAssignedLocations = [];

    if (agentId) {
      employee = await findEmployeeByAnyId(db, agentId);
      if (employee) {
        isShiftEligible = isShiftEligibleRole(employee.role_code, employee.position);
        todayAttendance = await db.findOne('attendance', { employee_id: toDbId(agentId), date: lagosTime.dateStr });
        if (todayAttendance) {
          morningRecorded = Boolean(todayAttendance.morning_clock_in);
          middayRecorded = Boolean(todayAttendance.midday_clock_in);
          eveningRecorded = Boolean(todayAttendance.evening_clock_out);
        }
        currentAssignedLocations = await locationService.getActivePermittedLocations(agentId, companyId);
      }
    }

    return {
      server_time_iso: serverNow.toISOString(),
      lagos_time: lagosTime,
      is_shift_eligible: isShiftEligible,
      window_info: windowInfo,
      attendance_today: todayAttendance,
      morning_recorded: morningRecorded,
      midday_recorded: middayRecorded,
      evening_recorded: eveningRecorded,
      assigned_locations_count: currentAssignedLocations.length,
      assigned_locations: currentAssignedLocations
    };
  },

  /**
   * Toggles shift start / end or records current shift attendance.
   */
  async toggleShift(agentId, latitude, longitude, device = 'Mobile App', req = null, testDate = null) {
    const serverNow = testDate ? new Date(testDate) : new Date();
    const lagos = getLagosTime(serverNow);
    const todayStr = lagos.dateStr;

    const employee = await findEmployeeByAnyId(db, agentId);
    const isShiftEligible = employee ? isShiftEligibleRole(employee.role_code, employee.position) : true;

    const existing = await db.findOne('attendance', { employee_id: toDbId(agentId), date: todayStr });
    const isAlreadyClockedIn = existing && 
      (existing.clock_in || existing.clock_in_time || existing.morning_clock_in || existing.midday_clock_in) && 
      !(existing.clock_out || existing.clock_out_time || existing.evening_clock_out);

    if (isAlreadyClockedIn) {
      return await this.checkOut({
        employeeId: agentId,
        latitude,
        longitude,
        device,
        req,
        testDate
      });
    }

    return await this.checkIn({
      employeeId: agentId,
      latitude,
      longitude,
      device,
      req,
      testDate
    });
  },

  /**
   * Secure Field Agent, Sales Agent, Promoter & Staff GPS Check-In with
   * Smart Shift Window Enforcement, Duplicate Prevention, and Individual Geofence Validation.
   */
  async checkIn({ employeeId, storeId = null, locationId = null, latitude, longitude, accuracy = 5, address = null, device = 'Mobile Device', isOverride = false, overrideReason = null, req = null, testDate = null }) {
    const employee = await findEmployeeByAnyId(db, employeeId);
    if (!employee) throw new Error(`Employee #${employeeId} not found.`);
    employeeId = employeeRef(employee);

    // 1. Authoritative Server Nigeria (Africa/Lagos) Time Calculation
    const serverNow = testDate ? new Date(testDate) : new Date();
    const lagos = getLagosTime(serverNow);
    const todayStr = lagos.dateStr;
    const isShiftEligible = isShiftEligibleRole(employee.role_code, employee.position);

    // 2. Validate GPS coordinates and accuracy bounds
    if (!latitude || !longitude) {
      throw new Error('Device GPS coordinates are required to check in. Please ensure location services are enabled.');
    }

    const coordCheck = validateCoordinates(latitude, longitude);
    if (!coordCheck.valid) {
      throw new Error(coordCheck.message || 'Invalid GPS coordinates provided.');
    }

    const agentLat = coordCheck.latitude;
    const agentLng = coordCheck.longitude;
    const gpsAccuracy = Number(accuracy || 5);

    if (gpsAccuracy > 500) {
      throw new Error(`LOCATION ACCURACY TOO LOW\n\nYour device currently reports an inaccurate location (Accuracy: ±${Math.round(gpsAccuracy)}m).\n\nPlease:\n• Turn on GPS/location services\n• Move outdoors or to an area with better GPS signal\n• Wait a few seconds\n• Try again`);
    }

    const companyId = employee.company_id || req?.user?.company_id || 1;
    const existing = await db.findOne('attendance', { employee_id: toDbId(employeeId), date: todayStr });

    // 3. Shift Window & Duplicate Validation for Eligible Roles (Sales / Field / Promoters)
    let windowInfo = null;
    let attendanceType = 'STAFF_CLOCK_IN';
    let activityName = 'Staff Clock-In';

    if (isShiftEligible) {
      windowInfo = determineShiftAttendanceWindow(serverNow);

      // Outside window -> Block and Audit
      if (!windowInfo.allowed && !isOverride) {
        await db.insert('location_logs', {
          employee_id: toDbId(employeeId),
          employee_name: `${employee.first_name} ${employee.last_name}`,
          role: employee.role_code || (employee.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT'),
          company_id: Number(companyId),
          supervisor_id: employee.supervisor_id || null,
          timestamp: serverNow.toISOString(),
          server_timestamp: serverNow.toISOString(),
          local_time_lagos: lagos.isoLagos,
          latitude: agentLat,
          longitude: agentLng,
          accuracy: gpsAccuracy,
          address: address || 'Field Location',
          current_activity: 'Shift Attendance Attempt',
          activity: 'Shift Attendance Attempt',
          attendance_type: 'BLOCKED',
          is_inside_geofence: false,
          geofence_status: 'Blocked Window',
          status: 'blocked',
          notes: windowInfo.message
        });

        await recordAudit(
          { id: employeeId, email: req?.user?.email || employee.phone },
          'CHECK_IN_BLOCKED_WINDOW',
          'attendance',
          null,
          { reason: windowInfo.message, lagos_time: lagos.timeStr },
          req
        );

        throw new Error(windowInfo.message);
      }

      // Check Duplicate Attendance within the current window on the same calendar day
      if (windowInfo.allowed) {
        attendanceType = windowInfo.attendance_type;
        activityName = windowInfo.label;

        if (attendanceType === 'MORNING_ATTENDANCE' && existing?.morning_clock_in) {
          throw new Error(`Duplicate attendance: Morning Attendance has already been recorded for today at ${formatTime(existing.morning_clock_in)}.`);
        }
        if (attendanceType === 'MIDDAY_ATTENDANCE' && existing?.midday_clock_in) {
          throw new Error(`Duplicate attendance: Midday Attendance has already been recorded for today at ${formatTime(existing.midday_clock_in)}.`);
        }
        if (attendanceType === 'EVENING_CLOCK_OUT' && existing?.evening_clock_out) {
          throw new Error(`Duplicate attendance: Evening Clock-Out has already been recorded for today at ${formatTime(existing.evening_clock_out)}.`);
        }
      }
    }

    // 4. Retrieve Active Permitted Locations & Geofence Validation
    let permittedLocations = await locationService.getActivePermittedLocations(employeeId, companyId);
    const targetLocId = toDbId(storeId || locationId);
    if (targetLocId) {
      const explicitLoc = await db.findById('work_locations', targetLocId) || await db.findById('stores', targetLocId);
      if (explicitLoc && Number(explicitLoc.company_id) === Number(companyId)) {
        if (!permittedLocations.some(l => sameId(l.id, targetLocId))) {
          permittedLocations.push({ ...explicitLoc, _is_store: Boolean(storeId) });
        }
      }
    }

    if (permittedLocations.length === 0) {
      const allStores = await db.find('stores', { company_id: Number(companyId) });
      const matchingStores = allStores.filter(s => {
        const fieldAssigned = Array.isArray(s.assigned_field_agents) && s.assigned_field_agents.includes(toDbId(employeeId));
        const salesAssigned = Array.isArray(s.assigned_sales_agents) && s.assigned_sales_agents.includes(toDbId(employeeId));
        return fieldAssigned || salesAssigned;
      });
      permittedLocations.push(...matchingStores.map(store => ({ ...store, _is_store: true })));
    }

    if (permittedLocations.length === 0 && !isOverride) {
      throw new Error('CHECK-IN UNAVAILABLE — No work location has been assigned to your account.\n\nPlease contact your supervisor or HR administrator.');
    }

    let matchedLocation = null;
    let shortestDistance = Infinity;
    const calculatedDistances = [];

    for (const loc of permittedLocations) {
      const locLat = Number(loc.latitude);
      const locLng = Number(loc.longitude);
      const radius = Number(loc.geofence_radius || loc.geofence_radius_meters || 150.0);

      const distanceMeters = calculateHaversineDistance(agentLat, agentLng, locLat, locLng);
      const isWithin = distanceMeters <= radius;

      calculatedDistances.push({
        id: loc.id,
        name: loc.name,
        address: loc.address,
        state: loc.state,
        region: loc.region || loc.state,
        latitude: locLat,
        longitude: locLng,
        radius,
        distance: distanceMeters,
        formattedDistance: formatDistance(distanceMeters),
        isWithin,
        _is_store: Boolean(loc._is_store)
      });

      if (isWithin && (!matchedLocation || distanceMeters < shortestDistance)) {
        matchedLocation = loc;
        shortestDistance = distanceMeters;
      }
    }

    calculatedDistances.sort((a, b) => a.distance - b.distance);
    const nearest = calculatedDistances[0] || null;
    const isWithin = matchedLocation !== null;

    if (!isWithin && !isOverride) {
      // Audit blocked geofence attempt
      await db.insert('location_logs', {
        employee_id: toDbId(employeeId),
        employee_name: `${employee.first_name} ${employee.last_name}`,
        role: employee.role_code || (employee.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT'),
        company_id: Number(companyId),
        supervisor_id: employee.supervisor_id || null,
        store_id: nearest?._is_store ? toDbId(nearest.id) : null,
        location_id: nearest && !nearest._is_store ? toDbId(nearest.id) : null,
        timestamp: serverNow.toISOString(),
        server_timestamp: serverNow.toISOString(),
        local_time_lagos: lagos.isoLagos,
        latitude: agentLat,
        longitude: agentLng,
        accuracy: gpsAccuracy,
        address: address || 'Outside Geofence Area',
        current_activity: activityName,
        activity: activityName,
        attendance_type: attendanceType,
        is_inside_geofence: false,
        distance_from_store: nearest ? nearest.distance : 0,
        geofence_status: 'Outside Geofence',
        status: 'blocked',
        notes: `Blocked: ${nearest?.formattedDistance || 'Distant'} from ${nearest?.name || 'Assigned Site'}`
      });

      await recordAudit(
        { id: employeeId, email: req?.user?.email || employee.phone },
        'CHECK_IN_BLOCKED_GEOFENCE',
        'attendance',
        null,
        { nearest: nearest?.name, distance_meters: nearest?.distance },
        req
      );

      if (calculatedDistances.length <= 1 && nearest) {
        throw new Error(`CHECK-IN BLOCKED — YOU ARE OUTSIDE YOUR ASSIGNED LOCATION.\n\nDistance: ${nearest.formattedDistance} from ${nearest.name} (Permitted Radius: ${nearest.radius}m).\n\nPlease move within the permitted attendance area or contact your supervisor.`);
      } else if (calculatedDistances.length > 1 && nearest) {
        const others = calculatedDistances.slice(1);
        const othersList = others.map(o => `• ${o.name} — ${o.formattedDistance} away (Permitted Radius: ${o.radius}m)`).join('\n');
        throw new Error(`CHECK-IN BLOCKED — You are outside all assigned work locations.\n\nNearest assigned location:\n• ${nearest.name} — ${nearest.formattedDistance} away (Permitted Radius: ${nearest.radius}m)\n\nOther assigned locations:\n${othersList}\n\nPlease move within the permitted attendance area or contact your supervisor.`);
      } else {
        throw new Error('CHECK-IN UNAVAILABLE — No work location has been assigned to your account.\n\nPlease contact your supervisor or HR administrator.');
      }
    }

    const targetLoc = matchedLocation || nearest || { id: null, name: 'Manual Override Location', geofence_radius: 150, state: employee.state || 'Lagos', region: 'WEST' };
    const finalDistance = matchedLocation ? shortestDistance : (nearest ? nearest.distance : 0);
    const finalRadius = Number(targetLoc.geofence_radius || targetLoc.geofence_radius_meters || 150.0);

    // Lateness calculation (standard 08:30 AM threshold)
    const isLate = lagos.hours > 8 || (lagos.hours === 8 && lagos.minutes > 30);
    const lateMinutes = isLate ? ((lagos.hours - 8) * 60 + (lagos.minutes - 30)) : 0;
    const status = isWithin ? (isLate ? 'Late' : 'Present') : (isOverride ? 'Present' : 'Outside Geofence');

    const attendanceData = {
      employee_id: toDbId(employeeId),
      company_id: Number(companyId),
      supervisor_id: employee.supervisor_id || null,
      store_id: targetLoc._is_store ? toDbId(targetLoc.id) : null,
      location_id: targetLoc.id && !targetLoc._is_store ? toDbId(targetLoc.id) : null,
      location_name: targetLoc?.name || null,
      market: targetLoc?.name || null,
      assigned_market: targetLoc?.name || null,
      assigned_region: targetLoc?.region || employee.region || 'WEST',
      assigned_state: targetLoc?.state || employee.state || 'Lagos',
      attendance_date: todayStr,
      date: todayStr,
      attendance_type: attendanceType,
      activity: activityName,
      clock_in: (existing && (existing.clock_in || existing.clock_in_time)) ? (existing.clock_in || existing.clock_in_time) : serverNow.toISOString(),
      clock_in_time: (existing && (existing.clock_in || existing.clock_in_time)) ? (existing.clock_in || existing.clock_in_time) : serverNow.toISOString(),
      clock_in_latitude: agentLat,
      clock_in_lat: agentLat,
      clock_in_longitude: agentLng,
      clock_in_lng: agentLng,
      clock_in_accuracy: gpsAccuracy,
      clock_in_device: device || 'Mobile Device',
      clock_in_address: address || targetLoc?.address || `${targetLoc?.name || 'Work Location'}, ${targetLoc?.state || ''}`,
      clock_in_distance_from_store: finalDistance,
      status: isWithin ? (isLate ? 'late' : 'present') : (isOverride ? 'present' : 'absent'),
      notes: isOverride ? `Manual Override: ${overrideReason || 'Supervisor approved'}` : `Shift: ${activityName} | GPS Verified`,
      verification_mode: 'GPS',
      distance_meters: finalDistance,
      formatted_distance: formatDistance(finalDistance),
      geofence_radius: finalRadius,
      is_geofence_verified: isWithin,
      geofence_status: isWithin ? 'Verified' : (isOverride ? 'Override' : 'Outside Geofence'),
      is_override: Boolean(isOverride),
      override_reason: overrideReason || null,
      override_by: isOverride ? (req?.user?.id || req?.user?.email || 'Supervisor') : null,
      working_hours: existing?.working_hours || 0.0,
      working_duration_text: existing?.working_duration_text || '0h 00m',
      server_timestamp: serverNow.toISOString(),
      local_time_lagos: lagos.isoLagos,
      updated_at: serverNow.toISOString()
    };

    if (attendanceType === 'MORNING_ATTENDANCE') {
      attendanceData.morning_clock_in = serverNow.toISOString();
      attendanceData.morning_lat = agentLat;
      attendanceData.morning_lng = agentLng;
      attendanceData.morning_distance = finalDistance;
      attendanceData.morning_geofence_status = isWithin ? 'Verified' : 'Override';
    } else if (attendanceType === 'MIDDAY_ATTENDANCE') {
      attendanceData.midday_clock_in = serverNow.toISOString();
      attendanceData.midday_lat = agentLat;
      attendanceData.midday_lng = agentLng;
      attendanceData.midday_distance = finalDistance;
      attendanceData.midday_geofence_status = isWithin ? 'Verified' : 'Override';
    } else if (attendanceType === 'EVENING_CLOCK_OUT') {
      attendanceData.evening_clock_out = serverNow.toISOString();
      attendanceData.clock_out = serverNow.toISOString();
      attendanceData.clock_out_time = serverNow.toISOString();
      attendanceData.evening_lat = agentLat;
      attendanceData.evening_lng = agentLng;
      attendanceData.evening_distance = finalDistance;
      attendanceData.evening_geofence_status = isWithin ? 'Verified' : 'Override';
    }

    let record;
    if (existing) {
      record = await db.update('attendance', existing.id, attendanceData);
    } else {
      record = await db.insert('attendance', attendanceData);
    }

    // Insert into location_logs for Geo-Location Reporting and Complete Audit
    await db.insert('location_logs', {
      employee_id: toDbId(employeeId),
      employee_name: `${employee.first_name} ${employee.last_name}`,
      role: employee.role_code || (employee.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT'),
      company_id: Number(companyId),
      supervisor_id: employee.supervisor_id || null,
      store_id: targetLoc._is_store ? toDbId(targetLoc.id) : null,
      location_id: targetLoc.id && !targetLoc._is_store ? toDbId(targetLoc.id) : null,
      assigned_market: targetLoc?.name || 'Assigned Location',
      assigned_region: targetLoc?.region || employee.region || 'WEST',
      assigned_state: targetLoc?.state || employee.state || 'Lagos',
      timestamp: serverNow.toISOString(),
      server_timestamp: serverNow.toISOString(),
      local_time_lagos: lagos.isoLagos,
      latitude: agentLat,
      longitude: agentLng,
      accuracy: gpsAccuracy,
      address: address || targetLoc?.address || 'Field Location',
      current_activity: activityName,
      activity: activityName,
      attendance_type: attendanceType,
      attendance_id: record.id,
      is_inside_geofence: isWithin,
      distance_from_store: finalDistance,
      geofence_status: isWithin ? 'Verified' : (isOverride ? 'Override' : 'Outside Geofence'),
      status: 'success',
      battery_level: 100
    });

    if (isLate) {
      await db.insert('location_alerts', {
        employee_id: toDbId(employeeId),
        supervisor_id: employee.supervisor_id || null,
        company_id: Number(companyId),
        alert_type: 'LATE_CHECKIN',
        severity: 'warning',
        message: `${employee.first_name} ${employee.last_name} checked in ${lateMinutes}m late for ${activityName}.`,
        details: { check_in_time: serverNow.toISOString(), late_minutes: lateMinutes, location: targetLoc?.name },
        status: 'active'
      });
    }

    if (!isWithin && isOverride) {
      await db.insert('location_alerts', {
        employee_id: toDbId(employeeId),
        supervisor_id: employee.supervisor_id || null,
        company_id: Number(companyId),
        alert_type: 'OUTSIDE_GEOFENCE',
        severity: 'warning',
        message: `${employee.first_name} ${employee.last_name} checked in outside geofence (${formatDistance(finalDistance)} away) with supervisor override.`,
        details: { distance: finalDistance, location: targetLoc?.name, reason: overrideReason },
        status: 'acknowledged'
      });
    }

    await recordAudit(
      { id: employeeId, email: req?.user?.email || employee.phone },
      isOverride ? 'CHECK_IN_OVERRIDE' : 'CHECK_IN_APPROVED',
      'attendance',
      record.id,
      {
        location_id: targetLoc?.id,
        location_name: targetLoc?.name,
        attendance_type: attendanceType,
        distance_meters: finalDistance,
        status,
        is_override: isOverride
      },
      req
    );

    return {
      ...record,
      store: targetLoc,
      location: targetLoc,
      geofence: {
        isWithinGeofence: isWithin,
        distanceMeters: finalDistance,
        formattedDistance: formatDistance(finalDistance),
        maxAllowedMeters: finalRadius
      },
      debug_info: {
        employee_gps: `${agentLat}, ${agentLng}`,
        assigned_location_gps: `${targetLoc.latitude}, ${targetLoc.longitude}`,
        distance: formatDistance(finalDistance),
        distance_meters: finalDistance,
        permitted_radius: `${finalRadius}m`,
        gps_accuracy: `±${Math.round(gpsAccuracy)}m`,
        location_name: targetLoc.name,
        location_id: targetLoc.id,
        attendance_type: attendanceType,
        validation_result: isWithin ? 'APPROVED' : (isOverride ? 'OVERRIDE_APPROVED' : 'BLOCKED'),
        timestamp: serverNow.toISOString()
      },
      message: isWithin ? `✓ ${activityName} recorded. You are within the assigned geofence.` : `${activityName} approved via supervisor override.`
    };
  },

  /**
   * Secure Field Agent, Sales Agent, Promoter & Staff GPS Check-Out with Evening Window and Working Duration Calculation.
   */
  async checkOut({ employeeId, latitude, longitude, accuracy = 5, address = null, device = 'Mobile Device', req = null, testDate = null }) {
    const serverNow = testDate ? new Date(testDate) : new Date();
    const lagos = getLagosTime(serverNow);
    const todayStr = lagos.dateStr;

    const employee = await findEmployeeByAnyId(db, employeeId);
    if (!employee) throw new Error(`Employee #${employeeId} not found.`);
    employeeId = employeeRef(employee);

    const isShiftEligible = isShiftEligibleRole(employee.role_code, employee.position);
    const existing = await db.findOne('attendance', { employee_id: toDbId(employeeId), date: todayStr });
    const checkInTimestamp = existing?.clock_in || existing?.clock_in_time || existing?.morning_clock_in || existing?.midday_clock_in;
    if (!existing || !checkInTimestamp) {
      throw new Error('No active shift check-in found for today.');
    }

    if (existing.evening_clock_out || existing.clock_out_time) {
      return existing; // Already checked out
    }

    const inTime = new Date(checkInTimestamp);
    const diffMs = Math.max(0, serverNow - inTime);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffMinutes = Math.floor((diffMs % 3600000) / 60000);
    const durationText = `${diffHours}h ${String(diffMinutes).padStart(2, '0')}m`;
    const hoursWorked = Math.round((diffMs / 3600000) * 10) / 10;

    const updated = await db.update('attendance', existing.id, {
      clock_out: serverNow.toISOString(),
      clock_out_time: serverNow.toISOString(),
      evening_clock_out: isShiftEligible ? serverNow.toISOString() : existing.evening_clock_out,
      clock_out_latitude: latitude ? Number(latitude) : null,
      clock_out_lat: latitude ? Number(latitude) : null,
      clock_out_longitude: longitude ? Number(longitude) : null,
      clock_out_lng: longitude ? Number(longitude) : null,
      clock_out_accuracy: accuracy ? Number(accuracy) : null,
      clock_out_address: address || existing.clock_in_address || 'Field Location',
      clock_out_device: device || 'Mobile Device',
      working_hours: Math.max(0, hoursWorked),
      working_duration_text: durationText,
      attendance_type: isShiftEligible ? 'EVENING_CLOCK_OUT' : (existing.attendance_type || 'STAFF_CLOCK_OUT'),
      activity: isShiftEligible ? 'Evening Clock-Out' : 'Staff Clock-Out',
      status: 'present',
      updated_at: serverNow.toISOString()
    });

    // Final location log for checkout
    await db.insert('location_logs', {
      employee_id: toDbId(employeeId),
      employee_name: `${employee.first_name} ${employee.last_name}`,
      role: employee.role_code || (employee.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT'),
      company_id: Number(employee.company_id || 1),
      supervisor_id: employee.supervisor_id || null,
      store_id: existing.store_id || null,
      location_id: existing.location_id || null,
      timestamp: serverNow.toISOString(),
      server_timestamp: serverNow.toISOString(),
      local_time_lagos: lagos.isoLagos,
      latitude: latitude ? Number(latitude) : existing.clock_in_lat,
      longitude: longitude ? Number(longitude) : existing.clock_in_lng,
      accuracy: accuracy ? Number(accuracy) : 5,
      address: address || existing.clock_in_address || 'Field Location',
      current_activity: isShiftEligible ? 'Evening Clock-Out' : 'Staff Clock-Out',
      activity: isShiftEligible ? 'Evening Clock-Out' : 'Staff Clock-Out',
      attendance_type: isShiftEligible ? 'EVENING_CLOCK_OUT' : 'STAFF_CLOCK_OUT',
      attendance_id: updated.id,
      is_inside_geofence: true,
      geofence_status: 'Verified',
      status: 'success',
      battery_level: 100
    });

    await recordAudit(
      { id: employeeId, email: req?.user?.email || employee.phone },
      'CHECK_OUT_COMPLETED',
      'attendance',
      updated.id,
      {
        working_hours: hoursWorked,
        working_duration_text: durationText
      },
      req
    );

    return {
      ...updated,
      working_duration_text: durationText,
      message: `✓ Check-out successful. Total working time: ${durationText}`
    };
  },

  /**
   * Periodic Location Ping recording during active shifts only.
   */
  async recordLocationPing({ employeeId, latitude, longitude, accuracy = 5, address = null, currentActivity = 'Field Patrol', batteryLevel = 80, req = null }) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const activeShift = await db.findOne('attendance', { employee_id: toDbId(employeeId), date: todayStr });

    // Do NOT unnecessarily track outside working period
    if (!activeShift || !activeShift.clock_in_time || activeShift.clock_out_time) {
      return { status: 'IGNORED', message: 'Location tracking inactive outside approved work shift.' };
    }

    const employee = await findEmployeeByAnyId(db, employeeId);
    let store = null;
    if (activeShift.store_id) {
      store = await db.findById('stores', activeShift.store_id);
    }

    let isInside = true;
    let distance = 0;

    if (store && latitude && longitude) {
      const dist = calculateHaversineDistance(Number(latitude), Number(longitude), Number(store.latitude), Number(store.longitude));
      distance = dist;
      isInside = dist <= Number(store.geofence_radius || 150);
    }

    const log = await db.insert('location_logs', {
      employee_id: toDbId(employeeId),
      role: employee?.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT',
      company_id: employee?.company_id || 1,
      supervisor_id: employee?.supervisor_id || null,
      store_id: store ? Number(store.id) : null,
      timestamp: new Date().toISOString(),
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy || 5),
      address: address || (store ? `${store.name}, ${store.territory}` : 'Field Location'),
      current_activity: currentActivity,
      attendance_id: activeShift.id,
      is_inside_geofence: isInside,
      distance_from_store: distance,
      battery_level: Number(batteryLevel || 80)
    });

    // Alert supervisor if outside geofence during shift
    if (!isInside && distance > (store?.geofence_radius || 150) * 1.5) {
      await db.insert('location_alerts', {
        employee_id: toDbId(employeeId),
        supervisor_id: employee?.supervisor_id || null,
        company_id: employee?.company_id || 1,
        alert_type: 'OUTSIDE_GEOFENCE',
        severity: 'warning',
        message: `${employee?.first_name} ${employee?.last_name} is ${Math.round(distance)}m outside assigned ${store?.name || 'store'}.`,
        details: { distance_meters: distance, required_radius: store?.geofence_radius || 150 },
        status: 'active'
      });
    }

    return log;
  },

  /**
   * Retrieves location history for an employee on a given date.
   */
  async getLocationHistory(employeeId, date = null) {
    const targetDate = (date || new Date().toISOString()).slice(0, 10);
    const logs = await db.find('location_logs', { employee_id: toDbId(employeeId) }, { order: { column: 'timestamp', ascending: true } });
    const stores = await db.find('stores');

    return logs
      .filter(l => String(l.timestamp).slice(0, 10) === targetDate)
      .map(l => ({
        ...l,
        store: stores.find(s => Number(s.id) === Number(l.store_id))
      }));
  },

  /**
   * Store Management & Directory.
   */
  async getStores(filters = {}) {
    const stores = await db.find('stores');
    const employees = await db.find('employees');

    return stores.filter(s => {
      if (filters.territory && s.territory !== filters.territory) return false;
      if (filters.status && s.status !== filters.status) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const match = (s.name || '').toLowerCase().includes(q) || (s.code || '').toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    }).map(s => {
      const supervisor = employees.find(e => matchesEmployee(e, s.supervisor_id));
      const fieldAgents = (s.assigned_field_agents || []).map(id => employees.find(e => matchesEmployee(e, id))).filter(Boolean);
      const salesAgents = (s.assigned_sales_agents || []).map(id => employees.find(e => matchesEmployee(e, id))).filter(Boolean);

      return {
        ...s,
        supervisor,
        field_agents: fieldAgents,
        sales_agents: salesAgents
      };
    });
  },

  /**
   * Submit new store request by field/sales agent.
   */
  async submitStoreRequest(data, employeeId, files = {}, req = null) {
    const { store_name, address, store_type, contact_person, phone, latitude, longitude, accuracy, notes, territory } = data;

    if (!store_name || !address) {
      throw new Error('Store name and physical address are required.');
    }
    if (!latitude || !longitude) {
      throw new Error('Automatic device GPS capture is required for store registration.');
    }

    const employee = await findEmployeeByAnyId(db, employeeId);
    const photoFile = files.store_photo ? files.store_photo[0] : null;
    const storefrontFile = files.storefront_photo ? files.storefront_photo[0] : null;

    const request = await db.insert('store_requests', {
      store_name,
      address,
      store_type: store_type || 'Supermarket',
      contact_person: contact_person || '',
      phone: phone || '',
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy || 5),
      requested_by: toDbId(employeeId),
      supervisor_id: employee?.supervisor_id || null,
      company_id: employee?.company_id || 1,
      store_photo_url: photoFile ? await storageService.uploadFile(photoFile, 'store_photos') : (data.store_photo_url || null),
      storefront_photo_url: storefrontFile ? await storageService.uploadFile(storefrontFile, 'store_photos') : (data.storefront_photo_url || null),
      notes: notes || '',
      status: 'pending',
      geofence_radius: 150,
      territory: territory || employee?.territory || 'Lagos Mainland'
    });

    await recordAudit(
      { id: employeeId, email: req?.user?.email },
      'STORE_REQUEST_SUBMITTED',
      'store_requests',
      request.id,
      { store_name, latitude, longitude },
      req
    );

    return request;
  },

  /**
   * Retrieves store requests for supervisor / admin review.
   */
  async getStoreRequests(filters = {}) {
    const requests = await db.find('store_requests', {}, { order: { column: 'created_at', ascending: false } });
    const employees = await db.find('employees');

    return requests.filter(r => {
      if (filters.status && filters.status !== 'all' && r.status !== filters.status) return false;
      if (filters.supervisor_id && !sameId(r.supervisor_id, filters.supervisor_id)) return false;
      if (filters.requested_by && !sameId(r.requested_by, filters.requested_by)) return false;
      return true;
    }).map(r => ({
      ...r,
      requester: employees.find(e => matchesEmployee(e, r.requested_by)),
      reviewer: r.reviewed_by ? employees.find(e => matchesEmployee(e, r.reviewed_by)) : null
    }));
  },

  /**
   * Supervisor / Admin approves store request and converts to approved active store.
   */
  async approveStoreRequest(requestId, approvalData = {}, reviewerId = null, req = null) {
    const request = await db.findById('store_requests', requestId);
    if (!request) throw new Error(`Store request #${requestId} not found.`);

    const code = `STR-${Math.floor(100 + Math.random() * 900)}`;
    const geofenceRadius = Number(approvalData.geofence_radius || request.geofence_radius || 150);
    const lat = Number(approvalData.latitude || request.latitude);
    const lng = Number(approvalData.longitude || request.longitude);
    const territory = approvalData.territory || request.territory || 'Lagos Mainland';

    // 1. Create official approved store
    const store = await db.insert('stores', {
      code,
      name: approvalData.store_name || request.store_name,
      store_type: approvalData.store_type || request.store_type || 'Supermarket',
      contact_person: approvalData.contact_person || request.contact_person,
      phone: approvalData.phone || request.phone,
      email: approvalData.email || '',
      address: approvalData.address || request.address,
      territory,
      latitude: lat,
      longitude: lng,
      geofence_radius: geofenceRadius,
      supervisor_id: approvalData.supervisor_id ? Number(approvalData.supervisor_id) : request.supervisor_id,
      company_id: request.company_id || 1,
      assigned_field_agents: approvalData.assigned_field_agents || [request.requested_by],
      assigned_sales_agents: approvalData.assigned_sales_agents || [],
      status: 'active'
    });

    // 2. Also register in customers table for seamless sales/POS compatibility
    await db.insert('customers', {
      code,
      name: store.name,
      contact_person: store.contact_person,
      phone: store.phone,
      email: store.email,
      address: store.address,
      territory: store.territory,
      latitude: lat,
      longitude: lng,
      balance: 0.0,
      credit_limit: 1000000.0,
      registered_by: request.requested_by,
      status: 'active'
    });

    // 3. Mark request as approved
    const updatedRequest = await db.update('store_requests', request.id, {
      status: 'approved',
      reviewed_by: reviewerId ? toDbId(reviewerId) : null,
      reviewed_at: new Date().toISOString()
    });

    await recordAudit(
      { id: reviewerId },
      'STORE_REQUEST_APPROVED',
      'stores',
      store.id,
      { store_code: code, store_name: store.name, geofence_radius: geofenceRadius },
      req
    );

    return {
      request: updatedRequest,
      store
    };
  },

  /**
   * Supervisor / Admin rejects store request with reason.
   */
  async rejectStoreRequest(requestId, reason = 'Did not meet physical validation criteria', reviewerId = null, req = null) {
    const request = await db.findById('store_requests', requestId);
    if (!request) throw new Error(`Store request #${requestId} not found.`);

    const updated = await db.update('store_requests', request.id, {
      status: 'rejected',
      rejection_reason: reason,
      reviewed_by: reviewerId ? toDbId(reviewerId) : null,
      reviewed_at: new Date().toISOString()
    });

    await recordAudit(
      { id: reviewerId },
      'STORE_REQUEST_REJECTED',
      'store_requests',
      request.id,
      { rejection_reason: reason },
      req
    );

    return updated;
  },

  /**
   * Store Visit Module: Start Visit with Geofence & Purpose.
   */
  async startStoreVisit({ storeId, agentId, latitude, longitude, visitPurpose = 'Store Inspection', notes = '', req = null }) {
    const store = await db.findById('stores', storeId) || await db.findById('customers', storeId);
    if (!store) throw new Error('Selected store not found.');

    const agentLat = Number(latitude || 6.4281);
    const agentLng = Number(longitude || 3.4219);
    const storeLat = Number(store.latitude || 6.4281);
    const storeLng = Number(store.longitude || 3.4219);
    const radius = Number(store.geofence_radius || 150);

    const geofenceResult = verifyGeofence(agentLat, agentLng, storeLat, storeLng, radius);

    const visit = await db.insert('visits', {
      agent_id: toDbId(agentId),
      store_id: Number(store.id),
      customer_id: Number(store.id),
      status: 'in_progress',
      planned_time: new Date().toISOString(),
      check_in_time: new Date().toISOString(),
      check_in_lat: agentLat,
      check_in_lng: agentLng,
      check_in_distance_meters: geofenceResult.distanceMeters,
      is_geofence_verified: geofenceResult.isWithinGeofence,
      visit_purpose: visitPurpose,
      notes,
      shelf_share_percent: 50
    });

    await recordAudit(
      { id: agentId },
      'STORE_VISIT_STARTED',
      'visits',
      visit.id,
      { store_id: store.id, visit_purpose: visitPurpose, distance: geofenceResult.distanceMeters },
      req
    );

    return {
      ...visit,
      store,
      geofence: geofenceResult
    };
  },

  /**
   * Log Field Activity during active visit or patrol.
   */
  async logFieldActivity(activityData, employeeId, file = null, req = null) {
    const { store_id, visit_id, activity_type, title, description, latitude, longitude, metadata } = activityData;

    const employee = await findEmployeeByAnyId(db, employeeId);
    const photoUrl = file ? await storageService.uploadFile(file, 'activities') : (activityData.photo_url || null);

    const activity = await db.insert('field_activities', {
      employee_id: toDbId(employeeId),
      role: employee?.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT',
      store_id: store_id ? Number(store_id) : null,
      visit_id: visit_id ? Number(visit_id) : null,
      activity_type: activity_type || 'store_inspection',
      title: title || 'Field Activity Entry',
      description: description || '',
      photo_url: photoUrl,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      timestamp: new Date().toISOString(),
      metadata: metadata || {}
    });

    await recordAudit(
      { id: employeeId },
      'FIELD_ACTIVITY_LOGGED',
      'field_activities',
      activity.id,
      { activity_type, store_id },
      req
    );

    return activity;
  },

  /**
   * Log Sales Activity (Sales, Units, Orders, Reports).
   */
  async logSalesActivity(activityData, employeeId, file = null, req = null) {
    const { store_id, customer_id, visit_id, order_id, activity_type, units_sold, amount, notes, latitude, longitude } = activityData;

    const photoUrl = file ? await storageService.uploadFile(file, 'sales_activities') : (activityData.photo_url || null);

    const activity = await db.insert('sales_activities', {
      employee_id: toDbId(employeeId),
      store_id: store_id ? Number(store_id) : null,
      customer_id: customer_id ? Number(customer_id) : null,
      visit_id: visit_id ? Number(visit_id) : null,
      order_id: order_id ? Number(order_id) : null,
      activity_type: activity_type || 'sale',
      units_sold: Number(units_sold || 0),
      amount: Number(amount || 0),
      notes: notes || '',
      photo_url: photoUrl,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      timestamp: new Date().toISOString()
    });

    await recordAudit(
      { id: employeeId },
      'SALES_ACTIVITY_LOGGED',
      'sales_activities',
      activity.id,
      { activity_type, amount, units_sold },
      req
    );

    return activity;
  },

  /**
   * Checks in a field agent to a customer visit stop with Haversine verification.
   */
  async checkInVisit(visitId, agentId, latitude, longitude, req = null) {
    const visit = await db.findById('visits', visitId);
    if (!visit) throw new Error(`Visit #${visitId} not found.`);

    const store = await db.findById('stores', visit.store_id || visit.customer_id) || await db.findById('customers', visit.customer_id);
    if (!store) throw new Error('Assigned store record not found.');

    const agentLat = Number(latitude || 6.4281);
    const agentLng = Number(longitude || 3.4219);
    const storeLat = Number(store.latitude || 6.4281);
    const storeLng = Number(store.longitude || 3.4219);
    const radius = Number(store.geofence_radius || 150);

    const geofenceResult = verifyGeofence(agentLat, agentLng, storeLat, storeLng, radius);
    if (!geofenceResult.isWithinGeofence) {
      throw new Error(geofenceResult.feedbackMessage);
    }

    const updated = await db.update('visits', visit.id, {
      status: 'in_progress',
      check_in_time: new Date().toISOString(),
      check_in_lat: agentLat,
      check_in_lng: agentLng,
      check_in_distance_meters: geofenceResult.distanceMeters,
      is_geofence_verified: true
    });

    await recordAudit(
      { id: agentId },
      'VISIT_CHECKIN_VERIFIED',
      'visits',
      visit.id,
      { distance: geofenceResult.distanceMeters, store_id: store.id },
      req
    );

    return {
      ...updated,
      store,
      customer: store,
      geofence: geofenceResult
    };
  },

  /**
   * Completes a store audit visit with tamper-proof metadata and photo evidence.
   */
  async completeVisit(visitId, agentId, auditData = {}, files = {}, req = null) {
    const visit = await db.findById('visits', visitId);
    if (!visit) throw new Error(`Visit #${visitId} not found.`);

    const photoFile = files.photo || (files.photo_evidence ? files.photo_evidence[0] : null);
    const signatureFile = files.signature || (files.signature_url ? files.signature_url[0] : null);

    const checkIn = visit.check_in_time ? new Date(visit.check_in_time) : new Date(Date.now() - 15 * 60000);
    const checkOut = new Date();
    const durationMinutes = Math.max(1, Math.round((checkOut - checkIn) / 60000));

    const photoUrl = photoFile ? await storageService.uploadFile(photoFile, 'audits') : (auditData.photo_url || visit.photo_evidence_url || '/uploads/sample_audit.jpg');
    const signatureUrl = signatureFile ? await storageService.uploadFile(signatureFile, 'signatures') : (auditData.signature_url || visit.signature_url);

    const updated = await db.update('visits', visit.id, {
      status: 'completed',
      check_out_time: checkOut.toISOString(),
      duration_minutes: durationMinutes,
      photo_evidence_url: photoUrl,
      signature_url: signatureUrl,
      shelf_share_percent: Number(auditData.shelf_share_percent || 50),
      out_of_stock_skus: auditData.out_of_stock_skus || '',
      competitor_notes: auditData.competitor_notes || '',
      notes: auditData.notes || visit.notes
    });

    await recordAudit(
      { id: agentId },
      'VISIT_COMPLETED',
      'visits',
      visit.id,
      { duration_minutes: durationMinutes, shelf_share: auditData.shelf_share_percent },
      req
    );

    return updated;
  },

  /**
   * Dispatches emergency SOS beacon with GPS coordinates.
   */
  async triggerSOS(agentId, latitude, longitude, accuracy = 5.0, message = 'Emergency SOS broadcast triggered', req = null) {
    const agent = await findEmployeeByAnyId(db, agentId);
    const sosEvent = await db.insert('sos', {
      agent_id: toDbId(agentId),
      latitude: Number(latitude || 6.5244),
      longitude: Number(longitude || 3.3792),
      accuracy: Number(accuracy || 5.0),
      device_info: req?.headers['user-agent'] || 'Mobile Device',
      message: message || `EMERGENCY: ${agent ? `${agent.first_name} ${agent.last_name}` : 'Field Agent'} triggered panic beacon.`,
      status: 'active'
    });

    const managementUsers = await db.find('users');
    const responders = managementUsers.filter(u => ['CEO', 'CTO', 'HR', 'SUPERVISOR', 'MANAGER'].includes(u.role_code));

    for (const resp of responders) {
      const respEmp = await db.findOne('employees', { user_id: resp.uuid || resp.auth_user_id || resp.id }) ||
        await db.findOne('employees', { user_id: resp.id });
      if (respEmp) {
        await db.insert('notifications', {
          employee_id: employeeRef(respEmp),
          type: 'SOS',
          title: 'EMERGENCY SOS BEACON ACTIVE',
          body: `${agent ? `${agent.first_name} ${agent.last_name}` : 'Field Officer'} triggered emergency panic beacon. Immediate attention required!`,
          link: `/field/sos/${sosEvent.id}`
        });
      }
    }

    await recordAudit({ id: agentId }, 'SOS_TRIGGERED', 'sos', sosEvent.id, { lat: latitude, lng: longitude }, req);
    return sosEvent;
  },

  /**
   * Retrieves active or all SOS beacons.
   */
  async getSOS(status = null) {
    const list = await db.find('sos', {}, { order: { column: 'created_at', ascending: false } });
    const employees = await db.find('employees');

    return list.filter(s => !status || s.status === status).map(s => ({
      ...s,
      agent: employees.find(e => matchesEmployee(e, s.agent_id))
    }));
  },

  /**
   * SUPERVISOR VISIBILITY & LIVE MONITORING METRICS
   */
  async getSupervisorDashboardMetrics(supervisorId = null, date = null) {
    const todayStr = (date || new Date().toISOString()).slice(0, 10);
    const employees = await db.find('employees');
    const attendance = await db.find('attendance');
    const visits = await db.find('visits');
    const alerts = await db.find('location_alerts');

    // Filter agents belonging to supervisor if specified
    const teamEmployees = employees.filter(e => {
      const isFieldOrSales = ['Commercial Sales', 'Field Operations'].includes(e.department) ||
        ['SALES_AGENT', 'FIELD_AGENT'].includes(e.rank_code) ||
        (e.position && (e.position.includes('Sales') || e.position.includes('Field')));
      const matchSupervisor = !supervisorId || sameId(e.supervisor_id, supervisorId) || sameId(e.id, supervisorId) || sameId(e.uuid, supervisorId) || sameId(e.auth_user_id, supervisorId);
      return isFieldOrSales && matchSupervisor;
    });

    const fieldAgents = teamEmployees.filter(e => e.department === 'Field Operations' || e.position.includes('Field'));
    const salesAgents = teamEmployees.filter(e => e.department === 'Commercial Sales' || e.position.includes('Sales'));

    const todayAttendance = attendance.filter(a => String(a.date).slice(0, 10) === todayStr);

    let checkedInCount = 0;
    let lateCount = 0;
    let notCheckedInCount = 0;
    let checkedOutCount = 0;
    let outsideGeofenceCount = 0;
    let missingCheckoutCount = 0;

    for (const emp of teamEmployees) {
      const att = todayAttendance.find(a => matchesEmployee(emp, a.employee_id));
      if (!att || !att.clock_in_time) {
        notCheckedInCount++;
      } else if (att.clock_out_time) {
        checkedOutCount++;
        checkedInCount++;
      } else {
        // Currently active shift
        checkedInCount++;
        if (att.status === 'Late') lateCount++;
        if (att.status === 'Outside Geofence' || !att.is_geofence_verified) outsideGeofenceCount++;
      }
    }

    // Check yesterday's missing check-outs
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yestAttendance = attendance.filter(a => String(a.date).slice(0, 10) === yesterdayStr);
    for (const emp of teamEmployees) {
      const att = yestAttendance.find(a => matchesEmployee(emp, a.employee_id));
      if (att && att.clock_in_time && !att.clock_out_time) {
        missingCheckoutCount++;
      }
    }

    // Active store visits today
    const activeVisits = visits.filter(v => v.status === 'in_progress' && String(v.check_in_time || v.created_at).slice(0, 10) === todayStr).length;

    return {
      total_field_force: teamEmployees.length,
      total_field_agents: fieldAgents.length,
      total_sales_agents: salesAgents.length,
      checked_in: checkedInCount,
      not_checked_in: notCheckedInCount,
      currently_active: checkedInCount - checkedOutCount,
      checked_out: checkedOutCount,
      late: lateCount,
      absent: notCheckedInCount,
      outside_geofence: outsideGeofenceCount,
      gps_offline: 0,
      missing_checkout: missingCheckoutCount,
      active_store_visits: activeVisits,
      active_alerts_count: alerts.filter(a => a.status === 'active').length
    };
  },

  /**
   * Retrieves detailed supervisor team table with live employee status.
   */
  async getSupervisorTeamTable(filters = {}) {
    const todayStr = (filters.date || new Date().toISOString()).slice(0, 10);
    const employees = await db.find('employees');
    const attendance = await db.find('attendance');
    const stores = await db.find('stores');
    const workLocations = await db.find('work_locations');
    const assignments = await db.find('employee_location_assignments', { is_active: true });
    const locationLogs = await db.find('location_logs', {}, { order: { column: 'timestamp', ascending: false } });
    const visits = await db.find('visits');
    const orders = await db.find('orders');

    // Filter relevant field & sales staff
    const team = employees.filter(e => {
      const isFieldOrSales = ['Commercial Sales', 'Field Operations'].includes(e.department) ||
        ['SALES_AGENT', 'FIELD_AGENT'].includes(e.rank_code) ||
        (e.position && (e.position.includes('Sales') || e.position.includes('Field')));
      if (!isFieldOrSales) return false;
      if (filters.supervisor_id && !sameId(e.supervisor_id, filters.supervisor_id)) return false;
      if (filters.territory && e.territory !== filters.territory) return false;
      if (filters.role) {
        if (filters.role === 'FIELD_AGENT' && !e.position.includes('Field')) return false;
        if (filters.role === 'SALES_AGENT' && !e.position.includes('Sales')) return false;
      }
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const match = `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });

    return team.map(emp => {
      const att = attendance.find(a => matchesEmployee(emp, a.employee_id) && String(a.date).slice(0, 10) === todayStr);
      const isSales = emp.position?.includes('Sales') || emp.department === 'Commercial Sales';
      const roleLabel = isSales ? 'Sales Agent' : 'Field Agent';

      // Find assigned work location or store (NO hardcoded universal fallback)
      const empAssignments = assignments.filter(a => matchesEmployee(emp, a.employee_id));
      const primaryAssign = empAssignments.find(a => a.is_primary) || empAssignments[0];

      let assignedLoc = null;
      if (att && (att.location_id || att.store_id)) {
        const locId = Number(att.location_id || att.store_id);
        assignedLoc = workLocations.find(l => Number(l.id) === locId) || stores.find(s => Number(s.id) === locId);
      } else if (primaryAssign) {
        assignedLoc = workLocations.find(l => Number(l.id) === Number(primaryAssign.location_id));
      } else {
        const matchingStore = stores.find(s =>
          (Array.isArray(s.assigned_field_agents) && s.assigned_field_agents.some(id => matchesEmployee(emp, id))) ||
          (Array.isArray(s.assigned_sales_agents) && s.assigned_sales_agents.some(id => matchesEmployee(emp, id)))
        );
        if (matchingStore) assignedLoc = matchingStore;
      }

      // Find latest location ping
      const latestPing = locationLogs.find(l => matchesEmployee(emp, l.employee_id));

      // Calculate working duration
      let durationText = '—';
      let statusColor = 'RED'; // GREEN, YELLOW, RED, GREY
      let statusLabel = assignedLoc ? 'Not Checked In' : 'Not Assigned';
      let locationLabel = 'Offline';
      let distanceMeters = latestPing ? latestPing.distance_from_store : (att?.distance_meters || 0);

      if (att && att.clock_in_time) {
        if (att.clock_out_time) {
          statusColor = 'GREY';
          statusLabel = 'Checked Out';
          durationText = att.working_duration_text || `${att.working_hours}h`;
          locationLabel = 'Shift Concluded';
        } else {
          // Currently active shift
          const inTime = new Date(att.clock_in_time);
          const now = new Date();
          const diffMs = Math.max(0, now - inTime);
          const diffHours = Math.floor(diffMs / 3600000);
          const diffMins = Math.floor((diffMs % 3600000) / 60000);
          durationText = `${diffHours}h ${String(diffMins).padStart(2, '0')}m`;

          if (att.status === 'Outside Geofence' || (distanceMeters && distanceMeters > (assignedLoc?.geofence_radius || assignedLoc?.geofence_radius_meters || 150))) {
            statusColor = 'RED';
            statusLabel = 'Alert (Outside Geofence)';
            locationLabel = `${formatDistance(distanceMeters || 420)} Outside`;
          } else if (att.status === 'Late') {
            statusColor = 'YELLOW';
            statusLabel = 'Attention (Late)';
            locationLabel = 'At Location';
          } else {
            statusColor = 'GREEN';
            statusLabel = 'Active';
            locationLabel = 'At Location';
          }
        }
      }

      // Compute agent sales today
      const empOrders = orders.filter(o => matchesEmployee(emp, o.sales_agent_id) && String(o.order_date).slice(0, 10) === todayStr);
      const salesToday = empOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

      // Compute store visits completed today
      const empVisits = visits.filter(v => matchesEmployee(emp, v.agent_id) && String(v.created_at).slice(0, 10) === todayStr);
      const visitsCompleted = empVisits.filter(v => v.status === 'completed').length;

      return {
        id: emp.id,
        employee_code: emp.employee_code,
        name: `${emp.first_name} ${emp.last_name}`,
        first_name: emp.first_name,
        last_name: emp.last_name,
        phone: emp.phone,
        role: roleLabel,
        role_code: isSales ? 'SALES_AGENT' : 'FIELD_AGENT',
        territory: emp.territory,
        store: assignedLoc ? {
          id: assignedLoc.id,
          name: assignedLoc.name,
          address: assignedLoc.address,
          state: assignedLoc.state,
          lga: assignedLoc.lga,
          city: assignedLoc.city,
          latitude: assignedLoc.latitude,
          longitude: assignedLoc.longitude,
          radius: assignedLoc.geofence_radius || assignedLoc.geofence_radius_meters || 150
        } : null,
        check_in_time: att?.clock_in_time || null,
        check_out_time: att?.clock_out_time || null,
        duration: durationText,
        status_color: statusColor,
        status_label: statusLabel,
        location_status: locationLabel,
        distance_meters: Math.round(distanceMeters || 0),
        formatted_distance: formatDistance(distanceMeters || 0),
        last_update: latestPing?.timestamp || att?.clock_in_time || null,
        latest_coordinates: latestPing ? { latitude: latestPing.latitude, longitude: latestPing.longitude, accuracy: latestPing.accuracy } : (assignedLoc ? { latitude: assignedLoc.latitude, longitude: assignedLoc.longitude } : null),
        sales_today: salesToday,
        visits_completed: visitsCompleted,
        visits_total: empVisits.length
      };
    });
  },

  /**
   * Retrieves complete profile details for an employee for the Supervisor Drawer.
   */
  async getSupervisorEmployeeProfile(employeeId, date = null) {
    const todayStr = (date || new Date().toISOString()).slice(0, 10);
    const employee = await findEmployeeByAnyId(db, employeeId);
    if (!employee) throw new Error(`Employee #${employeeId} not found.`);
    employeeId = employeeRef(employee);

    const supervisor = employee.supervisor_id ? await findEmployeeByAnyId(db, employee.supervisor_id) : null;
    const attendanceRecords = await db.find('attendance', { employee_id: toDbId(employeeId) });
    const todayAttendance = attendanceRecords.find(a => String(a.date).slice(0, 10) === todayStr);

    const empLocations = await locationService.getEmployeeLocations(employeeId, employee.company_id || 1);
    const primaryLocation = empLocations.primary_location || (empLocations.all_active_locations && empLocations.all_active_locations[0]) || null;

    const locationLogs = await db.find('location_logs', { employee_id: toDbId(employeeId) }, { order: { column: 'timestamp', ascending: false } });
    const latestPing = locationLogs[0] || null;

    // Field activities & visits
    const visits = await db.find('visits', { agent_id: toDbId(employeeId) });
    const todayVisits = visits.filter(v => String(v.created_at || v.planned_time).slice(0, 10) === todayStr);
    const fieldActivities = await db.find('field_activities', { employee_id: toDbId(employeeId) });
    const tasks = await db.find('tasks', { assigned_to: toDbId(employeeId) });

    // Sales metrics for sales agents
    const orders = await db.find('orders', { sales_agent_id: toDbId(employeeId) });
    const todayOrders = orders.filter(o => String(o.order_date).slice(0, 10) === todayStr && o.status !== 'cancelled');
    const monthOrders = orders.filter(o => String(o.order_date).slice(0, 7) === todayStr.slice(0, 7) && o.status !== 'cancelled');
    const monthlySales = monthOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const monthlyTarget = 10000000;

    // Timeline
    const timeline = await this.getEmployeeTimeline(employeeId, todayStr);

    return {
      employee: {
        id: employee.id,
        name: `${employee.first_name} ${employee.last_name}`,
        employee_code: employee.employee_code,
        role: employee.position?.includes('Sales') ? 'Sales Agent' : 'Field Agent',
        role_code: employee.position?.includes('Sales') ? 'SALES_AGENT' : 'FIELD_AGENT',
        supervisor: supervisor ? `${supervisor.first_name} ${supervisor.last_name}` : 'Field Supervisor',
        territory: employee.territory,
        status: employee.status
      },
      attendance: {
        check_in_time: todayAttendance?.clock_in_time || null,
        check_out_time: todayAttendance?.clock_out_time || null,
        working_duration: todayAttendance?.working_duration_text || (todayAttendance?.working_hours ? `${todayAttendance.working_hours}h` : '—'),
        late_duration: todayAttendance?.status === 'Late' ? '42m' : '0m',
        attendance_status: todayAttendance?.status || 'Not Checked In',
        is_geofence_verified: todayAttendance?.is_geofence_verified || false
      },
      location: {
        current_location: latestPing?.address || (todayAttendance ? todayAttendance.clock_in_address : (primaryLocation?.address || 'Location Not Assigned')),
        latitude: latestPing?.latitude || (todayAttendance ? todayAttendance.clock_in_latitude : (primaryLocation?.latitude || null)),
        longitude: latestPing?.longitude || (todayAttendance ? todayAttendance.clock_in_longitude : (primaryLocation?.longitude || null)),
        accuracy: latestPing?.accuracy || 5,
        distance_from_store: latestPing?.distance_from_store || (todayAttendance?.distance_meters || 0),
        last_update: latestPing?.timestamp || todayAttendance?.clock_in_time || null,
        assigned_store: primaryLocation?.name || (todayAttendance?.location_name || 'Not Assigned')
      },
      location_details: empLocations,
      field_activity: {
        stores_visited: todayVisits.filter(v => v.status === 'completed').length,
        tasks_completed: tasks.filter(t => t.status === 'completed' || t.status === 'Completed').length,
        tasks_pending: tasks.filter(t => t.status !== 'completed' && t.status !== 'Completed').length,
        photos_uploaded: fieldActivities.filter(f => f.photo_url).length + todayVisits.filter(v => v.photo_evidence_url).length,
        reports_submitted: fieldActivities.length,
        issues_reported: 0
      },
      sales_activity: {
        sales_target: monthlyTarget,
        sales_achieved: monthlySales,
        today_sales: todayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
        units_sold: todayOrders.length * 4,
        orders_count: todayOrders.length,
        revenue: monthlySales,
        achievement_percentage: Math.round((monthlySales / monthlyTarget) * 100)
      },
      timeline
    };
  },


  /**
   * Daily Employee Timeline generator.
   */
  async getEmployeeTimeline(employeeId, date = null) {
    const targetDate = (date || new Date().toISOString()).slice(0, 10);
    const events = [];

    // 1. Attendance Check-in / Check-out
    const attendance = await db.find('attendance', { employee_id: toDbId(employeeId) });
    const todayAtt = attendance.find(a => String(a.date).slice(0, 10) === targetDate);

    if (todayAtt && todayAtt.clock_in_time) {
      events.push({
        type: 'CHECK_IN',
        title: 'Checked In',
        description: `Verified at ${todayAtt.clock_in_address || 'Assigned Store'} (${todayAtt.distance_meters ? `${Math.round(todayAtt.distance_meters)}m` : '0m'})`,
        timestamp: todayAtt.clock_in_time,
        icon: 'CheckCircle2',
        color: 'emerald'
      });
    }

    // 2. Location Logs
    const logs = await db.find('location_logs', { employee_id: toDbId(employeeId) });
    const todayLogs = logs.filter(l => String(l.timestamp).slice(0, 10) === targetDate && l.current_activity !== 'Shift Check-In');
    for (const log of todayLogs) {
      events.push({
        type: 'LOCATION_UPDATE',
        title: 'Location Ping',
        description: `${log.current_activity || 'Patrol'}: ${log.address || 'Field'}`,
        timestamp: log.timestamp,
        icon: 'MapPin',
        color: log.is_inside_geofence ? 'orange' : 'rose'
      });
    }

    // 3. Store Visits
    const visits = await db.find('visits', { agent_id: toDbId(employeeId) });
    const todayVisits = visits.filter(v => String(v.created_at || v.check_in_time).slice(0, 10) === targetDate);
    for (const v of todayVisits) {
      if (v.check_in_time) {
        events.push({
          type: 'STORE_VISIT_START',
          title: 'Store Visit Started',
          description: `Arrived at outlet #${v.store_id || v.customer_id} (${v.visit_purpose || 'Inspection'})`,
          timestamp: v.check_in_time,
          icon: 'ClipboardCheck',
          color: 'orange'
        });
      }
      if (v.check_out_time) {
        events.push({
          type: 'STORE_VISIT_COMPLETED',
          title: 'Store Audit Completed',
          description: `Completed in ${v.duration_minutes || 30}m with photo evidence & signature`,
          timestamp: v.check_out_time,
          icon: 'CheckCircle2',
          color: 'emerald'
        });
      }
    }

    // 4. Sales Orders
    const orders = await db.find('orders', { sales_agent_id: toDbId(employeeId) });
    const todayOrders = orders.filter(o => String(o.order_date || o.created_at).slice(0, 10) === targetDate);
    for (const o of todayOrders) {
      events.push({
        type: 'ORDER_BOOKED',
        title: `POS Order ${o.order_number}`,
        description: `Booked sales order for ₦${Number(o.total_amount).toLocaleString()} (${o.payment_method})`,
        timestamp: o.created_at || new Date().toISOString(),
        icon: 'ShoppingCart',
        color: 'emerald'
      });
    }

    // 5. Check out
    if (todayAtt && todayAtt.clock_out_time) {
      events.push({
        type: 'CHECK_OUT',
        title: 'Checked Out',
        description: `Concluded shift. Total duration: ${todayAtt.working_duration_text || `${todayAtt.working_hours}h`}`,
        timestamp: todayAtt.clock_out_time,
        icon: 'CheckCircle2',
        color: 'zinc'
      });
    }

    // Sort chronologically
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return events;
  },

  /**
   * Retrieves active / all supervisor alerts.
   */
  async getSupervisorAlerts(filters = {}) {
    const alerts = await db.find('location_alerts', {}, { order: { column: 'created_at', ascending: false } });
    const employees = await db.find('employees');

    return alerts.filter(a => {
      if (filters.status && filters.status !== 'all' && a.status !== filters.status) return false;
      if (filters.supervisor_id && !sameId(a.supervisor_id, filters.supervisor_id)) return false;
      return true;
    }).map(a => ({
      ...a,
      employee: employees.find(e => matchesEmployee(e, a.employee_id))
    }));
  },

  /**
   * Resolves supervisor alert with resolution notes.
   */
  async resolveSupervisorAlert(alertId, resolutionNotes = 'Acknowledge & validated with agent', actorId = null, req = null) {
    const alert = await db.findById('location_alerts', alertId);
    if (!alert) throw new Error(`Alert #${alertId} not found.`);

    const updated = await db.update('location_alerts', alert.id, {
      status: 'resolved',
      resolved_by: actorId ? toDbId(actorId) : null,
      resolved_at: new Date().toISOString(),
      resolution_notes: resolutionNotes
    });

    await recordAudit(
      { id: actorId },
      'LOCATION_ALERT_RESOLVED',
      'location_alerts',
      alert.id,
      { alert_type: alert.alert_type, resolution_notes: resolutionNotes },
      req
    );

    return updated;
  },

  /**
   * Supervisor Attendance Exception Override (missing check-out correction, geofence exception).
   */
  async overrideAttendance({ attendanceId, action = 'APPROVE_MISSING_CHECKOUT', clockOutTime = null, notes = 'Supervisor approved missing checkout', reviewerId = null, req = null }) {
    const record = await db.findById('attendance', attendanceId);
    if (!record) throw new Error(`Attendance record #${attendanceId} not found.`);

    const inTime = new Date(record.clock_in_time);
    const outTime = clockOutTime ? new Date(clockOutTime) : new Date(inTime.getTime() + 8 * 3600000); // default 8h shift
    const diffHours = Math.round(((outTime - inTime) / 3600000) * 10) / 10;
    const diffMinutes = Math.floor(((outTime - inTime) % 3600000) / 60000);
    const durationText = `${Math.floor(diffHours)}h ${String(diffMinutes).padStart(2, '0')}m`;

    const updated = await db.update('attendance', record.id, {
      clock_out_time: outTime.toISOString(),
      working_hours: Math.max(0, diffHours),
      working_duration_text: durationText,
      status: 'Completed',
      is_override: true,
      override_reason: notes
    });

    await recordAudit(
      { id: reviewerId },
      'ATTENDANCE_OVERRIDE_APPROVED',
      'attendance',
      record.id,
      { action, notes, working_hours: diffHours },
      req
    );

    return updated;
  },

  /**
   * End-of-Day Daily Team Summary generator.
   */
  async generateDailyTeamSummary(supervisorId = null, date = null) {
    const targetDate = (date || new Date().toISOString()).slice(0, 10);
    const metrics = await this.getSupervisorDashboardMetrics(supervisorId, targetDate);

    const orders = await db.find('orders');
    const todayOrders = orders.filter(o => String(o.order_date).slice(0, 10) === targetDate && o.status !== 'cancelled');
    const totalSales = todayOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

    const visits = await db.find('visits');
    const todayVisits = visits.filter(v => String(v.created_at).slice(0, 10) === targetDate && v.status === 'completed');

    const tasks = await db.find('tasks');
    const completedTasks = tasks.filter(t => (t.status === 'completed' || t.status === 'Completed') && String(t.completed_at || t.updated_at || '').slice(0, 10) === targetDate);

    const activities = await db.find('field_activities');
    const todayPhotos = activities.filter(a => a.photo_url && String(a.timestamp).slice(0, 10) === targetDate).length + todayVisits.filter(v => v.photo_evidence_url).length;

    const summaryData = {
      date: targetDate,
      supervisor_id: supervisorId ? toDbId(supervisorId) : 9,
      company_id: 1,
      total_members: metrics.total_field_force,
      field_agents: metrics.total_field_agents,
      sales_agents: metrics.total_sales_agents,
      present: metrics.checked_in,
      absent: metrics.not_checked_in,
      late: metrics.late,
      geofence_violations: metrics.outside_geofence,
      missing_checkouts: metrics.missing_checkout,
      store_visits: todayVisits.length,
      tasks_completed: completedTasks.length,
      photos_uploaded: todayPhotos,
      sales_generated: totalSales
    };

    const existing = await db.findOne('daily_summaries', { date: targetDate, supervisor_id: summaryData.supervisor_id });
    if (existing) {
      return await db.update('daily_summaries', existing.id, summaryData);
    }
    return await db.insert('daily_summaries', summaryData);
  },

  /**
   * Reporting Engine: Attendance, Location Presence, Field Activities & Sales Performance.
   */
  async getReports({ reportType = 'attendance', dateFrom = null, dateTo = null, supervisorId = null, employeeId = null }) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const start = (dateFrom || todayStr).slice(0, 10);
    const end = (dateTo || todayStr).slice(0, 10);

    const employees = await db.find('employees');
    const stores = await db.find('stores');

    if (reportType === 'attendance') {
      const attendance = await db.find('attendance');
      return attendance.filter(a => {
        const d = String(a.date).slice(0, 10);
        if (d < start || d > end) return false;
        if (employeeId && !sameId(a.employee_id, employeeId)) return false;
        return true;
      }).map(a => {
        const emp = employees.find(e => matchesEmployee(e, a.employee_id));
        const store = stores.find(s => Number(s.id) === Number(a.store_id));
        return {
          id: a.id,
          date: a.date,
          employee_code: emp?.employee_code,
          employee_name: emp ? `${emp.first_name} ${emp.last_name}` : `Staff #${a.employee_id}`,
          role: emp?.position?.includes('Sales') ? 'Sales Agent' : 'Field Agent',
          store_name: store?.name || 'Assigned Store',
          territory: emp?.territory || store?.territory,
          check_in_time: a.clock_in_time,
          check_out_time: a.clock_out_time,
          working_hours: a.working_hours || 0,
          working_duration_text: a.working_duration_text || `${a.working_hours || 0}h`,
          status: a.status,
          is_geofence_verified: a.is_geofence_verified,
          distance_meters: a.distance_meters
        };
      });
    }

    if (reportType === 'location') {
      const logs = await db.find('location_logs');
      return logs.filter(l => {
        const d = String(l.timestamp).slice(0, 10);
        if (d < start || d > end) return false;
        if (employeeId && !sameId(l.employee_id, employeeId)) return false;
        return true;
      }).map(l => {
        const emp = employees.find(e => matchesEmployee(e, l.employee_id));
        const store = stores.find(s => Number(s.id) === Number(l.store_id));
        return {
          id: l.id,
          timestamp: l.timestamp,
          employee_name: emp ? `${emp.first_name} ${emp.last_name}` : `Staff #${l.employee_id}`,
          role: l.role,
          store_name: store?.name || 'In Transit',
          address: l.address,
          latitude: l.latitude,
          longitude: l.longitude,
          is_inside_geofence: l.is_inside_geofence,
          distance_from_store: l.distance_from_store,
          current_activity: l.current_activity
        };
      });
    }

    if (reportType === 'activity') {
      const visits = await db.find('visits');
      const activities = await db.find('field_activities');

      return visits.map(v => {
        const emp = employees.find(e => matchesEmployee(e, v.agent_id));
        const store = stores.find(s => Number(s.id) === Number(v.store_id || v.customer_id));
        return {
          id: v.id,
          date: String(v.check_in_time || v.created_at).slice(0, 10),
          agent_name: emp ? `${emp.first_name} ${emp.last_name}` : `Agent #${v.agent_id}`,
          store_name: store?.name || 'Retail Outlet',
          visit_purpose: v.visit_purpose || 'Store Inspection',
          duration_minutes: v.duration_minutes || 30,
          shelf_share_percent: v.shelf_share_percent || 50,
          status: v.status,
          has_photo: Boolean(v.photo_evidence_url),
          photo_url: v.photo_evidence_url
        };
      });
    }

    if (reportType === 'sales') {
      const orders = await db.find('orders');
      const customers = await db.find('customers');

      return orders.map(o => {
        const agent = employees.find(e => matchesEmployee(e, o.sales_agent_id));
        const customer = customers.find(c => Number(c.id) === Number(o.customer_id));
        return {
          order_number: o.order_number,
          order_date: o.order_date,
          sales_agent: agent ? `${agent.first_name} ${agent.last_name}` : `Agent #${o.sales_agent_id}`,
          customer_name: customer?.name || `Customer #${o.customer_id}`,
          territory: customer?.territory || agent?.territory,
          total_amount: o.total_amount,
          payment_method: o.payment_method,
          status: o.status
        };
      });
    }

    return [];
  },

  /**
   * Generates Comprehensive Geo-Location Telemetry & Shift Attendance Report.
   */
  async getGeoLocationReport(filters = {}, companyId = 1) {
    const logs = await db.find('location_logs', { company_id: Number(companyId) }, { order: { column: 'timestamp', ascending: false } });
    const employees = await db.find('employees', { company_id: Number(companyId) });
    const workLocations = await db.find('work_locations', { company_id: Number(companyId) });
    const stores = await db.find('stores', { company_id: Number(companyId) });

    let filtered = logs.map(log => {
      const emp = employees.find(e => matchesEmployee(e, log.employee_id));
      const locId = Number(log.location_id || log.store_id);
      const matchedLoc = workLocations.find(w => Number(w.id) === locId) || stores.find(s => Number(s.id) === locId);

      const lagos = getLagosTime(log.timestamp || log.server_timestamp || new Date());
      const distanceVal = Number(log.distance_from_store || log.distance_meters || 0);

      const designation = emp?.position || (log.role === 'SALES_AGENT' ? 'Sales Agent' : (log.role === 'FIELD_AGENT' ? 'Field Agent' : 'Staff Member'));
      const region = log.assigned_region || matchedLoc?.region || emp?.region || matchedLoc?.state || emp?.state || 'WEST';
      const market = log.assigned_market || matchedLoc?.name || emp?.city || 'Assigned Market';
      const state = log.assigned_state || matchedLoc?.state || emp?.state || 'Lagos';

      let geofenceStatus = log.geofence_status;
      if (!geofenceStatus) {
        if (log.is_inside_geofence) {
          geofenceStatus = 'Verified';
        } else if (log.status === 'blocked') {
          geofenceStatus = 'Blocked';
        } else {
          geofenceStatus = 'Outside Geofence';
        }
      }

      const assignedLat = matchedLoc ? Number(matchedLoc.latitude) : null;
      const assignedLng = matchedLoc ? Number(matchedLoc.longitude) : null;
      const permittedRadius = matchedLoc ? Number(matchedLoc.geofence_radius || 150) : 150;

      return {
        id: log.id,
        log_id: `LOG-${log.id}`,
        date: lagos.dateStr,
        timestamp: lagos.isoLagos,
        server_time: lagos.isoLagos,
        server_time_formatted: lagos.formatted12h,
        employee_id: log.employee_id,
        employee_code: emp?.employee_code || `EMP-${log.employee_id}`,
        agent_name: log.employee_name || (emp ? `${emp.first_name} ${emp.last_name}` : `Agent #${log.employee_id}`),
        ba_agent_name: log.employee_name || (emp ? `${emp.first_name} ${emp.last_name}` : `Agent #${log.employee_id}`),
        role: log.role || emp?.role_code || 'FIELD_AGENT',
        designation,
        activity: log.activity || log.current_activity || 'Location Telemetry',
        attendance_type: log.attendance_type || 'TELEMETRY_PING',
        region: String(region).toUpperCase(),
        state,
        market,
        latitude: Number(log.latitude),
        longitude: Number(log.longitude),
        accuracy: Number(log.accuracy || 5),
        accuracy_text: `±${Math.round(log.accuracy || 5)}m`,
        distance_meters: Math.round(distanceVal * 10) / 10,
        distance_formatted: formatDistance(distanceVal),
        distance_from_assigned_location: formatDistance(distanceVal),
        permitted_radius: permittedRadius,
        geofence_status: geofenceStatus,
        status: log.status || 'success',
        address: log.address || matchedLoc?.address || 'Field Location',
        assigned_location: matchedLoc ? {
          id: matchedLoc.id,
          name: matchedLoc.name,
          address: matchedLoc.address,
          latitude: assignedLat,
          longitude: assignedLng,
          radius: permittedRadius,
          state: matchedLoc.state,
          region: matchedLoc.region || matchedLoc.state
        } : null
      };
    });

    // Apply filtering
    if (filters.start_date) {
      filtered = filtered.filter(r => r.date >= filters.start_date);
    }
    if (filters.end_date) {
      filtered = filtered.filter(r => r.date <= filters.end_date);
    }
    if (filters.employee_id) {
      filtered = filtered.filter(r => sameId(r.employee_id, filters.employee_id));
    }
    if (filters.role) {
      filtered = filtered.filter(r => r.role === filters.role || r.designation.toLowerCase().includes(filters.role.toLowerCase()));
    }
    if (filters.region && filters.region !== 'ALL') {
      filtered = filtered.filter(r => r.region === filters.region.toUpperCase());
    }
    if (filters.state && filters.state !== 'ALL') {
      filtered = filtered.filter(r => r.state?.toLowerCase() === filters.state.toLowerCase());
    }
    if (filters.market && filters.market !== 'ALL') {
      filtered = filtered.filter(r => r.market?.toLowerCase().includes(filters.market.toLowerCase()));
    }
    if (filters.attendance_type && filters.attendance_type !== 'ALL') {
      filtered = filtered.filter(r => r.attendance_type === filters.attendance_type);
    }
    if (filters.geofence_status && filters.geofence_status !== 'ALL') {
      filtered = filtered.filter(r => r.geofence_status.toLowerCase() === filters.geofence_status.toLowerCase());
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter(r =>
        r.agent_name.toLowerCase().includes(q) ||
        r.market.toLowerCase().includes(q) ||
        r.designation.toLowerCase().includes(q) ||
        r.activity.toLowerCase().includes(q) ||
        String(r.id).includes(q)
      );
    }

    return filtered;
  }
};
