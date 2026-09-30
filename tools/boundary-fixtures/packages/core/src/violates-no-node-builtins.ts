// Violates: portable-packages-have-no-node-builtins
import { statSync } from 'node:fs';

export const probe = statSync;
