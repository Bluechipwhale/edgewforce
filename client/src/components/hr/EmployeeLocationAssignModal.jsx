// ==============================================================================
// EDGEWFORCE - EMPLOYEE LOCATION ASSIGNMENT MODAL
// Primary, Secondary, and Temporary Location Management with Audit History
// ==============================================================================

import React, { useState, useEffect } from 'react';
import {
  MapPin,
  Building2,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  X,
  History,
  Shield,
  User,
  Plus,
  Trash2,
  ArrowRight,
  Info,
  Loader2
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { formatDate } from '../../lib/formatters';
import LocationManagerModal from '../admin/LocationManagerModal';

export default function EmployeeLocationAssignModal({
  isOpen,
  onClose,
  employee,
  onAssignmentComplete
}) {
  const [locations, setLocations] = useState([]);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [assignmentType, setAssignmentType] = useState('primary'); // 'primary' | 'secondary' | 'temporary'
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [employeeLocations, setEmployeeLocations] = useState(null);
  const [historyLogs, setHistoryLogs] = useState([]);

  const [activeTab, setActiveTab] = useState('assign'); // 'assign' | 'active' | 'history'
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  useEffect(() => {
    if (isOpen && employee?.id) {
      setErrorMsg('');
      setSuccessMsg('');
      setReason('');
      setStartDate(new Date().toISOString().slice(0, 10));
      setEndDate(new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
      loadData();
    }
  }, [isOpen, employee]);

  const loadData = async () => {
    if (!employee?.id) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const [locsRes, empLocsRes] = await Promise.all([
        apiRequest('/locations?status=active'),
        apiRequest(`/locations/employee/${encodeURIComponent(employee.id)}`)
      ]);

      const locList = Array.isArray(locsRes) ? locsRes : (locsRes.data || locsRes.locations || []);
      setLocations(locList);

      const empData = empLocsRes.data || empLocsRes;
      setEmployeeLocations(empData);
      setHistoryLogs(empData?.history || []);

      if (locList.length > 0) {
        // Default selection to existing primary if any, else first location
        if (empData?.primary_location?.id) {
          setSelectedLocationId(String(empData.primary_location.id));
        } else {
          setSelectedLocationId(String(locList[0].id));
        }
      }
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load work locations. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignSubmit = async (e) => {
    e.preventDefault();
    if (!selectedLocationId) {
      setErrorMsg('Please select a work location to assign.');
      return;
    }

    if (assignmentType === 'temporary') {
      if (!startDate || !endDate) {
        setErrorMsg('Temporary assignment requires both start date and end date.');
        return;
      }
      if (new Date(startDate) > new Date(endDate)) {
        setErrorMsg('Start date cannot be after end date.');
        return;
      }
    }

    setSaving(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const payload = {
        location_id: selectedLocationId,
        assignment_type: assignmentType,
        is_primary: assignmentType === 'primary',
        start_date: assignmentType === 'temporary' ? startDate : null,
        end_date: assignmentType === 'temporary' ? endDate : null,
        reason: reason.trim() || `Assigned ${assignmentType} location`
      };

      await apiRequest(`/locations/employee/${encodeURIComponent(employee.id)}/assign`, 'POST', payload);
      setSuccessMsg(`✓ Location successfully assigned to ${employee.first_name || employee.name}!`);
      loadData();
      onAssignmentComplete?.();
      setTimeout(() => {
        setSuccessMsg('');
      }, 3000);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to assign location.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveAssignment = async (assignmentId) => {
    if (!window.confirm('Are you sure you want to remove this location assignment?')) return;
    try {
      await apiRequest(`/locations/assignments/${assignmentId}`, 'DELETE', {
        reason: 'Assignment removed via Admin/HR portal'
      });
      setSuccessMsg('✓ Assignment removed.');
      loadData();
      onAssignmentComplete?.();
    } catch (err) {
      setErrorMsg(err.message || 'Failed to remove assignment.');
    }
  };

  const handleNewLocationCreated = (newLoc) => {
    loadData();
    if (newLoc?.id) {
      setSelectedLocationId(String(newLoc.id));
    }
  };

  if (!isOpen || !employee) return null;

  const selectedLocObj = locations.find(l => String(l.id) === String(selectedLocationId));

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden my-6">
          {/* Header */}
          <div className="px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-zinc-50 dark:bg-zinc-800/50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-orange-500 text-white font-black flex items-center justify-center text-sm shadow-xs">
                {(employee.first_name?.[0] || employee.name?.[0] || 'E')}
              </div>
              <div>
                <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                  <span>{employee.first_name ? `${employee.first_name} ${employee.last_name}` : employee.name}</span>
                  <span className="px-2 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded text-[11px] font-mono">
                    {employee.employee_code || `EMP-${employee.id}`}
                  </span>
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {employee.position || employee.role || 'Staff'} • {employee.department || 'Operations'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Nav Tabs */}
          <div className="px-6 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-4 bg-zinc-50/50 dark:bg-zinc-800/20">
            <button
              onClick={() => setActiveTab('assign')}
              className={`py-3 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'assign'
                  ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <MapPin size={14} />
              <span>Assign Location</span>
            </button>

            <button
              onClick={() => setActiveTab('active')}
              className={`py-3 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'active'
                  ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Building2 size={14} />
              <span>Active Locations ({employeeLocations?.all_active_locations?.length || 0})</span>
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`py-3 text-xs font-bold border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'history'
                  ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <History size={14} />
              <span>Assignment History ({historyLogs.length})</span>
            </button>
          </div>

          {/* Modal Content */}
          <div className="p-6 space-y-4">
            {errorMsg && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 rounded-xl text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertCircle size={15} className="shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 size={15} className="shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* TAB 1: ASSIGN LOCATION */}
            {activeTab === 'assign' && (
              <form onSubmit={handleAssignSubmit} className="space-y-4">
                {/* Assignment Type Options */}
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                    Assignment Type *
                  </label>
                  <div className="grid grid-cols-3 gap-2.5">
                    <label className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col items-center text-center ${
                      assignmentType === 'primary'
                        ? 'border-orange-500 bg-orange-50/50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300 font-bold'
                        : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300'
                    }`}>
                      <input
                        type="radio"
                        name="assign_type"
                        value="primary"
                        checked={assignmentType === 'primary'}
                        onChange={() => setAssignmentType('primary')}
                        className="sr-only"
                      />
                      <Building2 size={18} className="mb-1 text-orange-500" />
                      <span className="text-xs">Primary Workplace</span>
                      <span className="text-[10px] text-zinc-400 mt-0.5">Main daily check-in</span>
                    </label>

                    <label className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col items-center text-center ${
                      assignmentType === 'secondary'
                        ? 'border-orange-500 bg-orange-50/50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300 font-bold'
                        : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300'
                    }`}>
                      <input
                        type="radio"
                        name="assign_type"
                        value="secondary"
                        checked={assignmentType === 'secondary'}
                        onChange={() => setAssignmentType('secondary')}
                        className="sr-only"
                      />
                      <MapPin size={18} className="mb-1 text-amber-500" />
                      <span className="text-xs">Allowed Secondary</span>
                      <span className="text-[10px] text-zinc-400 mt-0.5">Additional allowed site</span>
                    </label>

                    <label className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col items-center text-center ${
                      assignmentType === 'temporary'
                        ? 'border-orange-500 bg-orange-50/50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300 font-bold'
                        : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300'
                    }`}>
                      <input
                        type="radio"
                        name="assign_type"
                        value="temporary"
                        checked={assignmentType === 'temporary'}
                        onChange={() => setAssignmentType('temporary')}
                        className="sr-only"
                      />
                      <Clock size={18} className="mb-1 text-blue-500" />
                      <span className="text-xs">Temporary Window</span>
                      <span className="text-[10px] text-zinc-400 mt-0.5">Date-bounded project</span>
                    </label>
                  </div>
                </div>

                {/* Location Picker */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                      Work Location Destination *
                    </label>
                    <button
                      type="button"
                      onClick={() => setIsCreateModalOpen(true)}
                      className="text-xs text-orange-600 dark:text-orange-400 font-semibold hover:underline flex items-center gap-1"
                    >
                      <Plus size={13} />
                      <span>Create New Location</span>
                    </button>
                  </div>

                  <select
                    value={selectedLocationId}
                    onChange={(e) => setSelectedLocationId(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 bg-zinc-50 dark:bg-zinc-800/70 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                  >
                    <option value="">-- Choose Work Location --</option>
                    {locations.map(loc => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} ({loc.location_type || 'Office'} • {loc.state} • Radius: {loc.geofence_radius || 150}m)
                      </option>
                    ))}
                  </select>

                  {/* Selected Location Summary Card */}
                  {selectedLocObj && (
                    <div className="mt-2 p-3 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700/60 rounded-xl flex items-start gap-2.5 text-xs">
                      <MapPin size={16} className="text-orange-500 shrink-0 mt-0.5" />
                      <div className="flex-1 space-y-0.5">
                        <div className="font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                          <span>{selectedLocObj.name}</span>
                          <span className="px-1.5 py-0.2 bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300 rounded text-[10px]">
                            {selectedLocObj.location_type}
                          </span>
                        </div>
                        <p className="text-zinc-500 dark:text-zinc-400">{selectedLocObj.address || `${selectedLocObj.city || ''}, ${selectedLocObj.state}`}</p>
                        <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-3 pt-0.5">
                          <span>GPS: {selectedLocObj.latitude}, {selectedLocObj.longitude}</span>
                          <span>•</span>
                          <span>Permitted Radius: <b>{selectedLocObj.geofence_radius || 150}m</b></span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Date Bounds (For Temporary Assignment) */}
                {assignmentType === 'temporary' && (
                  <div className="p-3.5 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/40 rounded-xl space-y-2.5">
                    <div className="text-xs font-bold text-blue-900 dark:text-blue-200 flex items-center gap-1.5">
                      <Calendar size={14} className="text-blue-500" />
                      <span>Temporary Assignment Active Window</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">Start Date *</label>
                        <input
                          type="date"
                          required
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">End Date *</label>
                        <input
                          type="date"
                          required
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-xs"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Reason / Administrative Note for Audit History */}
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Assignment Reason / Audit Note
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Relocated to Oyo State territory, Temporary coverage for product launch"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-zinc-50 dark:bg-zinc-800/70 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                  />
                </div>

                {/* Submit Action */}
                <div className="pt-2 flex items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-semibold"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !selectedLocationId}
                    className="px-5 py-2 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-xl text-xs shadow-md shadow-orange-600/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    <span>Confirm Location Assignment</span>
                  </button>
                </div>
              </form>
            )}

            {/* TAB 2: ACTIVE LOCATIONS */}
            {activeTab === 'active' && (
              <div className="space-y-3">
                {employeeLocations?.all_active_locations?.length === 0 ? (
                  <div className="py-8 text-center text-zinc-400 text-xs">
                    No active work locations assigned to this employee.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Primary Location */}
                    {employeeLocations?.primary_location && (
                      <div className="p-3.5 bg-orange-50/50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-900/50 rounded-xl flex items-center justify-between">
                        <div className="flex items-start gap-2.5">
                          <Building2 size={18} className="text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                                {employeeLocations.primary_location.name}
                              </span>
                              <span className="px-2 py-0.5 bg-orange-500 text-white rounded text-[10px] font-black uppercase">
                                Primary
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                              {employeeLocations.primary_location.address || employeeLocations.primary_location.state} • Radius: {employeeLocations.primary_location.geofence_radius || 150}m
                            </p>
                          </div>
                        </div>

                        {employeeLocations.primary_assignment?.assignment_id && (
                          <button
                            onClick={() => handleRemoveAssignment(employeeLocations.primary_assignment.assignment_id)}
                            className="p-1.5 text-zinc-400 hover:text-red-500 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                            title="Remove assignment"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    )}

                    {/* Secondary & Temporary Locations */}
                    {employeeLocations?.allowed_locations?.map(loc => (
                      <div key={loc.id} className="p-3 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800 rounded-xl flex items-center justify-between">
                        <div className="flex items-start gap-2.5">
                          <MapPin size={16} className="text-amber-500 shrink-0 mt-0.5" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">{loc.name}</span>
                              <span className="px-1.5 py-0.2 bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 rounded text-[10px]">
                                Secondary
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              {loc.address || loc.state} • Radius: {loc.geofence_radius || 150}m
                            </p>
                          </div>
                        </div>
                        {loc.assignment_id && (
                          <button
                            onClick={() => handleRemoveAssignment(loc.assignment_id)}
                            className="p-1.5 text-zinc-400 hover:text-red-500 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}

                    {employeeLocations?.temporary_locations?.map(loc => (
                      <div key={loc.id} className="p-3 bg-blue-50/40 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/40 rounded-xl flex items-center justify-between">
                        <div className="flex items-start gap-2.5">
                          <Clock size={16} className="text-blue-500 shrink-0 mt-0.5" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">{loc.name}</span>
                              <span className="px-1.5 py-0.2 bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 rounded text-[10px]">
                                Temporary Window
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                              Valid: {formatDate(loc.start_date)} to {formatDate(loc.end_date)}
                            </p>
                          </div>
                        </div>
                        {loc.assignment_id && (
                          <button
                            onClick={() => handleRemoveAssignment(loc.assignment_id)}
                            className="p-1.5 text-zinc-400 hover:text-red-500 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: AUDIT HISTORY */}
            {activeTab === 'history' && (
              <div className="space-y-3">
                {historyLogs.length === 0 ? (
                  <div className="py-8 text-center text-zinc-400 text-xs">
                    No assignment audit history records found for this employee.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {historyLogs.map(log => (
                      <div key={log.id} className="p-3 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                            <Shield size={13} className="text-orange-500" />
                            <span>{log.action}</span>
                          </span>
                          <span className="text-[11px] text-zinc-400">{formatDate(log.created_at)}</span>
                        </div>
                        <p className="text-zinc-600 dark:text-zinc-300">
                          {log.new_location_name ? `Assigned to ${log.new_location_name}` : `Removed from ${log.previous_location_name}`}
                        </p>
                        {log.reason && (
                          <p className="text-[11px] text-zinc-500 italic">"{log.reason}"</p>
                        )}
                        <div className="text-[10px] text-zinc-400 pt-0.5">
                          By: {log.changed_by_name || 'HR Administrator'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* On-the-fly Location Creation Modal */}
      {isCreateModalOpen && (
        <LocationManagerModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          onLocationSaved={handleNewLocationCreated}
        />
      )}
    </>
  );
}
