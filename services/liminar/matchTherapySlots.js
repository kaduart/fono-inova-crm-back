// Appointment.date is also stored at UTC midnight in legacy records.
// Its UTC calendar date is the scheduling date, not an instant to shift locally.
export function matchTherapySlots(appointments, slots) {
  const timesByWeekday = new Map();
  for (const slot of slots) {
    const times = timesByWeekday.get(slot.dayOfWeek) || [];
    times.push(slot.time);
    timesByWeekday.set(slot.dayOfWeek, times);
  }
  const byDate = new Map();
  for (const appointment of appointments) {
    const day = new Date(appointment.date).toISOString().slice(0, 10);
    const group = byDate.get(day) || [];
    group.push(appointment);
    byDate.set(day, group);
  }
  const timeSyncMap = new Map();
  const toCancelIds = [];
  const minutes = time => time.split(':').reduce((h, m) => Number(h) * 60 + Number(m));
  for (const [day, appointmentsOnDate] of byDate) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const available = [...(timesByWeekday.get(weekday) || [])];
    const sorted = [...appointmentsOnDate].sort((a, b) =>
      a.time.localeCompare(b.time) || String(a._id).localeCompare(String(b._id)));
    // Preserve exact matches before moving other appointments to nearby slots.
    const unmatched = [];
    for (const appointment of sorted) {
      const index = available.indexOf(appointment.time);
      if (index < 0) unmatched.push(appointment);
      else timeSyncMap.set(String(appointment._id), available.splice(index, 1)[0]);
    }
    for (const appointment of unmatched) {
      if (!available.length) { toCancelIds.push(appointment._id); continue; }
      let index = 0;
      available.forEach((time, i) => {
        if (Math.abs(minutes(time) - minutes(appointment.time)) <
            Math.abs(minutes(available[index]) - minutes(appointment.time))) index = i;
      });
      timeSyncMap.set(String(appointment._id), available.splice(index, 1)[0]);
    }
  }
  return { timeSyncMap, toCancelIds };
}
