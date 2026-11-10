export function newStartupAttemptId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function logStartupEvent(attemptId, event, details = {}) {
    if (!attemptId) return;
    const payload = {
        attemptId,
        event,
        clientTime: new Date().toISOString(),
        ...details
    };

    // Logging must never delay or prevent a robot operation.
    fetch('/api/startup-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
    }).catch(error => console.warn('Startup log delivery failed:', error));
}
