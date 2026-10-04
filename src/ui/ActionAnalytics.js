const JOINTS = [
  ['knee', 'Knee flexion', 'leftKneeFlexion', 'rightKneeFlexion'],
  ['hip', 'Hip flexion/extension', 'leftHipSagittalAngle', 'rightHipSagittalAngle'],
  ['ankle', 'Ankle dorsi/plantarflexion', 'leftAnkleDorsiflexion', 'rightAnkleDorsiflexion']
];
const number = (n) => Number.isFinite(n) ? n.toFixed(1) : '—';
const range = (value) => value ? `${number(value.min)}…${number(value.max)}` : '—';

/** A small live bilateral view plus the last completed action's phase ranges. */
export function createActionAnalytics(panel, recorder) {
  const section = document.createElement('details');
  section.id = 'joint-analytics';
  section.open = true;
  const title = document.createElement('summary');
  title.textContent = 'Joint angles & action history';
  const phase = document.createElement('p');
  phase.id = 'movement-phase';
  const note = document.createElement('small');
  note.textContent = 'Live L / R (°). Hip: + flexion, − extension. Ankle: + dorsiflexion, − plantarflexion. Estimated geometry; — = unavailable.';
  section.append(title, phase, note);
  const fields = [];
  for (const [id, label, left, right] of JOINTS) {
    const row = document.createElement('p');
    const values = document.createElement('span');
    values.id = `${id}-bilateral`;
    row.append(`${label}: `, values);
    section.append(row);
    fields.push({ values, left, right });
  }
  const lastAction = document.createElement('p');
  lastAction.id = 'last-action-summary';
  lastAction.textContent = 'Last completed action: —';
  const table = document.createElement('table');
  table.id = 'action-phase-ranges';
  const header = document.createElement('tr');
  for (const label of ['Phase', 'Knee L / R', 'Hip ± L / R', 'Ankle ± L / R']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);
  const phaseRows = ['PREPARATION', 'TAKEOFF', 'FLIGHT', 'LANDING', 'CROUCH'].map((key) => {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.textContent = key.toLowerCase();
    row.append(label);
    const cells = JOINTS.map(() => { const cell = document.createElement('td'); row.append(cell); return cell; });
    table.append(row);
    return { key, row, cells };
  });
  const scroll = document.createElement('div');
  scroll.className = 'metrics-table-scroll';
  scroll.append(table);
  const historyNote = document.createElement('small');
  historyNote.textContent = 'Historical per-phase min…max, in degrees. Preparation is a 0.5 s look-back; takeoff is a landmark threshold event. Export session JSON for samples.';
  section.append(lastAction, scroll, historyNote);
  panel.append(section);
  let shown;
  const render = (metrics) => {
    phase.textContent = `Phase: ${recorder.currentPhase}`;
    for (const field of fields) field.values.textContent = metrics?.valid
      ? `${number(metrics[field.left])} / ${number(metrics[field.right])}` : '— / —';
    const record = recorder.getLast();
    if (shown === record) return;
    shown = record;
    lastAction.textContent = record ? `Last completed ${record.action.toLowerCase()} (${(record.endedAt / 1000).toFixed(1)} s): ${record.action === 'JUMP'
      ? `${record.flightTime?.toFixed(3) ?? '—'} s flight, ${record.jumpHeight?.toFixed(3) ?? '—'} m, ${record.verticalDisplacement?.toFixed(3) ?? '—'} frame-height hip rise`
      : `${record.pauseDuration?.toFixed(3) ?? '—'} s bottom pause`}${record.truncated ? ' — sample limit reached; ranges cover retained samples' : ''}`
      : 'Last completed action: —';
    for (const { key, row, cells } of phaseRows) {
      const data = record?.phases[key];
      row.hidden = !data;
      JOINTS.forEach(([, , left, right], index) => {
        cells[index].textContent = `${range(data?.angles[left])} / ${range(data?.angles[right])}`;
      });
    }
  };
  render(null);
  return { render, destroy: () => section.remove() };
}
