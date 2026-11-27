import { useEffect } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './hud/Hud';
import { connectBridge } from './bridge';
import { useStore } from './store';
import { playTransition, setAudioEnabled } from './audio';

export default function App() {
  // Live hook bridge (falls back to simulator mode while disconnected)
  useEffect(() => connectBridge(), []);

  // Sound on state transitions
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.state !== prev.state && !s.muted) playTransition(s.state);
      }),
    [],
  );

  // M toggles sound
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'm' || e.metaKey || e.ctrlKey) return;
      const { muted, setMuted } = useStore.getState();
      setAudioEnabled(muted);
      setMuted(!muted);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <Scene />
      </div>
      <Hud />
    </div>
  );
}
