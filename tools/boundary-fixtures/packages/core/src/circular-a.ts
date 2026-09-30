// Violates: no-circular (a -> b -> a)
import { fromB } from './circular-b.ts';

export const fromA = () => fromB;
