import * as THREE from 'three';

/** Matte clay + frosted glass palette (shared instances). */
export const PALETTE = {
  cream: '#ddd2c2',
  bone: '#f6f1ea',
  terracotta: '#c8734f',
  terracottaDark: '#9a5338',
  charcoal: '#2b2b2f',
  graphite: '#45464c',
  sage: '#9db59a',
  teOrange: '#ff5a1f',
};

const clay = (color: string, roughness = 0.82) =>
  new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, clearcoat: 0.08, clearcoatRoughness: 0.8, sheen: 0.25, sheenRoughness: 0.9, sheenColor: new THREE.Color('#ffffff') });

export const MAT = {
  deskTop: clay(PALETTE.cream, 0.88),
  deskBase: clay(PALETTE.terracotta),
  deskUnder: clay(PALETTE.terracottaDark, 0.9),
  bone: clay(PALETTE.bone),
  charcoal: clay(PALETTE.charcoal, 0.7),
  graphite: clay(PALETTE.graphite, 0.75),
  orange: clay(PALETTE.teOrange, 0.6),
  sage: clay(PALETTE.sage, 0.9),
  terracotta2: clay('#d9865f', 0.9),
  keycap: clay('#e8e1d6', 0.6),
  keycapDark: clay('#8d8a86', 0.65),
  frost: new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    roughness: 0.32,
    transmission: 1,
    thickness: 0.6,
    ior: 1.35,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    attenuationColor: new THREE.Color('#fff4ea'),
    attenuationDistance: 2.5,
  }),
};
