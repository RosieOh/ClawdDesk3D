// Local font files for troika 3D text (troika reads .woff/.ttf/.otf, not .woff2).
// Without an explicit font, troika fetches its default from a CDN on first load.
import interSemiBold from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import monoBold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url';

export const FONT = { sans: interSemiBold, mono: monoBold } as const;
