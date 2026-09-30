// Violates: no-circular (b -> a -> b)
import { fromA } from './circular-a.ts';

export const fromB = () => fromA;
