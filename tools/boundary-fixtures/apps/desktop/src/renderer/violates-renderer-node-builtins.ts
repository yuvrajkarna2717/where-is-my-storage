// Violates: renderer-has-no-node-builtins
import { readdirSync } from 'node:fs';

export const probe = readdirSync;
