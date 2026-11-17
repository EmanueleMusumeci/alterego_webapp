// Robot settings from the touch-screen Settings page, stored by the server (/api/settings).
// The workflow reloads them at each start, resume and docking, so every screen acts on the latest values.
let current = { autoShutdownOnDock: true, headMotion: true, gestures: true };

export async function loadSettings() {
    try {
        const response = await fetch('/api/settings');
        if (response.ok) current = await response.json();
    } catch (error) {
        // Keep the last known values; the defaults are the behaviour before settings existed.
    }
    return current;
}

export function getSetting(key) {
    return current[key];
}

export async function saveSetting(key, value) {
    const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
    });
    if (!response.ok) throw new Error(`Settings not saved (${response.status})`);
    current = await response.json();
    return current;
}
