// The signals Mushin blends. Add one here (+ a weight in
// CONFIG.mushin.signalWeights) to introduce a new discovery stream.

import { RecSignal } from './types.ts';
import { tasteMatch } from './tasteMatch.ts';
import { collaborative } from './collaborative.ts';
import { rising } from './rising.ts';
import { exploration } from './exploration.ts';
import { affinity } from './affinity.ts';

export const SIGNALS: RecSignal[] = [tasteMatch, collaborative, rising, exploration, affinity];
