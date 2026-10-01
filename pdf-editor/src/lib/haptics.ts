// Tactile feedback helper for Android and supported mobile devices

export type HapticIntensity = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

export function triggerHaptic(type: HapticIntensity = 'light') {
  if (typeof window === 'undefined' || !('vibrate' in navigator)) return;

  try {
    switch (type) {
      case 'light':
        navigator.vibrate(8);
        break;
      case 'medium':
        navigator.vibrate(18);
        break;
      case 'heavy':
        navigator.vibrate([25, 10, 25]);
        break;
      case 'success':
        navigator.vibrate([10, 30, 20]);
        break;
      case 'warning':
        navigator.vibrate([30, 40, 30]);
        break;
      case 'error':
        navigator.vibrate([50, 40, 50, 40, 50]);
        break;
    }
  } catch {
    // Ignore unsupported vibration errors
  }
}
