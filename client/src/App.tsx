import { useEffect } from 'react';
import { Scene } from './scene/Scene';
import { Hud } from './hud/Hud';
import { connectBridge } from './bridge';
import { useStore } from './store';
import { playTransition } from './audio';
import { useJarvisVoice } from './voice/useJarvisVoice';
import { toggleVoice } from './voice/controls';

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

  // Spoken announcements + captions
  useJarvisVoice();

  // M toggles sound effects, V toggles the voice
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'm') useStore.getState().toggleMute();
      else if (k === 'v') toggleVoice();
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
