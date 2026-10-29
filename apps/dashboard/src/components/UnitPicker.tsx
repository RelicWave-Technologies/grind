import { useQuery } from '@tanstack/react-query';
import { adminUnitsQuery } from '../lib/queries';
import { Select } from '../ui';

/**
 * Which unit (employer: EMIAC, MACOBS) a month download covers — '' for every
 * unit. Sits beside the download buttons on Reports and Attendance so HR can
 * take one company's sheet. Hidden until the workspace has units.
 */
export function UnitPicker({ value, onChange }: { value: string; onChange: (unit: string) => void }) {
  const q = useQuery(adminUnitsQuery());
  const units = q.data?.units ?? [];
  if (units.length === 0) return null;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Unit to download" title="Unit to download">
      <option value="">All units</option>
      {units.map((u) => (
        <option key={u.id} value={u.name}>
          {u.name}
        </option>
      ))}
    </Select>
  );
}
