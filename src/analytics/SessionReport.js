/** Only bounded numeric movement data and machine notes; no images/device IDs. */
export function createSessionReport(performanceMonitor, recorder, hardwareNotes = '') {
  return {
    schemaVersion: 1, exportedAt: new Date().toISOString(),
    performance: performanceMonitor.getSummary(hardwareNotes),
    movement: recorder.getReport(),
    validation: { source: 'live application session; observer must document whether input was human or simulated',
      manualEvaluation: 'Attach participant codes, movement speeds, repetitions, false positives/negatives and protocol notes. This export does not establish detection accuracy.' }
  };
}

export function downloadSessionReport(report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `cv-runner-session-${report.exportedAt.replace(/[:.]/g, '-')}.json`;
  // A click consumes the Blob URL synchronously; release it without a retained timer.
  try { link.click(); } finally { URL.revokeObjectURL(url); }
}
